/** Pure host/client usage normalization. DSH input/cache components are disjoint. */
export const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
export type ObservedUsage = Record<typeof usageFields[number], number | null> & {
  /** Optional for schema-v1 records written before total preservation. */
  totalTokens?: number | null;
  promptTokens: number | null;
  cacheHitRatio: number | null;
};
export function observedUsage(usage?: Partial<Record<typeof usageFields[number] | 'totalTokens', number | null>>): ObservedUsage {
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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

/** Sum known per-call prompt denominators, never average per-call percentages.
 * An unobserved attempt or one missing denominator makes the aggregate unknown. */
export function aggregateUsage(calls: readonly ObservedUsage[], unknownAttempts = 0): ObservedUsage {
  const sum = (key: typeof usageFields[number] | 'totalTokens' | 'promptTokens') => {
    if (!calls.length || unknownAttempts || calls.some(call => call[key] == null)) return null;
    const value = calls.reduce((n, call) => n + call[key]!, 0);
    return Number.isSafeInteger(value) ? value : null;
  };
  const result = Object.fromEntries(usageFields.map(key => [key, sum(key)])) as Record<typeof usageFields[number], number | null>;
  const prompt = sum('promptTokens');
  const total = prompt !== null && result.outputTokens !== null && Number.isSafeInteger(prompt + result.outputTokens)
    ? prompt + result.outputTokens : sum('totalTokens');
  const normalized = observedUsage({ ...result, totalTokens: total });
  // Do not resurrect a denominator when an individual call was contradictory.
  return { ...normalized, promptTokens: prompt === null ? null : normalized.promptTokens,
    cacheHitRatio: prompt === null ? null : normalized.cacheHitRatio };
}
