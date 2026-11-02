import { describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { formatTokens, collapsedFacts, diagnosticRows, parseWireDiagnostic, matchDiagnostic, nativeSummaryLabel, parseDiagnostic, type CompactionDiagnostic } from '../client/model.js';
import { defaultT, en, zh } from '../client/locales.js';
import { styles } from '../client/styles.js';

const record = (): CompactionDiagnostic => ({
  operationId: 'op-1', sessionId: 'session-1', summaryEventSeq: 42, compactionId: 'compact-1',
  trigger: 'pressure', status: 'success', reasonCode: 'configured-policy', summaryAttempts: 2,
  llmStreamCalls: 2, modelCalls: null, providerDispatch: 'unknown', unknownUsageCalls: 0, unknownSummaryAttempts: 0,
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 0, promptTokens: 500, cacheHitRatio: 0.8 },
});
const wireRecord = (value = record()) => ({ schemaVersion: 1, sessionId: value.sessionId, operationId: value.operationId,
  summaryEventSeqs: [value.summaryEventSeq, 43], compactionIds: ['compact-1'], trigger: value.trigger, status: value.status,
  decisions: [{ action: 'policy', reason: 'configured policy', totalTokens: 1200, hardThresholdTokens: 1000,
    effectiveThresholdTokens: 1000, projectedPruneTokens: null, retainTokens: 100, retainedTokens: null, removedTokens: null, safetyOverride: false }],
  result: { ...value, summaryEventSeqs: [value.summaryEventSeq, 43], compactionIds: ['compact-1'], preTokens: 1200, postTokens: 500 },
});
const projection = (records: unknown[] = [record()]) => ({ schemaVersion: 1, sessionId: 'session-1', records: records.map(value => wireRecord(value as CompactionDiagnostic)) });

describe('public client renderer', () => {
  it('matches the published host compact token formatter at thresholds', () => {
    const source = readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-ui-chat/client'), 'utf8');
    const start = source.indexOf('function formatTokens(');
    const end = source.indexOf('function formatExactTokens(', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const native = runInContext(`${source.slice(start, end)}; formatTokens`, createContext({}));
    for (const n of [0, 517, 999, 1000, 1200, 12200, 90004, 99999, 100000, 131086, 999999, 1000000, 1234567]) {
      expect(formatTokens(n, defaultT)).toBe(native(n, defaultT));
    }
    expect(formatTokens(90004, defaultT)).toBe('90K');
  });
  it('retains native small typography, single icon seat and sticky expanded header', () => {
    expect(styles).toContain('font-size:var(--dsh-content-font-size-secondary,13px)');
    expect(styles).toContain('position:sticky;top:0;z-index:7');
    expect(styles).toContain('background:var(--dsw-alias-bg-base)');
    expect(styles).toContain('.dsh-smart-compaction-body :has(>[data-code-block-banner]){top:var(--dsh-compaction-header-height)}');
    expect(styles).toContain('grid-area:1/1');
    expect(styles).toContain('.dsh-smart-compaction-disclosure-icon{opacity:0}');
    expect(styles).toContain(':hover .dsh-smart-compaction-context-icon{opacity:0}');
    expect(styles).toContain(':hover .dsh-smart-compaction-disclosure-icon{opacity:1}');
    expect(styles).toContain('flex-wrap:nowrap;white-space:nowrap');
    expect(styles).not.toContain('max-height');
  });
  it('loads with host-only externals and preserves native summary without projection', () => {
    const output = buildSync({ entryPoints: ['client/index.ts'], bundle: true, platform: 'browser', format: 'cjs', write: false,
      external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] }).outputFiles[0]!.text;
    const imports: string[] = [];
    const module = { exports: {} as Record<string, (...args: any[]) => any> };
    const tree = (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children });
    const react = { createElement: tree, useState: () => [true, () => {}], useId: () => 'body', useEffect: () => {}, useMemo: (fn: () => unknown) => fn() };
    const context = createContext({ module, exports: module.exports, require: (id: string) => {
      imports.push(id);
      if (id === 'react') return react;
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: 'StockMarkdown', IconApiOutlineRegular: 'ContextIcon', IconChevronDownOutlineRegular: 'Down', IconChevronRightOutlineRegular: 'Right' };
      throw new Error(`Unexpected bundled import: ${id}`);
    } });
    runInContext(output, context);
    expect(imports.sort()).toEqual(['@deepseek-ai/dsh-client-ui-primitives', 'react']);
    const props = { node: { data: { seq: 50, summary: 'UNCHANGED STOCK SUMMARY', summaryEventSeq: 42, shadowedItemCount: 4, shadowedTokenCount: 1200 } },
      sessionId: 'session-1', useProjection: (key: string) => { expect(key).toBe('smartCompaction'); return undefined; } };
    const fallback = JSON.stringify(module.exports.CompactionRenderer!(props));
    expect(fallback).toContain('StockMarkdown');
    expect(fallback).toContain('UNCHANGED STOCK SUMMARY');
    expect(fallback).toContain('4 items · ~1.2K tokens compacted');
    expect(fallback).not.toContain('Decision & observed usage');
    // Projection JSON is decoded in the browser realm, just like real RPC frames.
    context.propsJson = JSON.stringify(props); context.projectionJson = JSON.stringify(projection());
    const enriched = runInContext(`const p=JSON.parse(propsJson); p.useProjection=()=>JSON.parse(projectionJson); JSON.stringify(module.exports.CompactionRenderer(p))`, context);
    expect(enriched).toContain('Decision & observed usage');
    expect(enriched).toContain('UNCHANGED STOCK SUMMARY');
    expect(enriched.indexOf('Decision & observed usage')).toBeLessThan(enriched.indexOf('UNCHANGED STOCK SUMMARY'));
  });
});

