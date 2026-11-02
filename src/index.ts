/** One session-scoped plugin; execution and economic policy remain independent internally. */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { CacheFirstCompactionEngine, type CacheFirstConfig } from './engine.js';
import { Config as AdaptiveSchema, resolveConfig as resolveAdaptiveConfig, type AdaptiveConfig, type ResolvedConfig as ResolvedAdaptiveConfig } from './adaptive/config.js';
import { apply as applyPolicy } from './adaptive/policy.js';

export { CacheFirstCompactionEngine } from './engine.js';
export type { CacheFirstConfig } from './engine.js';
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
export const inject = BasicCompactionEngine.inject;
export const Config: z<PluginConfig> = z.transform(z.object({
  cacheFirst: z.boolean().default(true),
  adaptive: AdaptiveSchema,
  base: BasicCompactionEngine.Config,
  summaryFallbackAttempts: z.number().step(1).min(0).default(2),
  maxCandidateChecks: z.number().step(1).min(2).default(128),
}), value => resolveConfig(value as PluginConfig));

/** Root injection waits for Basic's services. Backend and observer share this fiber,
 * so readiness and disposal are atomic; no child requiring its parent's pending service.
 */
export function apply(ctx: Context, input: PluginConfig = {}): void {
  const config = resolveConfig(input);
  if (!config.cacheFirst) {
    new BasicCompactionEngine(ctx, config.base);
    return;
  }
  new CacheFirstCompactionEngine(ctx, {
    ...(config.base === undefined ? {} : { base: config.base }),
    summaryFallbackAttempts: config.summaryFallbackAttempts,
    maxCandidateChecks: config.maxCandidateChecks,
  });
  if (config.adaptive.mode !== 'off') applyPolicy(ctx, config.adaptive);
}

export default { name, inject, Config, apply };
