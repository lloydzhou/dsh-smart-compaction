import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';

/** Preserve the routed request's effort only for this engine's stock summary call. */
export class SummaryReasoningScope {
  private readonly scope = new AsyncLocalStorage<{ session: Session; active: boolean; claimed: boolean }>();

  constructor(ctx: Context) {
    ctx.on('llm/stream', (options, next) => {
      const scope = this.scope.getStore();
      if (!scope?.active || scope.claimed || options.purpose !== 'compaction' || options.sessionId !== scope.session.id) return next();
      // Claim before invoking listeners: nested auxiliary calls must not inherit this repair.
      scope.claimed = true;
      const latest = scope.session.requestHeader()?.config;
      if (options.reasoningEffort === undefined && latest?.reasoningEffort !== undefined
        && options.provider === latest.provider && options.model === latest.model) {
        // RC3/RC5 expose mutable GenerateOptions. Their zero-argument next() closes
        // over this very object: replacing it or passing next({...options}) does not
        // change dispatch. Keep the field for deferred adapter iteration as well.
        // All other envelope fields and the complete middleware chain stay intact.
        options.reasoningEffort = latest.reasoningEffort;
      }
      return next();
    }, { prepend: true });
  }

  async run<T>(session: Session, run: () => Promise<T>): Promise<T> {
    const scope = { session, active: true, claimed: false };
    return this.scope.run(scope, async () => {
      try { return await run(); }
      finally { scope.active = false; }
    });
  }
}
