/** Public-API-only selection and dry-run pricing. */
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
import type { TokenMeasurement, TokenMeter } from '@deepseek-ai/dsh-token-meter';
import type { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import type { CacheFirstCandidate } from './policy.js';

/** Enumerate balanced prefixes, always preserving the last surface node and system head. */
export function candidates(session: Session, measurement: TokenMeasurement, maxCandidateChecks = Number.POSITIVE_INFINITY): CacheFirstCandidate[] {
  const nodes = measurement.nodes;
  if (nodes.length !== session.surface.nodes.length || nodes.some((node, i) => node.seq !== session.surface.nodes[i])) {
    throw new Error('cache-first: token measurement does not match the surface');
  }
  const first = nodes[0];
  if (!first) return [];
  const offset = session.eventAt(first.seq)?.type === 'system/message' ? 1 : 0;
  const head = nodes[offset];
  if (!head || !toolPairingBalancedBefore(session, head.seq)) return [];
  const eligibleTokens = nodes.slice(offset).reduce((sum, node) => sum + node.tokens, 0);
  const result: CacheFirstCandidate[] = [];
  const possibleCuts = nodes.length - offset - 1;
  const checkedCuts = new Set<number>();
  const count = Math.min(possibleCuts, maxCandidateChecks);
  for (let sample = 0; sample < count; sample++) {
    checkedCuts.add(offset + (count <= 1 ? 0 : Math.floor(sample * (possibleCuts - 1) / (count - 1))));
  }
  let removedTokens = 0;
  for (let i = offset; i < nodes.length - 1; i++) {
    const node = nodes[i]!;
    removedTokens += node.tokens;
    if (checkedCuts.has(i) && removedTokens > 0 && toolPairingBalancedAfter(session, node.seq)) {
      result.push({ start: head.seq, end: node.seq, removedTokens, retainedTokens: eligibleTokens - removedTokens });
    }
  }
  return result;
}

/** Price full projected replacements; unchanged rich blocks retain their route-priced contribution. */
export function projectedPruneTokens(session: Session, measurement: TokenMeasurement, meter: TokenMeter, pruner: ToolResultPruner): number {
  let savings = 0;
  for (const node of measurement.nodes) {
    const event = session.eventAt(node.seq);
    if (event?.type !== 'tool/result') continue;
    const message = session.deriveEventMessage(event);
    if (message?.role !== 'tool') continue;
    const content = pruner.pruneContent(message.content);
    if (content !== null) savings += meter.estimateMessage(message) - meter.estimateMessage({ ...message, content });
  }
  return Math.max(0, measurement.totalTokens - savings);
}