// Execute the actual published projection definitions, not a hand-written mock
// of manual-compaction's payload. Override source path to repeat against rc3.
function publishedProjection() {
  const source = readFileSync(process.env.DSH_CHAT_SOURCE ?? createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-ui-chat/client'), 'utf8');
  const start = source.indexOf('const SURFACE_EVENT_TYPES =');
  const end = source.indexOf('//#region lib/types/client/conversation-nodes/fallback.js', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  return runInContext(`${source.slice(start, end)}; ({commandDefinition, compactionDefinition})`, createContext({
    // Only the generic final-node envelope is stubbed; all event matching,
    // lifecycle folding and payload construction are published production code.
    chatNode: (_context: unknown, kind: string, anchorSeq: number, data: unknown) => ({ kind, anchorSeq, data }),
  }));
}
function manualFixture(options: { checkpoint?: boolean; summary?: boolean; done?: boolean; error?: boolean } = {}) {
  const defs = publishedProjection();
  const event = (type: string, seq: number, data: unknown, surfaceOp?: unknown) => ({ type, seq, time: seq, data, surfaceOp });
  const events = [event('command/run', 40, { commandId: 'cmd-1', name: 'compact' })];
  if (options.summary !== false) events.push(event('compaction/summary', 42, { sourceCommandId: 'cmd-1', compactionId: 'compact-1',
    summary: [{ type: 'text', text: 'ONE ORIGINAL SUMMARY' }], shadowedSeqs: [1, 2, 3, 4], shadowedTokenCount: 1200 }));
  if (options.checkpoint !== false) events.push(event('user/message', 50, { source: { kind: 'compact-checkpoint', sourceCommandId: 'cmd-1', compactionId: 'compact-1' } }, { replacedSeqs: [1, 2, 3, 4] }));
  if (options.done !== false) events.push(event('command/done', 51, { commandId: 'cmd-1', kind: options.error ? 'error' : 'success', text: options.error ? 'Failed first line\nFailure detail' : 'Native command result', sourceEventSeq: 50 }));
  const context: any = { matches: [], state: undefined };
  for (const event of events) {
    expect(defs.compactionDefinition.match(event)).toBeNull(); // never a second compaction row
    const match = { event, ...defs.commandDefinition.match(event) };
    expect(match.id).toBe('cmd-1'); context.matches.push(match);
    context.state = match.role === 'start' ? defs.commandDefinition.start(context, match) : defs.commandDefinition.update(context, match);
  }
  return defs.commandDefinition.buildViewNode(context);
}
function manualHarness(expanded = true) {
  const output = buildSync({ entryPoints: ['client/index.ts'], bundle: true, platform: 'browser', format: 'cjs', write: false,
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] }).outputFiles[0]!.text;
  const module = { exports: {} as any }; const registrations: string[] = [];
  let toggle: (() => void) | undefined;
  const tree = (type: any, props: any, ...children: any[]): any => typeof type === 'function' ? type(props) : { type, props, children };
  const context = createContext({ module, exports: module.exports, require: (id: string) => {
    if (id === 'react') return { createElement: tree, useState: () => [expanded, (fn: any) => { expanded = typeof fn === 'function' ? fn(expanded) : fn; }], useId: () => 'body', useEffect: () => {}, useMemo: (fn: any) => fn() };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: 'StockMarkdown', IconApiOutlineRegular: 'ContextIcon', IconChevronDownOutlineRegular: 'Down', IconChevronRightOutlineRegular: 'Right' };
    throw Error(`Private import: ${id}`);
  } });
  runInContext(output, context);
  module.exports.apply({ effect: () => {}, slots: { inject: (_: string, fn: any) => { for (const _dispose of fn()) { /* collect registration effects */ } }, register: (options: any) => { registrations.push(options.key); return () => {}; } } });
  return { registrations, render(node: unknown, payload: unknown = projection(), sessionId = 'session-1', chinese = false) {
    context.input = JSON.stringify({ node, sessionId }); context.payload = JSON.stringify(payload); context.dictionary = chinese ? zh : en;
    const result = runInContext(`(()=>{const p=JSON.parse(input);p.useProjection=()=>JSON.parse(payload);p.t=(key,values)=> (dictionary[key]??key).replace(/\\{(\\w+)\\}/g,(m,k)=>String(values?.[k]??m));return module.exports.ManualCompactionRenderer(p)})()`, context);
    toggle = result.children[0].props.onClick;
    return JSON.stringify(result);
  }, toggle: () => toggle?.() };
}

