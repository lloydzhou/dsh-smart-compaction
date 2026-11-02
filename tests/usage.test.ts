import { describe, expect, it } from 'vitest';
import { observedUsage, aggregateUsage } from '../src/usage.js';
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
  it('rejects malformed counts and sum overflow', () => {
    expect(observedUsage({ inputTokens: NaN, outputTokens: 0, totalTokens: Infinity, cacheReadTokens: -1 }).cacheHitRatio).toBeNull();
    expect(observedUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 }).promptTokens).toBeNull();
  });
});
