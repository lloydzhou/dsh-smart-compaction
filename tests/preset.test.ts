import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import * as BasicCompaction from '@deepseek-ai/dsh-compaction-basic';
import { load } from 'js-yaml';
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import Loader, { EntryGroup, Group } from '@deepseek-ai/cordis-plugin-loader';
import { composeEntries, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot';
import AgentPresetRegistry, { type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import plugin, { CacheFirstCompactionEngine } from '../src/index.js';
import SmartPreset, { configuredStandard, integrationEnabled, transformStandard } from '../src/preset.js';

// Native declarative preset row lifecycle, using the real public registry.
class NativePreset extends Service {
  static [EntryGroup.key] = true;
  static inject = ['agentPresets'];
  constructor(ctx: Context, private definition: PresetDefinition) { super(ctx, 'fixtureNativePreset'); }
  async *[Service.init]() { yield this.ctx.agentPresets.register(this.definition); }
}

const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const definition: PresetDefinition = {
  id: 'standard', name: 'Operator standard', description: 'Keep my description', order: 41,
  plugins: [
    { id: 'custom', name: 'fixture:noop', config: { text: 'keep', deferred: { __jsExpr: '"later"' } } },
    { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { auto: false, maxTokens: 83, thresholdRatio: 0.71, retainTokens: { __jsExpr: '123' } } },
      { id: 'command-compact', name: 'fixture:noop' },
    ] },
  ],
};

async function fixture(overlays: ProfileContext['overlays'] = [], bundleEnabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'smart-preset-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home);
  const patchPath = join(root, 'cordis.patch.yml');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture-profile', private: true, dsh: { profile: { bundles: [] } } }));
  const stock = [{ id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: definition }];
  const patches = load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema }) as Parameters<typeof applyEntryPatches>[1];
  const source = JSON.stringify([{ insert: bundleEnabled ? applyEntryPatches(stock, patches, message => { throw new Error(message); }) : stock }]);
  await writeFile(patchPath, source);
  const profile: ProfileContext = { name: 'fixture', dir: root, patchPath, installAnchor: root, cwd: root, home, startedBundles: [], overlays, telemetryDisabledEnv: undefined };
  const ctx = new Context(); contexts.push(ctx);
  ctx.baseUrl = pathToFileURL(root).href + '/';
  ctx.provide('profileContext', profile);
  await ctx.plugin(Loader);
  ctx.loader.builtins.group = Group;
  await ctx.plugin(SessionProjections);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(TokenMeter);
  await ctx.plugin(AgentPresetRegistry, { default: 'standard' });
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    if (name === 'dsh-smart-compaction') return plugin;
    if (name === 'dsh-smart-compaction/preset') return SmartPreset;
    if (name === '@deepseek-ai/dsh-compaction-basic') return BasicCompaction;
    if (name === '@deepseek-ai/dsh-agent-preset') return NativePreset;
    if (name === 'fixture:noop') return { apply() {} };
    throw new Error(`Unexpected import ${name}`);
  } } as unknown as NonNullable<typeof ctx.loader.internal>;
  const rows = composeEntries([readProfilePatches('dsh', profile)]);
  await ctx.loader.root.update(rows);
  await ctx.loader.await();
  return { ctx, source, patchPath, profile };
}

