import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';

import { usageFields as fields, observedUsage, aggregateUsage, type ObservedUsage } from './usage.js';
export { observedUsage, type ObservedUsage } from './usage.js';
type UsageField = typeof fields[number];
export interface Call {
  callId: string;
  summaryAttempt: number;
  provider: string;
  model: string;
  evidence: 'llm/stream' | 'summary-result';
  status: string;
  usage: ObservedUsage;
}
export interface Attempt { index: number; compactionId: string | null; status: 'success' | 'error' | 'cancelled'; llmStreamCall: boolean | null }
export interface DecisionFact {
  action: 'policy' | 'prune' | 'summary' | 'skip';
  reason: string;
  totalTokens: number | null;
  hardThresholdTokens: number | null;
  effectiveThresholdTokens: number | null;
  projectedPruneTokens: number | null;
  retainTokens: number | null;
  retainedTokens: number | null;
  removedTokens: number | null;
  safetyOverride: boolean;
}
export interface CompactionTelemetryResult {
  operationId: string; sessionId: string; trigger: string; status: string;
  calls: Call[]; attempts: Attempt[]; decisions: DecisionFact[];
  surfaceChanged: boolean; preTokens: number | null; postTokens: number | null;
  summaryEventSeqs: number[]; compactionIds: string[]; startEventSeq: number;
  summaryAttempts: number; llmStreamCalls: number; unknownSummaryAttempts: number;
  modelCalls: 0 | null; providerDispatch: 'none' | 'unknown';
  knownUsageCalls: number; unknownUsageCalls: number; usage: ObservedUsage;
  knownUsageTotals: Record<UsageField, number | null>;
}
export type CompactionResultSink = (session: Session, result: CompactionTelemetryResult) => void | Promise<void>;
interface Operation {
  operationId: string;
  sessionId: string;
  trigger: string;
  calls: Call[];
  attempts: Attempt[];
  decisions: DecisionFact[];
}

/** Instance-local async scope: no service mutation and no correlation by timing alone. */
export class CompactionTelemetry {
  private readonly operations = new AsyncLocalStorage<Operation>();
  private readonly summaries = new AsyncLocalStorage<{ operation: Operation; attempt: Attempt }>();
  private readonly logger;

  constructor(private readonly ctx: Context, private readonly sink?: CompactionResultSink) {
    this.logger = ctx.logger('cache-first-compaction');
    ctx.on('llm/stream', (options, next) => {
      const scope = this.summaries.getStore();
      if (!scope || options.purpose !== 'compaction' || options.sessionId !== scope.operation.sessionId) return next();
      const call: Call = { callId: randomUUID(), summaryAttempt: scope.attempt.index, provider: options.provider, model: options.model,
        evidence: 'llm/stream', status: 'started', usage: observedUsage() };
      scope.operation.calls.push(call);
      // next() can throw synchronously, so invoke it inside the iterator's guarded scope.
      return this.observeStream(call, options, next);
    }, { prepend: true });
  }

