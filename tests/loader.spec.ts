import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Include from '@deepseek-ai/cordis-plugin-include';
import LlmRuntime, { LlmAdapter, createUserMessage, createAssistantMessage, createToolResultMessage, createSystemMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolsService from '@deepseek-ai/dsh-tools';
import CacheFirstPlugin, * as CacheFirst from '../src/index.js';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { PolicyObservation } from '../src/index.js';

// The actual published services and actual source plugins are loaded by Loader;
// only the external model boundary is deterministic. No compaction methods or
// service registrations are mocked, and no host config/persistence is mounted.
class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  onRequest?: (request: GenerateOptions) => void;
  constructor(readonly contextWindow: number) { super(); }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: this.contextWindow } };
  }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    request.signal?.throwIfAborted();
    this.requests.push(request);
    this.onRequest?.(request);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Earlier work completed; retain the result.' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Earlier work completed; retain the result.' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const roots: string[] = [];
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  // Each path is the exact directory returned by mkdtemp, never a host workspace.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const CACHE = 'dsh-smart-compaction';
const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
  ['@deepseek-ai/dsh-token-meter', TokenMeter],
  ['@deepseek-ai/dsh-compaction-tool-result-pruner', ToolResultPruner],
  ['@deepseek-ai/dsh-agent', AgentRegistry],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolsService],
  ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  [CACHE, CacheFirstPlugin],
]);

async function loadYaml(options: { window?: number; mode?: 'off' | 'observe' | 'active'; cacheFirst?: boolean; pruneThreshold?: number; informationLossPenalty?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-external-compaction-loader-'));
  roots.push(root);
  const configPath = join(root, 'cordis.yml');
  const rows = [
    ...[...modules.keys()].filter(name => name !== CACHE && name !== '@deepseek-ai/dsh-compaction-tool-result-pruner').map(name => `- name: '${name}'`),
    "- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    '  config:', `    thresholdChars: ${options.pruneThreshold ?? 300}`, '    headChars: 30', '    tailChars: 30',
    `- name: '${CACHE}'`,
    '  config:', `    cacheFirst: ${options.cacheFirst ?? true}`, '    summaryFallbackAttempts: 1', '    base:', '      auto: false',
    '      thresholdRatio: 0.8', '      headroomTokens: 0', '      retainTokens: 1', '      maxTokens: 80', '      compactionRetries: 0',
    ...(options.mode ? [
      '    adaptive:', `      mode: ${options.mode}`,
      '      expectedRemainingCalls: 100', '      minPressureRatio: 0', '      minRetainTokens: 1',
      '      summaryInputOverheadTokens: 0', '      minNetBenefit: 0',
      `      informationLossPerMillionTokens: ${options.informationLossPenalty ?? 0}`,
      '      prices:', '        - provider: dummy', '          model: test',
      '          input: 10', '          output: 1', '          cacheRead: 0', '          cacheWrite: 0',
    ] : []),
  ];
  await writeFile(configPath, rows.join('\n') + '\n');
  const ctx = new Context();
  contexts.push(ctx);
  ctx.baseUrl = pathToFileURL(root).href + '/';
  const observations: PolicyObservation[] = [];
  ctx.logger.exporter({ export(record) {
    for (const arg of record.args) {
      if (arg && typeof arg === 'object' && 'event' in arg && arg.event === 'adaptive-compaction/decision') observations.push(arg as PolicyObservation);
    }
  } });
  await ctx.plugin(Loader);
  ctx.loader.builtins.include = Include;
  // Same Loader importer seam as upstream loader-composition.spec.ts: this
  // substitutes module resolution, not YAML parsing, injection or plugin setup.
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>;
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } });
  await ctx.loader.await();
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && !entry.fiber).map(entry => entry.options.name)).toEqual([]);
  const adapter = new RecordingAdapter(options.window ?? 2000);
  ctx.llm.registerAdapter(['dummy'], adapter);
  const agent = await ctx.agentLoop.create(SessionId('yaml-integration'), { provider: 'dummy', model: 'test' });
  expect(ctx.agents.get(agent.id)).toBe(agent);
  expect(ctx.compaction).toBeInstanceOf(options.cacheFirst === false ? BasicCompactionEngine : CacheFirst.CacheFirstCompactionEngine);
  expect([...ctx.loader.entries()].filter(entry => entry.options.name === CACHE)).toHaveLength(1);
  return { ctx, adapter, agent, observations };
}

