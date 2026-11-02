/** Read-only policy input and the optional decision waterfall. */
import type { SessionSeq } from '@deepseek-ai/dsh-session';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';

/** A tool-balanced prefix; retainedTokens excludes the fixed system head. */
export interface CacheFirstCandidate {
  readonly start: SessionSeq;
  readonly end: SessionSeq;
  readonly removedTokens: number;
  readonly retainedTokens: number;
}

/** Route identity for explicit provider-specific pricing. */
export interface CacheFirstRoute {
  readonly provider: string;
  readonly model: string;
}

/** Numeric, detached snapshot. History counts include shadowed and inherited events. */
export interface CacheFirstSnapshot {
  readonly totalTokens: number;
  readonly surfaceTokens: number;
  readonly fixedTokens: number;
  readonly contextWindow: number;
  readonly thresholdTokens: number;
  readonly defaultRetainTokens: number;
  readonly summaryMaxTokens: number;
  readonly trigger: 'pressure' | 'context-overflow';
  readonly candidates: readonly CacheFirstCandidate[];
  readonly route: CacheFirstRoute;
  readonly summaryRoute: CacheFirstRoute;
  readonly history: {
    readonly userTurns: number;
    readonly modelCalls: number;
    readonly compactionCount: number;
  };
  readonly previousUsage?: Readonly<TokenUsage>;
}

/** Optional policy proposal; the executor clamps pressure to its safety budget. */
export interface CacheFirstDecision {
  readonly thresholdTokens: number;
  readonly retainTokens: number;
  readonly reason: string;
}

/** Null declines optional compaction, never overflow or hard-pressure recovery. */
export type CacheFirstDecisionResult = CacheFirstDecision | null;

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Decide optional pressure and retention without observing mutable session state.
     * @param snapshot - detached numeric measurements and route identities.
     * @param next - delegate to the next listener or the configured default.
     * @returns a policy proposal, or null to decline optional work.
     * @mode waterfall
     */
    'cache-first/decide'(snapshot: CacheFirstSnapshot, next: () => CacheFirstDecisionResult): CacheFirstDecisionResult;
  }
}
