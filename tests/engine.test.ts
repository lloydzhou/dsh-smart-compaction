import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import { createUserMessage, createAssistantMessage, createToolResultMessage, createSystemMessage, ToolCallId, LlmError, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { observedUsage } from '../src/telemetry.js';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { CacheFirstCompactionEngine } from '../src/index.js';
import { candidates, projectedPruneTokens } from '../src/selection.js';

const contexts: Context[] = [];
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); });

class LocalSummaryEngine extends CacheFirstCompactionEngine {
  protected override async summarize() {
    return { summary: [{ type: 'text' as const, text: 'Summary.' }], provider: 'mock', model: 'test' };
  }
}

function fixture(window = 1400, thresholdChars = 300, Engine = CacheFirstCompactionEngine, maxTokens = 80) {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: window } }), imageRequestPricing: () => undefined });
  new SessionProjectionRegistry(ctx);
  const meter = new TokenMeter(ctx);
  const pruner = new ToolResultPruner(ctx, { thresholdChars, headChars: 30, tailChars: 30 });
  const engine = new Engine(ctx, { base: { auto: false, thresholdRatio: 0.8, headroomTokens: 100, retainTokens: 1, maxTokens, compactionRetries: 0 } });
  const session = Session.create(SessionId('test'));
  session.append('turn/start', { turn: 0 });
  session.append('system/message', { turn: 0, step: 0, message: createSystemMessage('system') }, { surfaceOp: 'append' });
  session.append('request/header', { header: { config: { provider: 'mock', model: 'test' } }, reason: 'initial' });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'old '.repeat(100) }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('step/start', { turn: 0, step: 0 });
  const callId = ToolCallId('call');
  session.append('assistant/message', { turn: 0, step: 0, stream: [], message: createAssistantMessage({ source: { provider: 'mock', model: 'test' }, content: [{ type: 'tool-call', id: callId, name: 'test', arguments: '{}' }] }) }, { surfaceOp: 'append' });
  session.append('tool/result', { turn: 0, step: 0, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'tool '.repeat(1000) }], isError: false }) }, { surfaceOp: 'append' });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'recent' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  // Only session/options are observed by this unit; full Agent lifecycle is covered by integration tests.
  const agent = { session, options: { provider: 'mock', model: 'test' } } as Agent;
  return { ctx, engine, session, agent, meter, pruner };
}

function telemetryFixture(window = 600, thresholdChars = 10000, maxTokens = 80) {
  const f = fixture(window, thresholdChars, CacheFirstCompactionEngine, maxTokens);
  const records: Record<string, any>[] = [];
  f.ctx.logger.exporter({ export: record => {
    const value = record.args[0] as Record<string, any>;
    if (value?.event?.startsWith('cache-first-compaction/')) records.push(value);
  } });
  const stream = vi.fn<(options: GenerateOptions) => AsyncIterable<StreamChunk>>();
  // Exercise the public waterfall contract, not any private adapter implementation.
  Object.assign(f.ctx.llm, { stream: (options: GenerateOptions) => f.ctx.waterfall('llm/stream', options, () => stream(options)) });
  return { ...f, records, stream, result: () => records.filter(r => r.event === 'cache-first-compaction/result').at(-1)! };
}
const usage: TokenUsage = { inputTokens: 20, outputTokens: 5, cacheReadTokens: 70, cacheWriteTokens: 10 };
async function* summaryChunks(): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', index: 0, text: 'Summary.' };
  yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

