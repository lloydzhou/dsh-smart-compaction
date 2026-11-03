/** Public profile integration: replace only the configured standard Basic provider. */
import { Context, Service } from '@deepseek-ai/cordis';
import { evaluate, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import { composeEntries, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import type { Volatile } from '@deepseek-ai/cordis';
import { ADAPTIVE_MODES, type AdaptiveMode } from './live.js';
import { entryListProblem, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';

export interface IntegrationConfig {
  integration: true;
  /** Cache-first engine (default) or the native one; live through the settings form. */
  cacheFirst?: boolean | Volatile<boolean>;
  /** Adaptive economics mode (default observe); ignored while cacheFirst is false. */
  adaptiveMode?: AdaptiveMode | Volatile<AdaptiveMode>;
}
const INTEGRATION_KEYS = ['integration', 'cacheFirst', 'adaptiveMode'];
/** Validate the raw marker row exactly as written in the profile patch. */
export function assertIntegrationRow(config: unknown): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('integration marker requires { integration: true }');
  const row = config as Record<string, unknown>;
  if (row['integration'] !== true) throw new TypeError('integration marker requires { integration: true }');
  if (Object.keys(row).some(key => !INTEGRATION_KEYS.includes(key))) throw new TypeError('integration accepts only integration, cacheFirst and adaptiveMode');
  if (row['cacheFirst'] !== undefined && typeof row['cacheFirst'] !== 'boolean') throw new TypeError('cacheFirst must be a boolean');
  if (row['adaptiveMode'] !== undefined && !ADAPTIVE_MODES.includes(row['adaptiveMode'] as AdaptiveMode)) throw new TypeError('adaptiveMode must be off, observe or active');
}

/** Startup values of the two switches, read from the raw marker row. */
export function integrationStartup(rows: readonly EntryOptions[]): { cacheFirst: boolean; mode: AdaptiveMode } {
  const raw = (rows.find(row => row.id === 'smart-compaction-integration')?.config ?? {}) as Record<string, unknown>;
  const cacheFirst = raw['cacheFirst'] !== false;
  const mode = ADAPTIVE_MODES.includes(raw['adaptiveMode'] as AdaptiveMode) ? raw['adaptiveMode'] as AdaptiveMode : 'observe';
  return { cacheFirst, mode: cacheFirst ? mode : 'off' };
}

/** Copy only ancestors of the replaced provider; all other fields/expressions survive. */
export function transformStandard(definition: PresetDefinition, startup: { cacheFirst: boolean; mode: AdaptiveMode } = { cacheFirst: true, mode: 'observe' }): PresetDefinition {
  const problem = entryListProblem(definition.plugins);
  if (problem) throw new Error(`smart-compaction: invalid standard preset: ${problem}`);
  let count = 0;
  const walk = (rows: PresetDefinition['plugins']): PresetDefinition['plugins'] => rows.map(row => {
    if (row.group === true) return { ...row, config: walk(row.config) };
    if (row.name !== '@deepseek-ai/dsh-compaction-basic') return row;
    count++;
    return { ...row, name: 'dsh-smart-compaction', config: {
      cacheFirst: startup.cacheFirst, adaptive: { mode: startup.mode },
      ...(row.config === undefined ? {} : { base: row.config }),
    } };
  });
  const plugins = walk(definition.plugins);
  if (count !== 1) throw new Error(`smart-compaction: standard must contain exactly one Basic compaction provider (found ${count}); custom/non-Basic compositions require explicit integration`);
  return { ...definition, plugins };
}

/** Resolve the one root marker at cold startup, never a running Agent's state. */
export function integrationEnabled(rows: readonly EntryOptions[], ctx: object): boolean {
  const matches: EntryOptions[] = [];
  const walk = (entries: readonly EntryOptions[], nested = false) => {
    for (const row of entries) {
      if (row.id === 'smart-compaction-integration' || row.name === 'dsh-smart-compaction') {
        if (nested) throw new Error('smart-compaction: integration marker must be a top-level row');
        matches.push(row);
      }
      if (row.group === true && Array.isArray(row.config)) walk(row.config, true);
    }
  };
  walk(rows);
  const marker = matches[0];
  if (matches.length !== 1 || !marker || marker.name !== 'dsh-smart-compaction' || marker.group) {
    throw new Error('smart-compaction: expected exactly one root integration marker');
  }
  assertIntegrationRow(marker.config);
  const disabled: unknown = marker.disabled;
  if (isJsExpr(disabled)) {
    if (typeof disabled.__jsExpr !== 'string') throw new Error('smart-compaction: invalid integration disabled expression');
    try { return !Boolean(evaluate(ctx, disabled.__jsExpr)); }
    catch (error) { throw new Error('smart-compaction: cannot evaluate integration disabled expression', { cause: error }); }
  }
  if (disabled != null && typeof disabled !== 'boolean') throw new Error('smart-compaction: integration disabled must be a boolean or expression');
  return !disabled;
}

export function configuredStandard(rows: readonly EntryOptions[], enabled = true): PresetDefinition {
  const matches = rows.filter(row => row.id === 'preset-standard');
  const row = matches[0];
  if (matches.length !== 1 || !row || row.name !== '@deepseek-ai/dsh-agent-preset' || row.config?.id !== 'standard') {
    throw new Error('smart-compaction: expected the configured preset-standard declaration with id standard');
  }
  if (row.disabled !== true) throw new Error('smart-compaction: preset-standard must remain disabled by the bundle; refusing duplicate standard registration');
  const problem = entryListProblem(row.config.plugins);
  if (problem) throw new Error(`smart-compaction: invalid standard preset: ${problem}`);
  return enabled ? transformStandard(row.config, integrationStartup(rows)) : row.config;
}

/** Native Service.init yield owns disposal without blocking its own registration scope. */
export default class SmartCompactionPreset extends Service {
  static inject = ['agentPresets', 'profileContext'];
  constructor(ctx: Context) { super(ctx, 'smartCompactionPreset'); }
  async *[Service.init]() {
    // Host-owned loading may clean retired bundle declarations exactly as normal boot does.
    // Never hand-write profiles, change session headers, or access private registry state.
    const rows = composeEntries([readProfilePatches('dsh', this.ctx.profileContext)]);
    // The bundle keeps this adapter alive when its discoverable root marker is OFF.
    // This is a startup snapshot: changing the switch requires a Web restart.
    const standard = configuredStandard(rows, integrationEnabled(rows, this.ctx));
    yield this.ctx.agentPresets.register(standard);
    // Compatibility for sessions created with the old opt-in identity, without a stale snapshot.
    yield this.ctx.agentPresets.register({ ...standard, id: 'smart-compaction', name: 'Smart compaction' });
  }
}
