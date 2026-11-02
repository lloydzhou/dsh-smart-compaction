import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import LlmRuntime, { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { CompactionTelemetry } from '../src/telemetry.js';

const contexts: Context[] = [];
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); });
function fixture() {
  const ctx = new Context(); contexts.push(ctx);
  const records: any[] = [];
  ctx.logger.exporter({ export: record => { if ((record.args[0] as any)?.event === 'cache-first-compaction/result') records.push(record.args[0]); } });
  const telemetry = new CompactionTelemetry(ctx);
  const session = Session.create(SessionId('test'));
  return { ctx, records, telemetry, session };
}
const result = { provider: 'mock', model: 'test', llmStreamCall: true as const };
const options: GenerateOptions = { provider: 'mock', model: 'test', messages: [], sessionId: SessionId('test'), purpose: 'compaction' };

describe('telemetry scope and uncertainty', () => {
  it('records no-route failures as attempts, not known stream calls', async () => {
    const f = fixture();
    await expect(f.telemetry.summary(f.session, undefined, async () => { throw new Error('no route'); })).rejects.toThrow('no route');
    expect(f.records[0]).toMatchObject({ summaryAttempts: 1, llmStreamCalls: 0, unknownSummaryAttempts: 1, modelCalls: null, usage: { inputTokens: null } });
  });
  it('observes real public LlmRuntime NO_ADAPTER without claiming dispatch', async () => {
    const f = fixture(); const llm = new LlmRuntime(f.ctx);
    await f.telemetry.summary(f.session, undefined, async () => {
      for await (const _chunk of llm.stream(options)) { /* telemetry alone consumes no message content */ }
      return { provider: 'mock', model: 'test' };
    });
    expect(f.records[0]).toMatchObject({ llmStreamCalls: 1, modelCalls: null, providerDispatch: 'unknown', calls: [{ status: 'error', usage: { inputTokens: null } }] });
  });
  it('keeps known-only totals separate from incomplete aggregate accounting', async () => {
    const f = fixture();
    await f.telemetry.operation(f.session, 'test', undefined, async () => {
      await f.telemetry.summary(f.session, undefined, async () => ({ ...result, usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 70, cacheWriteTokens: 10 } }));
      await f.telemetry.summary(f.session, undefined, async () => ({ ...result, usage: { inputTokens: 2, outputTokens: 1 } }));
      await f.telemetry.summary(f.session, undefined, async () => result);
    });
    expect(f.records[0]).toMatchObject({ summaryAttempts: 3, llmStreamCalls: 3, knownUsageCalls: 1, unknownUsageCalls: 2,
      usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheHitRatio: null },
      knownUsageTotals: { inputTokens: 22, outputTokens: 6, cacheReadTokens: 70, cacheWriteTokens: 10 } });
  });
  it('does not attribute unrelated or concurrent session streams by timing', async () => {
    const f = fixture(); const second = Session.create(SessionId('second'));
    const stream = async function* (): AsyncIterable<StreamChunk> { yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }; };
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const first = f.telemetry.summary(f.session, undefined, async () => {
      await barrier;
      for await (const _ of f.ctx.waterfall('llm/stream', { ...options, purpose: 'session-title' }, stream)) {}
      for await (const _ of f.ctx.waterfall('llm/stream', options, stream)) {}
      return result;
    });
    await f.telemetry.summary(second, undefined, async () => {
      for await (const _ of f.ctx.waterfall('llm/stream', { ...options, sessionId: SessionId('second') }, stream)) {}
      return result;
    });
    release(); await first;
    expect(f.records).toHaveLength(2);
    expect(f.records.map(record => record.sessionId)).toEqual(['second', 'test']);
    expect(f.records.every(record => record.llmStreamCalls === 1 && record.summaryAttempts === 1)).toBe(true);
    expect(f.records[0].operationId).not.toBe(f.records[1].operationId);
  });
});
