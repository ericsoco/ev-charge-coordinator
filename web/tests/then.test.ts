import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Then from '../src/pages/Then.svelte';
import { session } from '../src/lib/apiSession.svelte';
import type { SeriesResult, SessionSummary } from '../../src/api/types';

// The ECharts view is a canvas binding (null in jsdom by design) — mock it so
// selection wiring (animateTo focus window) is observable. Everything below
// the view seam (options, readout, catalog/pagination) is the real component.
const chart = vi.hoisted(() => ({
  animateTo: vi.fn(),
  applyWindow: vi.fn(),
  setOption: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('../src/pages/bsocChartView', () => ({
  createChart: () => ({
    ...chart,
    onDataZoom: vi.fn(),
    onPointerMove: vi.fn(),
    pixelToTs: () => null,
    width: () => 800,
    resize: vi.fn(),
  }),
}));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Local-time fixtures (matching the API's label format) — TZ-independent. */
const PLUG7 = new Date(2026, 10, 12, 16, 51).getTime();
const UNPLUG7 = PLUG7 + 3 * HOUR;
const PLUG8 = new Date(2026, 10, 13, 9, 30).getTime();

const CLOSED: SessionSummary = {
  id: 7,
  label: '2026-11-12 16:51',
  plugTsMs: PLUG7,
  unplugTsMs: UNPLUG7,
  open: false,
  targetPercent: 42,
  initialTargetPercent: 42,
  targetChangeReason: null,
  stopReason: 'target_reached',
  energyKwh: 6.3,
  energyPercent: 10,
  efficiency: 0.87,
  evSocStartPercent: 32,
  evSocEndPercent: 42,
  batterySocStartPercent: 71,
  batterySocEndPercent: 65,
};

const OPEN: SessionSummary = {
  id: 8,
  label: '2026-11-13 09:30',
  plugTsMs: PLUG8,
  unplugTsMs: null,
  open: true,
  targetPercent: 60,
  initialTargetPercent: 60,
  targetChangeReason: null,
  stopReason: null,
  energyKwh: null,
  energyPercent: null,
  efficiency: null,
  evSocStartPercent: 21,
  evSocEndPercent: null,
  batterySocStartPercent: 24,
  batterySocEndPercent: null,
};

function series(): SeriesResult {
  return {
    metric: 'ev_soc',
    unit: 'percent',
    aggregation: 'avg',
    from: PLUG7 - HOUR,
    to: PLUG8 + HOUR,
    bucketMs: 5 * MINUTE,
    points: [
      [PLUG7 - HOUR, 32],
      [PLUG8 + HOUR, 42],
    ],
  };
}

/** Sessions served by the stub's first page; the pagination test adds pages. */
let sessionsServed: SessionSummary[];
let sessionsTotal: number;

/** Oldest row — served as the second page in the pagination test. */
const OLDER: SessionSummary = {
  ...CLOSED,
  id: 9,
  label: '2026-11-11 08:15',
  plugTsMs: new Date(2026, 10, 11, 8, 15).getTime(),
  unplugTsMs: new Date(2026, 10, 11, 10, 15).getTime(),
};

/** Minimal Response stand-in — jsdom need not implement the real class. */
const ok = (data: unknown): Response =>
  ({ ok: true, status: 200, json: async () => data }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  session.needsToken = false;
  chart.animateTo.mockClear();
  sessionsServed = [OPEN, CLOSED];
  sessionsTotal = 2;
  fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.startsWith('/api/series')) return Promise.resolve(ok(series()));
    if (url.startsWith('/api/sessions')) {
      const offset = Number(new URLSearchParams(url.split('?')[1]).get('offset') ?? '0');
      return Promise.resolve(
        ok({
          total: sessionsTotal,
          limit: 200,
          offset,
          sessions: offset === 0 ? sessionsServed : [OLDER],
        })
      );
    }
    return Promise.resolve(ok({}));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The menu item carrying `label`. Scoped to the Noph menu container: the
 * Select also renders a hidden native <option> list (its form value), which
 * role/text queries would otherwise hit. Closed-popover items are display:none
 * in jsdom (as in real a11y trees) — clicks still dispatch fine.
 */
function optionButton(label: string): HTMLElement {
  const menu = document.querySelector('.np-menu-container');
  expect(menu).not.toBeNull();
  return within(menu as HTMLElement).getByText(label).closest('button') as HTMLElement;
}

async function renderThen(): Promise<void> {
  render(Then);
  // Wait for the loader's first fetch to fill the catalog.
  await waitFor(() => expect(document.querySelector('.np-menu-container')).not.toBeNull());
  await waitFor(() => expect(optionButton('2026-11-12 16:51')).toBeTruthy());
}

describe('Then sessions selector', () => {
  it('lists sessions with start date+time labels and 🔄 on the open session', async () => {
    await renderThen();
    expect(optionButton('Select a session…')).toBeTruthy();
    expect(optionButton('2026-11-12 16:51')).toBeTruthy();
    expect(optionButton('2026-11-13 09:30 🔄')).toBeTruthy();
  });

  it('selecting a session eases the chart to the padded session window', async () => {
    await renderThen();
    fireEvent.click(optionButton('2026-11-12 16:51'));
    await waitFor(() => expect(chart.animateTo).toHaveBeenCalledTimes(1));
    // 3 h session + FOCUS_PAD_RATIO (10 %) padding each side = 18 min.
    expect(chart.animateTo).toHaveBeenCalledWith({
      from: PLUG7 - 18 * MINUTE,
      to: UNPLUG7 + 18 * MINUTE,
    });
  });

  it('renders the selected-session readout (the removed tooltip content)', async () => {
    await renderThen();
    fireEvent.click(optionButton('2026-11-12 16:51'));
    await waitFor(() => expect(screen.getByText('2026-11-12 16:51 → 19:51')).toBeTruthy());
    expect(screen.getByText('target 42% · stopped: target reached · 6.3 kWh')).toBeTruthy();
    expect(screen.getByText('🚗: 32.0% → 42.0%')).toBeTruthy();
    expect(screen.getByText('🏠: 71.0% → 65.0%')).toBeTruthy();
  });

  it('an open session reads → now 🔄 with live SoC values for the end', async () => {
    await renderThen();
    fireEvent.click(optionButton('2026-11-13 09:30 🔄'));
    await waitFor(() => expect(screen.getByText('2026-11-13 09:30 → now 🔄')).toBeTruthy());
    // Open end falls back to the newest loaded sample (42.0 % in the fixture).
    expect(screen.getByText('🚗: 21.0% → 42.0%')).toBeTruthy();
    expect(screen.getByText('🏠: 24.0% → 42.0%')).toBeTruthy();
  });

  it('re-selecting the placeholder clears the readout', async () => {
    await renderThen();
    fireEvent.click(optionButton('2026-11-12 16:51'));
    await waitFor(() => expect(screen.getByText('2026-11-12 16:51 → 19:51')).toBeTruthy());
    fireEvent.click(optionButton('Select a session…'));
    await waitFor(() =>
      expect(screen.queryByText('2026-11-12 16:51 → 19:51')).toBeNull()
    );
    expect(chart.animateTo).toHaveBeenCalledTimes(1); // placeholder never focuses
  });
});

describe('Then sessions pagination', () => {
  /**
   * The menu's inner scroller (.np-menu) with layout metrics jsdom cannot
   * produce (no layout engine). Scrolling it must reach the capture-phase
   * listener on the listbox container — as in a real browser.
   */
  function menuScrolledTo(end: boolean): HTMLElement {
    const box = document.querySelector('.np-menu-container .np-menu') as HTMLElement;
    expect(box).not.toBeNull();
    Object.defineProperty(box, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(box, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(box, 'scrollTop', {
      value: end ? 900 : 500,
      configurable: true,
      writable: true,
    });
    return box;
  }

  const sessionFetches = (): number =>
    fetchMock.mock.calls.filter((call: unknown[]) =>
      String(call[0]).startsWith('/api/sessions')
    ).length;

  it('pages in older sessions at the menu scroll end, once', async () => {
    sessionsTotal = 3;
    await renderThen();
    fireEvent.scroll(menuScrolledTo(false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionFetches()).toBe(1); // not near the end — no page

    fireEvent.scroll(menuScrolledTo(true));
    await waitFor(() => expect(optionButton('2026-11-11 08:15')).toBeTruthy());
    expect(
      fetchMock.mock.calls.some((call: unknown[]) => String(call[0]).includes('offset=2'))
    ).toBe(true);

    // Catalog is complete (3 / 3): another scroll to the end does not refetch.
    fireEvent.scroll(menuScrolledTo(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionFetches()).toBe(2); // coverage fetch + one page
  });
});