describe('actual compaction telemetry', () => {
  it('reports prune-only zero calls, without inventing cache counters', async () => {
    const f = telemetryFixture(1400, 300);
    await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
    expect(f.result()).toMatchObject({ sessionId: 'test', summaryAttempts: 0, llmStreamCalls: 0, modelCalls: 0, providerDispatch: 'none', surfaceChanged: true, usage: { cacheHitRatio: null } });
  });
  it('records insufficient-prune summary success and disjoint cache hit ratio', async () => {
    const f = telemetryFixture(); f.stream.mockImplementation(summaryChunks);
    await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
    expect(f.result()).toMatchObject({ status: 'success', summaryAttempts: 1, llmStreamCalls: 1, knownUsageCalls: 1, unknownUsageCalls: 0, modelCalls: null,
      usage: { ...usage, promptTokens: 100, cacheHitRatio: 0.7 }, attempts: [{ llmStreamCall: true }] });
    expect(f.result().calls[0]).toMatchObject({ summaryAttempt: 1, evidence: 'llm/stream', status: 'stop' });
    expect(JSON.stringify(f.records)).not.toContain('Summary.');
    expect(f.records[0]!.operationId).toBe(f.result().operationId);
  });
  it('retains failed stream usage and does not add cumulative usage snapshots', async () => {
    const f = telemetryFixture();
    f.stream.mockImplementation(async function* () {
      yield { type: 'usage', usage: { ...usage, inputTokens: 1 } };
      yield { type: 'usage', usage };
      throw new Error('private provider error text');
    });
    await expect(f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal)).rejects.toThrow('private provider');
    expect(f.result()).toMatchObject({ status: 'error', summaryAttempts: 1, llmStreamCalls: 1, knownUsageCalls: 1, usage: { inputTokens: 20 } });
    expect(JSON.stringify(f.records)).not.toContain('private provider');
  });
  it('records overflow retries individually and never treats unreported failures as free', async () => {
    const f = telemetryFixture(210, 300);
    f.stream.mockImplementation(async function* () { throw new LlmError('overflow', CONTEXT_WINDOW_EXCEEDED_CODE); });
    await expect(f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal)).rejects.toThrow('overflow');
    expect(f.result()).toMatchObject({ summaryAttempts: 2, llmStreamCalls: 2, knownUsageCalls: 0, unknownUsageCalls: 2, modelCalls: null, usage: { inputTokens: null, cacheHitRatio: null } });
    expect(f.result().calls.map((c: any) => c.summaryAttempt)).toEqual([1, 2]);
  });
  it('groups recovered failed and successful summary attempts without assuming the first was free', async () => {
    const f = telemetryFixture();
    f.stream.mockImplementationOnce(async function* () { throw new Error('recoverable'); }).mockImplementation(summaryChunks);
    let recoveries = 0;
    f.ctx.on('compaction/summary-error', () => recoveries++ === 0);
    await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
    expect(f.result()).toMatchObject({ status: 'success', summaryAttempts: 2, llmStreamCalls: 2, knownUsageCalls: 1, unknownUsageCalls: 1,
      usage: { inputTokens: null, cacheHitRatio: null }, knownUsageTotals: { inputTokens: 20, cacheReadTokens: 70 } });
    expect(f.result().attempts[0].compactionId).toBe(f.result().attempts[1].compactionId);
    expect(f.result().attempts.map((a: any) => a.status)).toEqual(['error', 'success']);
  });
  it('does not equate missing adapters with actual provider dispatch', async () => {
    const f = telemetryFixture();
    f.stream.mockImplementation(async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'missing' } } }; });
    await expect(f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal)).rejects.toThrow('missing');
    expect(f.result()).toMatchObject({ summaryAttempts: 1, llmStreamCalls: 1, modelCalls: null, providerDispatch: 'unknown', unknownUsageCalls: 1 });
  });
  it('records late cancellation usage while preserving cancellation and the original surface', async () => {
    const f = telemetryFixture(); const abort = new AbortController();
    f.stream.mockImplementation(async function* () { yield* summaryChunks(); abort.abort('cancel'); });
    await expect(f.engine.compactIfNeeded(f.agent, 'pressure', abort.signal)).rejects.toBe('cancel');
    expect(f.result()).toMatchObject({ status: 'cancelled', surfaceChanged: false, knownUsageCalls: 1, attempts: [{ status: 'cancelled', llmStreamCall: true }] });
  });
  it('instruments shared manual compaction independently of automatic checks', async () => {
    const f = telemetryFixture(); f.stream.mockImplementation(summaryChunks);
    f.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
    Object.assign(f.agent, { runMaintenance: (run: (signal: AbortSignal) => Promise<unknown>) => run(new AbortController().signal) });
    f.ctx.provide('sessions', { flush: async () => {} });
    await f.engine.compactNow(f.agent, new AbortController().signal);
    expect(f.result()).toMatchObject({ trigger: 'manual', status: 'success', summaryAttempts: 1, llmStreamCalls: 1 });
    expect(f.records.filter(r => r.event.endsWith('/result'))).toHaveLength(1);
  });
  it('logs direct inherited region calls without an automatic operation', async () => {
    const f = telemetryFixture(); f.stream.mockImplementation(summaryChunks);
    await f.engine.compactRegion(f.session.surface.nodes[1]!, f.session.surface.nodes[3]!, f.agent);
    expect(f.result()).toMatchObject({ trigger: 'region', summaryAttempts: 1, llmStreamCalls: 1 });
  });
  it('preserves missing and zero cache counter distinctions', () => {
    expect(observedUsage({ inputTokens: 20, outputTokens: 5 })).toMatchObject({ cacheReadTokens: null, cacheWriteTokens: null, cacheHitRatio: null });
    expect(observedUsage({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }).cacheHitRatio).toBe(0);
    expect(observedUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).cacheHitRatio).toBeNull();
  });
});

