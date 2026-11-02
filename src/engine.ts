/** Cache-preserving manual, automatic pressure and overflow compaction for DSH. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine, type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { CompactionId, compactCheckpointSource, ManualCompactionError, toolPairingBalancedBefore, toolPairingBalancedAfter, type CompactionResult, type CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import { CONTEXT_WINDOW_EXCEEDED_CODE, HarnessError, createUserMessage, errorChain, type ContentBlock, type TokenUsage, type Message, type ToolSchema } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import { candidates, projectedPruneTokens } from './selection.js';
import type { CacheFirstSnapshot } from './policy.js';
import { CompactionTelemetry, type CompactionResultSink } from './telemetry.js';
import { SummaryReasoningScope } from './reasoning.js';
export type * from './policy.js';

/** Base settings configure the stock summarizer; fallback attempts bound overflow shrinking. */
export interface CacheFirstConfig {
  base?: BasicCompactionConfig;
  summaryFallbackAttempts?: number;
  /** Maximum sampled pairing checks per selection; at least two preserves both extremes. */
  maxCandidateChecks?: number;
}

function fallbackAttempts(config: CacheFirstConfig): number {
  for (const key of Object.keys(config)) {
    if (key !== 'base' && key !== 'summaryFallbackAttempts' && key !== 'maxCandidateChecks') throw new Error(`cache-first: unknown config field ${key}`);
  }
  const value = config.summaryFallbackAttempts ?? 2;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('cache-first: summaryFallbackAttempts must be a non-negative safe integer');
  return value;
}

/** Reject active durable transactions before any model-free write. */
function assertInactive(session: Session): void {
  for (const event of [...session.snapshotEvents()].reverse()) {
    if (event.type === 'compaction/end' || event.type === 'session/end-seed') return;
    if (event.type === 'compaction/start') throw new ManualCompactionError('busy', 'cache-first: compaction is already active');
  }
}

function overflow(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (error instanceof HarnessError && error.code === CONTEXT_WINDOW_EXCEEDED_CODE) return true;
    error = error.cause;
  }
  return false;
}

/** Structural public vocabulary for the protected stock summary hook, whose named type is not exported. */
type SummaryOutput = {
  summary: ContentBlock[];
  provider: string;
  model: string;
  maxTokens?: number;
  usage?: TokenUsage;
} & ({ rawOutput: ContentBlock[]; llmStreamCall: true } | { rawOutput?: ContentBlock[]; llmStreamCall?: never });

/** Shares cache-first selection across manual and stock automatic listeners. */
export class CacheFirstCompactionEngine extends BasicCompactionEngine {
  private readonly fallbackLimit: number;
  private readonly candidateLimit: number;
  private readonly telemetry: CompactionTelemetry;
  private readonly summaryReasoning: SummaryReasoningScope;
  private readonly manualCommand = new AsyncLocalStorage<{ sourceCommandId: Parameters<BasicCompactionEngine['compactNow']>[2]; transactionOpen: boolean }>();

