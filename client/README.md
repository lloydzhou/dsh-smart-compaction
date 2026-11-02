# Smart compaction client diagnostics

## Public extension surface

This plugin replaces the `compaction` and `manual-compaction` keys in `conversation.chat.node`, using
`ctx.slots.inject` followed by `ctx.slots.register`. `ChatNodeViewProps` is imported
as a **type** from `@deepseek-ai/dsh-client-ui-chat/client`. The built artifact loads
as ModuleLoader id `dsh-smart-compaction`; only `react` and
`@deepseek-ai/dsh-client-ui-primitives` are runtime hostRequire externals.

Published rc3 and rc5 declarations and bundles were inspected. `CompactionItem`
is not publicly exported. Consequently this renderer recreates its public
summary/count disclosure semantics with host `MarkdownText` and icons, rather
than importing a private component or promising pixel-identical native CSS.
The original summary is passed unchanged, count labels are retained, missing
summaries stay unavailable, and rows without matching diagnostics still work.
The collapsed card stays one line; optional observations truncate/hide on narrow
screens. Expanded diagnostics precede the original summary.

The public rc3/rc5 manual payload is `{ command, compaction }`, with `compaction`
nullable. Published command projection code folds `sourceCommandId`-correlated
summary and replacement checkpoint evidence into one manual node; the automatic
projection excludes those events. The renderer therefore emits exactly one
summary, correlates using `compaction.summaryEventSeq` (never the command or
checkpoint sequence), and retains command outcome text when counts are missing.
Without a checkpoint it preserves plain-text running/error/done command behavior,
including multiline disclosure and accessible status; it cannot attach diagnostics
without an authoritative summary identity.

## Projection contract

`model.ts` exports `SmartCompactionProjection`, `WireDiagnostic`, `DecisionFact`
and a smaller normalized `CompactionDiagnostic`. The host owns the projection
`smartCompaction` and publishes this JSON envelope:

```ts
{ schemaVersion: 1, sessionId: string, records: WireDiagnostic[] } // max 64
```

A wire record is an operation, not a summary: it includes `schemaVersion`,
`sessionId`, `operationId`, **`summaryEventSeqs: number[]`**,
`compactionIds: string[]`, `trigger`, `status`, `decisions`, and nested `result`.
Result fields consumed are operation/session identity, summary sequences,
trigger/status, summaryAttempts, llmStreamCalls, modelCalls, providerDispatch,
unknownUsageCalls, unknownSummaryAttempts, usage, preTokens, postTokens.
Decision fields consumed are action, reason, totalTokens, hardThresholdTokens,
effectiveThresholdTokens, projectedPruneTokens, retainTokens, retainedTokens,
removedTokens, safetyOverride. Null means unknown, never zero.

Only the viewed session and the native node's exact `summaryEventSeq` can match.
Nested operation/session identities must agree. Duplicates are rejected; there
is no latest-operation, nearest-time or cross-session fallback. Operation usage
includes retries and may be repeated on multiple summaries from that operation.
Middleware stream calls are explicitly **not** billed-request counts. Missing
cache counters prevent a total-prompt/cache-ratio claim. Reasons are translated
from a fixed allowlist: arbitrary policy strings are never displayed. Only
numeric diagnostic fields and localized enums are rendered; the stock summary
is the only rendered content-bearing payload.

Persistence is experimental and best effort. No RPC, fake model messages,
provider dispatch interception, DOM monkeypatching, or polling is used.

## Integration manifest (lead owns root changes)

- Export `./client` to `./client/dist/client.js`; include `client/dist` in files.
- Append `node scripts/build-client.mjs` to build/prepack flow.
- Add `tsc -p client/tsconfig.json` to typecheck (host-only root config does not
  otherwise include the renderer).
- `dsh.client.platform`: `web`.
- `dsh.client.inject`: `@deepseek-ai/dsh-client-ui-chat`,
  `@deepseek-ai/dsh-client-ui-session`, `@deepseek-ai/dsh-client-locale`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`.
- Build devDependency: esbuild (validated 0.28).
- Typecheck devDependencies: public ui-chat, ui-session, ui-slots, ui-primitives,
  ui-conversation at `^0.2.1-rc.3`, plus `@types/react`; no production React copy.
  Host-provided React remains external, regardless of local development types.
- Do not install `dsh-client-runtime@0.2.1-rc.5`: that version is not published.

## Validation

`vitest run tests/client-ui.test.ts` exercises native fallback, plural summary
correlation, unknown cache, stream-versus-billed evidence, safe nested projection
validation, malicious values, localization, and a host-module-only renderer
harness. Manual tests additionally execute the installed published bundle's actual
command/compaction projection definitions, checking manual event ownership and
feeding their output into the renderer. Set `DSH_CHAT_SOURCE` to a downloaded
published client bundle to repeat these tests against another release (rc3 and
rc5 verified). Only the generic node envelope is stubbed, not lifecycle mapping.
`tsc -p client/tsconfig.json` checks the published public types.
`node scripts/build-client.mjs` checks the external import allowlist and emits
the browser factory. The live GUI has **not** been verified by this work.
