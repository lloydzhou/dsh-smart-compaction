# Implementation scope

One root npm project, `dsh-smart-compaction`, targets the published DSH 0.2.1-rc.5 API (original alpha source research: ce7073d51254c26cd63b22a60835b8f948deb447; runtime now validated against RC.5 npm packages). Runtime DSH prerelease dependencies remain exact; Cordis is 4.0.5 and Schemastery is 3.18.5. No private source imports, workspace package dependencies, or host checkout changes. The installed GUI 0.2.1-rc.3 is not upgraded or claimed compatible.

## Composition

The [root entry](<src/index.ts>) validates the configuration matrix before side effects. `cacheFirst` defaults true and `adaptive.mode` defaults observe. True/off selects fixed cache-first, true/observe preserves execution decisions while logging, and true/active applies economic proposals. False/off creates the stock Basic engine; false with observe/active (including omitted adaptive configuration) is rejected. All other existing execution and adaptive fields remain supported.

Root `inject` retains Basic's required services. Exactly one backend is constructed in the root plugin fiber. The optional internal policy is a synchronous function in that same fiber, not a child that waits on its parent's pending compaction service. Root fiber activation makes the backend and observer ready together; disposal removes both. The public executor constructor remains separately usable without implicitly attaching policy.

## Execution and policy boundaries

[Execution](<src/engine.ts>) extends exported `BasicCompactionEngine`, overrides automatic pressure/overflow behavior, and inherits manual and model-switch behavior. [Selection](<src/selection.ts>) dry-runs complete-message pruning and enumerates bounded, balanced head prefixes. The [policy protocol](<src/policy.ts>) contains detached numeric snapshots and synchronous proposals, never mutable Session access.

The [internal policy](<src/adaptive/policy.ts>) calls downstream first and emits structured numeric predictions. [Economics](<src/adaptive/economics.ts>) scores supplied legal cuts using explicit prices and bounded operator assumptions. It cannot override mandatory hard-pressure or overflow safety. Off installs no observer.

Successful compaction still uses Basic's durable summary transaction. Insufficient dry-run pruning leaves original bytes intact for summarization; retained results are pruned only after summary if pressure remains. Bounded smaller-prefix retries preserve complete pairing; cancellation prevents fallback mutation. Public historical APIs are deprecated in the pinned host but have no complete replacement for these operations.

## Packaging

One root manifest, lockfile, source tree and test suite. One additive [preset patch](<cordis.patch.yml>) derived from the former cache-first patch explicitly nests adaptive observe; stock presets remain unchanged. Old package directories and old tarballs were verified and moved without clobbering to a unique sibling archive outside this project. No publication, push, or installed GUI changes are part of this work.
