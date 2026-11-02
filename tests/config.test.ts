import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import plugin, { apply, Config, resolveConfig, CacheFirstCompactionEngine } from '../src/index.js';

const contexts: Context[] = [];
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); });

describe('single plugin configuration matrix', () => {
  it('defaults to cache-first plus observation via schema and direct calls', () => {
    expect(resolveConfig()).toMatchObject({ cacheFirst: true, adaptive: { mode: 'observe' }, summaryFallbackAttempts: 2, maxCandidateChecks: 128 });
    expect(Config({})).toMatchObject({ cacheFirst: true, adaptive: { mode: 'observe' } });
    expect(plugin.apply).toBe(apply);
    expect(plugin.inject).toEqual([]);
    expect(Config({ integration: true })).toEqual({ integration: true });
  });
  it('root integration is only a marker and mounts no services or child plugins', async () => {
    const ctx = new Context(); contexts.push(ctx);
    const fiber = ctx.plugin(plugin, { integration: true });
    await fiber;
    expect(ctx.get('compaction')).toBeUndefined();
    expect(ctx.get('smartCompactionPreset')).toBeUndefined();
    expect(ctx.get('agentPresets')).toBeUndefined();
  });
  it.each(['off', 'observe', 'active'] as const)('accepts cache-first/%s', mode => {
    expect(resolveConfig({ cacheFirst: true, adaptive: { mode } }).adaptive.mode).toBe(mode);
    expect(Config({ cacheFirst: true, adaptive: { mode } })).toMatchObject({ adaptive: { mode } });
  });
  it('rejects mixed integration and engine options in schema and direct calls', () => {
    expect(() => Config({ integration: true, cacheFirst: true })).toThrow();
    expect(() => Config({ integration: false } as never)).toThrow();
  });
  it('accepts native/off', () => {
    expect(Config({ cacheFirst: false, adaptive: { mode: 'off' } })).toMatchObject({ cacheFirst: false, adaptive: { mode: 'off' } });
  });
  it.each(['observe', 'active', undefined] as const)('rejects native/%s before service registration', mode => {
    const input = { cacheFirst: false, ...(mode === undefined ? {} : { adaptive: { mode } }) };
    expect(() => resolveConfig(input)).toThrow('requires adaptive.mode: off');
    expect(() => Config(input)).toThrow();
    const ctx = new Context(); contexts.push(ctx);
    expect(() => apply(ctx, input)).toThrow('requires adaptive.mode: off');
    expect(ctx.get('compaction')).toBeUndefined();
  });
  it.each([
    { cacheFirst: 'false' }, { extra: true }, { adaptive: { mode: 'invalid' } },
    { adaptive: { extra: true } }, { summaryFallbackAttempts: -1 }, { maxCandidateChecks: 1 },
    { maxCandidateChecks: Infinity }, { adaptive: { prices: null } },
  ])('rejects invalid direct config %j', input => {
    expect(() => resolveConfig(input as never)).toThrow();
  });
  it('keeps the public executor usable independently with its existing base config', () => {
    const ctx = new Context(); contexts.push(ctx);
    const engine = new CacheFirstCompactionEngine(ctx, { base: { auto: false }, summaryFallbackAttempts: 0, maxCandidateChecks: 2 });
    expect(engine).toBeInstanceOf(BasicCompactionEngine);
  });
});
