/** One session-scoped plugin; execution and economic policy remain independent internally. */
import { Context } from '@deepseek-ai/cordis';
import type { IntegrationConfig } from './preset.js';
import { ADAPTIVE_MODES, lateLive, provideLive } from './live.js';
import z from '@deepseek-ai/schemastery';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { CacheFirstCompactionEngine, type CacheFirstConfig } from './engine.js';
import { Config as AdaptiveSchema, resolveConfig as resolveAdaptiveConfig, type AdaptiveConfig, type ResolvedConfig as ResolvedAdaptiveConfig } from './adaptive/config.js';
import { registerDiagnostics } from './diagnostics.js';
import { apply as applyPolicy } from './adaptive/policy.js';

export { CacheFirstCompactionEngine } from './engine.js';
export type { CacheFirstConfig } from './engine.js';
export type { CompactionResultSink, CompactionTelemetryResult, DecisionFact } from './telemetry.js';
export type { DiagnosticRecord, DiagnosticState } from './diagnostics.js';
export type * from './policy.js';
export { evaluatePolicy } from './adaptive/economics.js';
export type { CandidateScore, Evaluation } from './adaptive/economics.js';
export { resolveAdaptiveConfig };
export type { AdaptiveConfig, RoutePrices } from './adaptive/config.js';
export type { PolicyObservation } from './adaptive/policy.js';

export interface PluginConfig extends CacheFirstConfig {
  cacheFirst?: boolean;
  adaptive?: AdaptiveConfig;
}
export interface ResolvedPluginConfig extends CacheFirstConfig {
  cacheFirst: boolean;
  adaptive: ResolvedAdaptiveConfig;
  summaryFallbackAttempts: number;
  maxCandidateChecks: number;
}

/** Validate the full matrix before providing services or registering any observers. */
export function resolveConfig(input: PluginConfig = {}): ResolvedPluginConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Expected config object');
  for (const key of Object.keys(input)) {
    if (!['cacheFirst', 'adaptive', 'base', 'summaryFallbackAttempts', 'maxCandidateChecks'].includes(key)) throw new TypeError(`Unknown option: ${key}`);
  }
  const cacheFirst = input.cacheFirst ?? true;
  if (typeof cacheFirst !== 'boolean') throw new TypeError('cacheFirst must be a boolean');
  const adaptive = resolveAdaptiveConfig(input.adaptive);
  if (!cacheFirst && adaptive.mode !== 'off') throw new TypeError('cacheFirst: false requires adaptive.mode: off; observe and active require the cache-first backend');
  const summaryFallbackAttempts = input.summaryFallbackAttempts ?? 2;
  const maxCandidateChecks = input.maxCandidateChecks ?? 128;
  if (!Number.isSafeInteger(summaryFallbackAttempts) || summaryFallbackAttempts < 0) throw new TypeError('summaryFallbackAttempts must be a non-negative safe integer');
  if (!Number.isSafeInteger(maxCandidateChecks) || maxCandidateChecks < 2) throw new TypeError('maxCandidateChecks must be a safe integer of at least 2');
  return { ...input, cacheFirst, adaptive, summaryFallbackAttempts, maxCandidateChecks };
}

export const name = 'smart-compaction';
// Dependencies belong to the selected branch: integration must not wait for or
// provide a global compaction engine. The session branch retains its native injection.
export const inject: string[] = [];
export const EngineConfig: z<PluginConfig> = z.transform(z.object({
  cacheFirst: z.boolean().default(true),
  adaptive: AdaptiveSchema,
  base: BasicCompactionEngine.Config,
  summaryFallbackAttempts: z.number().step(1).min(0).default(2),
  maxCandidateChecks: z.number().step(1).min(2).default(128),
}), value => resolveConfig(value as PluginConfig));