describe('manual compaction with real published projection', () => {
  it('maps command and checkpoint to exactly one registered, enriched summary', () => {
    const node = manualFixture();
    expect(node.kind).toBe('manual-compaction'); expect(node.data.compaction.summaryEventSeq).toBe(42);
    expect(node.data.compaction.seq).toBe(50); expect(node.data.command.outcome.sourceEventSeq).toBe(50);
    const harness = manualHarness();
    expect(harness.registrations).toEqual(['compaction', 'manual-compaction']);
    const result = harness.render(node);
    expect(result).toContain('4 items · ~1.2K tokens compacted'); expect(result).toContain('2 calls');
    expect(result.match(/ONE ORIGINAL SUMMARY/g)).toHaveLength(1);
    expect(result.indexOf('Decision & observed usage')).toBeLessThan(result.indexOf('ONE ORIGINAL SUMMARY'));
    expect(result).not.toContain('Native command result');
  });
  it('keeps exact summary/session matching and safely falls back for old sessions', () => {
    const node = manualFixture(); const harness = manualHarness();
    for (const payload of [null, projection([{ ...record(), summaryEventSeq: 50 }]), { ...projection(), sessionId: 'other-session' }]) {
      const result = harness.render(node, payload);
      expect(result).toContain('ONE ORIGINAL SUMMARY'); expect(result).not.toContain('observed stream calls');
    }
    expect(harness.render(node, projection(), 'other-session')).not.toContain('observed stream calls');
    expect(harness.render(manualFixture({ summary: false }))).toContain('Native command result');
  });
  it('preserves running, error and no-checkpoint command states without false diagnostics', () => {
    const harness = manualHarness();
    const running = harness.render(manualFixture({ checkpoint: false, summary: false, done: false }));
    expect(running).toContain('Compacting context…'); expect(running).toContain('"aria-busy":true');
    const failed = harness.render(manualFixture({ checkpoint: false, summary: false, error: true }));
    expect(failed).toContain('Failure detail'); expect(failed).toContain('"data-state":"error"');
    expect(failed).not.toContain('StockMarkdown'); expect(failed).not.toContain('observed stream calls');
    const noCheckpoint = harness.render(manualFixture({ checkpoint: false }));
    expect(noCheckpoint).toContain('Native command result'); expect(noCheckpoint).not.toContain('ONE ORIGINAL SUMMARY');
  });
  it('starts collapsed, exposes a keyboard button, toggles, and localizes', () => {
    const harness = manualHarness(false); const node = manualFixture();
    const collapsed = harness.render(node);
    expect(collapsed).toContain('"type":"button"'); expect(collapsed).toContain('"aria-expanded":false');
    expect(collapsed).not.toContain('ONE ORIGINAL SUMMARY'); expect(collapsed).toContain('2 calls');
    harness.toggle();
    expect(harness.render(node)).toContain('"aria-expanded":true');
    expect(harness.render(node, projection(), 'session-1', true)).toContain('决策与实际观测用量');
  });
});

