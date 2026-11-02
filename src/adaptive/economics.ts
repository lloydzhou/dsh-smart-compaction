import type { CacheFirstCandidate, CacheFirstDecisionResult, CacheFirstSnapshot } from '../policy.js';
import { resolveConfig, type AdaptiveConfig, type ResolvedConfig, type RoutePrices } from './config.js';

export interface CandidateScore {
  candidate: CacheFirstCandidate;
  projectedTokens: number;
  summaryInputCost: number;
  summaryOutputCost: number;
  cacheRebuildCost: number;
  futureInputCost: number;
  futureOutputCost: number;
  informationLossPenalty: number;
  totalCost: number;
  predictedNetBenefit: number;
}
export interface Evaluation {
  status: 'off' | 'invalid-snapshot' | 'missing-prices' | 'below-pressure' | 'no-candidate' | 'defer' | 'compact';
  decision: CacheFirstDecisionResult;
  baselineCost: number | null;
  evaluatedCandidates: number;
  availableCandidates: number;
  best: CandidateScore | null;
}
const MILLION = 1_000_000;
/** cacheWrite is an additive fee on the fraction of uncached tokens written. */
function inputCost(tokens: number, price: RoutePrices, hit: number, write: number): number {
  return tokens * (hit * price.cacheRead + (1 - hit) * (price.input + write * price.cacheWrite)) / MILLION;
}
const validNumber = (x: number) => Number.isFinite(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER;
function validSnapshot(s: CacheFirstSnapshot): boolean {
  return [s.totalTokens, s.surfaceTokens, s.fixedTokens, s.thresholdTokens, s.defaultRetainTokens, s.summaryMaxTokens].every(validNumber)
    && validNumber(s.contextWindow) && s.contextWindow > 0 && s.totalTokens >= s.fixedTokens;
}
function pricesFor(c: ResolvedConfig, route: CacheFirstSnapshot['route']): RoutePrices | undefined {
  return c.prices.find(p => p.provider === route.provider && p.model === route.model);
}
/** Pure, finite-horizon estimate. It does not predict cache hits or measure quality. */
export function evaluatePolicy(snapshot: CacheFirstSnapshot, config: AdaptiveConfig = {}): Evaluation {
  const c = resolveConfig(config);
  const result: Evaluation = { status: 'off', decision: null, baselineCost: null, evaluatedCandidates: 0, availableCandidates: snapshot.candidates.length, best: null };
  if (c.mode === 'off') return result;
  if (!validSnapshot(snapshot)) return { ...result, status: 'invalid-snapshot' };
  const price = pricesFor(c, snapshot.route);
  const summaryPrice = pricesFor(c, snapshot.summaryRoute);
  if (!price || !summaryPrice) return { ...result, status: 'missing-prices' };
  const decisionThreshold = Math.max(1, Math.min(snapshot.thresholdTokens, snapshot.totalTokens - 1));
  const summaryTokens = Math.min(c.expectedSummaryTokens, snapshot.summaryMaxTokens);
  const replacementTokens = summaryTokens + c.summaryFramingTokens;
  const sameSummaryRoute = snapshot.route.provider === snapshot.summaryRoute.provider && snapshot.route.model === snapshot.summaryRoute.model;
  const summaryCacheHitRatio = sameSummaryRoute ? c.summaryCacheHitRatio : 0;
  const calls = c.expectedRemainingCalls;
  const futureOutputCost = calls * c.expectedOutputTokensPerCall * price.output / MILLION;
  const baselineCost = calls * inputCost(snapshot.totalTokens, price, c.cacheHitRatio, c.cacheWriteFraction) + futureOutputCost;
  result.baselineCost = baselineCost;
  if (!Number.isFinite(baselineCost)) return { ...result, baselineCost: null, status: 'invalid-snapshot' };
  if (snapshot.trigger !== 'context-overflow' && snapshot.totalTokens < c.minPressureRatio * snapshot.contextWindow) return { ...result, status: 'below-pressure' };
  // Evenly sample existing legal candidates; never synthesize or align a new range.
  const count = Math.min(snapshot.candidates.length, c.maxCandidates);
  for (let i = 0; i < count; i++) {
    const index = count === 1 ? 0 : Math.floor(i * (snapshot.candidates.length - 1) / (count - 1));
    const candidate = snapshot.candidates[index]!;
    if (!validNumber(candidate.removedTokens) || !validNumber(candidate.retainedTokens)
      || candidate.retainedTokens < c.minRetainTokens || candidate.retainedTokens >= decisionThreshold
      || candidate.retainedTokens > c.maxRetainRatio * snapshot.contextWindow
      || candidate.removedTokens <= replacementTokens || candidate.removedTokens > snapshot.surfaceTokens
      || candidate.retainedTokens > snapshot.surfaceTokens) continue;
    const projectedTokens = snapshot.totalTokens - candidate.removedTokens + replacementTokens;
    if (projectedTokens < snapshot.fixedTokens || projectedTokens >= snapshot.totalTokens || projectedTokens > snapshot.contextWindow) continue;
    // Only the same-route replay prefix can use the configured cache assumption.
    // New summarizer instructions are always priced uncached; cross-route replay gets no assumed hits.
    const summaryInputCost = inputCost(snapshot.fixedTokens + candidate.removedTokens, summaryPrice, summaryCacheHitRatio, c.cacheWriteFraction)
      + inputCost(c.summaryInputOverheadTokens, summaryPrice, 0, c.cacheWriteFraction);
    const summaryOutputCost = summaryTokens * summaryPrice.output / MILLION;
    // First post-compaction call pays the explicitly configured rebuild hit/write assumptions.
    const cacheRebuildCost = inputCost(projectedTokens, price, c.rebuildCacheHitRatio, c.cacheWriteFraction);
    const futureInputCost = (calls - 1) * inputCost(projectedTokens, price, c.cacheHitRatio, c.cacheWriteFraction);
    const informationLossPenalty = candidate.removedTokens * c.informationLossPerMillionTokens / MILLION;
    const totalCost = summaryInputCost + summaryOutputCost + cacheRebuildCost + futureInputCost + futureOutputCost + informationLossPenalty;
    if (!Number.isFinite(totalCost)) continue;
    result.evaluatedCandidates++;
    const score: CandidateScore = { candidate, projectedTokens, summaryInputCost, summaryOutputCost, cacheRebuildCost, futureInputCost, futureOutputCost, informationLossPenalty, totalCost, predictedNetBenefit: baselineCost - totalCost };
    // On equal predicted cost prefer more verbatim history, then stable original order.
    if (!result.best || score.totalCost < result.best.totalCost || (score.totalCost === result.best.totalCost && candidate.retainedTokens > result.best.candidate.retainedTokens)) result.best = score;
  }
  if (!result.best) return { ...result, status: 'no-candidate' };
  if (result.best.predictedNetBenefit <= c.minNetBenefit) return { ...result, status: 'defer' };
  return {
    ...result, status: 'compact',
    decision: {
      thresholdTokens: decisionThreshold,
      retainTokens: result.best.candidate.retainedTokens,
      reason: 'adaptive: positive estimated finite-horizon net benefit; heuristic, not guaranteed savings',
    },
  };
}
