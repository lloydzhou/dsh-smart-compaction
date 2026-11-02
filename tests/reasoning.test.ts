import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import LlmRuntime, { LlmAdapter, ReasoningEffortId, createSystemMessage, createUserMessage,
  LlmError, CONTEXT_WINDOW_EXCEEDED_CODE, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { CacheFirstCompactionEngine } from '../src/engine.js';
import { SummaryReasoningScope } from '../src/reasoning.js';

const contexts: Context[] = [];
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); });
const effort = (value: string) => ReasoningEffortId(value);
class CaptureAdapter extends LlmAdapter {
  calls: GenerateOptions[] = [];
  fail = 0;
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 600 },
      reasoning: { efforts: ['max', 'low'].map(id => ({ id: effort(id), name: id })) } };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    if (this.fail-- > 0) throw new LlmError('overflow', CONTEXT_WINDOW_EXCEEDED_CODE);
    yield { type: 'text-delta', index: 0, text: 'Summary.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
function runtime() {
  const ctx = new Context(); contexts.push(ctx);
  const llm = new LlmRuntime(ctx); const adapter = new CaptureAdapter();
  llm.registerAdapter(['mock', 'other'], adapter);
  return { ctx, llm, adapter };
}
function session(id = 'test', reasoning: string | undefined = 'max') {
  const session = Session.create(SessionId(id));
  session.append('turn/start', { turn: 0 });
  session.append('system/message', { turn: 0, step: 0, message: createSystemMessage('system') }, { surfaceOp: 'append' });
  header(session, reasoning);
  for (let i = 0; i < 8; i++) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'old '.repeat(100) }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  return session;
}
function header(session: Session, reasoning?: string) {
  session.append('request/header', { header: { config: { provider: 'mock', model: 'test', ...(reasoning ? { reasoningEffort: effort(reasoning) } : {}) } }, reason: 'initial' });
}
function fixture(route?: { summarizationProvider: string; summarizationModel: string }, reasoning: string | undefined = 'max') {
  const f = runtime(); new SessionProjectionRegistry(f.ctx); new TokenMeter(f.ctx);
  const engine = new CacheFirstCompactionEngine(f.ctx, { base: { auto: false, thresholdRatio: 0.8, headroomTokens: 100, retainTokens: 1, maxTokens: 80, compactionRetries: 0, ...route } });
  const s = session('test', reasoning);
  const agent = { session: s, options: { provider: 'mock', model: 'test' }, runMaintenance: (run: (signal: AbortSignal) => Promise<unknown>) => run(new AbortController().signal) } as unknown as Agent;
  f.ctx.provide('sessions', { flush: async () => {} });
  return { ...f, engine, session: s, agent };
}
async function consume(llm: LlmRuntime, options: GenerateOptions) { for await (const _ of llm.stream(options)) {} }
function options(s: Session, extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'mock', model: 'test', sessionId: s.id, purpose: 'compaction', messages: [], ...extra };
}

describe('stock summarizer reasoning continuity through real LlmRuntime', () => {
  it('changes only reasoning effort relative to the stock summarizer envelope and result', async () => {
    class Stock extends BasicCompactionEngine { invoke(...args: Parameters<Stock['summarize']>) { return this.summarize(...args); } }
    class Fixed extends CacheFirstCompactionEngine { invoke(...args: Parameters<Fixed['summarize']>) { return this.summarize(...args); } }
    const stock = runtime(); const fixed = runtime();
    const s = session(); const agent = { session: s, options: { provider: 'mock', model: 'test' } } as Agent;
    const input = { messages: [createSystemMessage('unchanged system')], tools: [{ name: 'example', description: 'unchanged tool', parameters: { type: 'object', properties: {} } }] };
    const signal = new AbortController().signal;
    const original = await new Stock(stock.ctx, { auto: false }).invoke(input, agent, signal);
    const repaired = await new Fixed(fixed.ctx, { base: { auto: false } }).invoke(input, agent, signal);
    const { reasoningEffort, ...envelope } = fixed.adapter.calls[0]!;
    expect(reasoningEffort).toBe('max');
    expect(stock.adapter.calls[0]!.reasoningEffort).toBeUndefined();
    expect(envelope).toEqual(stock.adapter.calls[0]);
    expect(repaired).toEqual(original);
  });
  it.each(['automatic', 'manual', 'region'] as const)('preserves same-route effort for %s compaction', async mode => {
    const f = fixture(); const signal = new AbortController().signal;
    const observed: GenerateOptions[] = [];
    f.ctx.on('llm/stream', (o, next) => { observed.push(o); return next(); });
    if (mode === 'manual') {
      f.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
      await f.engine.compactNow(f.agent, signal);
    } else if (mode === 'region') await f.engine.compactRegion(f.session.surface.nodes[1]!, f.session.surface.nodes[6]!, f.agent, signal);
    else await f.engine.compactIfNeeded(f.agent, 'pressure', signal);
    expect(f.adapter.calls.length).toBeGreaterThan(0);
    expect(f.adapter.calls.every(o => o.reasoningEffort === 'max')).toBe(true);
    expect(observed).toHaveLength(f.adapter.calls.length);
    expect(observed[0]).toBe(f.adapter.calls[0]);
    expect(observed[0]).toMatchObject({ maxTokens: 80, signal, purpose: 'compaction' });
    expect(observed[0]!.messages[0]).toMatchObject({ role: 'system', content: [{ type: 'text', text: 'system' }] });
    expect(observed[0]!.messages.at(-1)).toMatchObject({ role: 'user' });
    expect(observed[0]!.toolHistory).toBeDefined();
  });
  it.each([{ summarizationProvider: 'other', summarizationModel: 'test' }, { summarizationProvider: 'mock', summarizationModel: 'different' }])('does not transfer effort across route overrides %o', async route => {
    const f = fixture(route); await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
    expect(f.adapter.calls[0]!.reasoningEffort).toBeUndefined();
  });
  it('preserves an unset effort', async () => {
    const f = fixture(); header(f.session);
    await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
    expect(f.adapter.calls[0]!.reasoningEffort).toBeUndefined();
  });
  it('re-reads the latest durable effort for recovered summary retries', async () => {
    const f = fixture(); f.adapter.fail = 1;
    f.ctx.on('compaction/summary-error', () => { header(f.session, 'low'); return true; });
    await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
    expect(f.adapter.calls.map(o => o.reasoningEffort)).toEqual(['max', 'low']);
  });
  it.each(['overflow', 'manual'] as const)('repairs each smaller-prefix %s fallback', async mode => {
    const f = fixture(); f.adapter.fail = 1;
    if (mode === 'manual') {
      f.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
      await f.engine.compactNow(f.agent, new AbortController().signal);
    } else await f.engine.compactIfNeeded(f.agent, 'context-overflow', new AbortController().signal);
    expect(f.adapter.calls.map(o => o.reasoningEffort)).toEqual(['max', 'max']);
    expect(f.adapter.calls[1]!.messages.length).toBeLessThan(f.adapter.calls[0]!.messages.length);
  });
});

