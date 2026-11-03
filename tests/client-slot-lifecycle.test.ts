import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import type { ClientContext } from '../client/index.js';

const SLOT = 'conversation.chat.node';
const keys = ['compaction', 'manual-compaction'] as const;
// Erase only the open SlotMap's compile-time component/owner props. All ledger,
// priority election, collisions, and disposal are the published SlotCore code.
const register = (core: SlotCore, options: object, component: unknown) =>
  (core.register as (options: object, component: unknown) => () => void)(options, component);

function loadClient() {
  const styles = new Set<unknown>();
  const document = {
    createElement: () => {
      const style = { dataset: {}, textContent: '', remove: () => { styles.delete(style); } };
      return style;
    },
    head: { append: (style: unknown) => { styles.add(style); } },
  };
  const output = buildSync({ entryPoints: ['client/index.ts'], bundle: true, platform: 'browser', format: 'cjs', write: false,
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] }).outputFiles[0]!.text;
  const module = { exports: {} as {
    apply: (ctx: ClientContext) => void;
    CompactionRenderer: unknown;
    ManualCompactionRenderer: unknown;
  } };
  runInContext(output, createContext({ module, exports: module.exports, document, require: (id: string) => {
    if (id === 'react' || id === '@deepseek-ai/dsh-client-ui-primitives') return {};
    throw new Error(`Unexpected client import: ${id}`);
  } }));
  return { ...module.exports, styles };
}

// Execute the existing published native registrations verbatim, with inert view
// identities: this test exercises registration, not React rendering. In
// particular manual-compaction is an existing view key, not a new durable event.
function nativeRegistrations(core: SlotCore) {
  const source = readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-ui-chat/client'), 'utf8');
  const native = { compaction: () => null, 'manual-compaction': () => null };
  const disposers: (() => void)[] = [];
  for (const key of keys) {
    const pattern = new RegExp('ctx\\.slots\\.inject\\("conversation\\.chat\\.node", \\(\\) => ctx\\.slots\\.register\\(\\{\\s*name: "conversation\\.chat\\.node",\\s*key: "' + key + '",[\\s\\S]*?\\}, \\w+\\)\\);');
    const statement = source.match(pattern)?.[0];
    expect(statement, `published native registration for ${key}`).toBeDefined();
    runInContext(statement!, createContext({
      NS: 'native-chat', CompactionNodeView: native.compaction, ManualCompactionNodeView: native['manual-compaction'],
      ctx: { slots: {
        inject: (_name: string, callback: () => () => void) => { disposers.push(callback()); },
        register: (options: object, component: unknown) => register(core, options, component),
      } },
    }));
  }
  return { native, dispose: () => disposers.reverse().forEach(dispose => dispose()) };
}

function pluginHarness(core: SlotCore, client: ReturnType<typeof loadClient>) {
  const root = new Context();
  const dictionaryDispose = vi.fn();
  const localeRegister = vi.fn(() => dictionaryDispose);
  let stopInjection: () => void = () => { throw new Error('plugin not applied'); };
  const fiber = root.plugin((ctx) => {
    const facade = {
      effect: ctx.effect.bind(ctx),
      locale: { register: localeRegister },
      // Settings form: served immediately; its slot is undeclared here, so it registers nothing.
      configForms: { get: () => ({ set: async () => true }), whileServed: (_ns: string[], fn: () => unknown) => fn() },
      slots: {
        register: (options: object, component: unknown) => ctx.effect(() => register(core, options, component), 'slots.register()'),
        inject: (name: string, callback: () => any) => {
          // Runtime SlotRegistry.inject uses a declaration subscription and a
          // nested ctx.effect(callback). The *real* Cordis effect below only
          // owns returned/yielded disposers, not arbitrary nested effects.
          const controller = ctx.effect(() => {
            let active: (() => unknown) | undefined;
            let epoch: number | undefined;
            const reconcile = () => {
              const nextEpoch = core.declarationEpoch(name);
              if (active && epoch === nextEpoch) return;
              active?.();
              active = undefined;
              epoch = undefined;
              if (!core.specDynamic(name)) return;
              active = ctx.effect(callback, 'slot declaration');
              epoch = nextEpoch;
            };
            const unsubscribe = core.subscribeDeclaration(name, reconcile);
            reconcile();
            return () => { unsubscribe(); active?.(); };
          }, 'slots.inject()');
          stopInjection = () => { void controller(); };
          return stopInjection;
        },
      },
    };
    client.apply(facade as ClientContext);
  });
  return { fiber, localeRegister, dictionaryDispose, stopInjection: () => stopInjection() };
}