const ORIGINAL = 'original-tool-head\n' + 'preserve-this-middle-evidence '.repeat(200) + '\noriginal-tool-tail';
function seedHistory(agent: Agent, oldText = 'older context '.repeat(250)) {
  const session = agent.session;
  session.append('turn/start', { turn: 1 });
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Fixture system prompt.') }, { surfaceOp: 'append' });
  session.append('request/header', { header: { config: { provider: 'dummy', model: 'test' } }, reason: 'initial' });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: oldText }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('step/start', { turn: 1, step: 1 });
  const callId = ToolCallId('fixture-read');
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'dummy', model: 'test' }, content: [{ type: 'tool-call', id: callId, name: 'read_fixture', arguments: '{}' }] }) }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'read_fixture', arguments: '{}' });
  const originalEvent = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: ORIGINAL }], isError: false }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  session.append('turn/start', { turn: 2 });
  const tail = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Keep this recent request verbatim.' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  return { session, originalEvent, tail };
}

function assertSummaryTransaction(session: Session, eventCountBefore: number) {
  const suffix = session.snapshotEvents().slice(eventCountBefore);
  expect(suffix.map(event => event.type)).toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
  const start = suffix[0]!;
  const summary = suffix[1]!;
  const replacement = suffix[2]!;
  const end = suffix[3]!;
  if (start.type !== 'compaction/start' || summary.type !== 'compaction/summary' || end.type !== 'compaction/end') throw new Error('Missing durable transaction');
  expect(summary.data.compactionId).toBe(start.data.compactionId);
  expect(end.data.compactionId).toBe(start.data.compactionId);
  expect(summary.data.llmStreamCall).toBe(true);
  expect(summary.data.rawOutput).toBeDefined();
  expect(replacement.surfaceOp).toEqual({ op: 'replace', startSeq: summary.data.shadowedRange.start, endSeq: summary.data.shadowedRange.end });
  expect(replacement.sourceEventSeqs).toEqual([start.seq, summary.seq, ...summary.data.shadowedSeqs]);
  expect(session.surface.nodes).toContain(replacement.seq);
  for (const seq of summary.data.shadowedSeqs) expect(session.surface.nodes).not.toContain(seq);
}

