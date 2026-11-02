# Internal adaptive policy

An internal cost-aware policy of the single `dsh-smart-compaction` package. Targets DSH **0.2.1-rc.5**, Cordis **4.0.5**. The root entry installs the sole backend and this policy in the same Cordis fiber. The policy contributes only a synchronous `cache-first/decide` waterfall listener; it calls `next()` first, installs no agent lifecycle handlers and never accesses a Session or model context.

## Safe rollout

The default is **`observe`**: preserve the downstream policy and emit structured logger observations. `off` preserves downstream without scoring/logging. `active` opts into estimated-benefit decisions; missing exact-route prices or invalid numeric input preserve downstream. Active `null` only declines **optional** compaction: the backend still enforces mandatory overflow/hard-pressure recovery. Host model-switch safety remains inherited, outside this policy waterfall.

Use the bundle-provided **Smart compaction** preset or the single plugin in your own compaction scope. Configure this policy under `adaptive`; do not add a separate policy plugin row. `cacheFirst: false` requires `adaptive.mode: off`. With `off`, the root entry installs no policy listener at all.

## Configuration

Configure `mode: active` only after reviewing observe logs and supplying your own current **exact provider/model** price entries for both the main route and summarization route. There is no built-in price table, wildcard route matching, or assumed published price. All monetary quantities must use the same operator-chosen currency.

All fields below belong inside the root `adaptive` object:

```ts
{
  mode: 'observe', // switch to active deliberately
  prices: [
    // Fill every field with YOUR negotiated rates, currency per million tokens:
    // { provider: '...', model: '...', input: ..., output: ..., cacheRead: ..., cacheWrite: ... }
  ],
  expectedRemainingCalls: 8,
  expectedOutputTokensPerCall: 0,
  cacheHitRatio: 0,
  rebuildCacheHitRatio: 0,
  cacheWriteFraction: 0,
  summaryInputOverheadTokens: 1024,
  expectedSummaryTokens: 2048,
  summaryFramingTokens: 64,
  summaryCacheHitRatio: 0,
  minPressureRatio: 0.25,
  minRetainTokens: 2048,
  maxRetainRatio: 0.8,
  maxCandidates: 256,
  minNetBenefit: 0.001,
  informationLossPerMillionTokens: 0
}
```

`cacheWrite` is the **incremental** fee added to ordinary uncached input charges, not a second all-inclusive input rate. Translate your provider's billing accordingly. `cacheWriteFraction` is the fraction of uncached tokens charged that extra fee. Cache ratios are explicit assumptions, not promises of hits. Snapshot prior usage/history are intentionally not used to infer prices or extrapolate a horizon from insufficient data. `expectedRemainingCalls` is an operator assumption bounded to 1–1000. Candidate evaluation is bounded to 1–4096 candidates, with deterministic evenly spaced sampling if needed.

The root `Config` schema validates nested policy settings, and exported `resolveAdaptiveConfig()` validates policy-only direct callers: finite non-negative prices, valid ratios, integer work limits, nonempty exact routes, no duplicates or unknown keys. Config is detached/frozen.

## What is optimized

The pure exported `evaluatePolicy(snapshot, config)` compares **compact now versus defer now** over a fixed horizon, scoring only candidates already deemed legal by the executor. It never chooses a line count and aligns it later. At equal cost it prefers more verbatim history.

For `N` expected remaining calls:

- Baseline = `N × current-input-cost + expected main-output-cost`.
- Candidate = summary replay input (fixed head + removed tokens) + uncached instruction overhead + expected summary output + first post-compaction input/cache-rebuild cost + `(N−1)` later input costs + expected main-output cost + optional information-loss penalty.
- Input cost = `tokens / 1e6 × [hit × cacheRead + (1−hit) × (input + writeFraction × cacheWrite)]`.
- Projected input tokens = current total − removed tokens + `min(expectedSummaryTokens, summaryMaxTokens)` + `summaryFramingTokens`.

Main output cost is explicitly included but cancels between alternatives under the equal-output assumption. `summaryCacheHitRatio` applies only to replay input when summary and main routes match exactly; a different route always gets zero assumed hits. New summarizer instruction overhead is always uncached. The 2048-token expected summary and 64-token replacement framing defaults are explicit heuristic estimates, **not** output guarantees; output is clamped to the executor's maximum, and framing affects future input rather than generated-output billing. Set these assumptions to fit your workload (or choose the full cap for pessimistic scoring). Rebuilding the first main request includes its configured cache read/write charges. A candidate must shrink, fit the window and obey retention limits. A positive predicted benefit exceeding `minNetBenefit` proposes immediate compaction with that candidate's retained tokens; otherwise active declines optional work. Mandatory executor recovery can override the recommendation.

This is a **bounded heuristic estimate, not a global optimum or savings guarantee**. It does not model growing future prompts, different future outputs after summarization, provider minimum cache blocks/TTL, future mandatory compactions, or repeated convergence attempts. A pruning-only executor outcome can cost less than the assumed summary; summary retries can cost more. `informationLossPerMillionTokens` defaults to zero: enabling it assigns an explicitly subjective linear penalty to removed tokens, not measured semantic information loss. Validate assumptions against real bills and quality evaluations.

## Observations and development

Structured `adaptive-compaction/decision` logger arguments contain route, trigger, mode, estimated baseline/candidate cost, predicted benefit, selected retention and evaluated candidate count. `decisionApplied` means active policy replaced the downstream decision (including a defer/null decision), **not** that compaction happened. They are **predictions**, not observed savings, and never become model context. No session transcript is logged.

Run `npm run build` and `npm test` at the single project root. Public entry points export the plugin, config/schema and pure scorer; `./economics` exports the scorer separately. `prepack` builds shipped JavaScript and declarations.
