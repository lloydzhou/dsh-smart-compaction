/** Versioned, content-free host → browser projection. Never put prompts, summaries,
 * tool arguments/results, error messages, endpoints or credentials in this payload. */
import { observedUsage } from '../src/usage.js';
export const PROJECTION_KEY = 'smartCompaction' as const;
export const REASON_CODES = ['configured-policy', 'adaptive-benefit', 'context-overflow', 'manual', 'unknown'] as const;
export type ReasonCode = typeof REASON_CODES[number];
export interface DiagnosticUsage {
  totalTokens?: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  promptTokens: number | null;
  cacheHitRatio: number | null;
}
export interface CompactionDiagnostic {
  operationId: string;
  sessionId: string;
  summaryEventSeq: number;
  compactionId?: string;
  trigger: 'pressure' | 'context-overflow' | 'manual' | 'summary-hook' | 'unknown';
  status: 'success' | 'error' | 'cancelled';
  reasonCode: ReasonCode;
  /** Operation-wide counters, including retries, not just the landed summary. */
  summaryAttempts: number;
  llmStreamCalls: number;
  /** Middleware observation is NOT evidence of a billed wire request. */
  modelCalls: number | null;
  providerDispatch: 'none' | 'unknown';
  unknownUsageCalls: number;
  unknownSummaryAttempts: number;
  usage: DiagnosticUsage;
  /** Optional policy estimates; never describe these as measured savings. */
  beforeTokens?: number;
  afterTokens?: number;
  thresholdTokens?: number;
  retainTokens?: number;
  decisions?: readonly { action: DecisionFact['action']; reasonCode: string; safetyOverride: boolean; totalTokens: number | null; projectedPruneTokens: number | null; retainedTokens: number | null; removedTokens: number | null }[];
}
export interface SmartCompactionProjection {
  schemaVersion: 1;
  sessionId: string;
  records: readonly WireDiagnostic[];
}
export interface DecisionFact {
  action: 'policy' | 'prune' | 'summary' | 'skip'; reason: string;
  totalTokens: number | null; hardThresholdTokens: number | null; effectiveThresholdTokens: number | null;
  projectedPruneTokens: number | null; retainTokens: number | null; retainedTokens: number | null; removedTokens: number | null;
  safetyOverride: boolean;
}
/** Authoritative host wire: one operation may land multiple summaries. */
export interface WireDiagnostic {
  schemaVersion: 1; sessionId: string; operationId: string; summaryEventSeqs: number[];
  compactionIds: string[]; trigger: string; status: string; decisions: DecisionFact[];
  result: {
    operationId: string; sessionId: string; summaryEventSeqs: number[]; compactionIds: string[];
    trigger: string; status: string; summaryAttempts: number; llmStreamCalls: number;
    modelCalls: number | null; providerDispatch: 'none' | 'unknown'; unknownUsageCalls: number;
    unknownSummaryAttempts: number; usage: DiagnosticUsage; preTokens: number | null; postTokens: number | null;
  };
}
export interface NativeSummary {
  summary: string | null;
  summaryEventSeq: number | null;
  shadowedItemCount: number | null;
  shadowedTokenCount: number | null;
}
export type Translate = (key: string, values?: Record<string, string | number>) => string;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): value is T => typeof value === 'string' && choices.includes(value as T);
const counterKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'promptTokens'] as const;

/** Validate and copy ONLY the allowlisted presentation fields. The projection is
 * JSON on the wire; reject getters too so test/local injection cannot execute code. */
export function parseDiagnostic(value: unknown): CompactionDiagnostic | undefined {
  try {
    if (!object(value) || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d))) return;
    if (!id(value.operationId) || !id(value.sessionId) || !count(value.summaryEventSeq)) return;
    if (value.compactionId !== undefined && !id(value.compactionId)) return;
    if (!oneOf(value.trigger, ['pressure', 'context-overflow', 'manual', 'summary-hook', 'unknown'])
      || !oneOf(value.status, ['success', 'error', 'cancelled']) || !oneOf(value.reasonCode, REASON_CODES)
      || !oneOf(value.providerDispatch, ['none', 'unknown'])) return;
    for (const key of ['summaryAttempts', 'llmStreamCalls', 'unknownUsageCalls', 'unknownSummaryAttempts']) if (!count(value[key])) return;
    // Public stream middleware cannot prove billed model dispatch. Only no-work is known zero.
    if (value.modelCalls !== null && !(value.modelCalls === 0 && value.providerDispatch === 'none' && value.summaryAttempts === 0 && value.llmStreamCalls === 0)) return;
    if (value.providerDispatch === 'none' && (value.summaryAttempts !== 0 || value.llmStreamCalls !== 0)) return;
    if (!object(value.usage) || Object.values(Object.getOwnPropertyDescriptors(value.usage)).some(d => !('value' in d))) return;
    const usage = {} as DiagnosticUsage;
    for (const key of counterKeys) {
      if (value.usage[key] !== null && !count(value.usage[key])) return;
      usage[key] = value.usage[key] as number | null;
    }
    const ratio = value.usage.cacheHitRatio;
    if (ratio !== null && (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)) return;
    if (value.usage.totalTokens !== undefined) {
      if (value.usage.totalTokens !== null && !count(value.usage.totalTokens)) return;
      usage.totalTokens = value.usage.totalTokens as number | null;
    }
    // Same evidence rules as the backend; schema-v1 without total remains valid.
    const normalized = observedUsage(usage);
    if (usage.promptTokens !== normalized.promptTokens) return;
    const expectedRatio = normalized.cacheHitRatio;
    if (ratio !== expectedRatio) return;
    usage.cacheHitRatio = expectedRatio;
    const result: CompactionDiagnostic = {
      operationId: value.operationId, sessionId: value.sessionId, summaryEventSeq: value.summaryEventSeq,
      ...(value.compactionId === undefined ? {} : { compactionId: value.compactionId as string }),
      trigger: value.trigger, status: value.status, reasonCode: value.reasonCode,
      summaryAttempts: value.summaryAttempts as number, llmStreamCalls: value.llmStreamCalls as number,
      modelCalls: value.modelCalls as number | null, providerDispatch: value.providerDispatch,
      unknownUsageCalls: value.unknownUsageCalls as number, unknownSummaryAttempts: value.unknownSummaryAttempts as number, usage,
    };
    for (const key of ['beforeTokens', 'afterTokens', 'thresholdTokens', 'retainTokens'] as const) {
      if (value[key] !== undefined) { if (!count(value[key])) return; result[key] = value[key]; }
    }
    return result;
  } catch { return; }
}

