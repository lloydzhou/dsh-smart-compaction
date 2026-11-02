import { describe, expect, it } from 'vitest';
import { snapshot, prices } from './fixtures.js';
import { Config, resolveConfig } from '../src/adaptive/config.js';
import { evaluatePolicy } from '../src/adaptive/economics.js';


describe('validated operator assumptions', () => {
  it('defaults to observe with labeled reference pricing and supports opt-out', () => {
    expect(resolveConfig().mode).toBe('observe');
    expect(Config({}).prices).toEqual([]);
    expect(Config({}).referencePriceFallback).toBe(true);
    expect(evaluatePolicy(snapshot).status).toBe('compact');
    expect(evaluatePolicy(snapshot, { referencePriceFallback: false }).status).toBe('missing-prices');
  });
  it.each([NaN, Infinity, -1])('rejects invalid price %s', value => {
    expect(() => resolveConfig({ prices: [{ ...prices[0]!, input: value }] })).toThrow();
  });
  it('rejects duplicate targets, fractional horizon, unknown keys and excessive work', () => {
    expect(() => resolveConfig({ prices: [prices[0]!, prices[0]!] })).toThrow();
    expect(() => resolveConfig({ expectedRemainingCalls: 1.5 })).toThrow();
    expect(() => Config({ maxCandidates: 100_000 })).toThrow();
    expect(() => resolveConfig({ extra: true } as never)).toThrow();
    expect(() => Config({ cacheHitRatio: 2 })).toThrow();
  });
});

describe('finite-horizon legal candidate economics', () => {
  it('selects a supplied candidate directly, not a line-based synthetic cut', () => {
    const result = evaluatePolicy(snapshot, { prices });
    expect(result.status).toBe('compact');
    expect(result.best?.candidate).toBe(snapshot.candidates[1]);
    expect(result.decision?.retainTokens).toBe(20_000);
    expect(result.decision!.thresholdTokens).toBeLessThan(snapshot.totalTokens);
  });
  it('accounts for summary output, rebuild, future inputs/output and additive write fees', () => {
    const result = evaluatePolicy(snapshot, { prices, expectedRemainingCalls: 3, expectedOutputTokensPerCall: 100, summaryInputOverheadTokens: 0, summaryFramingTokens: 0, cacheHitRatio: 0.5, rebuildCacheHitRatio: 0, cacheWriteFraction: 1 });
    const score = result.best!;
    expect(score.summaryInputCost).toBeCloseTo(0.08);
    expect(score.summaryOutputCost).toBeCloseTo(0.002);
    expect(score.cacheRebuildCost).toBeCloseTo(0.372);
    expect(score.futureInputCost).toBeCloseTo(0.403);
    expect(score.futureOutputCost).toBeCloseTo(0.006);
    expect(score.totalCost).toBeCloseTo(0.863);
    expect(result.baselineCost).toBeCloseTo(1.956);
  });
  it('models same-route replay cache but never cross-route hits or cached new instructions', () => {
    const same = { ...snapshot, summaryRoute: snapshot.route };
    const cold = evaluatePolicy(same, { prices, summaryInputOverheadTokens: 1000 });
    const warm = evaluatePolicy(same, { prices, summaryInputOverheadTokens: 1000, summaryCacheHitRatio: 1 });
    expect(cold.best!.summaryInputCost).toBeCloseTo(0.81);
    expect(warm.best!.summaryInputCost).toBeCloseTo(0.09);
    const cross = evaluatePolicy(snapshot, { prices, summaryCacheHitRatio: 1 });
    expect(cross.best!.summaryInputCost).toBe(evaluatePolicy(snapshot, { prices }).best!.summaryInputCost);
  });
  it('clamps expected summary to cap and accounts for replacement framing separately', () => {
    const low = evaluatePolicy(snapshot, { prices, expectedSummaryTokens: 500, summaryFramingTokens: 100 });
    expect(low.best!.summaryOutputCost).toBeCloseTo(0.001);
    expect(low.best!.projectedTokens).toBe(30600);
    const capped = evaluatePolicy(snapshot, { prices, expectedSummaryTokens: 2000, summaryFramingTokens: 0 });
    expect(capped.best!.summaryOutputCost).toBeCloseTo(0.002);
    expect(capped.best!.projectedTokens).toBe(31000);
    expect(evaluatePolicy({ ...snapshot, summaryMaxTokens: 65536 }, { prices }).status).toBe('compact');
  });
  it('short horizon and existing cheap cache can make waiting cheaper', () => {
    expect(evaluatePolicy(snapshot, { prices, expectedRemainingCalls: 1, cacheHitRatio: 1 }).status).toBe('defer');
    expect(evaluatePolicy(snapshot, { prices, expectedRemainingCalls: 100, cacheHitRatio: 1 }).status).toBe('compact');
  });
  it('optional subjective penalty can change how much history is retained', () => {
    const result = evaluatePolicy(snapshot, { prices, informationLossPerMillionTokens: 100 });
    expect(result.best?.candidate).toBe(snapshot.candidates[0]);
    expect(result.status).toBe('defer');
  });
  it('requires prices for the actual summary route and never matches partial routes', () => {
    expect(evaluatePolicy(snapshot, { prices: [prices[0]!], referencePriceFallback: false }).status).toBe('missing-prices');
    expect(evaluatePolicy({ ...snapshot, route: { provider: 'other', model: 'main' } }, { prices, referencePriceFallback: false }).status).toBe('missing-prices');
  });
  it('honors retention, pressure, budget and bounded candidate scanning', () => {
    expect(evaluatePolicy(snapshot, { prices, minRetainTokens: 50_000 }).status).toBe('no-candidate');
    expect(evaluatePolicy(snapshot, { prices, minPressureRatio: 0.9 }).status).toBe('below-pressure');
    expect(evaluatePolicy({ ...snapshot, trigger: 'context-overflow' }, { prices, minPressureRatio: 0.9 }).status).toBe('compact');
    expect(evaluatePolicy(snapshot, { prices, maxCandidates: 1 }).evaluatedCandidates).toBe(1);
  });
  it('never proposes retention at or above the executor decision threshold', () => {
    expect(evaluatePolicy({ ...snapshot, thresholdTokens: 20_000 }, { prices }).status).toBe('no-candidate');
    const result = evaluatePolicy({ ...snapshot, thresholdTokens: 30_000 }, { prices });
    expect(result.decision?.retainTokens).toBe(20_000);
    expect(result.decision!.retainTokens).toBeLessThan(result.decision!.thresholdTokens);
  });
  it('rejects non-finite snapshots and non-shrinking candidates', () => {
    expect(evaluatePolicy({ ...snapshot, totalTokens: NaN }, { prices }).status).toBe('invalid-snapshot');
    expect(evaluatePolicy({ ...snapshot, summaryMaxTokens: 80_000 }, { prices, expectedSummaryTokens: 80_000 }).status).toBe('no-candidate');
  });
  it('does not mutate snapshots or use usage as a universal cache-price prediction', () => {
    const before = structuredClone(snapshot);
    evaluatePolicy(Object.freeze(snapshot), { prices });
    expect(snapshot).toEqual(before);
    expect(evaluatePolicy(snapshot, { mode: 'off' }).status).toBe('off');
  });
});
