import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, pluginRecordOf, appendPluginRecord } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { CompactionId } from '@deepseek-ai/dsh-compaction';
import LlmRuntime, { createUserMessage, createSystemMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { CompactionTelemetry, type CompactionTelemetryResult } from '../src/telemetry.js';
import { CacheFirstCompactionEngine } from '../src/engine.js';
import { createDiagnosticSink, diagnosticProjection, diagnosticRecordSchema, registerDiagnostics } from '../src/diagnostics.js';

const contexts: Context[] = [];
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); });
function fixture() {
  const ctx = new Context(); contexts.push(ctx);
  const projection = new SessionProjectionRegistry(ctx);
  const sink = registerDiagnostics(ctx);
  const telemetry = new CompactionTelemetry(ctx, sink);
  const session = Session.create(SessionId('diagnostics'));
  return { ctx, projection, sink, telemetry, session };
}
function records(session: Session) { return session.snapshotEvents().flatMap(event => { const r = pluginRecordOf(event); return r ? [r] : []; }); }

async function legacyFixture() {
  const f = fixture();
  const id = CompactionId('legacy');
  const start = f.session.append('compaction/start', { compactionId: id, turn: null });
  let result!: CompactionTelemetryResult;
  const rawUsage = { inputTokens: 6215, outputTokens: 3891, totalTokens: 16250, cacheReadTokens: 6144 };
  await new CompactionTelemetry(f.ctx, (_session, value) => { result = value; }).summary(f.session, undefined,
    async () => ({ provider: 'mock', model: 'test', llmStreamCall: true, usage: rawUsage }));
  const summaryData = { compactionId: id, summary: [], shadowedRange: { start: start.seq, end: start.seq },
    shadowedSeqs: [], shadowedTokenCount: 1, provider: 'mock', model: 'test', usage: rawUsage };
  const summary = f.session.append('compaction/summary', summaryData);
  f.session.append('compaction/end', { compactionId: id, turn: null });
  // Reproduce the original writer: partial components, no preserved total/denominator.
  for (const usage of [result.usage, result.calls[0]!.usage]) {
    delete usage.totalTokens; usage.promptTokens = null; usage.cacheHitRatio = null;
  }
  result.summaryEventSeqs = [summary.seq];
  const record = diagnosticRecordSchema.parse({ schemaVersion: 1, sessionId: f.session.id,
    operationId: result.operationId, summaryEventSeqs: [summary.seq], compactionIds: [id],
    trigger: result.trigger, status: result.status, decisions: result.decisions, result });
  return { ...f, record, summary, summaryData };
}