/** Sanitize nested operation records into the small presentation model. No free
 * text (provider, model, reason, errors, contents) crosses this boundary. */
export function parseWireDiagnostic(value: unknown, summaryEventSeq: number): CompactionDiagnostic | undefined {
  try {
    const safeObject = (v: unknown): v is Record<string, unknown> => object(v) && Object.values(Object.getOwnPropertyDescriptors(v)).every(d => 'value' in d);
    if (!safeObject(value) || value.schemaVersion !== 1 || !safeObject(value.result)) return;
    if (!Array.isArray(value.summaryEventSeqs) || value.summaryEventSeqs.length > 128 || !value.summaryEventSeqs.every(count)
      || !value.summaryEventSeqs.includes(summaryEventSeq) || !Array.isArray(value.compactionIds)
      || value.compactionIds.length > 128 || !value.compactionIds.every(id)) return;
    const result = value.result;
    if (result.operationId !== value.operationId || result.sessionId !== value.sessionId || result.status !== value.status || result.trigger !== value.trigger) return;
    if (!Array.isArray(result.summaryEventSeqs) || !result.summaryEventSeqs.includes(summaryEventSeq)) return;
    if (!Array.isArray(value.decisions) || value.decisions.length > 128) return;
    let policy: Record<string, unknown> | undefined;
    for (const fact of value.decisions) {
      if (!safeObject(fact) || !oneOf(fact.action, ['policy', 'prune', 'summary', 'skip'])
        || typeof fact.reason !== 'string' || fact.reason.length > 512 || typeof fact.safetyOverride !== 'boolean') return;
      for (const key of ['totalTokens', 'hardThresholdTokens', 'effectiveThresholdTokens', 'projectedPruneTokens', 'retainTokens', 'retainedTokens', 'removedTokens'])
        if (fact[key] !== null && !count(fact[key])) return;
      if (fact.action === 'policy') policy = fact;
    }
    const reasonCode: ReasonCode = value.trigger === 'context-overflow' ? 'context-overflow' : value.trigger === 'manual' ? 'manual'
      : policy?.reason === 'configured policy' ? 'configured-policy'
      : policy?.reason === 'adaptive: positive estimated finite-horizon net benefit; heuristic, not guaranteed savings' ? 'adaptive-benefit' : 'unknown';
    const parsed = parseDiagnostic({
      operationId: value.operationId, sessionId: value.sessionId, summaryEventSeq,
      trigger: oneOf(value.trigger, ['pressure', 'context-overflow', 'manual', 'summary-hook']) ? value.trigger : 'unknown',
      status: value.status, reasonCode, summaryAttempts: result.summaryAttempts, llmStreamCalls: result.llmStreamCalls,
      modelCalls: result.modelCalls, providerDispatch: result.providerDispatch, unknownUsageCalls: result.unknownUsageCalls,
      unknownSummaryAttempts: result.unknownSummaryAttempts, usage: result.usage,
      ...(result.preTokens == null ? {} : { beforeTokens: result.preTokens }),
      ...(result.postTokens == null ? {} : { afterTokens: result.postTokens }),
      ...(policy?.effectiveThresholdTokens == null ? {} : { thresholdTokens: policy.effectiveThresholdTokens }),
      ...(policy?.retainTokens == null ? {} : { retainTokens: policy.retainTokens }),
    });
    if (!parsed) return;
    const reasonCodes: Record<string, string> = {
      'configured policy': 'configured-policy',
      'adaptive: positive estimated finite-horizon net benefit; heuristic, not guaranteed savings': 'adaptive-benefit',
      'explicit manual compaction; automatic pressure policy bypassed': 'manual',
      'policy declined optional work; executor owns hard-limit safety': 'safety',
      'pruner unavailable': 'pruner-unavailable',
      'projected prune is useful; execute': 'prune-useful',
      'prune cannot reduce measured tokens': 'prune-no-reduction',
      'prune alone cannot reach effective threshold; preserve prefix for summary': 'prune-insufficient',
      'no balanced range satisfies retention': 'no-range',
      'summary overflow: retry smaller balanced prefix': 'retry-smaller',
      'prune insufficient: summarize selected balanced prefix': 'summary-prefix',
    };
    parsed.decisions = value.decisions.map((fact: DecisionFact) => ({ action: fact.action,
      reasonCode: Object.hasOwn(reasonCodes, fact.reason) ? reasonCodes[fact.reason]! : 'unknown',
      safetyOverride: fact.safetyOverride, totalTokens: fact.totalTokens, projectedPruneTokens: fact.projectedPruneTokens,
      retainedTokens: fact.retainedTokens, removedTokens: fact.removedTokens }));
    return parsed;
  } catch { return; }
}