function declaredCore() {
  const core = new SlotCore();
  const declare = () => register(core, { name: 'root', children: { [SLOT]: { kind: 'keyed', scope: 'session' } } }, () => null);
  return { core, declare };
}

function expectWinners(core: SlotCore, components: Record<typeof keys[number], unknown>) {
  const winners = core.entriesOfSlot(SLOT);
  expect(winners).toHaveLength(2);
  for (const key of keys) expect(winners.find(entry => entry.options.key === key)?.component).toBe(components[key]);
}

describe('published keyed slot lifecycle', () => {
  it('real Cordis effects do not implicitly collect unreturned nested effects', async () => {
    const ctx = new Context();
    const disposeInner = vi.fn();
    let inner: (() => unknown) | undefined;
    const outer = ctx.effect(() => { inner = ctx.effect(() => disposeInner); return () => {}; });
    try {
      await outer();
      expect(disposeInner).not.toHaveBeenCalled();
      await inner!();
      expect(disposeInner).toHaveBeenCalledOnce();
    } finally { await inner?.(); await outer(); }
  });

  it.each(['native-first', 'plugin-first'] as const)('%s shadows without deleting native entries and restores them on disable', async (order) => {
    const { core, declare } = declaredCore();
    const undeclare = declare();
    const client = loadClient();
    let native: ReturnType<typeof nativeRegistrations> | undefined;
    if (order === 'native-first') native = nativeRegistrations(core);
    const plugin = pluginHarness(core, client);
    try {
      await plugin.fiber.await();
      native ??= nativeRegistrations(core);
      expectWinners(core, { compaction: client.CompactionRenderer, 'manual-compaction': client.ManualCompactionRenderer });
      expect(core.entries(SLOT)).toHaveLength(4);
      for (const key of keys) {
        const entries = core.entries(SLOT).filter(entry => entry.options.key === key);
        expect(entries.map(entry => entry.options.priority ?? 0)).toEqual([-10, 0]);
        expect(entries[1]!.component).toBe(native.native[key]);
      }
      expect(client.styles.size).toBe(1);
      expect(plugin.localeRegister).toHaveBeenCalledOnce();
      await plugin.fiber.dispose();
      expectWinners(core, native.native);
      expect(core.entries(SLOT)).toHaveLength(2);
      expect(client.styles.size).toBe(0);
      expect(plugin.dictionaryDispose).toHaveBeenCalledOnce();
    } finally {
      await plugin.fiber.dispose();
      native?.dispose();
      undeclare();
    }
  });

  it('rejects the previous same-priority override for both native keys', () => {
    const { core, declare } = declaredCore();
    const undeclare = declare();
    const native = nativeRegistrations(core);
    try {
      for (const key of keys) expect(() => register(core, { name: SLOT, key }, () => null)).toThrow(/already has an entry.*priority 0/);
      expectWinners(core, native.native);
    } finally { native.dispose(); undeclare(); }
  });

  it('waits for a declaration and reinstalls cleanly across declaration lifetimes', async () => {
    const { core, declare } = declaredCore();
    const client = loadClient();
    const plugin = pluginHarness(core, client);
    let undeclare: (() => void) | undefined;
    try {
      await plugin.fiber.await();
      expect(core.entries(SLOT)).toHaveLength(0);
      for (let lifetime = 0; lifetime < 2; lifetime++) {
        undeclare = declare();
        expectWinners(core, { compaction: client.CompactionRenderer, 'manual-compaction': client.ManualCompactionRenderer });
        expect(core.entries(SLOT)).toHaveLength(2);
        undeclare();
        undeclare = undefined;
        expect(core.entries(SLOT)).toHaveLength(0);
      }
      await plugin.fiber.dispose();
      undeclare = declare();
      expect(core.entries(SLOT)).toHaveLength(0); // pending subscription was removed
    } finally { await plugin.fiber.dispose(); undeclare?.(); }
  });

  it('the injection disposer alone releases both overrides, without unloading dictionaries or styles', async () => {
    const { core, declare } = declaredCore();
    const undeclare = declare();
    const native = nativeRegistrations(core);
    const client = loadClient();
    const plugin = pluginHarness(core, client);
    try {
      await plugin.fiber.await();
      plugin.stopInjection();
      expectWinners(core, native.native);
      expect(core.entries(SLOT)).toHaveLength(2);
      expect(client.styles.size).toBe(1);
      expect(plugin.dictionaryDispose).not.toHaveBeenCalled();
    } finally { await plugin.fiber.dispose(); native.dispose(); undeclare(); }
  });
});
