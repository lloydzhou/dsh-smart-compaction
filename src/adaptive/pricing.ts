import type { CacheFirstRoute } from '../policy.js';
import { resolveConfig, type AdaptiveConfig, type ResolvedConfig, type RoutePrices } from './config.js';

/** Pinned reference, NOT a claim about either execution route's actual bill. */
export const DEEPSEEK_REFERENCE = Object.freeze({
  model: 'DeepSeek V4.1 Flash',
  version: 'DeepSeek-V4.1-Flash-1017',
  apiModel: 'deepseek-flash',
  currency: 'USD' as const,
  unit: 'perMillionTokens' as const,
  period: 'peak' as const,
  date: '2026-11-02',
  url: 'https://api-docs.deepseek.com/quick_start/pricing/',
  versionUrl: 'https://api-docs.deepseek.com/news/news261017/',
  input: 0.30, cacheRead: 0.006, output: 1.20,
  // Additive premium only: ordinary uncached input is still charged.
  cacheWrite: 0,
});

type Rates = Readonly<Pick<RoutePrices, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>>;
export interface RoutePriceFact {
  readonly route: Readonly<CacheFirstRoute>;
  readonly source: 'legacy-config' | 'reference-fallback' | null;
  readonly currency: string | null;
  readonly unit: 'perMillionTokens';
  readonly rates: Rates | null;
  readonly reference: typeof DEEPSEEK_REFERENCE | null;
  readonly missing: 'public-model-pricing-unavailable' | null;
}
export interface ResolvedRoutePricing {
  readonly main: RoutePriceFact;
  readonly summary: RoutePriceFact;
  readonly compatible: boolean;
  readonly reason: 'missing-route-prices' | 'currency-mismatch' | null;
}

function resolveRoute(route: CacheFirstRoute, config: ResolvedConfig): RoutePriceFact {
  const identity = Object.freeze({ provider: route.provider, model: route.model });
  const explicit = config.prices.find(p => p.provider === route.provider && p.model === route.model);
  if (explicit) {
    const { input, output, cacheRead, cacheWrite } = explicit;
    return Object.freeze({ route: identity, source: 'legacy-config', currency: config.legacyPriceCurrency,
      unit: 'perMillionTokens', rates: Object.freeze({ input, output, cacheRead, cacheWrite }), reference: null, missing: null });
  }
  // RC3/RC5 public LlmResolvedModelInfo has no monetary fields and normalization
  // drops unknowns. Do not probe or fabricate a metadata pricing integration.
  const missing = 'public-model-pricing-unavailable';
  if (!config.referencePriceFallback) return Object.freeze({ route: identity, source: null, currency: null,
    unit: 'perMillionTokens', rates: null, reference: null, missing });
  const { input, output, cacheRead, cacheWrite } = DEEPSEEK_REFERENCE;
  return Object.freeze({ route: identity, source: 'reference-fallback', currency: 'USD', unit: 'perMillionTokens',
    rates: Object.freeze({ input, output, cacheRead, cacheWrite }), reference: DEEPSEEK_REFERENCE, missing });
}

/** Pure exact-route compatibility override, otherwise an explicitly labeled reference. */
export function resolveRoutePrice(route: CacheFirstRoute, config: AdaptiveConfig = {}): RoutePriceFact {
  return resolveRoute(route, resolveConfig(config));
}

/** Resolve both routes independently; never borrow main-route prices for summary. */
export function resolveRoutePricing(main: CacheFirstRoute, summary: CacheFirstRoute, config: AdaptiveConfig = {}): ResolvedRoutePricing {
  const c = resolveConfig(config);
  const mainPrice = resolveRoute(main, c);
  const summaryPrice = resolveRoute(summary, c);
  const reason = !mainPrice.rates || !summaryPrice.rates ? 'missing-route-prices'
    : mainPrice.currency !== summaryPrice.currency ? 'currency-mismatch' : null;
  return Object.freeze({ main: mainPrice, summary: summaryPrice, compatible: reason === null, reason });
}
