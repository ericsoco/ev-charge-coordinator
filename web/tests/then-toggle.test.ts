/**
 * Then readout row: the home/car label+value are buttons that toggle their
 * BSoC chart series on/off (aria-pressed reflects the series visibility;
 * the chart itself is pure logic pinned in bsoc.test.ts — jsdom has no
 * canvas, so createChart returns null here).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Then from '../src/pages/Then.svelte';
import { session } from '../src/lib/apiSession.svelte';

/** Minimal Response stand-in — jsdom need not implement the real class. */
const ok = (data: unknown): Response =>
  ({ ok: true, status: 200, json: async () => data }) as unknown as Response;

function seriesPayload(metric: string): unknown {
  return {
    metric,
    unit: 'percent',
    aggregation: 'avg',
    from: 1,
    to: 2,
    bucketMs: 300_000,
    points: [[1, 60]],
  };
}

beforeEach(() => {
  window.localStorage.clear();
  session.needsToken = false;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/series')) {
        const metric = url.includes('metric=battery_soc') ? 'battery_soc' : 'ev_soc';
        return Promise.resolve(ok(seriesPayload(metric)));
      }
      if (url.startsWith('/api/sessions')) {
        return Promise.resolve(ok({ total: 0, limit: 200, offset: 0, sessions: [] }));
      }
      return Promise.resolve(ok({}));
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Then readout series toggles', () => {
  it('renders both label/value toggles pressed and flips each independently on tap', async () => {
    render(Then);
    const home = await screen.findByRole('button', {
      name: /toggle home battery bsoc series/i,
    });
    const car = screen.getByRole('button', { name: /toggle vehicle bsoc series/i });
    expect(home.getAttribute('aria-pressed')).toBe('true');
    expect(car.getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(home);
    expect(home.getAttribute('aria-pressed')).toBe('false');
    expect(car.getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(home);
    expect(home.getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(car);
    expect(car.getAttribute('aria-pressed')).toBe('false');
    expect(home.getAttribute('aria-pressed')).toBe('true');
  });
});