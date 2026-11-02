/** Pure host/client usage normalization. DSH input/cache components are disjoint. */
export const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
/** Bounded, primitive per-call evidence: no derived fields or recursive aggregates. */
export type UsageAggregationEvidence = Record<typeof usageFields[number], number | null> & {
  totalTokens?: number | null;
};
export type ObservedUsage = UsageAggregationEvidence & {
  promptTokens: number | null;
  cacheHitRatio: number | null;
  aggregation?: UsageAggregationEvidence[];
};
export const MAX_USAGE_AGGREGATION = 128;
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function observedUsage(usage?: Partial<UsageAggregationEvidence>): ObservedUsage {
  const result = Object.fromEntries(usageFields.map(key => [key, valid(usage?.[key]) ? usage![key] : null])) as Record<typeof usageFields[number], number | null>;
  const total = valid(usage?.totalTokens) ? usage.totalTokens : null;
  const parts = [result.inputTokens, result.cacheReadTokens, result.cacheWriteTokens];
  const knownSum = parts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const complete = parts.every(value => value !== null);
  let prompt: number | null = null;
  if (total !== null && result.outputTokens !== null) {
    const candidate = total - result.outputTokens;
    // Never prefer an inconsistent total, nor silently hide the contradiction
    // by falling back to component sums. Missing components are not fabricated.
    if (valid(candidate) && valid(knownSum) && candidate >= knownSum && (!complete || candidate === knownSum)) prompt = candidate;
  } else if (complete && valid(knownSum)) prompt = knownSum;
  return { ...result, ...(usage?.totalTokens === undefined ? {} : { totalTokens: total }),
    promptTokens: prompt, cacheHitRatio: prompt !== null && prompt > 0 && result.cacheReadTokens !== null ? result.cacheReadTokens / prompt : null };
}

function primitiveUsage(call: UsageAggregationEvidence): UsageAggregationEvidence {
  return { ...Object.fromEntries(usageFields.map(key => [key, call[key]])) as Record<typeof usageFields[number], number | null>,
    ...(call.totalTokens === undefined ? {} : { totalTokens: call.totalTokens }) };
}

/** Sum strictly reconstructed per-call denominators, never average percentages. */
function sumUsage(calls: readonly ObservedUsage[], unknownAttempts = 0): ObservedUsage {
  const sum = (key: typeof usageFields[number] | 'totalTokens' | 'promptTokens') => {
    if (!calls.length || unknownAttempts || calls.some(call => call[key] == null)) return null;
    const value = calls.reduce((n, call) => n + call[key]!, 0);
    return valid(value) ? value : null;
  };
  const result = Object.fromEntries(usageFields.map(key => [key, sum(key)])) as Record<typeof usageFields[number], number | null>;
  const prompt = sum('promptTokens');
  const total = prompt !== null && result.outputTokens !== null && valid(prompt + result.outputTokens)
    ? prompt + result.outputTokens : sum('totalTokens');
  return { ...result, totalTokens: total, promptTokens: prompt,
    cacheHitRatio: prompt !== null && prompt > 0 && result.cacheReadTokens !== null ? result.cacheReadTokens / prompt : null };
}

/** An unobserved attempt or one missing denominator makes the aggregate unknown.
 * Evidence preserves per-call contradictions even when their arithmetic cancels,
 * and known denominators when incomplete aggregate counters cannot express them. */
export function aggregateUsage(calls: readonly ObservedUsage[], unknownAttempts = 0): ObservedUsage {
  const normalizedCalls = calls.map(call => observedUsage(call));
  const result = sumUsage(normalizedCalls, unknownAttempts);
  if (unknownAttempts || !calls.length) return result;
  if (calls.length <= MAX_USAGE_AGGREGATION) return { ...result, aggregation: normalizedCalls.map(primitiveUsage) };
  // Never truncate evidence: a prefix would not prove operation-wide totals.
  // Beyond the bound retain only aggregates safely expressible without evidence.
  const normalized = observedUsage(result);
  return normalized.promptTokens === result.promptTokens && normalized.cacheHitRatio === result.cacheHitRatio
    ? result : sumUsage([], 1);
}

function dataObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).every(key => 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}

/** Validate a persisted/public usage object and return a fresh canonical copy.
 * Aggregate evidence is checked one call at a time, never recursively and never
 * by trusting a saved denominator/ratio. Call-count matching belongs to the caller. */
export function expectedObservedUsage(value: unknown): ObservedUsage | null {
  try {
    if (!dataObject(value)) return null;
    for (const key of [...usageFields, 'promptTokens'] as const)
      if (value[key] !== null && !valid(value[key])) return null;
    if (value.totalTokens !== undefined && value.totalTokens !== null && !valid(value.totalTokens)) return null;
    const raw = value as ObservedUsage;
    let expected: ObservedUsage;
    if (value.aggregation !== undefined) {
      const evidence = value.aggregation;
      if (!Array.isArray(evidence) || !evidence.length || evidence.length > MAX_USAGE_AGGREGATION
        || Object.getPrototypeOf(evidence) !== Array.prototype
        || Reflect.ownKeys(evidence).some(key => (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)))
          || !('value' in Object.getOwnPropertyDescriptor(evidence, key)!))) return null;
      const calls: ObservedUsage[] = [];
      for (const entry of evidence) {
        if (!dataObject(entry) || Reflect.ownKeys(entry).some(key => typeof key !== 'string'
          || !(usageFields as readonly string[]).includes(key) && key !== 'totalTokens')) return null;
        for (const key of usageFields) if (entry[key] !== null && !valid(entry[key])) return null;
        if (entry.totalTokens !== undefined && entry.totalTokens !== null && !valid(entry.totalTokens)) return null;
        calls.push(observedUsage(entry as UsageAggregationEvidence));
      }
      expected = { ...sumUsage(calls), aggregation: calls.map(primitiveUsage) };
    } else expected = observedUsage(raw);
    for (const key of [...usageFields, 'totalTokens', 'promptTokens', 'cacheHitRatio'] as const)
      if (raw[key] !== expected[key]) return null;
    return expected;
  } catch { return null; }
}