function idle(f: ReturnType<typeof telemetryFixture>, agentSignal = new AbortController().signal) {
  f.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
  Object.assign(f.agent, { runMaintenance: (run: (signal: AbortSignal) => Promise<unknown>) => run(agentSignal) });
  const flush = vi.fn(async () => {});
  f.ctx.provide('sessions', { flush });
  return flush;
}

describe('forced cache-first manual execution', () => {
  it('forces below-pressure work without consulting economic deferral or Basic selection', async () => {
    const f = telemetryFixture(10000, 10000); const flush = idle(f);
    f.stream.mockImplementation(summaryChunks);
    const decide = vi.fn(() => null); f.ctx.on('cache-first/decide', decide);
    const stock = vi.spyOn(BasicCompactionEngine.prototype, 'compactNow');
    try {
      const result = await f.engine.compactNow(f.agent, new AbortController().signal, 'manual-command' as never);
      expect(result).not.toBeNull(); expect(stock).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled();
      expect(flush).toHaveBeenCalledOnce();
      const markers = f.session.snapshotEvents().filter(e => e.type === 'compaction/start' || e.type === 'compaction/end' || e.type === 'compaction/summary');
      expect(markers).toHaveLength(3);
      for (const marker of markers) expect(marker.data).toMatchObject({ sourceCommandId: 'manual-command' });
      expect(markers[0]!.data).toMatchObject({ turn: null });
      const checkpoint = f.session.snapshotEvents().filter(e => e.type === 'user/message').at(-1)!;
      expect(checkpoint.data).toMatchObject({ source: { kind: 'compact-checkpoint', sourceCommandId: 'manual-command' } });
      expect(f.result()).toMatchObject({ trigger: 'manual', summaryAttempts: 1, status: 'success' });
    } finally { stock.mockRestore(); }
  });
  it('manual produces a real checkpoint even when prune alone would suffice', async () => {
    const f = telemetryFixture(10000, 300, 400); const flush = idle(f);
    f.stream.mockImplementation(async function* () { yield* summaryChunks(); });
    const result = await f.engine.compactNow(f.agent, new AbortController().signal);
    expect(result).not.toBeNull();
    expect(f.stream).toHaveBeenCalledOnce(); expect(flush).toHaveBeenCalledOnce();
    expect(f.session.snapshotEvents().filter(e => e.type === 'compaction/prune')).toHaveLength(0);
    expect(f.result()).toMatchObject({ trigger: 'manual', surfaceChanged: true, summaryAttempts: 1 });
  });
  it('does not mistake crossing the automatic threshold for satisfying the manual target', async () => {
    const f = telemetryFixture(10000, 300); idle(f);
    // A large unprunable old prefix leaves the projected prune above the manual target.
    const old = f.session.surface.nodes[1]!;
    f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original '.repeat(3000) }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: old, endSeq: old }, sourceEventSeqs: [old] });
    const original = f.session.surface.nodes.slice();
    f.stream.mockImplementation(async function* () {
      expect(f.session.surface.nodes).toEqual(original);
      yield* summaryChunks();
    });
    const prune = vi.spyOn(f.pruner, 'pruneSession');
    await f.engine.compactNow(f.agent, new AbortController().signal);
    expect(f.stream).toHaveBeenCalledOnce(); expect(prune).not.toHaveBeenCalled();
  });
  it('retries overflow using a smaller original balanced prefix, retaining command identity', async () => {
    const f = telemetryFixture(10000, 10000); idle(f);
    f.stream.mockImplementationOnce(async function* () { throw new LlmError('overflow', CONTEXT_WINDOW_EXCEEDED_CODE); }).mockImplementation(summaryChunks);
    await f.engine.compactNow(f.agent, new AbortController().signal, 'fallback-command' as never);
    expect(f.stream).toHaveBeenCalledTimes(2);
    expect(f.stream.mock.calls[1]![0].messages.length).toBeLessThan(f.stream.mock.calls[0]![0].messages.length);
    for (const e of f.session.snapshotEvents().filter(e => e.type === 'compaction/start' || e.type === 'compaction/end')) expect(e.data).toMatchObject({ sourceCommandId: 'fallback-command', turn: null });
  });
  it('allows context appended outside the selected span during manual summary', async () => {
    const f = telemetryFixture(10000, 10000); idle(f);
    f.stream.mockImplementation(async function* () {
      f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'new external context'.repeat(1000) }], source: { kind: 'user' } }), { surfaceOp: 'append' });
      yield* summaryChunks();
    });
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).resolves.not.toBeNull();
    expect(f.session.deriveEventMessage(f.session.eventAt(f.session.surface.nodes.at(-1)!)!)?.content).toEqual([{ type: 'text', text: 'new external context'.repeat(1000) }]);
  });
  it('validates the exact selected span after a large unrelated append, preserving system and tools', async () => {
    const f = telemetryFixture(10000, 10000); idle(f);
    const tools = [{ name: 'test', description: 'tool schema', parameters: { type: 'object' as const, properties: {} } }];
    f.session.append('request/header', { header: { config: { provider: 'mock', model: 'test' }, tools }, reason: 'initial' });
    f.stream.mockImplementation(async function* (options) {
      expect(options.messages[0]).toMatchObject({ role: 'system', content: [{ type: 'text', text: 'system' }] });
      expect(options.tools).toEqual(tools);
      for (let i = 0; i < 300; i++) f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'external tail' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
      yield* summaryChunks();
    });
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).resolves.not.toBeNull();
    expect(f.stream).toHaveBeenCalledOnce();
  });
  it('rejects changed selected spans and closes the standalone transaction', async () => {
    const f = telemetryFixture(10000, 10000); const flush = idle(f);
    f.stream.mockImplementation(async function* () {
      const old = f.session.surface.nodes[1]!;
      f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'rewritten' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: old, endSeq: old }, sourceEventSeqs: [old] });
      yield* summaryChunks();
    });
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).rejects.toMatchObject({ code: 'changed' });
    expect(f.session.snapshotEvents().filter(e => e.type === 'compaction/end')).toHaveLength(1); expect(flush).toHaveBeenCalledOnce();
  });
  it('preserves cancellation, closes failed attempts, and skips fallback prune', async () => {
    const f = telemetryFixture(10000, 10000); idle(f); const abort = new AbortController();
    const before = f.session.surface.nodes.slice();
    f.stream.mockImplementation(async function* () { yield* summaryChunks(); abort.abort('manual-cancel'); });
    await expect(f.engine.compactNow(f.agent, abort.signal)).rejects.toBe('manual-cancel');
    expect(f.session.surface.nodes).toEqual(before);
    expect(f.session.snapshotEvents().filter(e => e.type === 'compaction/end')).toHaveLength(1);
  });
  it('preserves request cancellation during the final durability checkpoint', async () => {
    const f = telemetryFixture(10000, 300, 400); const flush = idle(f); const abort = new AbortController();
    flush.mockImplementation(async () => { abort.abort('flush-cancel'); });
    await expect(f.engine.compactNow(f.agent, abort.signal)).rejects.toBe('flush-cancel');
  });
  it('recovers a failed manual summary inside one durable transaction', async () => {
    const f = telemetryFixture(10000, 10000); idle(f);
    f.stream.mockImplementationOnce(async function* () { throw new Error('recoverable'); }).mockImplementation(summaryChunks);
    const derive = f.session.deriveEventMessage.bind(f.session);
    const selected = f.session.surface.nodes[1]!;
    let repaired = false;
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => {
      const message = derive(event);
      return repaired && event.seq === selected && message ? { ...message, content: [{ type: 'text', text: 'repaired '.repeat(100) }] } : message;
    });
    f.ctx.on('compaction/summary-error', () => { repaired = true; return true; });
    await f.engine.compactNow(f.agent, new AbortController().signal);
    expect(f.stream).toHaveBeenCalledTimes(2);
    expect(f.session.snapshotEvents().filter(e => e.type === 'compaction/start')).toHaveLength(1);
    expect(f.result()).toMatchObject({ summaryAttempts: 2, llmStreamCalls: 2 });
  });
  it.each(['summary', 'changed', 'commit'] as const)('preserves %s failure when flushing also fails', async code => {
    const f = telemetryFixture(10000, 10000); const flush = idle(f);
    flush.mockRejectedValue(new Error('disk failure'));
    const primary = new Error('primary failure');
    if (code === 'commit') {
      const append = f.session.append.bind(f.session);
      vi.spyOn(f.session, 'append').mockImplementation((...args) => {
        if (args[0] === 'compaction/summary') throw primary;
        return Reflect.apply(append, f.session, args);
      });
    }
    f.stream.mockImplementation(async function* () {
      if (code === 'summary') throw primary;
      if (code === 'changed') {
        const old = f.session.surface.nodes[1]!;
        f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'changed' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: old, endSeq: old }, sourceEventSeqs: [old] });
      }
      yield* summaryChunks();
    });
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).rejects.toMatchObject({ code, ...(code === 'changed' ? {} : { cause: primary }) });
    expect(flush).toHaveBeenCalledOnce();
  });
  it.each([false, true])('does not flush or prune an unmatched transaction (summary fails: %s)', async failSummary => {
    const f = telemetryFixture(10000, 10000); const flush = idle(f);
    const append = f.session.append.bind(f.session);
    vi.spyOn(f.session, 'append').mockImplementation((...args) => {
      if (args[0] === 'compaction/end') throw new Error('close failure');
      return Reflect.apply(append, f.session, args);
    });
    f.stream.mockImplementation(async function* () { if (failSummary) throw new Error('summary failure'); yield* summaryChunks(); });
    const prune = vi.spyOn(f.pruner, 'pruneSession');
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).rejects.toMatchObject({ code: 'commit' });
    expect(flush).not.toHaveBeenCalled(); expect(prune).not.toHaveBeenCalled();
    expect(f.session.snapshotEvents().filter(e => e.type === 'compaction/end')).toHaveLength(0);
  });
  it('does not re-call the model when recovery claims success without selected progress', async () => {
    const f = telemetryFixture(10000, 10000); idle(f);
    const primary = new Error('unrecoverable');
    f.stream.mockImplementation(async function* () { throw primary; });
    const recover = vi.fn(() => {
      f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'outside' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
      return true;
    });
    f.ctx.on('compaction/summary-error', recover);
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).rejects.toMatchObject({ code: 'summary', cause: primary });
    expect(f.stream).toHaveBeenCalledOnce(); expect(recover).toHaveBeenCalledOnce();
  });
  it('bounds recovery attempts even when every hook changes selected content', async () => {
    const f = telemetryFixture(10000, 10000); idle(f);
    const derive = f.session.deriveEventMessage.bind(f.session);
    const selected = f.session.surface.nodes[1]!;
    let revision = 0;
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => {
      const message = derive(event);
      return revision && event.seq === selected && message ? { ...message, content: [{ type: 'text', text: `repair ${revision}` }] } : message;
    });
    f.ctx.on('compaction/summary-error', () => { revision++; return true; });
    f.stream.mockImplementation(async function* () { throw new Error('still failing'); });
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).rejects.toMatchObject({ code: 'summary' });
    expect(f.stream).toHaveBeenCalledTimes(4); expect(revision).toBe(3);
  });
  it('stops a recovery cycle before resending an earlier selected prompt', async () => {
    const f = telemetryFixture(10000, 10000); idle(f);
    const derive = f.session.deriveEventMessage.bind(f.session);
    const selected = f.session.surface.nodes[1]!;
    let alternate = false;
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => {
      const message = derive(event);
      return alternate && event.seq === selected && message ? { ...message, content: [{ type: 'text', text: 'alternate' }] } : message;
    });
    f.ctx.on('compaction/summary-error', () => { alternate = !alternate; return true; });
    f.stream.mockImplementation(async function* () { throw new Error('cyclic failure'); });
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).rejects.toMatchObject({ code: 'summary' });
    expect(f.stream).toHaveBeenCalledTimes(2);
  });
  it('accepts unrelated repricing but rejects equal-price selected message rewrites', async () => {
    for (const rewrite of [false, true]) {
      const f = telemetryFixture(10000, 10000); idle(f);
      const measure = f.meter.measure.bind(f.meter);
      const derive = f.session.deriveEventMessage.bind(f.session);
      const selected = f.session.surface.nodes[1]!;
      let changed = false;
      vi.spyOn(f.meter, 'measure').mockImplementation(session => {
        const measurement = measure(session);
        return changed && !rewrite ? { ...measurement, nodes: measurement.nodes.map(node => ({ ...node, tokens: node.tokens + 1 })) } : measurement;
      });
      vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => {
        const message = derive(event);
        return changed && rewrite && event.seq === selected && message ? { ...message, content: [{ type: 'text', text: 'new '.repeat(100) }] } : message;
      });
      f.stream.mockImplementation(async function* () { changed = true; yield* summaryChunks(); });
      const result = f.engine.compactNow(f.agent, new AbortController().signal);
      if (rewrite) await expect(result).rejects.toMatchObject({ code: 'changed' });
      else await expect(result).resolves.not.toBeNull();
    }
  });
  it('rejects active durable compaction before manual pruning', async () => {
    const f = telemetryFixture(10000, 300, 400); idle(f);
    f.session.append('compaction/start', { compactionId: 'active' as never, turn: null }); const before = f.session.seq;
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).rejects.toMatchObject({ code: 'busy' });
    expect(f.session.seq).toBe(before);
  });
  it('classifies maintenance cancellation and synchronous busy admission', async () => {
    const f = telemetryFixture(10000, 10000); const abort = new AbortController(); idle(f, abort.signal);
    f.stream.mockImplementation(async function* () { abort.abort('agent-stop'); yield* summaryChunks(); });
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).rejects.toMatchObject({ code: 'cancelled' });
    Object.assign(f.agent, { runMaintenance: () => { throw new Error('busy'); } });
    expect(() => f.engine.compactNow(f.agent, new AbortController().signal)).toThrow('idle agent');
  });
  it('reports persistence failure after a manual summary checkpoint', async () => {
    const f = telemetryFixture(10000, 300, 400); const flush = idle(f); flush.mockRejectedValue(new Error('disk'));
    f.stream.mockImplementation(async function* () { yield* summaryChunks(); });
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).rejects.toMatchObject({ code: 'persistence' });
    expect(f.session.surface.replaceGeneration).toBeGreaterThan(0);
  });
  it('manual falls back to an explicitly configured summary route without a request header', async () => {
    const f = telemetryFixture(10000); idle(f);
    vi.spyOn(f.session, 'requestHeader').mockReturnValue(undefined);
    Object.assign(f.agent, { options: {} });
    Object.defineProperty(f.engine, 'config', { value: { ...f.engine.config, summarizationProvider: 'mock', summarizationModel: 'test' } });
    f.stream.mockImplementation(async function* () { yield* summaryChunks(); });
    const result = await f.engine.compactNow(f.agent, new AbortController().signal);
    expect(result).not.toBeNull();
    expect(f.stream).toHaveBeenCalledOnce();
  });
  it('manual missing route is an explicit error, not a false no-history result', async () => {
    const f = telemetryFixture(10000); idle(f);
    vi.spyOn(f.session, 'requestHeader').mockReturnValue(undefined);
    Object.assign(f.agent, { options: {} });
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).rejects.toMatchObject({ code: 'summary' });
  });
  it('short history is a native no-region no-op before capacity lookup', async () => {
    const f = telemetryFixture(); const flush = idle(f);
    const short = Session.create(SessionId('short'));
    short.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'only message' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    Object.assign(f.agent, { session: short });
    const resolve = vi.spyOn(f.ctx.llm, 'resolveModelInfo').mockRejectedValue(new Error('unavailable'));
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled();
  });
  it('rejects an open durable turn before prune-only mutation', async () => {
    const f = telemetryFixture(10000, 300); idle(f);
    f.session.append('turn/start', { turn: 1 }); const before = f.session.seq;
    await expect(f.engine.compactNow(f.agent, new AbortController().signal)).rejects.toMatchObject({ code: 'busy' });
    expect(f.session.seq).toBe(before);
  });
});

