import { describe, expect, it } from 'vitest';
import { Config, resolveConfig } from '../src/adaptive/config.js';
import { evaluatePolicy } from '../src/adaptive/economics.js';
import { DEEPSEEK_REFERENCE, resolveRoutePrice, resolveRoutePricing } from '../src/adaptive/pricing.js';
import { prices, snapshot } from './fixtures.js';

describe('normalized route pricing', () => {
  it('defaults to the pinned peak USD per-million reference, not actual route prices', () => {
    const fact = resolveRoutePrice(snapshot.route);
    expect(fact).toEqual({
      route: snapshot.route, source: 'reference-fallback', currency: 'USD', unit: 'perMillionTokens',
      rates: { input: 0.30, cacheRead: 0.006, output: 1.20, cacheWrite: 0 },
      reference: DEEPSEEK_REFERENCE, missing: 'public-model-pricing-unavailable',
    });
    expect(fact.reference).toMatchObject({ model: 'DeepSeek V4.1 Flash', version: 'DeepSeek-V4.1-Flash-1017',
      apiModel: 'deepseek-flash', period: 'peak', date: '2026-11-02',
      url: 'https://api-docs.deepseek.com/quick_start/pricing/', versionUrl: 'https://api-docs.deepseek.com/news/news261017/' });
    expect(evaluatePolicy(snapshot).baselineCost).toBeCloseTo(8 * 100_000 * 0.30 / 1_000_000);
  });
  it('zero cache-write premium does not make uncached input free', () => {
    const result = evaluatePolicy(snapshot, { cacheWriteFraction: 1 });
    expect(result.baselineCost).toBeCloseTo(0.24);
    expect(result.best!.summaryInputCost).toBeGreaterThan(0);
    expect(evaluatePolicy(snapshot, { cacheHitRatio: 1 }).baselineCost).toBeCloseTo(0.0048);
  });
  it('uses exact provider AND model overrides, never aliases or partial matches', () => {
    expect(resolveRoutePrice(snapshot.route, { prices })).toMatchObject({ source: 'legacy-config', currency: 'unspecified',
      rates: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 }, reference: null, missing: null });
    for (const route of [{ provider: 'other', model: 'main' }, { provider: 'test', model: 'MAIN' }, { provider: 'test', model: ' main' }]) {
      expect(resolveRoutePrice(route, { prices }).source).toBe('reference-fallback');
    }
  });
  it('resolves both routes independently rather than guessing summary pricing', () => {
    const result = resolveRoutePricing(snapshot.route, snapshot.summaryRoute, { prices: [prices[0]!], legacyPriceCurrency: 'USD' });
    expect(result.compatible).toBe(true);
    expect(result.main.source).toBe('legacy-config');
    expect(result.summary.source).toBe('reference-fallback');
    expect(result.summary.route).toEqual(snapshot.summaryRoute);
    expect(result.summary.rates!.input).toBe(0.30);
    expect(resolveRoutePricing(snapshot.route, snapshot.summaryRoute, { prices }).summary.rates!.input).toBe(1);
  });
  it('does not mix unknown or non-USD legacy currency with USD reference', () => {
    for (const legacyPriceCurrency of ['unspecified', 'EUR']) {
      const result = evaluatePolicy(snapshot, { prices: [prices[0]!], legacyPriceCurrency });
      expect(result.status).toBe('missing-prices');
      expect(result.pricing.reason).toBe('currency-mismatch');
      expect(result.baselineCost).toBeNull();
      expect(result.decision).toBeNull();
    }
    expect(evaluatePolicy(snapshot, { prices: [prices[0]!], legacyPriceCurrency: 'USD' }).status).toBe('compact');
    expect(evaluatePolicy(snapshot, { prices, legacyPriceCurrency: 'EUR' }).status).toBe('compact');
    expect(evaluatePolicy(snapshot, { prices }).pricing.main.currency).toBe('unspecified');
  });
  it('can disable fallback, reporting missing public pricing on each unresolved route', () => {
    const result = resolveRoutePricing(snapshot.route, snapshot.summaryRoute, { referencePriceFallback: false });
    expect(result.reason).toBe('missing-route-prices');
    for (const fact of [result.main, result.summary]) expect(fact).toMatchObject({ source: null, currency: null,
      rates: null, reference: null, missing: 'public-model-pricing-unavailable' });
    const partial = resolveRoutePricing(snapshot.route, snapshot.summaryRoute, { prices: [prices[0]!], referencePriceFallback: false });
    expect(partial.main.source).toBe('legacy-config');
    expect(partial.summary.rates).toBeNull();
    expect(evaluatePolicy(snapshot, { prices, referencePriceFallback: false }).status).toBe('compact');
    expect(Config({ referencePriceFallback: false }).referencePriceFallback).toBe(false);
  });
  it('uses identical facts for the same route with and without an override', () => {
    for (const config of [{}, { prices }]) {
      const result = resolveRoutePricing(snapshot.route, snapshot.route, config);
      expect(result.compatible).toBe(true);
      expect(result.main).toEqual(result.summary);
    }
  });
  it('recognizes explicit all-zero prices as legitimate overrides', () => {
    const zero = prices.map(p => ({ ...p, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
    const result = evaluatePolicy(snapshot, { prices: zero });
    expect(result.status).toBe('defer');
    expect(result.baselineCost).toBe(0);
    expect(result.pricing.main.source).toBe('legacy-config');
    expect(result.pricing.summary.source).toBe('legacy-config');
  });
  it('is deterministic, detached, frozen and does not mutate caller input', () => {
    const route = { ...snapshot.route };
    const config = { prices: structuredClone(prices) };
    const before = structuredClone(config);
    const first = resolveRoutePrice(route, config);
    expect(resolveRoutePrice(route, config)).toEqual(first);
    expect(config).toEqual(before);
    route.model = 'changed'; config.prices[0]!.input = 99;
    expect(first.route.model).toBe('main'); expect(first.rates!.input).toBe(10);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.route)).toBe(true);
    expect(Object.isFrozen(first.rates)).toBe(true);
    expect(Object.isFrozen(DEEPSEEK_REFERENCE)).toBe(true);
  });
  it('validates fallback switches and explicit currency declarations', () => {
    expect(() => resolveConfig({ referencePriceFallback: 'yes' } as never)).toThrow();
    for (const legacyPriceCurrency of ['', 'usd', ' dollars ', 'US']) {
      expect(() => resolveConfig({ legacyPriceCurrency })).toThrow();
    }
    expect(Config({ legacyPriceCurrency: 'USD' }).legacyPriceCurrency).toBe('USD');
  });
});