/** No latest-record or timing fallback: ambiguous/missing correlation stays native. */
export function matchDiagnostic(projection: unknown, sessionId: string, summaryEventSeq: number | null): CompactionDiagnostic | undefined {
  try {
    if (!count(summaryEventSeq) || !object(projection)
      || Object.values(Object.getOwnPropertyDescriptors(projection)).some(d => !('value' in d))
      || projection.schemaVersion !== 1 || projection.sessionId !== sessionId
      || !Array.isArray(projection.records) || projection.records.length > 64) return;
    let match: CompactionDiagnostic | undefined;
    for (const raw of projection.records) {
      const record = parseWireDiagnostic(raw, summaryEventSeq);
      if (record?.sessionId !== sessionId || record.summaryEventSeq !== summaryEventSeq) continue;
      if (match) return; // even identical duplicates are not authoritative
      match = record;
    }
    return match;
  } catch { return; }
}

/** Matches the host chat's formatTokens algorithm (not publicly exported).
 * Keep locale-owned K/M labels and rounding identical; never import private paths. */
export function formatTokens(value: number, t: Translate): string {
  const scaled = (candidate: number) => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1000) return String(value);
  if (value < 1000000) return t('number.thousand', { value: scaled(value / 1000) });
  return t('number.million', { value: scaled(value / 1000000) });
}
export function nativeSummaryLabel(node: NativeSummary, t: Translate): string {
  if (node.shadowedItemCount !== null && node.shadowedTokenCount !== null)
    return t('completed', { items: node.shadowedItemCount, tokens: formatTokens(node.shadowedTokenCount, t) });
  return t(node.summary !== null ? 'expand' : 'unavailable');
}
export function collapsedFacts(record: CompactionDiagnostic | undefined, t: Translate): string {
  if (!record) return '';
  return [t('inlineCalls', { calls: record.llmStreamCalls }),
    t('inlineCache', { ratio: record.usage.cacheHitRatio === null ? t('unknown') : `${(record.usage.cacheHitRatio * 100).toFixed(0)}%` })].join(' · ');
}
export function diagnosticRows(record: CompactionDiagnostic, t: Translate): readonly { label: string; value: string }[] {
  const number = (value: number | null | undefined) => value == null ? t('unknown') : String(value);
  return [
    { label: t('reason'), value: t(`reason.${record.reasonCode}`) },
    { label: t('trigger'), value: t(`trigger.${record.trigger}`) },
    { label: t('status'), value: t(`status.${record.status}`) },
    ...(['beforeTokens', 'afterTokens', 'thresholdTokens', 'retainTokens'] as const).filter(key => record[key] !== undefined).map(key => ({ label: t(key), value: number(record[key]) })),
    { label: t('summaryAttempts'), value: number(record.summaryAttempts) },
    { label: t('llmStreamCalls'), value: number(record.llmStreamCalls) },
    { label: t('modelCalls'), value: number(record.modelCalls) },
    { label: t('unknownUsageCalls'), value: number(record.unknownUsageCalls) },
    { label: t('unknownSummaryAttempts'), value: number(record.unknownSummaryAttempts) },
    ...counterKeys.map(key => ({ label: t(key), value: number(record.usage[key]) })),
    { label: t('cacheHitRatio'), value: record.usage.cacheHitRatio === null ? t('unknown') : `${(record.usage.cacheHitRatio * 100).toFixed(1)}%` },
    ...(record.decisions ?? []).flatMap((fact, index) => [
      { label: `${index + 1}. ${t(`action.${fact.action}`)}`, value: t(`reason.${fact.reasonCode}`) },
      ...(fact.safetyOverride ? [{ label: t('safetyOverride'), value: t('yes') }] : []),
      ...(['totalTokens', 'projectedPruneTokens', 'retainedTokens', 'removedTokens'] as const)
        .filter(key => fact[key] !== null).map(key => ({ label: t(key), value: number(fact[key]) })),
    ]),
  ];
}
