import { describe, expect, it } from 'vitest';
import { observedUsage, aggregateUsage, expectedObservedUsage, MAX_USAGE_AGGREGATION } from '../src/usage.js';
import { parseDiagnostic } from '../client/model.js';

describe('optional provider cache counters', () => {
  it('uses actual total minus output without inventing cache writes', () => {
    const usage = observedUsage({ inputTokens: 6215, outputTokens: 3891, totalTokens: 16250, cacheReadTokens: 6144 });
    expect(usage).toMatchObject({ promptTokens: 12359, cacheWriteTokens: null, cacheHitRatio: 6144 / 12359, totalTokens: 16250 });
    const record = parseDiagnostic({ operationId: 'op', sessionId: 'session', summaryEventSeq: 1, trigger: 'manual', status: 'success', reasonCode: 'manual', summaryAttempts: 1, llmStreamCalls: 1, modelCalls: null, providerDispatch: 'unknown', unknownUsageCalls: 1, unknownSummaryAttempts: 0, usage });
    expect(record?.usage).toEqual(usage);
  });
  it('does not interpret omitted cache counters as zero', () => {
    expect(observedUsage({ inputTokens: 6215, outputTokens: 3891, cacheReadTokens: 6144 }).cacheHitRatio).toBeNull();
    expect(observedUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })).toMatchObject({ promptTokens: 100, cacheReadTokens: null, cacheWriteTokens: null, cacheHitRatio: null });
  });
  it('accepts explicit zero, complete components and zero prompt safely', () => {
    expect(observedUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }).cacheHitRatio).toBe(0);
    expect(observedUsage({ inputTokens: 0, outputTokens: 20, totalTokens: 20, cacheReadTokens: 0 }).cacheHitRatio).toBeNull();
    expect(observedUsage({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 70, cacheWriteTokens: 10 }).cacheHitRatio).toBe(.7);
  });
  it.each([80, 130])('rejects inconsistent totals %s rather than guessing', totalTokens => {
    expect(observedUsage({ inputTokens: 20, outputTokens: 10, totalTokens, cacheReadTokens: 70, cacheWriteTokens: 10 }).cacheHitRatio).toBeNull();
  });
  it('rejects total below known partial counters or output', () => {
    expect(observedUsage({ inputTokens: 50, outputTokens: 20, totalTokens: 60, cacheReadTokens: 40 }).promptTokens).toBeNull();
    expect(observedUsage({ outputTokens: 20, totalTokens: 10, cacheReadTokens: 1 }).promptTokens).toBeNull();
  });
  it('aggregates denominators across retries without averaging percentages', () => {
    const calls = [observedUsage({ inputTokens: 50, outputTokens: 10, totalTokens: 110, cacheReadTokens: 50 }),
      observedUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 0 })];
    const usage = aggregateUsage(calls);
    expect(usage).toMatchObject({ promptTokens: 1000, cacheReadTokens: 850, cacheWriteTokens: null, cacheHitRatio: .85, totalTokens: 1030 });
    expect(observedUsage(usage).cacheHitRatio).toBe(.85);
    expect(aggregateUsage(calls, 1).cacheHitRatio).toBeNull();
    expect(aggregateUsage([...calls, observedUsage({ inputTokens: 5, outputTokens: 1 })]).cacheHitRatio).toBeNull();
  });
  it('preserves known prompt sums with missing output and complementary missing components', () => {
    const calls = [
      observedUsage({ inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 }),
      observedUsage({ outputTokens: 10, totalTokens: 210, cacheReadTokens: 100 }),
    ];
    const usage = aggregateUsage(calls);
    expect(usage).toMatchObject({ inputTokens: null, outputTokens: null, cacheWriteTokens: null,
      totalTokens: null, promptTokens: 300, cacheReadTokens: 180, cacheHitRatio: .6 });
    expect(observedUsage(usage).promptTokens).toBeNull();
    expect(expectedObservedUsage(usage)).toEqual(usage);
    expect(usage.aggregation).toEqual([
      { inputTokens: 20, outputTokens: null, cacheReadTokens: 80, cacheWriteTokens: 0 },
      { inputTokens: null, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: null, totalTokens: 210 },
    ]);
  });
  it('retains per-call contradictions even when inconsistent totals cancel exactly', () => {
    const calls = [90, 130].map(totalTokens => observedUsage({ inputTokens: 20,
      outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0, totalTokens }));
    const usage = aggregateUsage(calls);
    expect(usage).toMatchObject({ totalTokens: 220, promptTokens: null, cacheHitRatio: null });
    expect(observedUsage(usage).cacheHitRatio).toBe(.8);
    expect(expectedObservedUsage(usage)).toEqual(usage);
    expect(expectedObservedUsage({ ...usage, promptTokens: 200, cacheHitRatio: .8 })).toBeNull();
  });
  it('does not trust caller supplied derived values in aggregation', () => {
    const usage = aggregateUsage([{ ...observedUsage({ cacheReadTokens: 50 }), promptTokens: 100, cacheHitRatio: .5 }]);
    expect(usage.promptTokens).toBeNull();
    expect(expectedObservedUsage(usage)).toEqual(usage);
  });
  it('omits evidence when unknown attempts suppress all totals', () => {
    const usage = aggregateUsage([observedUsage({ inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 })], 1);
    expect(usage).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null,
      cacheWriteTokens: null, totalTokens: null, promptTokens: null, cacheHitRatio: null });
    expect(expectedObservedUsage(usage)).toEqual(usage);
  });
  it('bounds evidence without truncating or resurrecting inconsistent totals', () => {
    const call = observedUsage({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0 });
    const atLimit = aggregateUsage(Array(MAX_USAGE_AGGREGATION).fill(call));
    expect(atLimit.aggregation).toHaveLength(MAX_USAGE_AGGREGATION);
    expect(expectedObservedUsage(atLimit)).toEqual(atLimit);
    const aboveLimit = aggregateUsage(Array(MAX_USAGE_AGGREGATION + 1).fill(call));
    expect(aboveLimit.aggregation).toBeUndefined();
    expect(expectedObservedUsage(aboveLimit)).toEqual(aboveLimit);
    const contradictory = [90, 130].map(totalTokens => observedUsage({ ...call, totalTokens }));
    const suppressed = aggregateUsage(Array.from({ length: 130 }, (_, index) => contradictory[index % 2]!));
    expect(suppressed.aggregation).toBeUndefined();
    expect(suppressed.promptTokens).toBeNull();
    expect(expectedObservedUsage(suppressed)).toEqual(suppressed);
  });
  it('rejects malformed, nested, overlong and forged aggregate evidence', () => {
    const usage = aggregateUsage([observedUsage({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0 })]);
    const entry = usage.aggregation![0]!;
    for (const aggregation of [[], [null], new Array(1), Array(MAX_USAGE_AGGREGATION + 1).fill(entry),
      [{ ...entry, aggregation: [] }], [{ ...entry, promptTokens: 100 }], [{ ...entry, cacheReadTokens: -1 }],
      [{ ...entry, inputTokens: undefined }]]) {
      expect(expectedObservedUsage({ ...usage, aggregation })).toBeNull();
    }
    for (const field of ['inputTokens', 'totalTokens', 'promptTokens', 'cacheHitRatio']) {
      expect(expectedObservedUsage({ ...usage, [field]: 1 })).toBeNull();
    }
    let touched = false;
    const accessor = Object.defineProperty({ ...entry }, 'inputTokens', { get() { touched = true; return 20; } });
    expect(expectedObservedUsage({ ...usage, aggregation: [accessor] })).toBeNull();
    expect(touched).toBe(false);
    expect(expectedObservedUsage(observedUsage({ inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }))).not.toBeNull();
  });
  it('rejects malformed counts and sum overflow', () => {
    expect(observedUsage({ inputTokens: NaN, outputTokens: 0, totalTokens: Infinity, cacheReadTokens: -1 }).cacheHitRatio).toBeNull();
    expect(observedUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 }).promptTokens).toBeNull();
  });
});