describe('client projection correlation and native fallback', () => {
  it('keeps native summary and count labels without diagnostics', () => {
    const node = { summary: 'Original stock summary', summaryEventSeq: 42, shadowedItemCount: 4, shadowedTokenCount: 1200 };
    expect(matchDiagnostic(undefined, 'session-1', 42)).toBeUndefined();
    expect(nativeSummaryLabel(node, defaultT)).toBe('4 items · ~1.2K tokens compacted');
    expect(node.summary).toBe('Original stock summary');
    expect(nativeSummaryLabel({ ...node, shadowedItemCount: null }, defaultT)).toBe('Show summary');
    expect(nativeSummaryLabel({ ...node, summary: null, shadowedTokenCount: null }, defaultT)).toBe('Summary unavailable');
  });
  it('matches exact session and summary only, without latest-operation fallback', () => {
    expect(matchDiagnostic(projection(), 'session-1', 42)?.operationId).toBe('op-1');
    expect(matchDiagnostic(projection(), 'session-1', 43)?.operationId).toBe('op-1');
    for (const seq of [null, 41, 44]) expect(matchDiagnostic(projection(), 'session-1', seq)).toBeUndefined();
    expect(matchDiagnostic(projection(), 'session-2', 42)).toBeUndefined();
    expect(matchDiagnostic(projection([{ ...record(), sessionId: 'session-2' }]), 'session-1', 42)).toBeUndefined();
    expect(matchDiagnostic(projection([record(), { ...record(), operationId: 'op-2' }]), 'session-1', 42)).toBeUndefined();
    expect(matchDiagnostic({ ...projection(), schemaVersion: 2 }, 'session-1', 42)).toBeUndefined();
  });
});

describe('honest usage presentation', () => {
  it('uses a short singular label and retains explicitly known zero', () => {
    const value = record(); value.llmStreamCalls = 1;
    expect(collapsedFacts(value, defaultT)).toBe('1 call · cache hit 80.0%');
    value.usage.cacheHitRatio = 0;
    expect(collapsedFacts(value, defaultT)).toBe('1 call · cache hit 0.0%');
    value.usage.cacheHitRatio = null;
    expect(collapsedFacts(value, defaultT)).toBe('1 call');
  });
  it('explains missing reads separately from missing totals without changing native UI', () => {
    const missingRead = record();
    missingRead.usage = { inputTokens: 12115, outputTokens: 3743, totalTokens: 15858, cacheReadTokens: null, cacheWriteTokens: null, promptTokens: 12115, cacheHitRatio: null };
    const parsed = parseDiagnostic(missingRead)!;
    expect(collapsedFacts(parsed, defaultT)).toBe('2 calls');
    expect(diagnosticRows(parsed, defaultT).find(row => row.label === 'Cache-hit ratio')?.value).toContain('zero or unreported');
    expect(collapsedFacts(parsed, defaultT)).not.toContain('0.0%');
    const noTotal = record();
    noTotal.usage = { inputTokens: 6215, outputTokens: 3891, cacheReadTokens: 6144, cacheWriteTokens: null, promptTokens: null, cacheHitRatio: null };
    expect(collapsedFacts(parseDiagnostic(noTotal), defaultT)).toBe('2 calls');
  });
  it('never converts missing cache to zero or invents cache-hit ratio', () => {
    const value = record();
    value.usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: null, cacheWriteTokens: null, promptTokens: null, cacheHitRatio: null };
    const parsed = parseDiagnostic(value)!;
    expect(parsed).toBeDefined();
    const rows = diagnosticRows(parsed, defaultT);
    for (const label of ['Cache-read tokens', 'Cache-write tokens', 'Total prompt tokens'])
      expect(rows.find(row => row.label === label)?.value).toBe('Unknown');
  });
  it('separates observed streams from unknowable billed model requests', () => {
    const rows = diagnosticRows(record(), defaultT);
    expect(rows.find(row => row.label === 'Observed LLM stream calls')?.value).toBe('2');
    expect(rows.find(row => row.label === 'Billed model requests')?.value).toBe('Unknown');
    expect(parseDiagnostic({ ...record(), modelCalls: 2 })).toBeUndefined();
    expect(parseDiagnostic({ ...record(), modelCalls: 0 })).toBeUndefined();
    expect(parseDiagnostic({ ...record(), modelCalls: 0, providerDispatch: 'none', summaryAttempts: 0, llmStreamCalls: 0 })).toBeDefined();
  });
  it('keeps measured zero distinct from missing values', () => {
    expect(diagnosticRows(record(), defaultT).find(row => row.label === 'Cache-write tokens')?.value).toBe('0');
    expect(diagnosticRows(record(), defaultT).find(row => row.label === 'Cache-hit ratio')?.value).toBe('80.0%');
  });
});

