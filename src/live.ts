/**
 * User-facing switches of the root integration entry, read live.
 * The entry's `cacheFirst` and `adaptiveMode` fields are `.volatile()`: the Web
 * settings form edits them without restarting the entry, the Loader updates the
 * references and emits `loader/volatile-update` to the entry that owns them.
 * The engine, mounted from the preset, reads them through this module.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';

export type AdaptiveMode = 'off' | 'observe' | 'active';
export const ADAPTIVE_MODES: readonly AdaptiveMode[] = ['off', 'observe', 'active'];

type Source<T> = T | Volatile<T> | undefined;
export interface LiveRefs { cacheFirst?: Source<boolean>; adaptiveMode?: Source<AdaptiveMode> }

export interface LiveSettings {
  /** Whether the cache-first engine is selected (false selects the native one). */
  cacheFirst(): boolean;
  /** Adaptive mode actually in force: the native engine never runs the policy. */
  mode(): AdaptiveMode;
  /** Run `listener` after any of the switches changed; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

function read<T>(source: Source<T>, fallback: T): T {
  if (source === undefined) return fallback;
  return typeof source === 'object' && source !== null && 'get' in source && typeof (source as Volatile<T>).get === 'function'
    ? ((source as Volatile<T>).get() as T)
    : (source as T);
}

let current: LiveSettings | undefined;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of [...listeners]) listener(); };

/** The settings published by the enabled integration entry, if any. */
export function currentLive(): LiveSettings | undefined {
  return current;
}

/**
 * Late-bound view for an engine: values come from the integration entry whenever
 * it is present (it may start before or after the engine) and from `fallback`
 * (the startup config) otherwise. Subscribers hear about appearance, removal and edits.
 */
export function lateLive(fallback: { cacheFirst: boolean; mode: AdaptiveMode }): LiveSettings {
  return {
    cacheFirst: () => current?.cacheFirst() ?? fallback.cacheFirst,
    mode: () => (current ? current.mode() : fallback.cacheFirst ? fallback.mode : 'off'),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** Publish the entry's switches for the lifetime of its fiber. */
export function provideLive(ctx: Context, refs: LiveRefs): LiveSettings {
  const live: LiveSettings = {
    cacheFirst: () => read(refs.cacheFirst, true) !== false,
    mode: () => {
      if (!live.cacheFirst()) return 'off';
      const value = read<AdaptiveMode>(refs.adaptiveMode, 'observe');
      return ADAPTIVE_MODES.includes(value) ? value : 'observe';
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  ctx.effect(() => {
    current = live;
    notify();
    return () => { if (current === live) { current = undefined; notify(); } };
  });
  ctx.on('loader/volatile-update' as never, (() => { notify(); }) as never);
  return live;
}
