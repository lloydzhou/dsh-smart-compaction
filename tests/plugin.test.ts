import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../src/adaptive/policy.js';
import { snapshot, prices } from './fixtures.js';

const baseline = { thresholdTokens: 102400, retainTokens: 40000, reason: 'baseline' };
describe('policy-only middleware', () => {
  it('always calls downstream first and preserves it by default', () => {
    const ctx = new Context();
    apply(ctx, { prices });
    const next = vi.fn(() => baseline);
    expect(ctx.waterfall('cache-first/decide', snapshot, next)).toBe(baseline);
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('active overrides only after next and unknown prices preserve the baseline', () => {
    const ctx = new Context();
    const order: string[] = [];
    apply(ctx, { mode: 'active', prices });
    const result = ctx.waterfall('cache-first/decide', snapshot, () => { order.push('next'); return baseline; });
    expect(order).toEqual(['next']);
    expect(result?.retainTokens).toBe(20000);
    const unknown = { ...snapshot, summaryRoute: { provider: 'unknown', model: 'unknown' } };
    expect(ctx.waterfall('cache-first/decide', unknown, () => baseline)).toBe(baseline);
  });
  it('active can decline optional work but has no executor safety authority', () => {
    const ctx = new Context();
    apply(ctx, { mode: 'active', prices, expectedRemainingCalls: 1, cacheHitRatio: 1 });
    expect(ctx.waterfall('cache-first/decide', snapshot, () => baseline)).toBeNull();
    expect(ctx.waterfall('cache-first/decide', { ...snapshot, trigger: 'context-overflow' }, () => baseline)).toBeNull();
    // A null proposal cannot disable executor-owned mandatory fallback.
  });
  it('logs numeric structured predictions without adding model context or lifecycle listeners', () => {
    const ctx = new Context();
    const on = vi.spyOn(ctx, 'on');
    const exportLog = vi.fn();
    ctx.logger.exporter({ export: exportLog });
    apply(ctx, { prices });
    expect(on.mock.calls.filter(([name]) => name === 'cache-first/decide')).toHaveLength(1);
    expect(on.mock.calls.some(([name]) => String(name).startsWith('agent/'))).toBe(false);
    const next = vi.fn(() => baseline);
    ctx.waterfall('cache-first/decide', snapshot, next);
    expect(exportLog).toHaveBeenCalledWith(expect.objectContaining({ args: [expect.objectContaining({
      event: 'adaptive-compaction/decision', mode: 'observe', decisionApplied: false,
      executorOwnsSafety: true, status: 'compact', retainedTokens: 20000,
    })] }));
    expect(next.mock.invocationCallOrder[0]).toBeLessThan(exportLog.mock.invocationCallOrder.at(-1)!);
  });
  it('off preserves the next result without pricing', () => {
    const ctx = new Context();
    apply(ctx, { mode: 'off' });
    expect(ctx.waterfall('cache-first/decide', snapshot, () => baseline)).toBe(baseline);
  });
});
