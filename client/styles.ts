/** Native RC3/RC5 compaction chrome, namespaced without private CSS imports.
 * Derived from DeepSeek Harness (MIT; see THIRD_PARTY_NOTICES.md).
 */
export const styles = `
.dsh-smart-compaction{--dsh-compaction-header-height:calc(24px + var(--dsh-content-font-delta,0px));padding:2px 0}
.dsh-smart-compaction-toggle{display:flex;align-items:center;width:100%;height:var(--dsh-compaction-header-height);min-width:0;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);transition:color 100ms ease;font:inherit;text-align:left;flex-wrap:nowrap;white-space:nowrap}
.dsh-smart-compaction:has(.dsh-smart-compaction-body) .dsh-smart-compaction-toggle{position:sticky;top:0;z-index:7;border-radius:0;background:var(--dsw-alias-bg-base)}
.dsh-smart-compaction-body :has(>[data-code-block-banner]){top:var(--dsh-compaction-header-height)}
.dsh-smart-compaction-toggle:not(:disabled){cursor:pointer}
.dsh-smart-compaction-icons{flex:none;display:inline-grid;place-items:center;width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));margin-right:6px;color:inherit}
.dsh-smart-compaction-icons svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}
.dsh-smart-compaction-context-icon,.dsh-smart-compaction-disclosure-icon{display:inline-flex;grid-area:1/1;align-items:center;justify-content:center}
.dsh-smart-compaction-disclosure-icon{opacity:0}
.dsh-smart-compaction-toggle:not(:disabled):focus-visible .dsh-smart-compaction-context-icon{opacity:0}
.dsh-smart-compaction-toggle:not(:disabled):focus-visible .dsh-smart-compaction-disclosure-icon{opacity:1}
.dsh-smart-compaction-title{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:var(--dsh-compaction-header-height);color:inherit}
.dsh-smart-compaction-sep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}
.dsh-smart-compaction-counts{flex:1 1 auto;min-width:0;overflow:hidden;color:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:var(--dsh-compaction-header-height);text-overflow:ellipsis;white-space:nowrap}
.dsh-smart-compaction-body{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:var(--dsh-compaction-header-height);overflow-wrap:anywhere}
.dsh-smart-compaction-diagnostics{margin-bottom:8px}
.dsh-smart-compaction-diagnostics h4{font:inherit;font-weight:600;margin:0 0 8px}
.dsh-smart-compaction-diagnostics dl{margin:0}
.dsh-smart-compaction-diagnostics dl>div{display:flex;flex-wrap:wrap;gap:0 12px}
.dsh-smart-compaction-diagnostics dd{margin:0}
.dsh-smart-compaction-diagnostics p{margin:8px 0}
.dsh-smart-compaction-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.dsh-smart-compaction [data-error]{color:var(--dsw-alias-label-error,currentColor)}
.dsh-smart-compaction pre{white-space:pre-wrap}
@media(hover:hover){
.dsh-smart-compaction-toggle:hover{color:var(--dsw-alias-label-secondary)}
.dsh-smart-compaction-toggle:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-smart-compaction:has(.dsh-smart-compaction-body) .dsh-smart-compaction-toggle:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.dsh-smart-compaction-toggle:not(:disabled):hover .dsh-smart-compaction-context-icon{opacity:0}
.dsh-smart-compaction-toggle:not(:disabled):hover .dsh-smart-compaction-disclosure-icon{opacity:1}
}
@media(prefers-reduced-motion:reduce){.dsh-smart-compaction-toggle{transition:none}}
`;