// The root is ONE plain object so its two user switches can be `.volatile()`:
// the Web settings form only edits volatile fields at a fixed object path, which
// neither a union nor a transform wrapper provides. It serves two row kinds:
//   { integration: true, cacheFirst?, adaptiveMode? }  the user-facing marker
//   { cacheFirst, adaptive, base, ... }                the engine row the preset generates
// Engine rows are validated by `resolveConfig` in `apply`.
export const Config = z.object({
  integration: z.const(true),
  cacheFirst: z.boolean().default(true).volatile(),
  adaptiveMode: z.union([...ADAPTIVE_MODES]).default('observe').volatile(),
  adaptive: AdaptiveSchema,
  base: BasicCompactionEngine.Config,
  summaryFallbackAttempts: z.number().step(1).min(0).default(2),
  maxCandidateChecks: z.number().step(1).min(2).default(128),
}) as unknown as z<RootInput, RootInput>;
type Maybe<T> = T | { get(): T };
type RootInput = Omit<PluginConfig, 'cacheFirst'> & { integration?: true; cacheFirst?: Maybe<boolean>; adaptiveMode?: Maybe<'off' | 'observe' | 'active'> };
const unwrap = <T>(value: Maybe<T> | undefined): T | undefined =>
  value !== null && typeof value === 'object' && 'get' in value && typeof (value as { get(): T }).get === 'function' ? (value as { get(): T }).get() : (value as T | undefined);

/** Dispatch before mounting services. Child plugin lifetime is owned by the root. */
export function apply(ctx: Context, input: RootInput = {}): void {
  if ('integration' in input && input.integration !== undefined) {
    if (input.integration !== true) throw new TypeError('integration must be true');
    // Enable/client-discovery marker. The bundle's separate startup adapter owns
    // standard + legacy alias registration even when this row is disabled; the
    // two switches are published so the engine follows them live.
    provideLive(ctx, { cacheFirst: input.cacheFirst, adaptiveMode: input.adaptiveMode });
    return;
  }
  const { integration: _marker, adaptiveMode: _mode, cacheFirst, ...rest } = input;
  const plain: PluginConfig = { ...rest, ...(cacheFirst === undefined ? {} : { cacheFirst: unwrap(cacheFirst) as boolean }) };
  const config = resolveConfig(plain);
  ctx.plugin({ name: 'smart-compaction-engine', inject: [...BasicCompactionEngine.inject, 'sessionProjections'], apply: applyEngine }, config);
}

function mountEngine(ctx: Context, config: ResolvedPluginConfig, cacheFirst: boolean, modeOf?: () => 'off' | 'observe' | 'active'): void {
  if (!cacheFirst) {
    new BasicCompactionEngine(ctx, config.base);
    return;
  }
  const diagnosticSink = registerDiagnostics(ctx);
  new CacheFirstCompactionEngine(ctx, {
    ...(config.base === undefined ? {} : { base: config.base }),
    summaryFallbackAttempts: config.summaryFallbackAttempts,
    maxCandidateChecks: config.maxCandidateChecks,
  }, diagnosticSink);
  // With a live source the policy is always installed and reads the mode per decision.
  if (modeOf || config.adaptive.mode !== 'off') applyPolicy(ctx, config.adaptive, modeOf);
}

const ENGINE_INJECT = [...BasicCompactionEngine.inject, 'sessionProjections'];

function applyEngine(ctx: Context, input: PluginConfig): void {
  const config = resolveConfig(input);
  const live = lateLive({ cacheFirst: config.cacheFirst, mode: config.adaptive.mode });
  // The integration entry's switches are authoritative whenever it is present.
  // A mode change needs no remount (the policy reads it per decision); a
  // cacheFirst change swaps the engine: dispose the old one, then mount the other.
  let child: { dispose(): Promise<void> | void } | undefined;
  let mounted: boolean | undefined;
  let queue: Promise<void> = Promise.resolve();
  const sync = () => {
    queue = queue.then(async () => {
      const want = live.cacheFirst();
      if (child !== undefined && mounted === want) return;
      await child?.dispose();
      mounted = want;
      child = ctx.plugin({ name: 'smart-compaction-engine-live', inject: ENGINE_INJECT, apply: (c: Context) => { mountEngine(c, config, want, live.mode); } });
    }).catch(() => { /* a failed swap keeps the previous state; the next change retries */ });
  };
  sync();
  ctx.effect(() => live.subscribe(sync));
}

export default { name, inject, Config, apply };
