import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.svelte';
import { session } from '../src/lib/apiSession.svelte';
import { SWIPE_IGNORE_ATTR } from '../src/lib/swipe';

/** Minimal Response stand-ins — jsdom need not implement the real class. */
const ok = (data: unknown): Response =>
  ({ ok: true, status: 200, json: async () => data }) as unknown as Response;

function payload(): unknown {
  return {
    nowMs: 1,
    vehicle: null,
    battery: { socPercent: 71, ageMs: 1000, solarW: 0, homeLoadW: 500 },
    session: null,
  };
}

/** The Then tab fetches /api/series + /api/sessions alongside /api/now. */
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

function sessionsPayload(): unknown {
  return { total: 0, limit: 200, offset: 0, sessions: [] };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  session.needsToken = false;
  fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.startsWith('/api/series')) {
      const metric = url.includes('metric=battery_soc') ? 'battery_soc' : 'ev_soc';
      return Promise.resolve(ok(seriesPayload(metric)));
    }
    if (url.startsWith('/api/sessions')) return Promise.resolve(ok(sessionsPayload()));
    return Promise.resolve(ok(payload()));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** jsdom's TouchEvent accepts plain coordinate objects for touches. */
const point = (x: number, y: number) => ({ clientX: x, clientY: y }) as unknown as Touch;

/**
 * One one-finger gesture on `target`: touchstart at `from`, touchend at `to`
 * (a touch's target is fixed for its duration, per spec). Two fingers when
 * `second` is set (a pinch attempt — must never switch tabs).
 */
async function gesture(
  target: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
  second?: { x: number; y: number }
): Promise<void> {
  const startTouches = [point(from.x, from.y)];
  if (second !== undefined) startTouches.push(point(second.x, second.y));
  await fireEvent.touchStart(target, { touches: startTouches });
  await fireEvent.touchEnd(target, { touches: [], changedTouches: [point(to.x, to.y)] });
}

function activeTab(): string | null {
  return screen.getByRole('main').getAttribute('aria-label');
}

describe('swipe tab navigation', () => {
  it('swipes left forward through the tabs and right back', async () => {
    render(App);
    await screen.findByText('Home battery');
    const content = screen.getByRole('main');

    await gesture(content, { x: 200, y: 400 }, { x: 40, y: 410 });
    expect(activeTab()).toBe('Then');
    await screen.findByRole('img', { name: /state of charge over time/i });

    await gesture(content, { x: 200, y: 400 }, { x: 40, y: 410 });
    expect(activeTab()).toBe('Messages');

    await gesture(content, { x: 40, y: 400 }, { x: 200, y: 410 });
    expect(activeTab()).toBe('Then');
  });

  it('does not wrap around at the ends', async () => {
    render(App);
    await screen.findByText('Home battery');
    const content = screen.getByRole('main');

    await gesture(content, { x: 40, y: 400 }, { x: 200, y: 400 });
    expect(activeTab()).toBe('Now'); // right on Now stays

    await gesture(content, { x: 200, y: 400 }, { x: 40, y: 400 });
    await gesture(content, { x: 200, y: 400 }, { x: 40, y: 400 });
    expect(activeTab()).toBe('Messages');
    await gesture(content, { x: 200, y: 400 }, { x: 40, y: 400 });
    expect(activeTab()).toBe('Messages'); // left on Messages stays
  });

  it('ignores gestures starting on chart elements', async () => {
    render(App);
    await screen.findByText('Home battery');
    await fireEvent.click(screen.getAllByRole('button', { name: /Then/ })[0]);
    const chart = await screen.findByRole('img', { name: /state of charge over time/i });
    // Pin the markup to the selector App checks.
    expect(chart.closest(`[${SWIPE_IGNORE_ATTR}]`)).not.toBeNull();

    await gesture(chart, { x: 200, y: 300 }, { x: 40, y: 310 });
    expect(activeTab()).toBe('Then');
  });

  it('ignores gestures starting on the navigation controls', async () => {
    render(App);
    await screen.findByText('Home battery');
    const navButton = screen.getAllByRole('button', { name: /Messages/ })[0];

    await gesture(navButton, { x: 200, y: 700 }, { x: 40, y: 710 });
    expect(activeTab()).toBe('Now');
  });

  it('ignores vertical scrolls, short flicks, and two-finger touches', async () => {
    render(App);
    await screen.findByText('Home battery');
    const content = screen.getByRole('main');

    // Dominance: far travel but mostly vertical.
    await gesture(content, { x: 200, y: 100 }, { x: 260, y: 500 });
    // Below the distance floor.
    await gesture(content, { x: 200, y: 400 }, { x: 180, y: 402 });
    // Pinch attempt (second finger at touchstart).
    await gesture(content, { x: 200, y: 400 }, { x: 40, y: 400 }, { x: 300, y: 500 });
    expect(activeTab()).toBe('Now');

    // Sanity: the same target still swipes when the gesture is deliberate.
    await gesture(content, { x: 200, y: 400 }, { x: 40, y: 400 });
    expect(activeTab()).toBe('Then');
  });
});