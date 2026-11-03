/** Bundle detail-page form: two live switches of the integration entry. */
import * as React from 'react';
import { Switch, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives';

import { settingsEn } from './settings-locales.js';

const h = React.createElement;
/** Settings namespace = the profile entry id of the root integration row. */
export const SETTINGS_NAMESPACE = 'smart-compaction-integration';
export const SETTINGS_PACKAGE = 'dsh-smart-compaction';

interface FormView { status?: string; writable?: boolean; value?: Record<string, unknown> }
export interface SettingsProps {
  t: (key: keyof typeof settingsEn) => string;
  useConfig: <T>(select: (view: FormView) => T) => T;
  setField: (field: string, value: boolean | string) => void;
}

const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 0' };
const hint = { fontSize: 12, opacity: 0.7, marginTop: 2 };
const text = (title: string, note: string) => h('div', null, h('div', null, title), h('div', { style: hint }, note));

export function SettingsCard(props: SettingsProps): React.ReactElement {
  const { t } = props;
  const form = props.useConfig(view => view);
  if (form.status !== 'ready') return h('div', { style: hint }, t('settings.unavailable'));
  const values = form.value ?? {};
  const disabled = form.writable !== true;
  const cacheFirst = values['cacheFirst'] !== false;
  const raw = values['adaptiveMode'];
  const mode = raw === 'off' || raw === 'active' ? raw : 'observe';
  const SegmentedAny = SegmentedControl as unknown as React.ComponentType<Record<string, unknown>>;
  const SwitchAny = Switch as unknown as React.ComponentType<Record<string, unknown>>;
  return h('div', null,
    h('div', { style: row }, text(t('settings.cacheFirst'), t('settings.cacheFirstHint')),
      h(SwitchAny, { checked: cacheFirst, label: t('settings.cacheFirst'), disabled, onChange: (checked: boolean) => props.setField('cacheFirst', checked) })),
    h('div', { style: row }, text(t('settings.mode'), t('settings.modeHint')),
      h(SegmentedAny, {
        id: 'smart-compaction-mode', label: t('settings.mode'), value: cacheFirst ? mode : 'off', disabled: disabled || !cacheFirst,
        options: (['off', 'observe', 'active'] as const).map(value => ({ value, label: t(`settings.${value}` as keyof typeof settingsEn) })),
        onChange: (next: string) => props.setField('adaptiveMode', next),
      })),
    disabled ? h('div', { style: hint }, t('settings.readOnly')) : null);
}