  constructor(ctx: Context, options: CacheFirstConfig = {}, sink?: CompactionResultSink) {
    const limit = fallbackAttempts(options);
    const candidateLimit = options.maxCandidateChecks ?? 128;
    if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 2) throw new Error('cache-first: maxCandidateChecks must be a safe integer of at least 2');
    super(ctx, options.base);
    this.fallbackLimit = limit;
    this.candidateLimit = candidateLimit;
    this.telemetry = new CompactionTelemetry(ctx, sink);
    this.summaryReasoning = new SummaryReasoningScope(ctx);
  }

  /** Prevent a late adapter response from committing after cancellation. */
  protected override async summarize(input: { readonly messages: readonly Message[]; readonly tools?: readonly ToolSchema[] }, agent: Agent, signal?: AbortSignal): Promise<SummaryOutput> {
    return this.telemetry.summary(agent.session, signal,
      () => this.summaryReasoning.run(agent.session, () => super.summarize(input, agent, signal)));
  }

  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    return this.telemetry.operation(agent.session, trigger, signal, () => this.compactWithTelemetry(agent, trigger, signal));
  }

  override compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: Parameters<BasicCompactionEngine['compactNow']>[2]): ReturnType<BasicCompactionEngine['compactNow']> {
    signal.throwIfAborted();
    try {
      return agent.runMaintenance(async agentSignal => {
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        try {
          const command = { sourceCommandId, transactionOpen: false };
          return await this.manualCommand.run(command, () =>
            this.telemetry.operation(agent.session, 'manual', operationSignal, async () => {
              const before = agent.session.seq;
              let result: CompactionResult | null = null;
              let failure: { error: unknown } | undefined;
              let flushFailure: { error: unknown } | undefined;
              try { result = await this.compactWithTelemetry(agent, 'pressure', operationSignal, true); }
              catch (error) { failure = { error }; }
              // Never checkpoint an unmatched opening marker. Prune-only changes and
              // closed failed attempts still need durability, without masking their cause.
              if (agent.session.seq !== before && !command.transactionOpen) {
                try { await this.ctx.sessions.flush(agent.session); }
                catch (error) { flushFailure = { error }; }
              }
              operationSignal.throwIfAborted();
              if (failure) throw failure.error;
              if (flushFailure) throw new ManualCompactionError('persistence', 'manual compaction durability checkpoint failed', { cause: flushFailure.error });
              return result;
            }));
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error });
          operationSignal.throwIfAborted();
          throw error;
        }
      });
    } catch (error) {
      throw new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', { cause: error });
    }
  }

  override compactRegion(...args: Parameters<BasicCompactionEngine['compactRegion']>): ReturnType<BasicCompactionEngine['compactRegion']> {
    return this.telemetry.operation(args[2].session, 'region', args[3], () => {
      // Both selectors converge here; Basic owns in-turn transactions only.
      try {
        const measurement = this.ctx.tokenMeter.measure(args[2].session);
        const start = measurement.nodes.findIndex(node => node.seq === args[0]);
        const end = measurement.nodes.findIndex(node => node.seq === args[1]);
        if (start >= 0 && end >= start) {
          const removedTokens = measurement.nodes.slice(start, end + 1).reduce((sum, node) => sum + node.tokens, 0);
          this.telemetry.recordDecision({ action: 'summary', reason: 'execute selected balanced region',
            totalTokens: measurement.totalTokens, removedTokens, retainedTokens: Math.max(0, measurement.surfaceTokens - removedTokens) });
        }
      } catch { /* optional diagnostic measurement cannot alter the compaction outcome */ }
      if (this.manualCommand.getStore()) return this.compactManualRegion(...args);
      return super.compactRegion(...args);
    });
  }

  /** Public Session transaction for idle regions: Basic exposes only an in-turn region API. */
  private async compactManualRegion(start: Parameters<BasicCompactionEngine['compactRegion']>[0], end: Parameters<BasicCompactionEngine['compactRegion']>[1], agent: Agent, signal?: AbortSignal): Promise<CompactionResult> {
    signal?.throwIfAborted();
    const session = agent.session;
    assertInactive(session);
    const meter = this.ctx.tokenMeter;
    const command = this.manualCommand.getStore()!;
    const sourceCommandId = command.sourceCommandId;
    const lifecycle = { compactionId: CompactionId(randomUUID()), turn: null,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }) };
    const select = () => {
      const surface = session.surface.nodes;
      const first = surface.indexOf(start);
      const last = surface.indexOf(end);
      const offset = surface[0] !== undefined && session.eventAt(surface[0])?.type === 'system/message' ? 1 : 0;
      if (first !== offset || last < first || last >= surface.length - 1
        || !toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) {
        throw new ManualCompactionError('changed', 'manual compaction selected span is no longer a balanced prefix');
      }
      const seqs = surface.slice(first, last + 1);
      const measurement = meter.measure(session);
      const nodes = measurement.nodes.slice(first, last + 1);
      if (nodes.length !== seqs.length || nodes.some((node, index) => node.seq !== seqs[index])) {
        throw new ManualCompactionError('changed', 'manual compaction measurement does not match the selected span');
      }
      // Raw envelopes include source provenance; projected messages catch overlays.
      // Route prices are deliberately excluded: unrelated appends can reprice them.
      const sources = structuredClone(seqs.map(seq => {
        const event = session.eventAt(seq)!;
        return { event, message: session.deriveEventMessage(event) };
      }));
      return { nodes, seqs, sources, removedTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
    };
    let selected = select();
    const stable = () => {
      if (!isDeepStrictEqual(select().sources, selected.sources)) throw new ManualCompactionError('changed', 'manual compaction selected span changed');
    };
    const startEvent = session.append('compaction/start', lifecycle);
    command.transactionOpen = true;
    let closing = false;
    let stage: 'summary' | 'commit' = 'summary';
    try {
      let output: SummaryOutput;
      const recoverySnapshots = [selected.sources];
      // Recovery hooks are third-party synchronous mutations, not an unlimited
      // license to dispatch the same failed prompt (or cycle between prompts).
      const recoveryLimit = 3;
      for (let recovery = 0; ; recovery++) {
        signal?.throwIfAborted();
        const system = session.surface.nodes[0];
        const head = system === undefined ? undefined : session.eventAt(system);
        const seqs = head?.type === 'system/message' ? [head.seq, ...selected.seqs] : selected.seqs;
        const messages = seqs.map(seq => session.deriveEventMessage(session.eventAt(seq)!)).filter((message): message is Message => message !== null);
        const tools = session.requestHeader()?.tools;
        try { output = await this.summarize({ messages, ...(tools === undefined ? {} : { tools }) }, agent, signal); break; }
        catch (error) {
          signal?.throwIfAborted();
          stable();
          if (recovery >= recoveryLimit || !this.ctx.waterfall('compaction/summary-error', { session, sourceEventSeqs: selected.seqs, error, ...(signal ? { signal } : {}) }, () => false)) throw error;
          const repaired = select();
          if (recoverySnapshots.some(sources => isDeepStrictEqual(sources, repaired.sources))) throw error;
          recoverySnapshots.push(repaired.sources);
          selected = repaired;
        }
      }
      signal?.throwIfAborted();
      stable();
      const checkpoint = createUserMessage({
        content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>' }, ...output.summary, { type: 'text', text: '</compacted-summary>' }],
        source: compactCheckpointSource(lifecycle.compactionId, sourceCommandId),
      });
      if (meter.estimateMessage(checkpoint) >= selected.removedTokens) throw new Error('summary is not smaller than the shadowed content');
      stage = 'commit';
      const shadowedTokenCount = selected.nodes.reduce((sum, node) => sum + node.heuristicTokens, 0);
      const body = { compactionId: lifecycle.compactionId,
        ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
        summary: output.summary, shadowedRange: { start, end }, shadowedSeqs: selected.seqs, shadowedTokenCount };
      const summaryEvent = session.append('compaction/summary', { ...body, provider: output.provider, model: output.model,
        ...(output.maxTokens === undefined ? {} : { maxTokens: output.maxTokens }),
        ...(output.usage === undefined ? {} : { usage: output.usage }),
        ...(output.llmStreamCall === true ? { llmStreamCall: true as const, rawOutput: output.rawOutput }
          : output.rawOutput === undefined ? {} : { rawOutput: output.rawOutput }),
      });
      session.append('user/message', checkpoint, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selected.seqs] });
      closing = true;
      const endEvent = session.append('compaction/end', lifecycle);
      command.transactionOpen = false;
      return { ...body, startSeq: startEvent.seq, summarySeq: summaryEvent.seq, endSeq: endEvent.seq };
    } catch (error) {
      if (!closing) {
        try {
          session.append('compaction/end', { ...lifecycle, error: errorChain(error) });
          command.transactionOpen = false;
        }
        catch (closeError) { throw new ManualCompactionError('commit', 'manual compaction marker could not close', { cause: closeError }); }
      }
      signal?.throwIfAborted();
      if (error instanceof ManualCompactionError) throw error;
      throw new ManualCompactionError(stage, 'manual compaction failed', { cause: error });
    }
  }

  private async compactWithTelemetry(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal, manual = false): Promise<CompactionResult | null> {
    signal.throwIfAborted();
    const session = agent.session;
    if (manual) {
      assertInactive(session);
      const boundary = [...session.snapshotEvents()].reverse().find(event => event.type === 'turn/start' || event.type === 'turn/end');
      if (boundary?.type === 'turn/start') throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn');
      // Native manual keeps at least the last balanced unit, irrespective of automatic retention.
      // Short/no-region history is a no-op even when model capacity is unavailable.
      if (!candidates(session, this.ctx.tokenMeter.measure(session), this.candidateLimit).length) return null;
    }
    const header = session.requestHeader();
    const fallback = manual && agent.options.provider && agent.options.model
      ? { provider: agent.options.provider, model: agent.options.model }
      : manual && this.config.summarizationProvider && this.config.summarizationModel
        ? { provider: this.config.summarizationProvider, model: this.config.summarizationModel } : undefined;
    const provider = header?.config.provider || fallback?.provider;
    const model = header?.config.model || fallback?.model;
    if (!provider || !model) {
      if (manual) throw new ManualCompactionError('summary', 'manual compaction requires a configured model route');
      return null;
    }
    const route = { provider, model };
    const override = this.config.modelPolicies.find(item => item.provider === route.provider && item.model === route.model);
    const policy = { ...this.config, ...override };
    const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal);
    signal.throwIfAborted();
    assertInactive(session);
    if (!info.context) throw new Error(`cache-first: contextWindow unavailable for ${route.provider}/${route.model}`);
    const contextWindow = info.context.contextWindow;
    const reservedCompletionTokens = header?.config.maxTokens ?? info.defaultMaxTokens ?? 0;
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0
      || !Number.isSafeInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
      throw new Error('cache-first: context window and output reservation must be finite integer budgets');
    }
    const messageBudget = contextWindow - reservedCompletionTokens;
    const hardThreshold = Math.floor(Math.min(contextWindow * policy.thresholdRatio, messageBudget - policy.headroomTokens));
    const retain = override?.retainTokens !== undefined ? override.retainTokens
      : override?.retainRatio !== undefined ? Math.floor(messageBudget * override.retainRatio)
      : this.config.retainTokens ?? Math.floor(messageBudget * (this.config.retainRatio ?? 0));
    if (!manual && (hardThreshold <= 0 || retain >= hardThreshold)) throw new Error('cache-first: output/headroom/retention budgets leave no compaction capacity');
    const meter = this.ctx.tokenMeter;
    let measurement = meter.measure(session);
    const history = { userTurns: 0, modelCalls: 0, compactionCount: 0 };
    for (const event of session.snapshotEvents()) {
      if (event.type === 'user/message' && event.surfaceOp === 'append' && event.data.source.kind === 'user') history.userTurns++;
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') history.modelCalls++;
      if (event.type === 'compaction/summary') { history.compactionCount++; if (event.data.llmStreamCall) history.modelCalls++; }
    }
    const ranges = candidates(session, measurement, this.candidateLimit);
    const snapshot: CacheFirstSnapshot = Object.freeze({
      ...this.telemetry.correlation(),
      totalTokens: measurement.totalTokens, surfaceTokens: measurement.surfaceTokens,
      fixedTokens: Math.max(0, measurement.totalTokens - measurement.surfaceTokens)
        + (measurement.nodes[0] && session.eventAt(measurement.nodes[0].seq)?.type === 'system/message' ? measurement.nodes[0].tokens : 0),
      contextWindow, thresholdTokens: hardThreshold, defaultRetainTokens: retain, summaryMaxTokens: policy.maxTokens,
      trigger, candidates: Object.freeze(ranges.map(item => Object.freeze(item))),
      route: Object.freeze(route), summaryRoute: Object.freeze({ provider: policy.summarizationProvider || route.provider, model: policy.summarizationModel || route.model }),
      history: Object.freeze(history),
      ...(measurement.baseline.kind === 'usage' ? { previousUsage: Object.freeze({ ...measurement.baseline.usage }) } : {}),
    });
    // A manual request is not an economic opportunity: it cannot be deferred. Price a
    // native-retain=0 prefix with a summary allowance, capped at a 25% reduction.
    // This target gates post-summary pruning. Native /compact currently requires
    // a real checkpoint, so manual dry-run cannot return prune-only success.
    const manualTarget = Math.max(1, Math.min(Math.floor(measurement.totalTokens * 0.75),
      measurement.totalTokens - (ranges.at(-1)?.removedTokens ?? 0) + policy.maxTokens));
    const decision = manual
      ? { thresholdTokens: manualTarget, retainTokens: 0, reason: 'explicit manual request: force cache-first shrink; retain latest balanced unit' }
      : this.ctx.waterfall('cache-first/decide', snapshot, () => ({ thresholdTokens: hardThreshold, retainTokens: retain, reason: 'configured policy' }));
    if (decision && (!Number.isFinite(decision.thresholdTokens) || decision.thresholdTokens <= 0
      || !Number.isFinite(decision.retainTokens) || decision.retainTokens < 0 || decision.retainTokens >= decision.thresholdTokens)) {
      throw new Error('cache-first: policy returned invalid token budgets');
    }
    const threshold = manual ? manualTarget : Math.min(hardThreshold, decision?.thresholdTokens ?? hardThreshold);
    const retention = manual || trigger === 'context-overflow' ? 0 : Math.min(hardThreshold - 1, decision?.retainTokens ?? retain);
    const facts = { totalTokens: measurement.totalTokens, hardThresholdTokens: hardThreshold,
      effectiveThresholdTokens: threshold, retainTokens: retention,
      safetyOverride: trigger === 'context-overflow' || (decision === null && measurement.totalTokens >= hardThreshold) };
    this.telemetry.recordDecision({ action: 'policy', reason: decision?.reason ?? 'policy declined optional work; executor owns hard-limit safety', ...facts });
    if (!manual && trigger === 'pressure' && (measurement.totalTokens < threshold || (decision === null && measurement.totalTokens < hardThreshold))) return null;
    const pruner = this.ctx.get('toolResultPruner');
    const prune = (requireSufficient: boolean, dryRunOnly = false): boolean => {
      signal.throwIfAborted();
      assertInactive(session);
      measurement = meter.measure(session);
      if (!pruner) { this.telemetry.recordDecision({ action: 'prune', reason: 'pruner unavailable', ...facts, totalTokens: measurement.totalTokens }); return false; }
      const projected = projectedPruneTokens(session, measurement, meter, pruner);
      const useful = projected < measurement.totalTokens && (!requireSufficient || projected < threshold);
      this.telemetry.recordDecision({ action: 'prune', ...facts, totalTokens: measurement.totalTokens,
        projectedPruneTokens: projected, reason: dryRunOnly ? 'manual dry-run only; preserve original prefix for required summary checkpoint' : useful ? 'projected prune is useful; execute' : projected >= measurement.totalTokens ? 'prune cannot reduce measured tokens' : 'prune alone cannot reach effective threshold; preserve prefix for summary' });
      if (!useful || dryRunOnly) return false;
      const before = measurement.totalTokens;
      pruner.pruneSession(session);
      measurement = meter.measure(session);
      signal.throwIfAborted();
      return measurement.totalTokens < before;
    };
    // No asynchronous work separates the fresh projection from its synchronous commit.
    // Explicit /compact promises a summary checkpoint: the stock command maps
    // null to "No compactable history yet". Do not commit a prune-only manual
    // mutation that would be falsely presented as no work; preserve its prefix.
    if (manual) prune(true, true);
    else if (prune(true) && measurement.totalTokens < threshold) return null;
    let result: CompactionResult | null = null;
    for (let attempt = 0; attempt <= policy.compactionRetries; attempt++) {
      signal.throwIfAborted();
      measurement = meter.measure(session);
      let options = candidates(session, measurement, this.candidateLimit).filter(item => item.retainedTokens >= retention);
      let range = options.at(-1);
      if (!range) { this.telemetry.recordDecision({ action: 'skip', reason: 'no balanced range satisfies retention', ...facts, totalTokens: measurement.totalTokens }); prune(false); return result; }
      const before = measurement.totalTokens;
      let summarized = false;
      for (let fallback = 0; fallback <= this.fallbackLimit; fallback++) {
        try {
          this.telemetry.recordDecision({ action: 'summary', reason: fallback ? 'summary overflow: retry smaller balanced prefix' : 'prune insufficient: summarize selected balanced prefix',
            ...facts, totalTokens: measurement.totalTokens, retainedTokens: range.retainedTokens, removedTokens: range.removedTokens });
          result = await this.compactRegion(range.start, range.end, agent, signal);
          summarized = true;
          break;
        } catch (error) {
          signal.throwIfAborted();
          // An end-marker failure leaves the durable lock active. Do not mask
          // the commit failure with busy, or mutate/flush its partial transaction.
          if (this.manualCommand.getStore()?.transactionOpen) throw error;
          if (!overflow(error) || fallback === this.fallbackLimit) { prune(false); throw error; }
          // A smaller complete prefix preserves its original bytes and tool pairing.
          options = options.filter(item => item.removedTokens <= range!.removedTokens / 2);
          const smaller = options.at(-1);
          if (!smaller) { prune(false); throw error; }
          range = smaller;
        }
      }
      signal.throwIfAborted();
      measurement = meter.measure(session);
      // Manual validates shrink of the selected span. Concurrent context appended
      // outside that span may legitimately increase the whole-session measurement.
      // One useful summary fulfills the request; the target gates pruning only.
      if (manual && summarized) {
        if (measurement.totalTokens >= threshold) prune(false);
        return result;
      }
      if (!summarized || measurement.totalTokens >= before) throw new Error('cache-first: compaction made no measured progress');
      if (measurement.totalTokens < threshold) return result;
      // Only after preserving a summary of the original prefix may retained results be rewritten.
      prune(false);
      if (measurement.totalTokens < threshold || trigger === 'context-overflow') return result;
    }
    throw new Error(`cache-first: pressure remains above threshold after ${policy.compactionRetries + 1} attempts`);
  }
}
