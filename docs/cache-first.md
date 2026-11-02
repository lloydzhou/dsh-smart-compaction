# dsh-smart-compaction

A session-scoped compaction provider for **DSH 0.2.1-rc.3 and 0.2.1-rc.5**, tested with Cordis 4.0.5. It extends the published `BasicCompactionEngine`; no private DSH imports or checkout aliases are used. Both exact releases pass build, typecheck, all 65 tests and isolated packed-host activation. The engine gate admits only those two tested releases; live GUI end-to-end behavior is not tested.

## Behavior

Automatic step pressure and context-overflow recovery first price tool-result pruning without changing the session. The dry-run calls the composed pruner's public `pruneContent` and the singleton token meter on complete projected messages. When the fresh projection would put pressure below the configured limit, pruning commits synchronously. Otherwise, a tool-balanced prefix is summarized without first rewriting it. The system head and at least the last surface node remain outside that prefix.

After a successful summary the provider remeasures pressure, and only prunes retained tool results if pressure still requires reduction. Summary overflow retries use smaller balanced prefixes, bounded by `summaryFallbackAttempts`. If no smaller prefix exists or summary work fails, a final useful pruning pass may remain durable even though the summary error is rethrown. Cancellation prevents that fallback. Successful summary transactions, checkpoint framing, source attribution, shrink checks, and persistence remain owned by Basic's `compactRegion` implementation.

**Manual compaction uses the plugin selector and public idle transaction.** It dry-runs pruning without mutations before summarizing the original prefix, then remeasures and prunes the retained tail only if still over its manual target. Unlike automatic checks, native `/compact` currently requires a real summary checkpoint: the public result has no prune-only success variant, and null is displayed as no compactable history. Thus manual dry-run does not skip the LLM merely because pruning would suffice; no fake checkpoint is manufactured. This is an explicit current API limitation, not full prune-only equivalence.

**Model-switch compaction remains a separate stock path.** The inherited model-switch listener uses a private stock pressure path, not the cache-first override; it may prune before summarizing. This package does not intercept that method or claim cache-first behavior on model switches. The protected summary wrapper rejects late adapter responses after cancellation for all inherited paths.

## Configuration

The plugin module exports `apply`, `inject`, and `Config`. Install it as the sole `compaction` provider in a session preset, replacing—not stacking on—the stock Basic provider. The [root README](../README.md) covers the single shipped derived preset and configuration matrix. Loading this provider at a host scope does not silently replace an existing per-session provider.

```yaml
cacheFirst: true
adaptive:
  mode: observe
base:
  thresholdRatio: 0.8
  headroomTokens: 65536
  retainRatio: 0.16
  maxTokens: 65536
  compactionRetries: 1
  maxOverflowRetries: 1
summaryFallbackAttempts: 2
maxCandidateChecks: 128
```

`base` accepts the complete published `BasicCompactionConfig`, including exact-route `modelPolicies` and `auto`. Base values are validated by Basic. `summaryFallbackAttempts` is a nonnegative safe integer; its default is 2 extra smaller-prefix attempts per outer compaction attempt. Each outer operation is limited by the route's `compactionRetries`. The optional `toolResultPruner` service supplies its own validated character budgets; if absent, this provider summarizes without pruning. The package dependency makes that service available to install, but does not instantiate it automatically.

## Policy extension

The root and `dsh-smart-compaction/policy` exports provide `CacheFirstSnapshot`, `CacheFirstCandidate`, `CacheFirstDecision`, and `CacheFirstDecisionResult`. `cache-first/decide` is a **synchronous** Cordis waterfall. A listener receives a frozen numeric snapshot with public branded sequence identities, route and summary-route names, candidate prefixes, and historical counts. Call `next()` to delegate to other listeners. Return `null` to skip optional early compaction or `{ thresholdTokens, retainTokens, reason }` to propose budgets. The executor clamps thresholds to its configured hard-pressure budget; neither null nor a higher threshold disables hard pressure or overflow recovery. Overflow can disregard retention to force progress.

`history.userTurns` counts append-origin user messages whose source is `user`; injected messages and replacement summaries are excluded. `modelCalls` counts settled assistant messages, failed assistant attempts, and successful explicitly marked summary calls. Failed auxiliary summary calls are not independently recorded by Basic and cannot be counted reliably. `compactionCount` counts successful summary records. These counts include inherited and shadowed history. `previousUsage` is present only when the meter's current baseline uses authoritative provider usage; it is not a promise of a future cache hit.

## Limits and verification

Token estimates are heuristic, not provider admission guarantees. Rich blocks are unchanged by text pruning; the dry-run subtracts complete-message heuristic savings from route-priced pressure. There is no universal pricing table, cache-hit guarantee, or automatic repair for an oversized fixed envelope or indivisible tail. A provider-confirmed overflow may still require a bounded request retry after a measured reduction.

Range checks use the public pairing helpers. These helpers and historical reconstruction currently require public `Session.eventAt`/`snapshotEvents`, which the pinned DSH release marks deprecated without exposing a complete replacement in this API. `maxCandidateChecks` (default 128, safe integer at least 2) bounds pairing checks per selection. Longer surfaces sample evenly spaced cut positions including both extremes; each sampled position still uses the authoritative pairing helper. This costs O(N × min(N, maxCandidateChecks)) in the surface length, rather than unbounded quadratic work. Sampling may miss a legal cut or the most cost-effective prefix; increase the limit when exhaustive selection is more important than overhead. Basic's separately installed `compaction/summary-error` listeners retain their own retry semantics; this package cannot bound arbitrary listener-driven internal recovery without replacing the durable transaction implementation.

Run `npm run build`, `npm run typecheck`, and `npm test` from the project root. Focused tests use real published Session, TokenMeter, Pruner, and Basic durable transactions with controlled summary outcomes; no external model credentials are needed. They do not assert real-provider cache-hit rates.
