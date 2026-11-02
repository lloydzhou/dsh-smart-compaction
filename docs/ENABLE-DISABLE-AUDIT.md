# Enable/disable lifecycle audit

Date: 2026-11-02. **Read-only investigation; no implementation, profile, GUI, installation, restart, history mutation, or model calls performed.** This report is the only authored deliverable. Frontend lifecycle testing belongs to the other delegated workstream.

## Verdict

The present implementation **does not meet** the exact contract: enabled means smart manual/automatic/overflow compaction with native interactions; disabled means native rendering and Basic compaction for every trigger, including an existing nonblank standard session.

There are three independent problems:

1. Disabling the integration **plugin row** leaves the bundle's `preset-standard: disabled: true` override in force. The integration removes its replacement registrations, leaving no current `standard` registration.
2. Disabling the **bundle layer** can restore the original standard declaration for newly mounted agents, but existing agents deliberately retain the prior smart generation and its engine/listeners.
3. Enabling the bundle does not upgrade an existing agent already bound to native Basic. Its original generation is retained too. A smart-engine OFF gate alone cannot solve this ON direction.

A successful Host plugin-management result is not proof that existing session engines changed, and does not prove browser synchronization. No public API inspected authorizes replacing a nonblank agent's preset in place. Do not use private registry maps, service-table mutation, prototype patches, rewritten session headers/events, or `recompose()` on a started session.

## Authoritative evidence and provenance

The following runtime files were read from an existing extraction and verified byte-for-byte against the installed application ASAR by parsing its header and reading file byte ranges. No extraction/reinstallation was needed:

- [RC5 plugin manager](</tmp/dsh-prompt-review-20261102/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js>): SHA-256 `1b8bf9eb266d7b3b7f899175e3f435c89ed8baa8aabc677212759f8c6cd23132`.
- [RC5 preset registry](</tmp/dsh-prompt-review-20261102/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js>): SHA-256 `95edcc66175a87091ba90fe0809246821df470bf960e1cfd725b5ca6baaf4f07`.
- [RC5 Basic engine](</tmp/dsh-prompt-review-20261102/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js>): SHA-256 `b7ac52f20a36430cf01a66b3a36f23a48ffdb22708d714dbe1fff541b5df4ec5`.

The installed registry manifest identifies `0.2.1-rc.5`. The existing [published RC3 registry](</tmp/dsh-compat-rc3-hpzojS/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js>) has the **same SHA-256** as installed RC5, confirming the relevant retention behavior across those versions. Public signatures were also read in the workspace [registry declarations](<../node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/types/index.d.ts>). This does not assert that every package or every release is identical.

## Current package wiring

