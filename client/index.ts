import * as React from 'react';
import { MarkdownText, IconApiOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import { collapsedFacts, diagnosticRows, matchDiagnostic, nativeSummaryLabel, PROJECTION_KEY, type Translate } from './model.js';
import { defaultT, en, zh, NAMESPACE } from './locales.js';

import { styles } from './styles.js';
import { SettingsCard, SETTINGS_NAMESPACE, SETTINGS_PACKAGE } from './settings.js';

const h = React.createElement;
function leadingIcons(open: boolean, expandable = true) {
  return h('span', { className: 'dsh-smart-compaction-icons', 'aria-hidden': true },
    h('span', { className: 'dsh-smart-compaction-context-icon' }, h(IconApiOutlineRegular)),
    expandable && h('span', { className: 'dsh-smart-compaction-disclosure-icon' }, h(open ? IconChevronDownOutlineRegular : IconChevronRightOutlineRegular)));
}
/** Public slot props only. CompactionItem is not a public export in rc3/rc5.
 * Reproduce its summary/count disclosure using the public MarkdownText primitive. */
export type CompactionProps = Omit<ChatNodeViewProps<'compaction'>, 't'> & { t?: Translate };
export function CompactionRenderer({ node, sessionId, useProjection, t = defaultT, title, fallbackSummary }: CompactionProps & { title?: string; fallbackSummary?: string | null }) {
  const [expanded, setExpanded] = React.useState(false);
  // The standard session-scoped slot hook subscribes to host projection changes.
  // No RPC, fake messages, DOM probing, or timing-based correlation.
  const projection = (useProjection as (key: string) => unknown)(PROJECTION_KEY);
  const data = node.data;
  const record = matchDiagnostic(projection, sessionId, data.summaryEventSeq);
  const expandable = data.summary !== null || record !== undefined;
  const open = expandable && expanded;
  const bodyId = React.useId();
  React.useEffect(() => { setExpanded(false); }, [sessionId, data.summaryEventSeq, data.seq]);
  const labels = React.useMemo(() => ({ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }), [t]);
  return h('div', { className: 'dsh-smart-compaction' },
    h('button', { className: 'dsh-smart-compaction-toggle', type: 'button', disabled: !expandable,
      'aria-expanded': expandable ? open : undefined, 'aria-controls': expandable ? bodyId : undefined,
      onClick: () => setExpanded(value => !value) },
      leadingIcons(open),
      h('span', { className: 'dsh-smart-compaction-title' }, title ?? t('title')), h('span', { className: 'dsh-smart-compaction-sep', 'aria-hidden': true }),
      h('span', { className: 'dsh-smart-compaction-counts' }, data.shadowedItemCount !== null && data.shadowedTokenCount !== null
        ? nativeSummaryLabel(data, t) : fallbackSummary ?? nativeSummaryLabel(data, t),
        record && h('span', { className: 'dsh-smart-compaction-facts' }, ` · ${collapsedFacts(record, t)}`))),
    open && h('div', { id: bodyId, className: 'dsh-smart-compaction-body' },
      record && h('section', { className: 'dsh-smart-compaction-diagnostics', 'aria-label': t('details') },
        h('h4', null, t('details')),
        h('dl', null, ...diagnosticRows(record, t).map(({ label, value }, index) => h('div', { key: index }, h('dt', null, label), h('dd', null, value)))),
        h('p', null, t('evidence')), h('p', null, t('persistence'))),
      data.summary !== null && h(MarkdownText, { text: data.summary, labels })));
}

/** The public rc3/rc5 manual node owns BOTH command and checkpoint. Never add a
 * second summary row or correlate diagnostics using command/checkpoint seq. */
export type ManualCompactionProps = Omit<ChatNodeViewProps<'manual-compaction'>, 't'> & { t?: Translate };
export function ManualCompactionRenderer(props: ManualCompactionProps) {
  const { node, t = defaultT } = props;
  const { command, compaction } = node.data;
  if (compaction !== null) return h(CompactionRenderer, {
    ...props, node: { ...node, kind: 'compaction', data: compaction },
    title: t('commandTitle'), fallbackSummary: command.outcome?.text ?? null,
  });
  return h(ManualCommandStatus, { command, t });
}

/** No checkpoint means no authoritative summary identity, even if a command
 * outcome names a source event. Preserve native plain-text command semantics. */
function ManualCommandStatus({ command, t }: { command: ManualCompactionProps['node']['data']['command']; t: Translate }) {
  const [expanded, setExpanded] = React.useState(false);
  const bodyId = React.useId();
  React.useEffect(() => { setExpanded(false); }, [command.commandId]);
  const state = command.outcome === null ? 'running' : command.outcome.kind === 'error' ? 'error' : 'done';
  const text = command.outcome?.text;
  const summary = state === 'running' ? t('commandRunning') : text ?? t(state === 'error' ? 'commandFailed' : 'commandDone');
  const body = text?.includes('\n') ? text : null;
  const open = expanded && body !== null;
  return h('div', { className: 'dsh-smart-compaction', 'data-state': state, 'aria-busy': state === 'running' },
    h('button', { type: 'button', className: 'dsh-smart-compaction-toggle', disabled: body === null,
      'aria-expanded': body === null ? undefined : open, 'aria-controls': body === null ? undefined : bodyId,
      onClick: () => setExpanded(value => !value) },
      leadingIcons(open, body !== null),
      h('span', { className: 'dsh-smart-compaction-title' }, command.name ?? t('commandTitle')),
      h('span', { className: 'dsh-smart-compaction-sep', 'aria-hidden': true }),
      h('span', { className: 'dsh-smart-compaction-counts', 'data-error': state === 'error' || undefined }, summary)),
    state !== 'done' && h('span', { className: 'dsh-smart-compaction-sr', role: 'status' }, t(state === 'running' ? 'commandRunning' : 'commandFailed')),
    open && h('pre', { id: bodyId, className: 'dsh-smart-compaction-body', 'data-error': state === 'error' || undefined }, body));
}

export const inject = ['slots', 'locale', 'configForms'];
/** Minimal public host capability shape keeps the client independent of runtime
 * implementation imports. The published ChatNodeViewProps remains authoritative. */
export interface ClientContext {
  effect(effect: () => void | (() => void), label?: string): unknown;
  locale: { register(namespace: string, locales: { en: typeof en; zh: typeof zh }): (() => void) };
  configForms: {
    get(namespace: string): { set(field: string, value: unknown): Promise<boolean> };
    whileServed(namespaces: string[], fn: () => unknown): unknown;
  };
  slots: {
    inject(name: 'plugins.bundle.config', effect: () => unknown): unknown;
    register(options: { name: 'plugins.bundle.config'; key: string; locale: string; inject: () => unknown }, component: typeof SettingsCard): () => void;
    inject(name: 'conversation.chat.node', effect: () => unknown): unknown;
    register(options: { name: 'conversation.chat.node'; key: 'compaction'; locale: string; priority: number }, component: typeof CompactionRenderer): () => void;
    register(options: { name: 'conversation.chat.node'; key: 'manual-compaction'; locale: string; priority: number }, component: typeof ManualCompactionRenderer): () => void;
  };
}
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { en, zh }), 'smart-compaction: dictionaries');
  // Detail-page form: two switches written live to the profile patch.
  const form = ctx.configForms.get(SETTINGS_NAMESPACE);
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NAMESPACE], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: SETTINGS_PACKAGE, locale: NAMESPACE,
    inject: () => ({ hooks: { config: form }, setField: (field: string, value: boolean | string) => { void form.set(field, value); } }),
  }, SettingsCard))) as () => void, 'smart-compaction: settings page');
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'dsh-smart-compaction';
    style.textContent = styles;
    document.head.append(style);
    return () => style.remove();
  }, 'smart-compaction: styles');
  // Shadow native priority 0 without colliding with or removing its registration.
  // Disposing this plugin reveals the original renderer, including historical nodes.
  ctx.slots.inject('conversation.chat.node', function* () {
    yield ctx.slots.register({ name: 'conversation.chat.node', key: 'compaction', locale: NAMESPACE, priority: -10 }, CompactionRenderer);
    yield ctx.slots.register({ name: 'conversation.chat.node', key: 'manual-compaction', locale: NAMESPACE, priority: -10 }, ManualCompactionRenderer);
  });
}