describe('cache-first public API execution', () => {
  it('dry-runs complete replacements without changing the surface', () => {
    const { session, meter, pruner } = fixture();
    const before = session.seq;
    const estimate = projectedPruneTokens(session, meter.measure(session), meter, pruner);
    expect(session.seq).toBe(before);
    pruner.pruneSession(session);
    expect(meter.measure(session).totalTokens).toBe(estimate);
  });

  it('uses only head-anchored balanced ranges and keeps the system and final node', () => {
    const { session, meter } = fixture();
    const ranges = candidates(session, meter.measure(session));
    expect(ranges).toHaveLength(2);
    expect(ranges.every(item => item.start === session.surface.nodes[1])).toBe(true);
    expect(ranges.map(item => item.end)).toEqual([session.surface.nodes[1], session.surface.nodes[3]]);
  });

  it('bounds sampled candidate cuts while preserving both positional extremes', () => {
    const { session, meter } = fixture();
    for (let i = 0; i < 40; i++) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'tail' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const ranges = candidates(session, meter.measure(session), 2);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.end).toBe(session.surface.nodes[1]);
    expect(ranges[1]!.end).toBe(session.surface.nodes.at(-2));
  });

  it('commits sufficient prune without calling summarizer', async () => {
    const { engine, session, agent } = fixture();
    const summary = vi.spyOn(engine, 'compactRegion');
    const before = session.surface.replaceGeneration;
    expect(await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)).toBeNull();
    expect(summary).not.toHaveBeenCalled();
    expect(session.surface.replaceGeneration).toBeGreaterThan(before);
  });

  it('preserves original prefix when pruning cannot meet threshold', async () => {
    const { engine, session, agent } = fixture(210);
    const original = session.surface.nodes.slice();
    const expected = new Error('summary failed');
    const summary = vi.spyOn(engine, 'compactRegion').mockImplementation(async () => {
      expect(session.surface.nodes).toEqual(original);
      throw expected;
    });
    await expect(engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)).rejects.toBe(expected);
    expect(summary).toHaveBeenCalledOnce();
    expect(session.surface.replaceGeneration).toBeGreaterThan(0);
  });

  it('cancellation prevents fallback pruning and preserves its exact reason', async () => {
    const { engine, session, agent } = fixture(210);
    const abort = new AbortController();
    const reason = new Error('cancel');
    vi.spyOn(engine, 'compactRegion').mockImplementation(async () => { abort.abort(reason); throw reason; });
    await expect(engine.compactIfNeeded(agent, 'pressure', abort.signal)).rejects.toBe(reason);
    expect(session.surface.replaceGeneration).toBe(0);
  });

  it('retries summary overflow with a smaller balanced prefix then falls back once', async () => {
    const { engine, agent, session } = fixture(210);
    const summary = vi.spyOn(engine, 'compactRegion').mockRejectedValue(new LlmError('overflow', CONTEXT_WINDOW_EXCEEDED_CODE));
    await expect(engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)).rejects.toThrow('overflow');
    expect(summary).toHaveBeenCalledTimes(2);
    expect(summary.mock.calls[0]![1]).not.toBe(summary.mock.calls[1]![1]);
    expect(session.surface.replaceGeneration).toBe(1);
  });

  it('null decisions cannot disable hard pressure and receive immutable history', async () => {
    const { ctx, engine, agent } = fixture();
    ctx.on('cache-first/decide', (snapshot) => {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.history)).toBe(true);
      expect(snapshot.history.modelCalls).toBe(1);
      return null;
    });
    await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(agent.session.surface.replaceGeneration).toBe(1);
  });

  it('uses inherited durable summary replacement without pruning an already-sufficient tail', async () => {
    const { engine, agent, session, ctx } = fixture(600, 10000, LocalSummaryEngine);
    const pruner = vi.spyOn(ctx.toolResultPruner, 'pruneSession');
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).not.toBeNull();
    expect(pruner).not.toHaveBeenCalled();
    const events = session.snapshotEvents();
    expect(events.filter(event => event.type === 'compaction/start')).toHaveLength(1);
    expect(events.filter(event => event.type === 'compaction/end')).toHaveLength(1);
    expect(events.filter(event => event.type === 'compaction/summary')).toHaveLength(1);
  });

  it('prunes retained tool results only after the original selected prefix was summarized', async () => {
    const { engine, agent, session, ctx, meter } = fixture(600, 300, LocalSummaryEngine);
    // Make the first prefix large enough to summarize, and retain the tool pair by policy.
    const old = session.surface.nodes[1]!;
    const message = createUserMessage({ content: [{ type: 'text', text: 'original '.repeat(800) }], source: { kind: 'user' } });
    session.append('user/message', message, { surfaceOp: { op: 'replace', startSeq: old, endSeq: old }, sourceEventSeqs: [old] });
    // Control the selected region to leave a large durable tool tail after a real summary transaction.
    const summary = vi.spyOn(engine, 'compactRegion');
    summary.mockImplementation(async (start, _end, owner, signal) => BasicCompactionEngine.prototype.compactRegion.call(engine, start, start, owner, signal));
    const policyDisposer = ctx.on('cache-first/decide', (snapshot) => ({ thresholdTokens: snapshot.thresholdTokens, retainTokens: 1, reason: 'bounded test' }), { prepend: true });
    const prune = vi.spyOn(ctx.toolResultPruner, 'pruneSession');
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    policyDisposer();
    expect(result).not.toBeNull();
    expect(prune).toHaveBeenCalledOnce();
    const events = session.snapshotEvents();
    expect(events.findIndex(event => event.type === 'compaction/summary')).toBeLessThan(events.findIndex(event => event.type === 'compaction/prune'));
    expect(meter.measure(session).totalTokens).toBeLessThan(480);
  });

  it('rejects late stock summary results after cancellation before durable replacement', async () => {
    const { engine, agent, session } = fixture(600, 10000);
    const abort = new AbortController(); const reason = new Error('late abort');
    // The protected method is reachable only for this controlled adapter outcome; no private implementation import.
    const stock = BasicCompactionEngine.prototype as unknown as { summarize(): Promise<{ summary: { type: 'text'; text: string }[]; provider: string; model: string }> };
    const stub = vi.spyOn(stock, 'summarize').mockImplementation(async () => {
      abort.abort(reason);
      return { summary: [{ type: 'text', text: 'Late result' }], provider: 'mock', model: 'test' };
    });
    try {
      await expect(engine.compactIfNeeded(agent, 'pressure', abort.signal)).rejects.toBe(reason);
      expect(session.surface.replaceGeneration).toBe(0);
      expect(session.snapshotEvents().filter(event => event.type === 'compaction/end')).toHaveLength(1);
    } finally { stub.mockRestore(); }
  });

  it('does not mutate when aborted before entry', async () => {
    const { engine, agent, session } = fixture();
    const before = session.seq;
    const abort = new AbortController(); abort.abort('stop');
    await expect(engine.compactIfNeeded(agent, 'pressure', abort.signal)).rejects.toBe('stop');
    expect(session.seq).toBe(before);
  });

  it('rejects invalid own configuration before providing a backend', () => {
    const ctx = new Context(); contexts.push(ctx);
    expect(() => new CacheFirstCompactionEngine(ctx, { summaryFallbackAttempts: -1 })).toThrow('summaryFallbackAttempts');
    expect(ctx.get('compaction')).toBeUndefined();
  });
});
