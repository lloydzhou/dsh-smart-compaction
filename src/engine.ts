/** Cache-preserving automatic pressure and overflow compaction for DSH. */
import { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine, type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import { CONTEXT_WINDOW_EXCEEDED_CODE, HarnessError, type ContentBlock, type TokenUsage, type Message, type ToolSchema } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import { candidates, projectedPruneTokens } from './selection.js';
import type { CacheFirstSnapshot } from './policy.js';
export type * from './policy.js';

/** Base settings retain stock manual/model-switch behavior; fallback attempts bound overflow shrinking. */
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
    if (event.type === 'compaction/start') throw new Error('cache-first: compaction is already active');
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

/** Extends durable Basic transactions and inherits all stock automatic listeners and manual compaction. */
export class CacheFirstCompactionEngine extends BasicCompactionEngine {
  private readonly fallbackLimit: number;
  private readonly candidateLimit: number;

  constructor(ctx: Context, options: CacheFirstConfig = {}) {
    const limit = fallbackAttempts(options);
    const candidateLimit = options.maxCandidateChecks ?? 128;
    if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 2) throw new Error('cache-first: maxCandidateChecks must be a safe integer of at least 2');
    super(ctx, options.base);
    this.fallbackLimit = limit;
    this.candidateLimit = candidateLimit;
  }

  /** Prevent a late adapter response from committing after cancellation. */
  protected override async summarize(input: { readonly messages: readonly Message[]; readonly tools?: readonly ToolSchema[] }, agent: Agent, signal?: AbortSignal): Promise<SummaryOutput> {
    signal?.throwIfAborted();
    const result = await super.summarize(input, agent, signal);
    signal?.throwIfAborted();
    return result;
  }

  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    signal.throwIfAborted();
    const session = agent.session;
    const header = session.requestHeader();
    if (!header || !header.config.provider || !header.config.model) return null;
    const route = { provider: header.config.provider, model: header.config.model };
    const override = this.config.modelPolicies.find(item => item.provider === route.provider && item.model === route.model);
    const policy = { ...this.config, ...override };
    const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal);
    signal.throwIfAborted();
    assertInactive(session);
    if (!info.context) throw new Error(`cache-first: contextWindow unavailable for ${route.provider}/${route.model}`);
    const contextWindow = info.context.contextWindow;
    const reservedCompletionTokens = header.config.maxTokens ?? info.defaultMaxTokens ?? 0;
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0
      || !Number.isSafeInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
      throw new Error('cache-first: context window and output reservation must be finite integer budgets');
    }
    const messageBudget = contextWindow - reservedCompletionTokens;
    const hardThreshold = Math.floor(Math.min(contextWindow * policy.thresholdRatio, messageBudget - policy.headroomTokens));
    const retain = override?.retainTokens !== undefined ? override.retainTokens
      : override?.retainRatio !== undefined ? Math.floor(messageBudget * override.retainRatio)
      : this.config.retainTokens ?? Math.floor(messageBudget * (this.config.retainRatio ?? 0));
    if (hardThreshold <= 0 || retain >= hardThreshold) throw new Error('cache-first: output/headroom/retention budgets leave no compaction capacity');
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
      totalTokens: measurement.totalTokens, surfaceTokens: measurement.surfaceTokens,
      fixedTokens: Math.max(0, measurement.totalTokens - measurement.surfaceTokens)
        + (measurement.nodes[0] && session.eventAt(measurement.nodes[0].seq)?.type === 'system/message' ? measurement.nodes[0].tokens : 0),
      contextWindow, thresholdTokens: hardThreshold, defaultRetainTokens: retain, summaryMaxTokens: policy.maxTokens,
      trigger, candidates: Object.freeze(ranges.map(item => Object.freeze(item))),
      route: Object.freeze(route), summaryRoute: Object.freeze({ provider: policy.summarizationProvider || route.provider, model: policy.summarizationModel || route.model }),
      history: Object.freeze(history),
      ...(measurement.baseline.kind === 'usage' ? { previousUsage: Object.freeze({ ...measurement.baseline.usage }) } : {}),
    });
    const decision = this.ctx.waterfall('cache-first/decide', snapshot, () => ({ thresholdTokens: hardThreshold, retainTokens: retain, reason: 'configured policy' }));
    if (decision && (!Number.isFinite(decision.thresholdTokens) || decision.thresholdTokens <= 0
      || !Number.isFinite(decision.retainTokens) || decision.retainTokens < 0 || decision.retainTokens >= decision.thresholdTokens)) {
      throw new Error('cache-first: policy returned invalid token budgets');
    }
    const threshold = Math.min(hardThreshold, decision?.thresholdTokens ?? hardThreshold);
    const retention = trigger === 'context-overflow' ? 0 : Math.min(hardThreshold - 1, decision?.retainTokens ?? retain);
    if (trigger === 'pressure' && (measurement.totalTokens < threshold || (decision === null && measurement.totalTokens < hardThreshold))) return null;
    const pruner = this.ctx.get('toolResultPruner');
    const prune = (requireSufficient: boolean): boolean => {
      signal.throwIfAborted();
      assertInactive(session);
      measurement = meter.measure(session);
      if (!pruner) return false;
      const projected = projectedPruneTokens(session, measurement, meter, pruner);
      if (projected >= measurement.totalTokens || (requireSufficient && projected >= threshold)) return false;
      const before = measurement.totalTokens;
      pruner.pruneSession(session);
      measurement = meter.measure(session);
      signal.throwIfAborted();
      return measurement.totalTokens < before;
    };
    // No asynchronous work separates the fresh projection from its synchronous commit.
    if (prune(true) && measurement.totalTokens < threshold) return null;
    let result: CompactionResult | null = null;
    for (let attempt = 0; attempt <= policy.compactionRetries; attempt++) {
      signal.throwIfAborted();
      measurement = meter.measure(session);
      let options = candidates(session, measurement, this.candidateLimit).filter(item => item.retainedTokens >= retention);
      let range = options.at(-1);
      if (!range) { prune(false); return result; }
      const before = measurement.totalTokens;
      let summarized = false;
      for (let fallback = 0; fallback <= this.fallbackLimit; fallback++) {
        try {
          result = await this.compactRegion(range.start, range.end, agent, signal);
          summarized = true;
          break;
        } catch (error) {
          signal.throwIfAborted();
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
      if (!summarized || measurement.totalTokens >= before) throw new Error('cache-first: compaction made no measured progress');
      if (measurement.totalTokens < threshold) return result;
      // Only after preserving a summary of the original prefix may retained results be rewritten.
      prune(false);
      if (measurement.totalTokens < threshold || trigger === 'context-overflow') return result;
    }
    throw new Error(`cache-first: pressure remains above threshold after ${policy.compactionRetries + 1} attempts`);
  }
}
