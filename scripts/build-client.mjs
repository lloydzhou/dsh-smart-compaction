import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
// Explicit browser externals resolve against the host's ModuleLoader registry.
// This bundles plugin code only: never React or another copy of UI services.
const external = ['react', '@deepseek-ai/dsh-client-ui-primitives'];
const result = await build({
  absWorkingDir: fileURLToPath(root), entryPoints: ['client/index.ts'], bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', write: false, external,
  metafile: true, legalComments: 'inline',
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const item of output.imports) if (!external.includes(item.path)) throw new Error(`Unexpected client runtime import: ${item.path}`);
}
const source = result.outputFiles[0].text;
const wrapped = `window.__ModuleLoader__.load({id:'dsh-smart-compaction',factory:(hostRequire)=>{const module={exports:{}};const exports=module.exports;const require=hostRequire;\n${source}\nreturn module.exports;}});\n`;
await mkdir(new URL('../client/dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../client/dist/client.js', import.meta.url), wrapped);
console.log('Built client/dist/client.js (host React/UI externals; no runtime npm imports)');
