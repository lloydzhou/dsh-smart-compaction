import z from '@deepseek-ai/schemastery';

/** All monetary rates use one operator-chosen currency per million tokens. */
export interface RoutePrices {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  /** Incremental cache-write charge, in addition to uncached input. */
  cacheWrite: number;
}
export interface AdaptiveConfig {
  mode?: 'off' | 'observe' | 'active';
  /** Compatibility override: exact routes, not public runtime model metadata. */
  prices?: RoutePrices[];
  /** Use the pinned DeepSeek reference for routes without explicit prices. */
  referencePriceFallback?: boolean;
  /** Currency of all legacy entries; unspecified cannot mix with the USD reference. */
  legacyPriceCurrency?: string;
  expectedRemainingCalls?: number;
  expectedOutputTokensPerCall?: number;
  cacheHitRatio?: number;
  rebuildCacheHitRatio?: number;
  cacheWriteFraction?: number;
  summaryInputOverheadTokens?: number;
  /** Explicit estimate, clamped to the executor output cap; not a guaranteed length. */
  expectedSummaryTokens?: number;
  /** Replacement envelope/framing tokens, separate from summarizer instruction input. */
  summaryFramingTokens?: number;
  /** Same-route replay prefix cache assumption; cross-route summary is always uncached. */
  summaryCacheHitRatio?: number;
  minPressureRatio?: number;
  minRetainTokens?: number;
  maxRetainRatio?: number;
  maxCandidates?: number;
  minNetBenefit?: number;
  /** Optional subjective quality penalty; never a measured information value. */
  informationLossPerMillionTokens?: number;
}
export type ResolvedConfig = Required<AdaptiveConfig>;
const defaults: ResolvedConfig = {
  mode: 'observe', prices: [], referencePriceFallback: true, legacyPriceCurrency: 'unspecified', expectedRemainingCalls: 8,
  expectedOutputTokensPerCall: 0, cacheHitRatio: 0, rebuildCacheHitRatio: 0,
  cacheWriteFraction: 0, summaryInputOverheadTokens: 1024,
  expectedSummaryTokens: 2048, summaryFramingTokens: 64, summaryCacheHitRatio: 0,
  minPressureRatio: 0.25, minRetainTokens: 2048, maxRetainRatio: 0.8,
  maxCandidates: 256, minNetBenefit: 0.001, informationLossPerMillionTokens: 0,
};
const finite = (value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${label} must be finite and in [${min}, ${max}]`);
  }
};
/** Validate direct callers too, rejecting unknown keys and duplicate exact routes. */
export function resolveConfig(input: AdaptiveConfig = {}): ResolvedConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Expected config object');
  for (const key of Object.keys(input)) if (!Object.hasOwn(defaults, key)) throw new TypeError(`Unknown option: ${key}`);
  const c = { ...defaults, ...input };
  if (!['off', 'observe', 'active'].includes(c.mode)) throw new TypeError('Invalid mode');
  if (typeof c.referencePriceFallback !== 'boolean') throw new TypeError('referencePriceFallback must be boolean');
  if (typeof c.legacyPriceCurrency !== 'string' || !/^(unspecified|[A-Z]{3})$/.test(c.legacyPriceCurrency)) throw new TypeError('legacyPriceCurrency must be unspecified or an uppercase three-letter currency code');
  for (const key of ['cacheHitRatio', 'rebuildCacheHitRatio', 'cacheWriteFraction', 'summaryCacheHitRatio', 'minPressureRatio', 'maxRetainRatio'] as const) finite(c[key], key, 0, 1);
  for (const key of ['expectedOutputTokensPerCall', 'summaryInputOverheadTokens', 'expectedSummaryTokens', 'summaryFramingTokens', 'minRetainTokens', 'minNetBenefit', 'informationLossPerMillionTokens'] as const) finite(c[key], key);
  finite(c.expectedRemainingCalls, 'expectedRemainingCalls', 1, 1000);
  finite(c.maxCandidates, 'maxCandidates', 1, 4096);
  for (const key of ['expectedRemainingCalls', 'expectedOutputTokensPerCall', 'summaryInputOverheadTokens', 'expectedSummaryTokens', 'summaryFramingTokens', 'minRetainTokens', 'maxCandidates'] as const) {
    if (!Number.isSafeInteger(c[key])) throw new TypeError(`${key} must be an integer`);
  }
  if (!Array.isArray(c.prices)) throw new TypeError('prices must be an array');
  const seen = new Set<string>();
  const prices = c.prices.map((p) => {
    if (!p || typeof p !== 'object') throw new TypeError('Invalid price entry');
    for (const key of Object.keys(p)) if (!['provider', 'model', 'input', 'output', 'cacheRead', 'cacheWrite'].includes(key)) throw new TypeError(`Unknown price option: ${key}`);
    for (const key of ['provider', 'model'] as const) if (typeof p[key] !== 'string' || !p[key].trim()) throw new TypeError(`Price ${key} must be nonempty`);
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) finite(p[key], `prices.${key}`);
    const key = JSON.stringify([p.provider, p.model]);
    if (seen.has(key)) throw new TypeError('Duplicate price route');
    seen.add(key);
    return Object.freeze({ ...p });
  });
  return Object.freeze({ ...c, prices: Object.freeze(prices) as unknown as RoutePrices[] });
}
const rate = () => z.number().min(0).required();
const ratio = (value: number) => z.number().min(0).max(1).default(value);
/** Loader/UI schema plus the same strict runtime checks as direct installation. */
export const Config = z.transform(z.object({
  mode: z.union(['off', 'observe', 'active']).default('observe'),
  referencePriceFallback: z.boolean().default(true),
  legacyPriceCurrency: z.string().default('unspecified'),
  prices: z.array(z.object({ provider: z.string().required(), model: z.string().required(), input: rate(), output: rate(), cacheRead: rate(), cacheWrite: rate() })).default([]),
  expectedRemainingCalls: z.natural().min(1).max(1000).default(8),
  expectedOutputTokensPerCall: z.natural().default(0),
  cacheHitRatio: ratio(0), rebuildCacheHitRatio: ratio(0), cacheWriteFraction: ratio(0),
  summaryInputOverheadTokens: z.natural().default(1024),
  expectedSummaryTokens: z.natural().default(2048), summaryFramingTokens: z.natural().default(64),
  summaryCacheHitRatio: ratio(0), minPressureRatio: ratio(0.25),
  minRetainTokens: z.natural().default(2048), maxRetainRatio: ratio(0.8),
  maxCandidates: z.natural().min(1).max(4096).default(256),
  minNetBenefit: z.number().min(0).default(0.001),
  informationLossPerMillionTokens: z.number().min(0).default(0),
}), (value) => resolveConfig(value as AdaptiveConfig));
