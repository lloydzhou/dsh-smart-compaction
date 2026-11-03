/** Dependency-free strings of the settings form (merged into the plugin dictionary). */
export const settingsEn = {
  'settings.cacheFirst': 'Cache-first compaction',
  'settings.cacheFirstHint': 'Protect the prompt cache when compacting. Off falls back to the native engine and disables adaptive economics. Applies at the next compaction.',
  'settings.mode': 'Adaptive economics',
  'settings.modeHint': 'Off: no cost model. Observe: record estimated savings only. Active: let the estimate decide when to compact.',
  'settings.off': 'Off', 'settings.observe': 'Observe', 'settings.active': 'Active',
  'settings.unavailable': 'The plugin is not loaded or its settings are not served, so it cannot be configured right now.',
  'settings.readOnly': 'This deployment stores settings read-only.',
};
export const settingsZh: typeof settingsEn = {
  'settings.cacheFirst': '缓存优先压缩',
  'settings.cacheFirstHint': '压缩时优先保护提示词缓存。关闭后回退到原生引擎，自适应经济策略同时失效。在下一次压缩时生效。',
  'settings.mode': '自适应经济策略',
  'settings.modeHint': '关闭：不使用成本模型。观察：只记录估算收益。主动：按估算结果决定何时压缩。',
  'settings.off': '关闭', 'settings.observe': '观察', 'settings.active': '主动',
  'settings.unavailable': '插件未加载或其设置未提供，暂时无法配置。',
  'settings.readOnly': '本部署的设置为只读。',
};

