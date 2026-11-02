/** Experimental, ignorable diagnostics; never part of the model-visible surface. */
import type { Context } from '@deepseek-ai/cordis';
import { appendPluginRecord, pluginRecordOf, type Session } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import { z } from 'zod';
import type { CompactionResultSink, CompactionTelemetryResult } from './telemetry.js';

export const DIAGNOSTIC_RECORD_TYPE = 'plugin:smart-compaction/diagnostic' as const;
export const MAX_DIAGNOSTIC_RECORDS = 64;
const count = z.number().finite().nonnegative();
const maybeCount = count.nullable();
const text = z.string().max(512);
const usage = z.object({ inputTokens: maybeCount, outputTokens: maybeCount, cacheReadTokens: maybeCount,
  cacheWriteTokens: maybeCount, totalTokens: maybeCount.optional(), promptTokens: maybeCount, cacheHitRatio: z.number().min(0).max(1).nullable() });
const decision = z.object({ action: z.enum(['policy', 'prune', 'summary', 'skip']), reason: text,
  totalTokens: maybeCount, hardThresholdTokens: maybeCount, effectiveThresholdTokens: maybeCount,
  projectedPruneTokens: maybeCount, retainTokens: maybeCount, retainedTokens: maybeCount,
  removedTokens: maybeCount, safetyOverride: z.boolean() });
const resultSchema = z.object({ operationId: text, sessionId: text, trigger: text, status: text,
  calls: z.array(z.object({ callId: text, summaryAttempt: count.int(), provider: text, model: text,
    evidence: z.enum(['llm/stream', 'summary-result']), status: text, usage })).max(128),
  attempts: z.array(z.object({ index: count.int(), compactionId: text.nullable(),
    status: z.enum(['success', 'error', 'cancelled']), llmStreamCall: z.boolean().nullable() })).max(128),
  decisions: z.array(decision).max(128), surfaceChanged: z.boolean(), preTokens: maybeCount, postTokens: maybeCount,
  summaryEventSeqs: z.array(count.int()).max(128), compactionIds: z.array(text).max(128),
  startEventSeq: z.number().int().min(-1), summaryAttempts: count.int(), llmStreamCalls: count.int(),
  unknownSummaryAttempts: count.int(), modelCalls: z.literal(0).nullable(), providerDispatch: z.enum(['none', 'unknown']),
  knownUsageCalls: count.int(), unknownUsageCalls: count.int(), usage,
  knownUsageTotals: z.object({ inputTokens: maybeCount, outputTokens: maybeCount, cacheReadTokens: maybeCount, cacheWriteTokens: maybeCount }),
});
export const diagnosticRecordSchema = z.object({ schemaVersion: z.literal(1), sessionId: text, operationId: text,
  summaryEventSeqs: z.array(count.int()).max(128), compactionIds: z.array(text).max(128), trigger: text, status: text,
  decisions: z.array(decision).max(128), result: resultSchema });
export type DiagnosticRecord = z.infer<typeof diagnosticRecordSchema>;
export const diagnosticStateSchema = z.object({ schemaVersion: z.literal(1), sessionId: text, records: z.array(diagnosticRecordSchema).max(MAX_DIAGNOSTIC_RECORDS) });
export type DiagnosticState = z.infer<typeof diagnosticStateSchema>;

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:smart-compaction/diagnostic': DiagnosticRecord }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { smartCompaction: DiagnosticState }
  interface SessionProjectionStateMap { smartCompaction: DiagnosticState }
}

export const diagnosticProjection = {
  key: 'smartCompaction', stateVersion: 1, stateSchema: diagnosticStateSchema,
  init: header => ({ schemaVersion: 1, sessionId: String(header.id), records: [] }),
  apply(state, event) {
    const record = pluginRecordOf(event);
    if (record?.type !== DIAGNOSTIC_RECORD_TYPE) return state;
    const parsed = diagnosticRecordSchema.safeParse(record.data);
    if (!parsed.success || parsed.data.sessionId !== state.sessionId) return state;
    return { ...state, records: [...state.records.filter(item => item.operationId !== parsed.data.operationId), parsed.data].slice(-MAX_DIAGNOSTIC_RECORDS) };
  },
  wire: { viewSchema: diagnosticStateSchema, view: state => state },
} satisfies ProjectionDefinition<'smartCompaction'>;

/** Pending summary-hook results are flushed only at a later completed operation.
 * No timer or session/event write can interleave the summary/prune replacement pair.
 * If no later boundary occurs, the native summary remains the UI fallback. */
export type DiagnosticFailure = 'invalid-record' | 'append-failed';

export function createDiagnosticSink(onFailure?: (reason: DiagnosticFailure) => void): CompactionResultSink {
  const pending = new WeakMap<Session, CompactionTelemetryResult[]>();
  const reported = new Set<DiagnosticFailure>();
  const report = (reason: DiagnosticFailure) => {
    if (reported.has(reason)) return;
    reported.add(reason);
    // Never expose exception text, transcript, usage payloads, or credentials.
    try { onFailure?.(reason); } catch { /* optional reporting is fail-soft too */ }
  };
  return (session, result) => {
    try {
      const meaningful = result.surfaceChanged || result.summaryAttempts > 0 || result.status !== 'success'
        || result.decisions.some(fact => fact.action === 'skip');
      const queue = [...(pending.get(session) ?? []), ...(meaningful ? [result] : [])].slice(-MAX_DIAGNOSTIC_RECORDS);
      const events = session.snapshotEvents();
      const lastBoundary = [...events].reverse().find(e => e.type === 'compaction/start' || e.type === 'compaction/end' || e.type === 'session/end-seed');
      if (lastBoundary?.type === 'compaction/start') { pending.set(session, queue); return; }
      pending.delete(session);
      for (const item of queue) {
        // Late correlation uses transaction identity, never time/proximity alone.
        const summaries = events.filter(e => e.type === 'compaction/summary' && item.compactionIds.includes(String(e.data.compactionId)));
        const summaryEventSeqs = [...new Set([...item.summaryEventSeqs, ...summaries.map(e => Number(e.seq))])];
        const linked = { ...item, summaryEventSeqs };
        const parsed = diagnosticRecordSchema.safeParse({ schemaVersion: 1, sessionId: item.sessionId,
          operationId: item.operationId, summaryEventSeqs, compactionIds: item.compactionIds,
          trigger: item.trigger, status: item.status, decisions: item.decisions, result: linked });
        if (parsed.success) appendPluginRecord(session, DIAGNOSTIC_RECORD_TYPE, parsed.data);
        else report('invalid-record');
      }
    } catch { report('append-failed'); /* diagnostics never affect execution */ }
  };
}

export function registerDiagnostics(ctx: Context): CompactionResultSink {
  ctx.sessionProjections.register(diagnosticProjection);
  return createDiagnosticSink(reason => {
    ctx.logger('smart-compaction').warn({ event: 'smart-compaction/diagnostic-unavailable', reason });
  });
}
