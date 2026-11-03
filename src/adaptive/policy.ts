import type { Context } from '@deepseek-ai/cordis';
import type { CacheFirstDecisionResult, CacheFirstSnapshot } from '../policy.js';
import { Config, resolveConfig, type AdaptiveConfig } from './config.js';
import { evaluatePolicy, type Evaluation } from './economics.js';

export { Config, resolveConfig } from './config.js';
export type { AdaptiveConfig, ResolvedConfig, RoutePrices } from './config.js';
export { evaluatePolicy } from './economics.js';
export type { CandidateScore, Evaluation } from './economics.js';
export const name = 'adaptive-compaction';
export const inject = ['compaction'];

export interface PolicyObservation {
  event: 'adaptive-compaction/decision';
  sessionId?: string;
  operationId?: string;
  mode: 'observe' | 'active';
  route: CacheFirstSnapshot['route'];
  summaryRoute: CacheFirstSnapshot['summaryRoute'];
  trigger: CacheFirstSnapshot['trigger'];
  status: Evaluation['status'];
  totalTokens: number;
  evaluatedCandidates: number;
  availableCandidates: number;
  pricing: Evaluation['pricing'];
  baselineCost: number | null;
  estimatedCost: number | null;
  predictedNetBenefit: number | null;
  retainedTokens: number | null;
  /** This policy replaced the downstream decision, not proof compaction occurred. */
  decisionApplied: boolean;
  assumptions: {
    expectedRemainingCalls: number;
    cacheHitRatio: number;
    rebuildCacheHitRatio: number;
    cacheWriteFraction: number;
    informationLossPerMillionTokens: number;
    expectedSummaryTokens: number;
    summaryFramingTokens: number;
    effectiveSummaryCacheHitRatio: number;
  };
  costs: null | {
    summaryInput: number;
    summaryOutput: number;
    cacheRebuild: number;
    futureInput: number;
    futureOutput: number;
    informationLossPenalty: number;
  };
  /** Mandatory pressure/overflow recovery belongs to the execution backend. */
  executorOwnsSafety: true;
}
/** Numeric-only waterfall middleware: never installs a service or lifecycle driver. */
export function apply(ctx: Context, input: AdaptiveConfig = {}, modeOf?: () => 'off' | 'observe' | 'active'): void {
  const config = resolveConfig(input);
  const logger = ctx.logger(name);
  ctx.on('cache-first/decide', (snapshot, next): CacheFirstDecisionResult => {
    const previous = next();
    // A live source (the integration entry's switch) wins over the startup value.
    const mode = modeOf ? modeOf() : config.mode;
    if (mode === 'off') return previous;
    const evaluation = evaluatePolicy(snapshot, { ...config, mode });
    const usable = ['compact', 'defer', 'below-pressure', 'no-candidate'].includes(evaluation.status);
    const applied = mode === 'active' && usable;
    const observation: PolicyObservation = {
      event: 'adaptive-compaction/decision', mode,
      ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
      ...(snapshot.operationId === undefined ? {} : { operationId: snapshot.operationId }),
      route: snapshot.route, summaryRoute: snapshot.summaryRoute, trigger: snapshot.trigger,
      status: evaluation.status, totalTokens: snapshot.totalTokens, pricing: evaluation.pricing,
      evaluatedCandidates: evaluation.evaluatedCandidates, availableCandidates: evaluation.availableCandidates,
      baselineCost: evaluation.baselineCost, estimatedCost: evaluation.best?.totalCost ?? null,
      predictedNetBenefit: evaluation.best?.predictedNetBenefit ?? null,
      retainedTokens: evaluation.best?.candidate.retainedTokens ?? null,
      decisionApplied: applied, executorOwnsSafety: true,
      assumptions: {
        expectedRemainingCalls: config.expectedRemainingCalls,
        cacheHitRatio: config.cacheHitRatio,
        rebuildCacheHitRatio: config.rebuildCacheHitRatio,
        cacheWriteFraction: config.cacheWriteFraction,
        informationLossPerMillionTokens: config.informationLossPerMillionTokens,
        expectedSummaryTokens: Math.min(config.expectedSummaryTokens, snapshot.summaryMaxTokens),
        summaryFramingTokens: config.summaryFramingTokens,
        effectiveSummaryCacheHitRatio: snapshot.route.provider === snapshot.summaryRoute.provider && snapshot.route.model === snapshot.summaryRoute.model ? config.summaryCacheHitRatio : 0,
      },
      costs: evaluation.best ? {
        summaryInput: evaluation.best.summaryInputCost,
        summaryOutput: evaluation.best.summaryOutputCost,
        cacheRebuild: evaluation.best.cacheRebuildCost,
        futureInput: evaluation.best.futureInputCost,
        futureOutput: evaluation.best.futureOutputCost,
        informationLossPenalty: evaluation.best.informationLossPenalty,
      } : null,
    };
    // Structured exporter arguments only; no session event, prompt, message or tool output.
    logger.info(observation);
    return applied ? evaluation.decision : previous;
  });
}