describe('legacy projection-only usage recovery', () => {
  it('recovers the exact linked legacy total as 49.7% without mutating source data', async () => {
    const f = await legacyFixture();
    appendPluginRecord(f.session, 'plugin:smart-compaction/diagnostic', f.record);
    const event = f.session.snapshotEvents().at(-1)!;
    const before = structuredClone(f.session.snapshotEvents());
    const state = f.projection.snapshot(f.session).values.smartCompaction!;
    expect(state.records[0]!.result.usage).toMatchObject({ totalTokens: 16250, promptTokens: 12359,
      cacheReadTokens: 6144, cacheWriteTokens: null, cacheHitRatio: 6144 / 12359 });
    expect((state.records[0]!.result.usage.cacheHitRatio! * 100).toFixed(1)).toBe('49.7');
    expect(state.records[0]!.result.calls[0]!.usage.totalTokens).toBe(16250);
    expect(f.session.snapshotEvents()).toEqual(before);
    expect(f.session.snapshotEvents().at(-1)).toBe(event);
    expect(f.record.result.usage.totalTokens).toBeUndefined();
    expect(state).not.toHaveProperty('summaries');
    const checkpoint = f.projection.checkpoint(f.session);
    expect(checkpoint.smartCompaction!.ver).toBe(2);
    expect(f.projection.viewCheckpoint(checkpoint).smartCompaction).toEqual(state);
    const old = { smartCompaction: { ...checkpoint.smartCompaction!, ver: 1 } };
    expect(f.projection.viewCheckpoint(old)).toEqual({});
    expect(f.projection.restoreFloor(old)).toBe(0);
    const replay = f.session.snapshotEvents().reduce<Parameters<typeof diagnosticProjection.apply>[0]>((s, e) => diagnosticProjection.apply(s, e), diagnosticProjection.init(f.session.header));
    expect(diagnosticProjection.wire.view(replay)).toEqual(state);
  });

  it.each(['seq', 'id', 'result-seq', 'result-id', 'call-counter', 'aggregate-counter', 'subtotal-counter', 'retry', 'failed', 'newer', 'missing-read'] as const)(
    'does not infer usage for %s evidence', async kind => {
      const f = await legacyFixture(); const r = f.record.result;
      if (kind === 'seq') { f.record.summaryEventSeqs = [999]; r.summaryEventSeqs = [999]; }
      if (kind === 'id') { f.record.compactionIds = ['other']; r.compactionIds = ['other']; r.attempts[0]!.compactionId = 'other'; }
      if (kind === 'result-seq') r.summaryEventSeqs = [999];
      if (kind === 'result-id') r.compactionIds = ['other'];
      if (kind === 'call-counter') r.calls[0]!.usage.inputTokens = 6216;
      if (kind === 'aggregate-counter') r.usage.outputTokens = 3892;
      if (kind === 'subtotal-counter') r.knownUsageTotals.cacheReadTokens = 6143;
      if (kind === 'retry') { r.summaryAttempts = 2; r.attempts.push({ ...r.attempts[0]!, index: 2 }); }
      if (kind === 'failed') r.calls[0]!.status = 'error';
      if (kind === 'newer' || kind === 'missing-read') {
        r.usage.totalTokens = null; r.calls[0]!.usage.totalTokens = null;
        if (kind === 'missing-read') { r.usage.totalTokens = 16250; r.calls[0]!.usage.totalTokens = 16250;
          r.usage.cacheReadTokens = null; r.calls[0]!.usage.cacheReadTokens = null; }
      }
      appendPluginRecord(f.session, 'plugin:smart-compaction/diagnostic', f.record);
      expect(f.projection.snapshot(f.session).values.smartCompaction!.records[0]).toEqual(f.record);
    });

  it('retains bounded evidence across a host-state checkpoint without exposing it', async () => {
    const f = await legacyFixture();
    f.projection.snapshot(f.session);
    const row = f.projection.checkpoint(f.session).smartCompaction!;
    const restored = diagnosticProjection.stateSchema.parse(JSON.parse(JSON.stringify(row.val)));
    appendPluginRecord(f.session, 'plugin:smart-compaction/diagnostic', f.record);
    const next = diagnosticProjection.apply(restored, f.session.snapshotEvents().at(-1)!);
    expect(next.records[0]!.result.usage.cacheHitRatio).toBe(6144 / 12359);
    expect(diagnosticProjection.wire.view(next)).not.toHaveProperty('summaries');
  });

  it('never backfills an earlier diagnostic from a future summary', async () => {
    const f = await legacyFixture();
    // Deliberately claim the future sequence while keeping both arrays consistent.
    const futureSeq = Number(f.session.seq) + 1;
    f.record.summaryEventSeqs = [futureSeq]; f.record.result.summaryEventSeqs = [futureSeq];
    appendPluginRecord(f.session, 'plugin:smart-compaction/diagnostic', f.record);
    const future = f.session.append('compaction/summary', f.summaryData);
    expect(future.seq).toBe(futureSeq);
    expect(f.projection.snapshot(f.session).values.smartCompaction!.records[0]).toEqual(f.record);
  });

  it('bounds persisted metadata, retains only seq/id/usage and omits it from the wire', async () => {
    const f = await legacyFixture();
    for (let i = 0; i < 70; i++) f.session.append('compaction/summary', f.summaryData);
    const state = f.projection.stateOf(f.session, 'smartCompaction')!;
    expect(state.summaries).toHaveLength(64);
    expect(Object.keys(state.summaries![0]!).sort()).toEqual(['compactionId', 'seq', 'usage']);
    expect(f.projection.snapshot(f.session).values.smartCompaction).not.toHaveProperty('summaries');
    appendPluginRecord(f.session, 'plugin:smart-compaction/diagnostic', f.record);
    expect(f.projection.snapshot(f.session).values.smartCompaction!.records[0]).toEqual(f.record);
  });
});

