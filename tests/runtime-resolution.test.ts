import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const script = fileURLToPath(new URL('../scripts/verify-host-peers.mjs', import.meta.url));

// Runtime identity is a process-wide Node property. Do not test it through
// Vitest's transformed module graph, nor install hooks in the test runner.
function probe(mode: 'peers' | 'dependencies') {
  const stdout = execFileSync(process.execPath, [script, '--mode', mode], {
    encoding: 'utf8', timeout: 30_000,
  });
  return JSON.parse(stdout.trim().split('\n').at(-1)!);
}

describe('published host resolution for linked external plugins', () => {
  it('keeps shared runtime contracts in peers plus development installs, never dependencies', () => {
    const runtimeContracts = [
      '@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-agent-preset-registry',
      '@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-compaction-tool-result-pruner', '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-token-meter', '@deepseek-ai/dsh-session-projection',
    ];
    expect(Object.keys(manifest.dependencies).filter(name => name.startsWith('@deepseek-ai/'))).toEqual([]);
    for (const name of runtimeContracts) {
      expect(manifest.peerDependencies[name], name).toEqual(expect.any(String));
      expect(manifest.devDependencies[name], name).toBe(manifest.peerDependencies[name]);
      expect(manifest.dependencies[name], name).toBeUndefined();
    }
  });

  it('public boot interception shadows a linked plugin local runtime with its host peer', () => {
    const result = probe('peers');
    expect(result.sameSession).toBe(true);
    expect(result.sameHelper).toBe(true);
    expect(result.events).toBe(1);
    expect(result.negativeControlError).toBeNull();
    expect(fileURLToPath(result.pluginEntry)).toBe(result.hostEntry);
    expect(result.actualCheckoutSessionDir).toBe(result.hostEntry.replace(/\/lib\/index\.js$/, ''));
  }, 35_000);

  it('negative control reproduces the private-brand failure when Session is a dependency', () => {
    const result = probe('dependencies');
    expect(result.sameSession).toBe(false);
    expect(result.sameHelper).toBe(false);
    expect(result.events).toBe(0);
    expect(result.negativeControlError).toMatch(/Receiver must be an instance of class Session/);
    expect(fileURLToPath(result.pluginEntry)).not.toBe(result.hostEntry);
  }, 35_000);
});