describe('narrow public middleware scope', () => {
  it('preserves explicit effort and leaves unrelated, nested and later calls alone', async () => {
    const f = runtime(); const scope = new SummaryReasoningScope(f.ctx); const s = session();
    await scope.run(s, async () => {
      await consume(f.llm, options(s, { purpose: 'session-title' }));
      await consume(f.llm, options(s, { sessionId: SessionId('unrelated') }));
      await consume(f.llm, options(s, { reasoningEffort: effort('low') }));
      await consume(f.llm, options(s));
    });
    await consume(f.llm, options(s));
    expect(f.adapter.calls.map(o => o.reasoningEffort)).toEqual([undefined, undefined, 'low', undefined, undefined]);
  });
  it('does not repair a nested same-session compaction dispatch from downstream middleware', async () => {
    const f = runtime(); const scope = new SummaryReasoningScope(f.ctx); const s = session();
    let nested = false;
    f.ctx.on('llm/stream', async function* (_options, next) {
      if (!nested) { nested = true; await consume(f.llm, options(s)); }
      yield* next();
    });
    await scope.run(s, () => consume(f.llm, options(s)));
    expect(f.adapter.calls.map(o => o.reasoningEffort)).toEqual([undefined, 'max']);
  });
  it('respects upstream explicit effort', async () => {
    const f = runtime(); const scope = new SummaryReasoningScope(f.ctx); const s = session();
    f.ctx.on('llm/stream', (o, next) => { o.reasoningEffort = effort('low'); return next(); }, { prepend: true });
    await scope.run(s, () => consume(f.llm, options(s)));
    expect(f.adapter.calls[0]!.reasoningEffort).toBe('low');
  });
  it('isolates overlapping sessions and clears failed scopes', async () => {
    const f = runtime(); const scope = new SummaryReasoningScope(f.ctx); const a = session('a'); const b = session('b', 'low');
    let release!: () => void; const barrier = new Promise<void>(r => { release = r; });
    const first = scope.run(a, async () => { await barrier; await consume(f.llm, options(a)); });
    await scope.run(b, () => consume(f.llm, options(b))); release(); await first;
    expect(f.adapter.calls.map(o => [o.sessionId, o.reasoningEffort])).toEqual([['b', 'low'], ['a', 'max']]);
    await expect(scope.run(a, async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    await consume(f.llm, options(a)); expect(f.adapter.calls.at(-1)!.reasoningEffort).toBeUndefined();
  });
  it('does not bypass downstream exceptions or short circuits', async () => {
    const f = runtime(); const scope = new SummaryReasoningScope(f.ctx); const s = session();
    const dispose = f.ctx.on('llm/stream', () => { throw new Error('middleware'); });
    await expect(scope.run(s, () => consume(f.llm, options(s)))).rejects.toThrow('middleware');
    dispose();
    f.ctx.on('llm/stream', async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; });
    await scope.run(s, () => consume(f.llm, options(s)));
    expect(f.adapter.calls).toHaveLength(0);
  });
});
