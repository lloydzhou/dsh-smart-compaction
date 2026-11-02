// Offline, isolated proof of public DSH linked-package resolution.
// Default: local published packages. For the desktop host, run with
// ELECTRON_RUN_AS_NODE=1 '<app>/Contents/MacOS/DeepSeek Harness' this-script
//   --host-anchor '<app>/Contents/Resources/app.asar/dsh/package.json'
//   --mode peers (or dependencies for the negative control).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const mode = option('--mode', 'peers');
assert.ok(['peers', 'dependencies'].includes(mode));
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-host-peers-')));
// Retain the exact mkdtemp fixture for inspection; never delete a computed path.
const home = join(root, 'home');
process.env.DSH_HOME = home;
const profileDir = join(home, 'profiles', 'isolated');
const linked = join(root, 'linked-plugin');
mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
mkdirSync(linked);
const runtimeName = '@deepseek-ai/dsh-session';
const runtimeRange = manifest.peerDependencies[runtimeName];
assert.ok(runtimeRange, 'dsh-session must be a peer');
const fixtureManifest = { ...manifest, name: 'linked-peer-probe', exports: './index.mjs',
  dependencies: { ...manifest.dependencies }, peerDependencies: { ...manifest.peerDependencies } };
if (mode === 'dependencies') {
  fixtureManifest.dependencies[runtimeName] = runtimeRange;
  delete fixtureManifest.peerDependencies[runtimeName];
}
writeFileSync(join(linked, 'package.json'), JSON.stringify(fixtureManifest));
symlinkSync(join(repo, 'node_modules'), join(linked, 'node_modules'), 'dir');
writeFileSync(join(linked, 'index.mjs'), `export { Session, appendPluginRecord } from '@deepseek-ai/dsh-session';\nexport const resolved = import.meta.resolve('@deepseek-ai/dsh-session');\n`);
symlinkSync(linked, join(profileDir, 'node_modules', 'linked-peer-probe'), 'dir');
// Also register the actual checkout as a linked package: packageOf below checks
// its peer mapping, independently of the probe's copied manifest.
symlinkSync(repo, join(profileDir, 'node_modules', manifest.name), 'dir');
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'isolated-profile', private: true,
  dependencies: { 'linked-peer-probe': `file:${linked}`, [manifest.name]: `file:${repo}` } }));
const configPath = join(profileDir, 'cordis.yml');
writeFileSync(configPath, '[]\n');
let installAnchor = option('--host-anchor', undefined);
const localRequire = createRequire(join(repo, 'package.json'));
if (!installAnchor) {
  // A distinct physical host Session (even at the same version) makes identity
  // assertions meaningful without needing another install or any network.
  const host = join(root, 'host');
  mkdirSync(join(host, 'node_modules', '@deepseek-ai'), { recursive: true });
  const localSessionEntry = localRequire.resolve(runtimeName);
  const sessionDir = dirname(dirname(localSessionEntry));
  const hostSession = join(host, 'node_modules', '@deepseek-ai', 'dsh-session');
  mkdirSync(join(hostSession, 'lib'), { recursive: true });
  writeFileSync(join(hostSession, 'package.json'), readFileSync(join(sessionDir, 'package.json')));
  writeFileSync(join(hostSession, 'lib', 'index.js'), readFileSync(localSessionEntry));
  symlinkSync(join(repo, 'node_modules'), join(hostSession, 'node_modules'), 'dir');
  installAnchor = join(host, 'package.json');
  writeFileSync(installAnchor, JSON.stringify({ name: 'isolated-host', dependencies: { [runtimeName]: runtimeRange } }));
}
installAnchor = resolve(installAnchor);
const hostRequire = createRequire(installAnchor);
const bootEntry = option('--host-anchor', undefined)
  ? hostRequire.resolve('@deepseek-ai/dsh-app-boot') : localRequire.resolve('@deepseek-ai/dsh-app-boot');
const { boot, createRuntimeResolution, PluginPackages } = await import(pathToFileURL(bootEntry).href);
const hostEntry = hostRequire.resolve(runtimeName);
const hostSession = await import(pathToFileURL(hostEntry).href);
const profile = { name: 'isolated', dir: profileDir, layers: [], patchPath: join(profileDir, 'cordis.patch.yml'), patches: [], skippedBundles: [] };
const resolution = await createRuntimeResolution({ installAnchor, profile, home });
assert.ok(resolution.linkedRoots.some(item => item.realPath === linked));
const ctx = await boot('peer-proof', configPath, [], async context => {
  await context.plugin(PluginPackages, { resolution });
});
try {
  const probe = await import(pathToFileURL(join(profileDir, 'node_modules', 'linked-peer-probe', 'index.mjs')).href);
  const sameSession = probe.Session === hostSession.Session;
  const sameHelper = probe.appendPluginRecord === hostSession.appendPluginRecord;
  const session = hostSession.Session.create(hostSession.SessionId('offline-peer-proof'));
  let error;
  try { probe.appendPluginRecord(session, 'plugin:smart-compaction/diagnostic', { offline: true }); }
  catch (cause) { error = cause; }
  const actualCheckoutPackage = ctx.pluginPackages.packageOf(runtimeName, pathToFileURL(join(repo, 'lib', 'diagnostics.js')).href);
  let actualSinkRecords = null;
  if (mode === 'peers' && option('--host-anchor', undefined)) {
    const { CompactionTelemetry } = await import(pathToFileURL(join(repo, 'lib', 'telemetry.js')).href);
    const { createDiagnosticSink, diagnosticProjection } = await import(pathToFileURL(join(repo, 'lib', 'diagnostics.js')).href);
    const owned = hostSession.Session.create(hostSession.SessionId('offline-actual-sink'));
    const failures = [];
    const telemetry = new CompactionTelemetry(ctx, createDiagnosticSink(reason => failures.push(reason)));
    await telemetry.operation(owned, 'manual', undefined, async () => {
      telemetry.recordDecision({ action: 'skip', reason: 'offline verification: no model request' });
    });
    assert.deepEqual(failures, []);
    const event = owned.snapshotEvents().at(-1);
    assert.equal(event?.type, 'plugin:smart-compaction/diagnostic');
    const state = diagnosticProjection.apply({ schemaVersion: 1, sessionId: String(owned.id), records: [] }, event);
    actualSinkRecords = state.records.length;
    assert.equal(actualSinkRecords, 1);
    assert.equal(state.records[0].trigger, 'manual');
    assert.equal(state.records[0].result.llmStreamCalls, 0);
  }
  if (mode === 'peers') {
    assert.equal(sameSession, true);
    assert.equal(sameHelper, true);
    assert.equal(error, undefined);
    assert.equal(session.snapshotEvents().length, 1);
    assert.equal(session.snapshotEvents()[0].ignorable, true);
    assert.equal(realpathSync(actualCheckoutPackage.dir), realpathSync(dirname(dirname(hostEntry))));
  } else {
    assert.equal(sameSession, false);
    assert.equal(sameHelper, false);
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /private|brand|class/i);
    assert.equal(session.snapshotEvents().length, 0);
  }
  console.log(JSON.stringify({ mode, fixture: root, hostEntry, pluginEntry: probe.resolved,
    sameSession, sameHelper, actualSinkRecords, events: session.snapshotEvents().length,
    actualCheckoutSessionDir: actualCheckoutPackage.dir,
    negativeControlError: error?.message ?? null }));
} finally {
  await ctx.fiber.dispose();
}
