import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { lateLive, provideLive, currentLive } from '../src/live.js';

const ref = <T,>(value: T) => { const box = { value }; return { box, get: () => box.value }; };

describe('live integration switches', () => {
  it('falls back to startup values, then follows the entry, then falls back again', async () => {
    const live = lateLive({ cacheFirst: true, mode: 'observe' });
    const seen: string[] = [];
    live.subscribe(() => seen.push(`${live.cacheFirst()}/${live.mode()}`));
    expect(live.mode()).toBe('observe');
    const ctx = new Context();
    const cache = ref(true), mode = ref<'off' | 'observe' | 'active'>('active');
    const fiber = ctx.plugin((c: Context) => { provideLive(c, { cacheFirst: cache as never, adaptiveMode: mode as never }); });
    await fiber;
    expect(live.mode()).toBe('active');
    mode.box.value = 'off';
    expect(live.mode()).toBe('off');
    cache.box.value = false; mode.box.value = 'active';
    expect(live.cacheFirst()).toBe(false);
    expect(live.mode()).toBe('off'); // native engine never runs the policy
    await fiber.dispose();
    expect(currentLive()).toBeUndefined();
    expect(live.cacheFirst()).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});
