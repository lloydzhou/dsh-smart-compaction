# Cache usage compatibility

## Evidence boundary

The published DSH TokenUsage contract describes disjoint uncached input, cache read and cache write counters, with an exact optional total. A known total minus output can supply the denominator without requiring cacheWriteTokens. Missing cacheReadTokens cannot be silently changed to observed zero.

The installed RC.5 pi-ai bridge retains cache counters only when positive. Both underlying OpenAI Chat Completions and Responses implementations default omitted cache details to zero before conversion. Their resulting host records cannot distinguish explicit wire zero from absent details. Same session and model do not restore the missing evidence. The plugin does not modify the installed adapter or pretend to recover raw responses.

## Historical replay

Projection state v2 replays native summaries, retaining only bounded sequence/id/usage metadata. It recovers a missing legacy total only for an exact one-call, one-attempt, one-summary match with matching counters. No session events are rewritten. The metadata cache is host-only and bounded to 64 summaries. Ambiguity, retries, newer explicitly unknown totals and conflicting counters do not receive guessed data.

For the observed records:

- 6215 uncached + 6144 cached read, 3891 output, 16250 total: prompt 12359, ratio 49.7%; absent write count stays unknown.
- 12115 input, 3743 output, 15858 total, absent cache details: known prompt 12115; ratio unavailable, with UI explanation "zero or unreported". Not claimed as observed 0% or definitively missing provider field.

## Aggregation and presentation

Per-call denominator evidence must survive aggregation. Opposing invalid totals must not cancel into a valid ratio; independently valid denominators must remain usable even when an output counter is missing. The client validates bounded primitive evidence, not arbitrary claimed ratios. Existing v1 records without extra evidence remain readable.

The UI retains native interactions and styles; only explanatory text changes. Missing read counts, missing/inconsistent prompt totals, empty prompts and unobserved attempts have distinct explanations. Backend changes require restarting Web and refreshing the client. No additional model call is necessary to validate replay.
