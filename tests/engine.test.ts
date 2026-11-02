import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import { createUserMessage, createAssistantMessage, createToolResultMessage, createSystemMessage, ToolCallId, LlmError, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
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

function fixture(window = 1400, thresholdChars = 300, Engine = CacheFirstCompactionEngine) {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: window } }), imageRequestPricing: () => undefined });
  new SessionProjectionRegistry(ctx);
  const meter = new TokenMeter(ctx);
  const pruner = new ToolResultPruner(ctx, { thresholdChars, headChars: 30, tailChars: 30 });
  const engine = new Engine(ctx, { base: { auto: false, thresholdRatio: 0.8, headroomTokens: 100, retainTokens: 1, maxTokens: 80, compactionRetries: 0 } });
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