describe('public standard integration', () => {
  it('changes only the Basic provider and preserves metadata, settings and deferred expressions', () => {
    const before = structuredClone(definition);
    const transformed = transformStandard(definition);
    expect(transformed).toEqual({ ...before, plugins: [before.plugins[0], { ...before.plugins[1], config: [
      { ...before.plugins[1]!.config[0], name: 'dsh-smart-compaction', config: { cacheFirst: true, adaptive: { mode: 'observe' }, base: before.plugins[1]!.config[0].config } },
      before.plugins[1]!.config[1],
    ] }] });
    expect(definition).toEqual(before);
    expect(EntryGroup.key in plugin).toBe(false);
    expect(EntryGroup.key in SmartPreset).toBe(false);
  });
  it('fails clearly for custom non-Basic or duplicate source providers', () => {
    expect(() => transformStandard({ ...definition, plugins: [] })).toThrow('custom/non-Basic');
    expect(() => transformStandard({ ...definition, plugins: [...definition.plugins, ...definition.plugins] })).toThrow('found 2');
    expect(() => configuredStandard([{ id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: definition }])).toThrow('must remain disabled');
  });
  it('rejects missing, duplicate, grouped and invalid marker states without guessing', () => {
    const marker = { id: 'smart-compaction-integration', name: 'dsh-smart-compaction', config: { integration: true } };
    expect(() => integrationEnabled([], {})).toThrow('exactly one');
    expect(() => integrationEnabled([marker, { ...marker, id: 'second' }], {})).toThrow('exactly one');
    expect(() => integrationEnabled([{ id: 'g', name: 'cordis:group', group: true, config: [marker] }], {})).toThrow('top-level');
    expect(() => integrationEnabled([{ ...marker, disabled: 'false' as never }], {})).toThrow('boolean or expression');
    expect(() => integrationEnabled([{ ...marker, disabled: { __jsExpr: 'missing.value' } as never }], {})).toThrow('cannot evaluate');
    expect(integrationEnabled([{ ...marker, disabled: { __jsExpr: 'off' } as never }], { off: false })).toBe(true);
  });
  it.each([true, { __jsExpr: 'true' }, { __jsExpr: 'profileContext.name === "fixture"' }])('root OFF at startup restores untouched native configuration: %j', async disabled => {
    const { ctx, source, patchPath } = await fixture([{ id: 'smart-compaction-integration', disabled } as never]);
    expect(await ctx.agentPresets.resolve()).toEqual({ id: 'standard' });
    expect(await ctx.agentPresets.resolve('smart-compaction')).toEqual({ id: 'smart-compaction' });
    for (const id of ['standard', 'smart-compaction']) {
      const doc = await ctx.agentPresets.readDocument(id);
      expect(doc.content).toContain('@deepseek-ai/dsh-compaction-basic');
      expect(doc.content).not.toContain('name: dsh-smart-compaction');
      expect(doc.content).toContain('maxTokens: 83');
      expect(doc.content).toContain('!!js');
    }
    expect(ctx.get('compaction')).toBeUndefined();
    expect(configuredStandard([{ id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', disabled: true, config: definition }], false)).toBe(definition);
    expect(await readFile(patchPath, 'utf8')).toBe(source);
    expect([...ctx.loader.entries()].find(row => row.options.id === 'smart-compaction-integration')!.fiber).toBeUndefined();
  });
  it.each([true, false])('cold startup binds the actual expected engine (enabled=%s)', async enabled => {
    const { ctx } = await fixture([{ id: 'smart-compaction-integration', disabled: !enabled }]);
    let engine: unknown;
    const binding = createScope(ctx, {});
    await ctx.agentPresets.mount(binding.ctx, 'standard');
    engine = ctx.agentPresets.serviceFor({ ctx: binding.ctx }, 'compaction');
    try {
      expect(engine).toBeInstanceOf(BasicCompaction.BasicCompactionEngine);
      expect(engine instanceof CacheFirstCompactionEngine).toBe(enabled);
      if (!enabled) {
        for (const method of ['compactNow', 'compactIfNeeded', 'compactRegion', 'summarize'] as const)
          expect(Object.getPrototypeOf(engine)[method]).toBe(BasicCompaction.BasicCompactionEngine.prototype[method]);
      }
    } finally { await binding.dispose(); }
  });
  it('root OFF preserves current overlay settings without requiring a Basic provider', async () => {
    const native = { ...definition, name: 'Native custom override', plugins: [{ id: 'custom', name: 'fixture:noop', config: { raw: { __jsExpr: '"deferred"' } } }] };
    const { ctx } = await fixture([{ id: 'preset-standard', config: native }, { id: 'smart-compaction-integration', disabled: true }]);
    const doc = await ctx.agentPresets.readDocument('standard');
    expect(doc.name).toBe(native.name);
    expect(doc.content).toContain('fixture:noop');
    expect(doc.content).toContain('!!js');
    expect(doc.content).not.toContain('dsh-smart-compaction');
  });
  it('disabled false expression keeps the smart branch enabled', async () => {
    const { ctx } = await fixture([{ id: 'smart-compaction-integration', disabled: { __jsExpr: 'false' } } as never]);
    expect((await ctx.agentPresets.readDocument('standard')).content).toContain('name: dsh-smart-compaction');
    expect([...ctx.loader.entries()].find(row => row.options.id === 'smart-compaction-integration')!.fiber).toBeDefined();
  });
  it('bundle absent restores the native default Basic registration without an alias', async () => {
    const { ctx, source, patchPath } = await fixture([], false);
    expect(await ctx.agentPresets.resolve()).toEqual({ id: 'standard' });
    expect((await ctx.agentPresets.list()).map(row => row.id)).toEqual(['standard']);
    expect((await ctx.agentPresets.readDocument('standard')).content).toContain('@deepseek-ai/dsh-compaction-basic');
    expect([...ctx.loader.entries()].some(row => row.options.name.startsWith('dsh-smart-compaction'))).toBe(false);
    expect(await readFile(patchPath, 'utf8')).toBe(source);
  });
  it('derives the effective launch overlay instead of a bundled snapshot', async () => {
    const overlaid = { ...definition, name: 'Launch override', plugins: definition.plugins.map(row => row.id === 'compaction' ? { ...row, config: row.config.map((child: { id: string }) => child.id === 'compaction-basic' ? { ...child, name: '@deepseek-ai/dsh-compaction-basic', config: { auto: false, maxTokens: 321 } } : child) } : row) };
    const { ctx } = await fixture([{ id: 'preset-standard', config: overlaid }]);
    const doc = await ctx.agentPresets.readDocument('standard');
    expect(doc.name).toBe('Launch override');
    expect(doc.content).toContain('maxTokens: 321');
    expect(doc.content).not.toContain('maxTokens: 83');
  });
  it('registers through the real Loader and registry without a global engine or profile edits', async () => {
    const { ctx, source, patchPath } = await fixture();
    expect(await ctx.agentPresets.resolve('standard')).toEqual({ id: 'standard' });
    expect(await ctx.agentPresets.resolve('smart-compaction')).toEqual({ id: 'smart-compaction' });
    expect(ctx.get('compaction')).toBeUndefined();
    const inventory = ctx.agentPresets.inspectCompositions();
    expect(inventory.map(row => row.id).sort()).toEqual(['smart-compaction', 'standard']);
    expect(inventory.every(row => row.leakedServices.length === 0)).toBe(true);
    const doc = await ctx.agentPresets.readDocument('standard');
    expect(doc.content).toContain('dsh-smart-compaction');
    expect(doc.content).toContain('maxTokens: 83');
    expect(doc.content).toContain('!!js');
    expect(doc.name).toBe(definition.name);
    expect(await readFile(patchPath, 'utf8')).toBe(source);
    await expect(ctx.agentPresets.register(transformStandard(definition))).rejects.toThrow('Duplicate agent preset: standard');
    // Resume resolves the recorded identity; registration never rewrites a header.
    const lease = await ctx.agentPresets.acquireScope('standard');
    await lease[Symbol.asyncDispose]();
    const integration = [...ctx.loader.entries()].find(row => row.options.id === 'smart-compaction-integration')!;
    await integration.fiber!.dispose();
    // Marker disposal is not a hot switch: adapter retains both registrations.
    expect((await ctx.agentPresets.list()).map(row => row.id).sort()).toEqual(['smart-compaction', 'standard']);
    const adapter = [...ctx.loader.entries()].find(row => row.options.id === 'smart-compaction-preset-adapter')!;
    await adapter.fiber!.dispose();
    expect(await ctx.agentPresets.list()).toEqual([]);
    await ctx.loader.create({ name: 'dsh-smart-compaction/preset' });
    await ctx.loader.await();
    expect(await ctx.agentPresets.resolve('standard')).toEqual({ id: 'standard' });
  }, 15000);
});
