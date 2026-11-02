// Copy this script into a clean npm installation; it imports only installed exports.
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import Sessions, { SessionSeq } from '@deepseek-ai/dsh-session';
import Projection from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import plugin, { CacheFirstCompactionEngine, Config } from 'dsh-smart-compaction';
import { evaluatePolicy } from 'dsh-smart-compaction/economics';
import 'dsh-smart-compaction/policy';

const installed = fileURLToPath(import.meta.resolve('dsh-smart-compaction'));
assert.equal(await realpath(installed), installed, 'packed entry must not be a workspace symlink');
assert(installed.startsWith(process.cwd() + '/node_modules/'));
const expectedDsh = process.env.EXPECT_DSH_VERSION;
assert(['0.2.1-rc.3', '0.2.1-rc.5'].includes(expectedDsh), 'set EXPECT_DSH_VERSION to the exact host release');
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const dshPackages = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/@deepseek-ai\/dsh-[^/]+$/.test(path));
assert(dshPackages.length > 0);
for (const [path, info] of dshPackages) {
  assert.equal(info.version, expectedDsh, `${path} must use the host release, not a hidden newer backend`);
  assert(path.startsWith('node_modules/@deepseek-ai/dsh-'), `${path} must be deduplicated`);
}
const hostRequire = createRequire(import.meta.url);
const pluginRequire = createRequire(installed);
const manifest = JSON.parse(await readFile(hostRequire.resolve('dsh-smart-compaction/package.json'), 'utf8'));
assert.equal(manifest.version, '0.2.1-rc.1');
for (const name of Object.keys(manifest.dependencies)) {
  assert.equal(await realpath(pluginRequire.resolve(name)), await realpath(hostRequire.resolve(name)), `${name} must share the host runtime module`);
}
console.log(`PASS host ${expectedDsh}: ${dshPackages.length} DSH packages, no nested copies, shared runtime modules`);
assert.equal(Config({}).adaptive.mode, 'observe');
const snapshot = {
  totalTokens: 1000, surfaceTokens: 900, fixedTokens: 100,
  contextWindow: 20000, thresholdTokens: 16000, defaultRetainTokens: 100,
  summaryMaxTokens: 80, trigger: 'pressure', route: { provider: 'smoke', model: 'test' },
  summaryRoute: { provider: 'smoke', model: 'test' }, history: { userTurns: 2, modelCalls: 1, compactionCount: 0 },
  candidates: [{ start: SessionSeq(1), end: SessionSeq(2), removedTokens: 700, retainedTokens: 200 }],
};
assert.equal(evaluatePolicy(snapshot, { referencePriceFallback: false }).status, 'missing-prices');
assert.equal(evaluatePolicy(snapshot).pricing.main.source, 'reference-fallback');
assert.equal(evaluatePolicy(snapshot).pricing.main.currency, 'USD');
const client = await readFile(hostRequire.resolve('dsh-smart-compaction/client'), 'utf8');
assert(client.includes('__ModuleLoader__'));
assert(client.includes('dsh-smart-compaction'));
for (const [config, native, mode] of [
  [undefined, false, 'observe'],
  [{ cacheFirst: true, adaptive: { mode: 'off' } }, false, 'off'],
  [{ cacheFirst: true, adaptive: { mode: 'active' } }, false, 'active'],
  [{ cacheFirst: false, adaptive: { mode: 'off' } }, true, 'off'],
]) {
  const ctx = new Context();
  const logs = [];
  ctx.logger.exporter({ export(record) { for (const arg of record.args) if (arg?.event === 'adaptive-compaction/decision') logs.push(arg); } });
  try {
    await ctx.plugin(Loader);
    await ctx.plugin(Projection);
    await ctx.plugin(Sessions);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(TokenMeter);
    ctx.loader.internal = { version: 'v2', async import(name) { return import(name); } };
    const id = await ctx.loader.create({ name: 'dsh-smart-compaction', ...(config ? { config } : {}) });
    await ctx.loader.await();
    const entry = [...ctx.loader.entries()].find(entry => entry.id === id);
    assert(entry?.fiber, 'Loader must activate the packed default plugin');
    assert(ctx.compaction instanceof BasicCompactionEngine);
    assert.equal(ctx.compaction instanceof CacheFirstCompactionEngine, !native);
    if (native) assert.equal(Object.getPrototypeOf(ctx.compaction), BasicCompactionEngine.prototype);
    assert.equal([...ctx.loader.entries()].filter(e => e.options.name === 'dsh-smart-compaction').length, 1);
    const baseline = { thresholdTokens: 16000, retainTokens: 100, reason: 'smoke' };
    assert.equal(ctx.waterfall('cache-first/decide', snapshot, () => baseline), mode === 'active' ? null : baseline);
    assert.equal(logs.length, mode === 'off' ? 0 : 1);
    await entry.fiber.dispose();
    assert.equal(ctx.get('compaction'), undefined);
    ctx.waterfall('cache-first/decide', snapshot, () => baseline);
    assert.equal(logs.length, mode === 'off' ? 0 : 1);
    await ctx.plugin(plugin, config);
    ctx.waterfall('cache-first/decide', snapshot, () => baseline);
    assert.equal(logs.length, mode === 'off' ? 0 : 2);
    console.log(`PASS packed activation cacheFirst=${!native} adaptive=${mode}, dispose/reload clean`);
  } finally { await ctx.fiber.dispose(); }
}
console.log('PASS isolated packed exports and all supported activation modes');
