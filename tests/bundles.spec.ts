import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader';

interface PresetRow extends EntryOptions {
  config: { id: string; name: string; plugins: EntryOptions[] };
}
async function bundle() {
  return load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema }) as Array<{ insert: PresetRow[] }>;
}
function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : [])]);
}

describe('single additive bundle', () => {
  it.each(['standard', 'custom', 'minimal', 'operator-edited'])('leaves existing %s preset unchanged', async id => {
    const stock: EntryOptions = { id: `preset-${id}`, name: '@deepseek-ai/dsh-agent-preset', config: { id, plugins: [{ id: 'user-tool', name: 'my-custom-tool' }] } };
    const warnings: string[] = [];
    const rows = applyEntryPatches([stock], await bundle(), message => warnings.push(message));
    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(stock);
    const row = rows[1] as PresetRow;
    const plugins = flatten(row.config.plugins);
    const providers = plugins.filter(item => item.name === 'dsh-smart-compaction');
    expect(providers).toHaveLength(1);
    expect(providers[0]!.config).toEqual({ cacheFirst: true, adaptive: { mode: 'observe' } });
    expect(plugins.some(item => item.name === '@deepseek-ai/dsh-compaction-basic')).toBe(false);
    expect(plugins.filter(item => item.name === '@deepseek-ai/dsh-command-compact')).toHaveLength(1);
    expect(plugins.filter(item => item.name === '@deepseek-ai/dsh-compaction-tool-result-pruner')).toHaveLength(1);
    expect(row.config.plugins.find(item => item.id === 'compaction')).toMatchObject({ group: true, isolate: { compaction: true, toolResultPruner: true } });
  });

  it('root manifest is the only publishable project with exact runtime compatibility', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.name).toBe('dsh-smart-compaction');
    expect(manifest.private).toBeUndefined();
    expect(manifest.workspaces).toBeUndefined();
    expect(manifest.engines.dsh).toBe('0.2.1-rc.5');
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml');
    expect(manifest.files).toContain('cordis.patch.yml');
    expect(JSON.stringify(manifest)).not.toContain('workspace:');
    expect(Object.keys(manifest.dependencies).every(name => name.startsWith('@deepseek-ai/'))).toBe(true);
  });
});