describe('untrusted diagnostic payloads', () => {
  it('strips arbitrary contents and renders only whitelisted reason codes', () => {
    const raw = { ...record(), summary: 'secret summary', prompt: 'private prompt', toolResult: 'secret result', error: '<script>bad()</script>' };
    const parsed = parseDiagnostic(raw)!;
    expect(parsed).toEqual(record());
    expect(JSON.stringify(diagnosticRows(parsed, defaultT))).not.toMatch(/secret|private|<script>/);
    expect(parseDiagnostic({ ...raw, reasonCode: '<img onerror=alert(1)>' })).toBeUndefined();
  });
  it.each([NaN, Infinity, -1, 1.5, '12', {}, Number.MAX_SAFE_INTEGER + 1])('rejects malformed counters %s', value => {
    expect(parseDiagnostic({ ...record(), llmStreamCalls: value })).toBeUndefined();
    expect(parseDiagnostic({ ...record(), usage: { ...record().usage, cacheReadTokens: value } })).toBeUndefined();
  });
  it('rejects incomplete schema, forged ratios, prototypes and executable getters', () => {
    expect(parseDiagnostic({ operationId: 'op-1' })).toBeUndefined();
    expect(parseDiagnostic({ ...record(), usage: { ...record().usage, cacheHitRatio: 1 } })).toBeUndefined();
    expect(parseDiagnostic({ ...record(), usage: { ...record().usage, cacheReadTokens: null } })).toBeUndefined();
    expect(parseDiagnostic(Object.create(record()))).toBeUndefined();
    let executed = false;
    expect(parseDiagnostic({ ...record(), get reasonCode() { executed = true; return 'configured-policy'; } })).toBeUndefined();
    expect(executed).toBe(false);
    expect(matchDiagnostic(projection(Array(1001).fill(record())), 'session-1', 42)).toBeUndefined();
  });
  it('validates nested wire identity and replaces unrecognized free-text reasons', () => {
    const raw = wireRecord();
    expect(parseWireDiagnostic(raw, 42)?.reasonCode).toBe('configured-policy');
    expect(parseWireDiagnostic({ ...raw, result: { ...raw.result, operationId: 'other-op' } }, 42)).toBeUndefined();
    raw.decisions[0]!.reason = '<script>private prompt</script>';
    const parsed = parseWireDiagnostic(raw, 42)!;
    expect(parsed.reasonCode).toBe('unknown');
    expect(JSON.stringify(diagnosticRows(parsed, defaultT))).not.toMatch(/script|private prompt/);
  });
  it('adds concise single-line observed facts without inventing missing cache', () => {
    expect(collapsedFacts(undefined, defaultT)).toBe('');
    expect(collapsedFacts(record(), defaultT)).toBe('2 calls · cache hit 80.0%');
    const value = record(); value.usage.cacheHitRatio = null;
    expect(collapsedFacts(value, defaultT)).toBe('2 calls');
    expect(collapsedFacts(value, defaultT)).not.toContain('\n');
  });
  it('ships matching Chinese and English namespaces', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const row of diagnosticRows(record(), defaultT)) expect(row.label).not.toMatch(/^reason\.|^trigger\.|^status\./);
  });
});
