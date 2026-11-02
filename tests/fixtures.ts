import { SessionSeq } from '@deepseek-ai/dsh-session';
import type { CacheFirstSnapshot } from '../src/policy.js';
export const snapshot: CacheFirstSnapshot = {
  totalTokens: 100_000, surfaceTokens: 90_000, fixedTokens: 10_000,
  contextWindow: 128_000, thresholdTokens: 102_400, defaultRetainTokens: 20_000,
  summaryMaxTokens: 1000, trigger: 'pressure',
  route: { provider: 'test', model: 'main' }, summaryRoute: { provider: 'test', model: 'summary' },
  history: { userTurns: 5, modelCalls: 20, compactionCount: 0 },
  candidates: [
    { start: SessionSeq(1), end: SessionSeq(10), removedTokens: 50_000, retainedTokens: 40_000 },
    { start: SessionSeq(1), end: SessionSeq(20), removedTokens: 70_000, retainedTokens: 20_000 },
  ],
};
export const prices = [
  { provider: 'test', model: 'main', input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
  { provider: 'test', model: 'summary', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
];