- [Bundle patch](<../cordis.patch.yml#L1-L10>) disables native `preset-standard`, then inserts the root `dsh-smart-compaction` integration row. The root package name also enables client discovery.
- [Configured-standard reader](<../src/preset.ts#L33-L40>) requires that original row to remain disabled. [Transformation](<../src/preset.ts#L15-L30>) replaces exactly one Basic provider and otherwise preserves configuration; it is not a copied standard-preset snapshot.
- [Integration lifetime](<../src/preset.ts#L44-L57>) registers transformed `standard` and legacy `smart-compaction` definitions with returned disposers owned by the integration service.
- [Root dispatch](<../src/index.ts#L67-L91>) distinguishes integration from engine instances. `cacheFirst: false` constructs Basic **at initial engine activation**; it is not a live root-disable fallback.
- [Smart engine](<../src/engine.ts#L63-L143>) extends Basic, overrides manual, automatic, region and summarization methods, and has no integration-enable predicate.
- [Diagnostics](<../src/diagnostics.ts#L64-L101>) register a projection and append optional plugin records; retained plugin ownership can outlive the integration row. Turning the UI off does not erase historical records and must not do so.

## Three different management operations

| Operation | Actual public behavior | Consequence for this package |
|---|---|---|
| `setPluginEnabled(entryId, false)` | Writes the selected Loader row's desired `disabled` value, reloads the profile; does not deselect its bundle. | Root disappears but native standard remains disabled by the still-selected bundle. |
| `setBundleEnabled(packageName, false)` | Removes that bundle from the ordered profile selection, retaining the dependency, then reloads. | The override and inserted row are removed together; native declaration can return, subject to higher-priority overlays. Existing agents keep old revisions. |
| `removeBundle(packageName)` | Deselect/unload first, then package removal, with in-use and startup-profile restrictions. | Not equivalent to disable. It may refuse or fail; never promise removal merely because the root row stopped. |

Evidence: [manager methods](</tmp/dsh-prompt-review-20261102/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js#L1925-L1957>), [removal](</tmp/dsh-prompt-review-20261102/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js#L2132-L2150>), and [reload/result handling](</tmp/dsh-prompt-review-20261102/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js#L2333-L2399>). Without Host HMR the operation reports `restart-required`; `reload()` only validates composition, not a live switch. This is Host HMR, distinct from a frontend bundle-build watcher. No live management operation was invoked during this audit.

Higher-priority home/launch overrides can prevent requested effective state; plugin-row enablement explicitly reports `overridden`. Bundle re-enable appends selection and can change precedence. Test actual composed state rather than assuming patch priority.

## Why disposal does not remove the old engine

[Registry registration and retirement](</tmp/dsh-prompt-review-20261102/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js#L470-L548>):

- Duplicate preset IDs throw; registration is not an override stack.
- Activation creates the preset scope from the **registry owner**, not the declaring integration plugin.
- Unregister deletes the current definition, marks its generation retired, then collects it **only if `users === 0`**.
- Thus disposing the integration's registrations is intentionally not disposing generations used by existing agents.

[Binding and inheritance](</tmp/dsh-prompt-review-20261102/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js#L654-L728>) explicitly count users and allow a child to join its parent's exact retained generation. A child created after disable can therefore inherit old smart behavior. `serviceFor(agent, 'compaction')` reads that exact retained composition, not the current registration with the same ID.

[Public switching boundary](</tmp/dsh-prompt-review-20261102/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js#L729-L760>): `recompose()` is documented for **blank agents**, caller-owned blank check; `select()` enforces no started/open turn. Its technical callability is not permission to bypass that contract. The [public type surface](<../node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/types/index.d.ts#L83-L135>) exposes inspection, binding and blank selection, but no supported nonblank capability replacement or preset decoration operation.

Restoring `standard` in the registry is necessary for new/cold sessions, but insufficient for existing agents. Legacy `smart-compaction` histories also lose their current registration on removal; continuing/cold-rendering those sessions requires an explicit safe compatibility strategy, not header rewriting.

## Can a gate delegate to Basic?

**Feasible bounded improvement, not a complete solution by itself.** Basic's [automatic listeners](</tmp/dsh-prompt-review-20261102/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js#L824-L887>) dynamically call `this.compactIfNeeded()`. A retained smart instance can therefore check a public lifecycle-owned activation signal and choose `super.compactIfNeeded()` or `super.compactNow()` instead of smart behavior.

Important constraints:

1. Checking the smart engine's own `ctx.fiber` is insufficient: its retained generation remains active. A gate must reflect **integration control lifetime**, not engine lifetime. A process-global boolean is also insufficient: separate hosts/profiles, module reloads and multiple integration instances can cross-talk. Prefer a documented Host-scoped public service/event with explicit ownership and fail-closed behavior; prove visibility through preset isolation and after disposal.
2. Public `Fiber.state`/`uid` exist ([declarations](<../node_modules/@deepseek-ai/cordis/lib/types/fiber.d.ts#L59-L114>)), but do not establish a supported cross-context control channel. Cordis can withdraw a service/listener without destroying a JavaScript object reference. Do not assume calling a captured method is prevented just because its owner was disposed.
3. Gate **all** override paths: `compactNow`, `compactIfNeeded`, `compactRegion`, and `summarize`. Basic [selection/region/manual code](</tmp/dsh-prompt-review-20261102/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js#L914-L1022>) calls virtual region and summary hooks. Gating only the top-level selector can still invoke smart telemetry/reasoning/manual-region code inside supposedly native compaction.
4. Disabled mode must bypass smart policy, decision events, diagnostic writes and reasoning transforms, not merely select a different range. Historical records remain untouched. Avoid constructing a second Basic service on the same context, which can duplicate registrations/listeners.
5. A mid-flight toggle must have a defined boundary. Do not switch algorithm inside a durable start/end transaction. Either drain the admitted operation before acknowledging applied, or cancel and await safe settlement, then route later operations to Basic. This must be tested with delayed stub streams and failures.
6. A gate tied forever to one disposed integration instance cannot support OFF → ON on existing retained engines. A valid design needs a stable host-scoped source of **current** enablement, while old controls stay revoked across reloads.
7. Even a perfect smart-to-Basic gate cannot make a native Basic instance created **before installation/enabling** become smart. That requires a pre-existing stable routing seam or a supported safe lifecycle transition.

“No hidden old engine after disable” must distinguish behavior from object retention: host retention may keep inert objects/modules alive. A tested Basic-only path can satisfy default behavior, but claiming complete unloading would be false. If zero retained plugin objects is required, this host's retained-generation contract cannot satisfy it while those agents stay bound.

## Minimal robust direction and hard limits

Do not ship a disposer that secretly re-registers Basic after its owning plugin is gone: it creates unowned registrations, can race native restoration, duplicates the same ID, and survives later toggles unexpectedly. Do not save a hardcoded or startup-cloned native preset as a permanent fallback.

Two designs must be distinguished:

### Bounded plugin-only improvement (requires explicit scope acceptance)

- Separate a stable, visible native-preserving integration/compatibility bridge from the smart feature control, **or** require bundle-level lifecycle for preset restoration. A single disposable root cannot both disappear and continue owning a fallback registration. The current bundle's native-disable override must not be left effective without an owned standard provider.
- Derive native declarations from the current public profile composition each time a new registration is needed, preserve expressions and user overlays, and validate exactly one intended Basic provider. No bundled native snapshot.
- Route already bridge-equipped agents through the gate above, preserving their events and identity. Clearly document that pre-bridge native agents cannot be upgraded live through the APIs inspected.
- Bundle removal still needs a deliberate compatibility/cold-reopen plan for the legacy alias. A residual bridge must be visible and must not run smart code when disabled.

This is not a claim that such a bridge is already implemented or that leaving a bridge installed satisfies every interpretation of “disabled.” It requires lifecycle tests and user/product agreement on the distinction between feature disable and package removal.

### Full exact requirement

For a native standard session that is **already running before enable**, the clean architecture is a Host-supported, lifecycle-owned compaction routing/decorator seam, present independently of this plugin, with native Basic as the unconditional no-extension fallback. Both command/manual dispatch and automatic pressure/overflow must use that seam; the smart plugin acquires/releases a scoped provider/handler. No preset-ID takeover is then necessary. The seam must settle in-flight transactions before reporting disable applied, and renderer enhancements must have their own normal disposer.

**No such complete public seam was established in the inspected RC3/RC5 APIs.** Host development, or an explicitly approved safe cold reopen using a documented public session lifecycle, is therefore needed to claim the full contract. A cold reopen is not a history rewrite, but is not a transparent in-place toggle either; no safe public reopen route was verified in this audit, and none is recommended as an assumed workaround. No Host changes or restarts were made.

## Hard test plan — deterministic, no paid calls

Run against actual RC3 and RC5 public packages with mock LLM streams and temporary profiles; no live user session toggles until these pass. Baseline compare to an unmodified Basic fixture using the same config, routed request, token meter and transcript.

### Required starting states

A. New smart standard session; B. nonblank smart standard session; C. current nonblank **native Basic standard** session created before enable; D. blank standard; E. legacy `smart-compaction`; F. cold persisted history containing prior smart diagnostic records. Include child agents inherited before and after each toggle.

### Every transition and trigger

For each starting state test root row OFF/ON, bundle OFF/ON, repeated OFF/ON/OFF, and removal separately. Test with Host HMR and without it; assert `applied`, `overridden`, `failed`, or `restart-required` truthfully.

For each effective state execute manual Compact through the native command service, automatic pressure through `agent/pre-step`, and actual overflow through `agent/request-error`. Also directly call region compaction to expose virtual-hook leakage. Assert:

- ON uses smart selection/telemetry exactly once, with unchanged native command identity and transaction correlation.
- OFF uses Basic's selection, retention, summary request, error classes, transaction framing, flush behavior and retry bounds. No cache-first decision events, smart diagnostics, or smart reasoning changes occur after the disable boundary.
- Exactly one compaction service/listener set services each trigger; no double prune/summary/flush.
- New/cold standard resolves after either disable path; alias behavior is explicit. Existing agents and inherited children report their actual composition via public inspection.
- Test C must genuinely become smart ON and Basic OFF without private mutation or nonblank recomposition. If it cannot, mark the full contract unsupported rather than skipping C.

### Integrity/race checks

- Hash/compare the entire historical event prefix and header before/after toggles: unchanged. Only subsequently admitted normal operations may append their normal events.
- Preserve summary visibility, checkpoint linkage, tool pairing, surface replace generation and native stop/cancel behavior.
- Toggle while a summary is awaiting a stub stream, while prune-only work executes, during cancellation, and after flush failure. Require matched native start/end framing and no late smart commit after acknowledged disable.
- Reload profile settings between toggles; prove new registrations derive updated user Basic settings without frozen snapshots. Test non-Basic custom standards fail clearly without stealing their ID.
- Include two host contexts/profiles and HMR module reload: one gate cannot enable another or revive a revoked generation.
- Test no-HMR save separately from effective runtime state; never label a saved preference as live disable.
- Browser tests (other workstream): disable enhanced renderer through normal plugin disposal; old and new summaries use default renderer, diagnostics remain stored but inert; re-enable does not duplicate slots/listeners. Host success and browser synchronization are separately asserted.

## Audit status

Static source evidence confirms the defects and the host constraints. This report does **not** claim an end-to-end reproduction or passing lifecycle test suite. No lead-owned source was edited. The proposed gate and host seam are design recommendations, not existing APIs or completed fixes.