  private async *observeStream(call: Call, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    let finished = false;
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') call.usage = observedUsage(chunk.usage); // snapshots, not deltas (BlockAssembler semantics)
        if (chunk.type === 'finish') call.status = chunk.reason.kind;
        yield chunk;
      }
      finished = true;
      if (call.status === 'started') call.status = 'ended-without-finish';
    } catch (error) {
      call.status = options.signal?.aborted ? 'cancelled' : 'error';
      throw error;
    } finally {
      if (!finished && call.status === 'started') call.status = options.signal?.aborted ? 'cancelled' : 'interrupted';
    }
  }

  correlation(): { operationId: string; sessionId: string } | undefined {
    const operation = this.operations.getStore();
    return operation && { operationId: operation.operationId, sessionId: operation.sessionId };
  }

  recordDecision(fact: Pick<DecisionFact, 'action' | 'reason'> & Partial<DecisionFact>): void {
    const operation = this.operations.getStore();
    if (!operation || operation.decisions.length >= 128) return;
    operation.decisions.push({ totalTokens: null, hardThresholdTokens: null, effectiveThresholdTokens: null,
      projectedPruneTokens: null, retainTokens: null, retainedTokens: null, removedTokens: null,
      safetyOverride: false, ...fact, reason: fact.reason.slice(0, 512) });
  }

  private tokens(session: Session): number | null {
    try { const n = this.ctx.get('tokenMeter')?.measure(session).totalTokens; return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null; } catch { return null; }
  }

  async operation<T>(session: Session, trigger: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const current = this.operations.getStore();
    if (current?.sessionId === session.id) return run();
    const operation: Operation = { operationId: randomUUID(), sessionId: session.id, trigger, calls: [], attempts: [], decisions: [] };
    const preTokens = this.tokens(session);
    const startEventSeq = session.snapshotEvents().at(-1)?.seq ?? -1;
    const generation = session.surface.replaceGeneration;
    let status = 'success';
    return this.operations.run(operation, async () => {
      this.log({ event: 'cache-first-compaction/operation', operationId: operation.operationId, sessionId: operation.sessionId, trigger });
      try { return await run(); }
      catch (error) { status = signal?.aborted || operation.attempts.some(attempt => attempt.status === 'cancelled') ? 'cancelled' : 'error'; throw error; }
      finally {
        const { calls, attempts } = operation;
        const knownUsageCalls = calls.filter(call => fields.every(key => call.usage[key] !== null)).length;
        const unknownSummaryAttempts = attempts.filter(attempt => attempt.llmStreamCall !== true && !calls.some(call => call.summaryAttempt === attempt.index)).length;
        // Component sums are reported only if every observed call supplied that component.
        const knownTotals = Object.fromEntries(fields.map(key => [key, calls.some(call => call.usage[key] !== null)
          ? calls.reduce((sum, call) => sum + (call.usage[key] ?? 0), 0) : null]));
        const delta = session.snapshotEvents().filter(event => event.seq > startEventSeq);
        const summaryEventSeqs = delta.filter(event => event.type === 'compaction/summary').map(event => Number(event.seq));
        const compactionIds = [...new Set([...attempts.flatMap(a => a.compactionId ? [a.compactionId] : []),
          ...delta.flatMap(event => event.type === 'compaction/start' ? [String(event.data.compactionId)] : [])])];
        const result: CompactionTelemetryResult = { ...operation, status, preTokens, postTokens: this.tokens(session),
          summaryEventSeqs, compactionIds, startEventSeq,
          surfaceChanged: session.surface.replaceGeneration !== generation,
          summaryAttempts: attempts.length, llmStreamCalls: calls.length, unknownSummaryAttempts,
          // Public middleware precedes adapter selection; neither success nor usage proves a billed wire request.
          modelCalls: attempts.length === 0 && calls.length === 0 ? 0 : null,
          providerDispatch: attempts.length === 0 && calls.length === 0 ? 'none' : 'unknown',
          knownUsageCalls, unknownUsageCalls: calls.length - knownUsageCalls,
          usage: aggregateUsage(calls.map(call => call.usage), unknownSummaryAttempts), knownUsageTotals: knownTotals as Record<UsageField, number | null>,
        };
        this.log({ event: 'cache-first-compaction/result', ...result });
        // This is an operation boundary, never a session/event observer. A sink may
        // defer a summary-hook result while Basic still owns its transaction.
        try { await this.sink?.(session, result); } catch { /* diagnostics never affect execution */ }
      }
    });
  }

  async summary<T extends { provider: string; model: string; llmStreamCall?: true; usage?: TokenUsage }>(
    session: Session, signal: AbortSignal | undefined, run: () => Promise<T>,
  ): Promise<T> {
    return this.operation(session, 'summary-hook', signal, async () => {
      const operation = this.operations.getStore()!;
      const lastStart = [...session.snapshotEvents()].reverse().find(event => event.type === 'compaction/start' || event.type === 'compaction/end');
      const attempt: Attempt = { index: operation.attempts.length + 1,
        compactionId: lastStart?.type === 'compaction/start' ? lastStart.data.compactionId : null,
        status: 'success', llmStreamCall: null };
      operation.attempts.push(attempt);
      return this.summaries.run({ operation, attempt }, async () => {
        try {
          signal?.throwIfAborted();
          const result = await run();
          attempt.llmStreamCall = result.llmStreamCall === true ? true : null;
          if (result.llmStreamCall && !operation.calls.some(call => call.summaryAttempt === attempt.index)) {
            operation.calls.push({ callId: randomUUID(), summaryAttempt: attempt.index, provider: result.provider, model: result.model,
              evidence: 'summary-result', status: 'success', usage: observedUsage(result.usage) });
          }
          signal?.throwIfAborted();
          return result;
        } catch (error) { attempt.status = signal?.aborted ? 'cancelled' : 'error'; throw error; }
      });
    });
  }

  private log(record: unknown): void {
    // Observability must not turn successful compaction into failure if an exporter throws.
    try { this.logger.info(record); } catch { /* best effort */ }
  }
}
