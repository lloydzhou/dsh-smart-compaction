/** Public profile integration: replace only the configured standard Basic provider. */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { evaluate, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import { composeEntries, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import { entryListProblem, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';

export interface IntegrationConfig { integration: true }
export const Config: z<IntegrationConfig> = z.transform(z.object({ integration: z.const(true).required() }), value => {
  if (Object.keys(value).some(key => key !== 'integration')) throw new TypeError('integration accepts only { integration: true }');
  return value as IntegrationConfig;
});

/** Copy only ancestors of the replaced provider; all other fields/expressions survive. */
export function transformStandard(definition: PresetDefinition): PresetDefinition {
  const problem = entryListProblem(definition.plugins);
  if (problem) throw new Error(`smart-compaction: invalid standard preset: ${problem}`);
  let count = 0;
  const walk = (rows: PresetDefinition['plugins']): PresetDefinition['plugins'] => rows.map(row => {
    if (row.group === true) return { ...row, config: walk(row.config) };
    if (row.name !== '@deepseek-ai/dsh-compaction-basic') return row;
    count++;
    return { ...row, name: 'dsh-smart-compaction', config: {
      cacheFirst: true, adaptive: { mode: 'observe' },
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
  Config(marker.config);
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
  return enabled ? transformStandard(row.config) : row.config;
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