describe('durable public diagnostics', () => {
  it('omits routine no-ops but retains failed operations without error text or surface changes', async () => {
    const f = fixture(); const before = f.session.surface.replaceGeneration;
    for (let i = 0; i < 10; i++) await f.telemetry.operation(f.session, 'pressure', undefined, async () => {});
    expect(records(f.session)).toHaveLength(0);
    await expect(f.telemetry.operation(f.session, 'pressure', undefined, async () => { throw new Error('SECRET'); })).rejects.toThrow('SECRET');
    expect(records(f.session)).toHaveLength(1);
    expect(f.session.surface.replaceGeneration).toBe(before);
    const state = f.projection.snapshot(f.session).values.smartCompaction!;
    expect(state.records[0]!.result).toMatchObject({ status: 'error', preTokens: null, postTokens: null, modelCalls: 0 });
    expect(JSON.stringify(state)).not.toContain('SECRET');
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('bounds state, replays records and ignores malformed or future diagnostics', async () => {
    const f = fixture();
    for (let i = 0; i < 70; i++) await f.telemetry.summary(f.session, undefined, async () => ({ provider: 'mock', model: 'test' }));
    const state = f.projection.snapshot(f.session).values.smartCompaction!;
    expect(state.records).toHaveLength(64);
    const replay = f.session.snapshotEvents().reduce((state, event) => diagnosticProjection.apply(state, event), { schemaVersion: 1, sessionId: f.session.id, records: [] } as typeof state);
    expect(replay).toEqual(state);
    expect(diagnosticRecordSchema.safeParse({ ...state.records[0], schemaVersion: 2 }).success).toBe(false);
    expect(diagnosticRecordSchema.safeParse({ ...state.records[0], result: { ...state.records[0]!.result, postTokens: NaN } }).success).toBe(false);
    const event = f.session.snapshotEvents().at(-1)!;
    expect(diagnosticProjection.apply(state, { ...event, data: { invalid: true } } as unknown as typeof event)).toBe(state);
  });

  it('isolates synchronous and asynchronous sink failures from execution', async () => {
    const f = fixture();
    for (const sink of [() => { throw new Error('sink'); }, async () => { throw new Error('sink'); }]) {
      const telemetry = new CompactionTelemetry(f.ctx, sink);
      await expect(telemetry.operation(f.session, 'manual', undefined, async () => 42)).resolves.toBe(42);
    }
  });

  it('defers a standalone summary hook until a safe boundary and correlates by transaction ID', async () => {
    const f = fixture(); const id = CompactionId('late');
    f.session.append('compaction/start', { compactionId: id, turn: null });
    await f.telemetry.summary(f.session, undefined, async () => ({ provider: 'mock', model: 'test' }));
    expect(records(f.session)).toHaveLength(0);
    const start = f.session.snapshotEvents()[0]!.seq;
    const seq = f.session.append('compaction/summary', { compactionId: id, summary: [], shadowedRange: { start, end: start }, shadowedSeqs: [], shadowedTokenCount: 1, provider: 'mock', model: 'test' });
    f.session.append('compaction/end', { compactionId: id, turn: null });
    await f.telemetry.operation(f.session, 'pressure', undefined, async () => {});
    const state = f.projection.snapshot(f.session).values.smartCompaction!;
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({ trigger: 'summary-hook', summaryEventSeqs: [seq.seq], compactionIds: [id] });
  });

  it('keeps meaningful prune-only results, and ignores invalid unsafe JSON', async () => {
    const f = fixture(); let result!: CompactionTelemetryResult;
    const telemetry = new CompactionTelemetry(f.ctx, (_session, value) => { result = value; });
    await telemetry.operation(f.session, 'pressure', undefined, async () => {});
    const sink = createDiagnosticSink();
    await sink(f.session, { ...result, surfaceChanged: true });
    expect(records(f.session)).toHaveLength(1);
    await sink(f.session, { ...result, operationId: 'bad', surfaceChanged: true, postTokens: Infinity });
    expect(records(f.session)).toHaveLength(1);
  });

  it('reports invalid diagnostics once without exposing their payload or observer failures', async () => {
    const f = fixture(); let result!: CompactionTelemetryResult;
    await new CompactionTelemetry(f.ctx, (_session, value) => { result = value; }).operation(f.session, 'manual', undefined, async () => {});
    const failures: string[] = [];
    const sink = createDiagnosticSink(reason => { failures.push(reason); throw new Error('observer-secret'); });
    for (let i = 0; i < 2; i++) await expect(Promise.resolve(sink(f.session, {
      ...result, surfaceChanged: true, postTokens: Infinity,
    }))).resolves.toBeUndefined();
    expect(failures).toEqual(['invalid-record']);
    expect(records(f.session)).toHaveLength(0);
  });

  it('reports append failures once and leaves compaction successful', async () => {
    const f = fixture(); let result!: CompactionTelemetryResult;
    await new CompactionTelemetry(f.ctx, (_session, value) => { result = value; }).operation(f.session, 'manual', undefined, async () => {});
    const failures: string[] = [];
    const sink = createDiagnosticSink(reason => { failures.push(reason); });
    // Structural foreign Session: public reads work, this module's private append brand cannot.
    const foreign = { snapshotEvents: () => [] } as unknown as Session;
    for (let i = 0; i < 2; i++) await expect(Promise.resolve(sink(foreign, {
      ...result, surfaceChanged: true,
    }))).resolves.toBeUndefined();
    expect(failures).toEqual(['append-failed']);
    expect(records(f.session)).toHaveLength(0);
  });

  it('demonstrates why the host Session package must be shared across installations', () => {
    // A separate Node process avoids Vitest's module graph collapsing the two URLs.
    // No provider, server, existing session, or filesystem mutation is involved.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const url = import.meta.resolve('@deepseek-ai/dsh-session');
      const host = await import(url);
      const other = await import(url + '?separate-session-installation');
      const session = host.Session.create('cross-install-proof');
      let rejected = false;
      try { other.appendPluginRecord(session, 'plugin:smart-compaction/diagnostic', {}); }
      catch (error) { rejected = error instanceof TypeError; }
      console.log(JSON.stringify({ rejected, seq: session.seq, distinct: host.Session !== other.Session }));
    `], { cwd: process.cwd(), encoding: 'utf8' });
    expect(JSON.parse(output.trim())).toEqual({ rejected: true, seq: 0, distinct: true });
  });

  it('persists real manual-engine diagnostics with public stream hooks and partial cache usage', async () => {
    const f = fixture();
    new LlmRuntime(f.ctx);
    // Short-circuit the public stream chain: exercise the real runtime, no adapter/network.
    f.ctx.on('llm/stream', () => (async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'Brief.' };
      yield { type: 'usage', usage: { inputTokens: 5220, outputTokens: 2764, totalTokens: 14128, cacheReadTokens: 6144 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })());
    // Model metadata only; the stream still traverses the real public middleware.
    f.ctx.llm.resolveModelInfo = async () => ({ provider: 'mock', id: 'test', name: 'Test', context: { contextWindow: 10000 } });
    new TokenMeter(f.ctx);
    f.ctx.provide('sessions', { flush: async () => {} });
    const engine = new CacheFirstCompactionEngine(f.ctx, { base: { auto: false, retainTokens: 1, maxTokens: 80, headroomTokens: 100 } }, f.sink);
    f.session.append('system/message', { turn: 0, step: 0, message: createSystemMessage('system') }, { surfaceOp: 'append' });
    f.session.append('request/header', { header: { config: { provider: 'mock', model: 'test' } }, reason: 'initial' });
    f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'old '.repeat(1000) }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'recent' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const agent = { session: f.session, options: { provider: 'mock', model: 'test' },
      runMaintenance: (run: (signal: AbortSignal) => Promise<unknown>) => run(new AbortController().signal) } as Agent;
    const result = await engine.compactNow(agent, new AbortController().signal);
    expect(result).not.toBeNull();
    const state = f.projection.snapshot(f.session).values.smartCompaction!;
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({ trigger: 'manual', summaryEventSeqs: [result!.summarySeq],
      result: { status: 'success', summaryAttempts: 1, llmStreamCalls: 1, unknownSummaryAttempts: 0,
        usage: { inputTokens: 5220, outputTokens: 2764, cacheReadTokens: 6144, cacheWriteTokens: null, promptTokens: 11364, cacheHitRatio: 6144 / 11364 },
        calls: [{ evidence: 'llm/stream' }] } });
    const events = f.session.snapshotEvents();
    const index = events.findIndex(event => event.seq === result!.summarySeq);
    expect(events.slice(index, index + 4).map(event => event.type)).toEqual([
      'compaction/summary', 'user/message', 'compaction/end', 'plugin:smart-compaction/diagnostic',
    ]);
    expect(events[index + 1]!.surfaceOp).toMatchObject({ op: 'replace' });
  });

  it('links completed manual/region summaries without changing summary replacement adjacency', async () => {
    const f = fixture();
    f.ctx.provide('llm', {
      resolveModelInfo: async () => ({ context: { contextWindow: 10000 } }), imageRequestPricing: () => undefined,
      stream: () => (async function* (): AsyncIterable<StreamChunk> { yield { type: 'text-delta', index: 0, text: 'Brief.' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(),
    });
    new TokenMeter(f.ctx);
    const engine = new CacheFirstCompactionEngine(f.ctx, { base: { auto: false, retainTokens: 1, maxTokens: 80, headroomTokens: 100 } }, f.sink);
    f.session.append('turn/start', { turn: 0 });
    f.session.append('system/message', { turn: 0, step: 0, message: createSystemMessage('system') }, { surfaceOp: 'append' });
    f.session.append('request/header', { header: { config: { provider: 'mock', model: 'test' } }, reason: 'initial' });
    const start = f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'old '.repeat(1000) }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'recent' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const agent = { session: f.session, options: { provider: 'mock', model: 'test' } } as Agent;
    await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(records(f.session)).toHaveLength(0);
    await engine.compactRegion(start.seq, start.seq, agent);
    const state = f.projection.snapshot(f.session).values.smartCompaction!;
    expect(state.records).toHaveLength(1);
    const events = f.session.snapshotEvents();
    const summaryIndex = events.findIndex(event => event.type === 'compaction/summary');
    expect(events[summaryIndex + 1]!.type).toBe('user/message');
    expect(events[summaryIndex + 1]!.surfaceOp).toMatchObject({ op: 'replace' });
    expect(state.records[0]!.summaryEventSeqs).toEqual([events[summaryIndex]!.seq]);
    expect(state.records[0]!.result.preTokens).toBeGreaterThan(state.records[0]!.result.postTokens!);
    expect(state.records[0]!.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'summary', reason: 'execute selected balanced region', removedTokens: expect.any(Number) })]));
    expect(events.at(-1)?.type).toBe('plugin:smart-compaction/diagnostic');
  });
});