const signal = () => new AbortController().signal;
describe('published Loader + Include composition with external source plugins', () => {
  it('commits sufficient pruning without any summary request or compaction transaction', async () => {
    const { ctx, adapter, agent } = await loadYaml({ window: 1500 });
    const { session, originalEvent, tail } = seedHistory(agent, 'short old prompt');
    const before = ctx.tokenMeter.measure(session).totalTokens;
    const eventCount = session.snapshotEvents().length;
    expect(before).toBeGreaterThanOrEqual(1200);
    expect(await ctx.compaction.compactIfNeeded(agent, 'pressure', signal())).toBeNull();
    expect(adapter.requests).toHaveLength(0);
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(1200);
    expect(session.surface.replaceGeneration).toBe(1);
    expect(session.surface.nodes).not.toContain(originalEvent.seq);
    expect(session.surface.nodes).toContain(tail.seq);
    expect(session.eventAt(originalEvent.seq)).toEqual(originalEvent);
    expect(session.snapshotEvents().slice(eventCount).map(event => event.type)).toEqual(['compaction/prune', 'tool/result']);
  });

  it('passes original tool bytes to the real Basic summarizer when pruning is insufficient', async () => {
    const { ctx, adapter, agent } = await loadYaml({ window: 1000 });
    const { session, originalEvent, tail } = seedHistory(agent);
    const originalSurface = [...session.surface.nodes];
    const eventCount = session.snapshotEvents().length;
    adapter.onRequest = request => {
      expect(session.surface.nodes).toEqual(originalSurface);
      expect(session.surface.replaceGeneration).toBe(0);
      expect(request.messages.some(message => message.role === 'tool' && message.content.some(block => block.type === 'text' && block.text === ORIGINAL))).toBe(true);
    };
    const result = await ctx.compaction.compactIfNeeded(agent, 'pressure', signal());
    expect(result).not.toBeNull();
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]).toMatchObject({ provider: 'dummy', model: 'test', maxTokens: 80 });
    assertSummaryTransaction(session, eventCount);
    expect(session.surface.nodes).toContain(tail.seq);
    expect(session.eventAt(originalEvent.seq)).toEqual(originalEvent);
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(800);
  });

  it.each(['observe', 'active'] as const)('runs combined %s policy through the real executor, not a synthetic snapshot', async mode => {
    const { ctx, adapter, agent, observations } = await loadYaml({ window: 20000, mode, pruneThreshold: 100000 });
    const { session } = seedHistory(agent);
    const eventCount = session.snapshotEvents().length;
    const before = ctx.tokenMeter.measure(session).totalTokens;
    expect(before).toBeLessThan(16000);
    const result = await ctx.compaction.compactIfNeeded(agent, 'pressure', signal());
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ mode, status: 'compact', decisionApplied: mode === 'active', totalTokens: before, executorOwnsSafety: true });
    expect(observations[0]!.predictedNetBenefit).toBeGreaterThan(0);
    expect(JSON.stringify(observations)).not.toContain('preserve-this-middle-evidence');
    if (mode === 'observe') {
      expect(result).toBeNull();
      expect(adapter.requests).toHaveLength(0);
      expect(session.snapshotEvents()).toHaveLength(eventCount);
    } else {
      expect(result).not.toBeNull();
      expect(adapter.requests).toHaveLength(1);
      assertSummaryTransaction(session, eventCount);
    }
  });

  it.each(['pressure', 'context-overflow'] as const)('keeps mandatory %s recovery when active adaptive economics recommends deferring', async trigger => {
    const { ctx, agent, adapter, observations } = await loadYaml({ window: 1000, mode: 'active', informationLossPenalty: 1000000 });
    const { session } = seedHistory(agent);
    const eventCount = session.snapshotEvents().length;
    expect(await ctx.compaction.compactIfNeeded(agent, trigger, signal())).not.toBeNull();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ status: 'defer', decisionApplied: true, executorOwnsSafety: true });
    expect(adapter.requests).toHaveLength(1);
    assertSummaryTransaction(session, eventCount);
  });

  it('default combined config observes once and removes both backend and observer on dispose/reload', async () => {
    const { ctx, agent, observations } = await loadYaml({ window: 20000 });
    seedHistory(agent);
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === CACHE)!;
    await ctx.compaction.compactIfNeeded(agent, 'pressure', signal());
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ mode: 'observe', status: 'missing-prices', decisionApplied: false });
    await entry.fiber!.dispose();
    expect(ctx.get('compaction')).toBeUndefined();
    // A frozen snapshot from the unit fixture verifies no dangling observer.
    const { snapshot } = await import('./fixtures.js');
    ctx.waterfall('cache-first/decide', snapshot, () => null);
    expect(observations).toHaveLength(1);
    await ctx.loader.create({ name: CACHE, config: entry.options.config });
    await ctx.loader.await();
    await ctx.compaction.compactIfNeeded(agent, 'pressure', signal());
    expect(observations).toHaveLength(2);
  });

  it('uses the exact native Basic engine with both switches off', async () => {
    const { ctx, agent, observations } = await loadYaml({ window: 20000, cacheFirst: false, mode: 'off' });
    expect(ctx.compaction).not.toBeInstanceOf(CacheFirst.CacheFirstCompactionEngine);
    // Cordis trace-wraps property functions, so compare the underlying prototype.
    expect(Object.getPrototypeOf(ctx.compaction)).toBe(BasicCompactionEngine.prototype);
    seedHistory(agent);
    expect(await ctx.compaction.compactIfNeeded(agent, 'pressure', signal())).toBeNull();
    expect(observations).toEqual([]);
  });

  it('fixed cache-first installs no policy observer', async () => {
    const { ctx, agent, observations } = await loadYaml({ window: 20000, mode: 'off' });
    seedHistory(agent);
    await ctx.compaction.compactIfNeeded(agent, 'pressure', signal());
    expect(observations).toEqual([]);
  });
});
