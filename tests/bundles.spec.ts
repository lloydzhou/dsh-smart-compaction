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
describe('standard integration bundle', () => {
  it('disables only native registration and inserts startup plumbing plus discoverable marker', async () => {
    const stock: EntryOptions = { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard', plugins: [{ id: 'user-tool', name: 'my-custom-tool' }] } };
    const custom: EntryOptions = { id: 'preset-custom', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'custom', plugins: [] } };
    const before = structuredClone(stock);
    const warnings: string[] = [];
    const rows = applyEntryPatches([stock, custom], await bundle(), message => warnings.push(message));
    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ ...before, disabled: true });
    expect(rows[1]).toEqual(custom);
    expect(rows[2]).toEqual({ id: 'smart-compaction-preset-adapter', name: 'dsh-smart-compaction/preset' });
    expect(rows[3]).toEqual({ id: 'smart-compaction-integration', name: 'dsh-smart-compaction', config: { integration: true } });
    // Without this bundle's patch there is no disabled override or adapter/marker.
    expect(applyEntryPatches([stock, custom], [], message => warnings.push(message))).toEqual([before, custom]);
  });

  it('root manifest declares a minimum host API and compatible dependency ranges', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.name).toBe('dsh-smart-compaction');
    expect(manifest.private).toBeUndefined();
    expect(manifest.workspaces).toBeUndefined();
    const supported = '^0.2.1-rc.3';
    expect(manifest.version).toBe('0.2.1-rc.1');
    expect(manifest.engines.dsh).toBe('>=0.2.1-rc.3');
    for (const section of ['dependencies', 'devDependencies']) {
      for (const [name, range] of Object.entries(manifest[section])) {
        if (name.startsWith('@deepseek-ai/dsh-')) expect(range, name).toBe(supported);
      }
    }
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml');
    expect(manifest.files).toContain('cordis.patch.yml');
    expect(JSON.stringify(manifest)).not.toContain('workspace:');
    expect(Object.keys(manifest.dependencies).every(name => name.startsWith('@deepseek-ai/') || name === 'zod')).toBe(true);
  });
});
