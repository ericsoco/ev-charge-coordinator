import { describe, expect, it } from 'vitest';
import type { SeriesResult, SessionSummary } from '../../src/api/types';
import {
  buildBsocOption,
  classifyWheel,
  clampWindow,
  EV_COLOR,
  EV_SERIES_NAME,
  fetchWindowFor,
  formatBsocValue,
  formatReadoutTs,
  HOME_COLOR,
  HOME_SERIES_NAME,
  MAX_EVENT_ZOOM,
  MAX_SPAN_MS,
  MIN_SPAN_MS,
  needsRefetch,
  newestSampleTs,
  panBy,
  panMsFor,
  percentToWindow,
  readoutAt,
  sampleAtOrBefore,
  sessionsInWindow,
  spanOf,
  windowToPercent,
  zoomAt,
  zoomFactorFor,
  type BsocData,
  type TimeWindow,
} from '../src/pages/bsocChart';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 10, 0, 0, 0);
const BOUNDS: TimeWindow = { from: T0, to: T0 + DAY };

function series(points: Array<[number, number]>): SeriesResult {
  return {
    metric: 'ev_soc',
    unit: 'percent',
    aggregation: 'avg',
    from: BOUNDS.from,
    to: BOUNDS.to,
    bucketMs: 5 * MINUTE,
    points,
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    label: '2026-11-10 14:03',
    plugTsMs: T0 + 14 * HOUR,
    unplugTsMs: T0 + 17 * HOUR,
    open: false,
    targetPercent: 60,
    initialTargetPercent: 60,
    targetChangeReason: null,
    stopReason: 'target_reached',
    energyKwh: 12.5,
    energyPercent: 18,
    efficiency: 0.87,
    evSocStartPercent: 54,
    evSocEndPercent: 62,
    batterySocStartPercent: 71,
    batterySocEndPercent: 58,
    ...overrides,
  };
}

function data(sessions: SessionSummary[]): BsocData {
  return {
    ev: series([[T0 + HOUR, 54]]),
    home: series([[T0 + HOUR, 71]]),
    sessions,
    bounds: BOUNDS,
  };
}

describe('clampWindow', () => {
  it('raises a too-small span to the 2 h minimum', () => {
    const win = clampWindow({ from: T0, to: T0 + HOUR }, BOUNDS);
    expect(spanOf(win)).toBe(MIN_SPAN_MS);
    expect(win.from).toBe(T0);
  });

  it('caps a too-large span at the bounds (bounds win over 1 yr)', () => {
    const bounds = { from: T0, to: T0 + 100 * DAY };
    const win = clampWindow({ from: T0, to: T0 + 400 * DAY }, bounds);
    expect(spanOf(win)).toBe(100 * DAY);
  });

  it('caps a too-large span at 1 yr when the bounds allow it', () => {
    const bounds = { from: T0, to: T0 + 500 * DAY };
    const win = clampWindow({ from: T0, to: T0 + 500 * DAY }, bounds);
    expect(spanOf(win)).toBe(MAX_SPAN_MS);
  });

  it('shifts a window that hangs off the bounds back inside', () => {
    const win = clampWindow({ from: T0 - 6 * HOUR, to: T0 + 6 * HOUR }, BOUNDS);
    expect(win).toEqual({ from: T0, to: T0 + 12 * HOUR });
  });
});

describe('zoomAt', () => {
  it('keeps the anchor fraction under zoom-in', () => {
    const anchor = T0 + 6 * HOUR; // 25% into the 24 h window
    const win = zoomAt(BOUNDS, BOUNDS, anchor, 0.5);
    expect(spanOf(win)).toBe(12 * HOUR);
    expect(win.from).toBe(T0 + 3 * HOUR);
    expect(win.to).toBe(T0 + 15 * HOUR);
  });

  it('never zooms past the 2 h floor', () => {
    const win = zoomAt(BOUNDS, BOUNDS, T0 + 12 * HOUR, 1e-9);
    expect(spanOf(win)).toBe(MIN_SPAN_MS);
  });

  it('never zooms out past the 1 yr ceiling', () => {
    const bounds = { from: T0, to: T0 + 500 * DAY };
    const win = zoomAt({ from: T0, to: T0 + 300 * DAY }, bounds, T0 + 150 * DAY, 100);
    expect(spanOf(win)).toBe(MAX_SPAN_MS);
  });

  it('clamps the anchored window into the bounds', () => {
    // Anchored at the right edge: zoom-out must not spill past bounds.to.
    const win = zoomAt(BOUNDS, BOUNDS, T0 + DAY, 0.5);
    expect(win.to).toBe(BOUNDS.to);
    expect(win.from).toBe(BOUNDS.to - 12 * HOUR);
  });
});

describe('panBy', () => {
  it('shifts the window by the given delta', () => {
    const bounds = { from: T0, to: T0 + 4 * DAY };
    const win = panBy({ from: T0 + DAY, to: T0 + 2 * DAY }, bounds, HOUR);
    expect(win).toEqual({ from: T0 + DAY + HOUR, to: T0 + 2 * DAY + HOUR });
  });

  it('clamps at the bounds edges without changing the span', () => {
    const win = panBy({ from: T0 + DAY, to: T0 + 2 * DAY }, BOUNDS, -10 * DAY);
    expect(win.from).toBe(BOUNDS.from);
    expect(spanOf(win)).toBe(DAY);
  });
});

describe('window percent conversions', () => {
  it('maps the full window to 0–100 and round-trips', () => {
    const pct = windowToPercent(BOUNDS, BOUNDS);
    expect(pct).toEqual({ start: 0, end: 100 });
    expect(percentToWindow(pct.start, pct.end, BOUNDS)).toEqual(BOUNDS);
  });

  it('maps a half window to 50–100', () => {
    const half = { from: T0 + 12 * HOUR, to: T0 + DAY };
    expect(windowToPercent(half, BOUNDS)).toEqual({ start: 50, end: 100 });
  });
});

describe('classifyWheel (requirements 2b)', () => {
  it('classifies vertical-dominant scroll as zoom: up = in, down = out', () => {
    expect(classifyWheel(0, -12)).toEqual({ kind: 'zoom', direction: 1 });
    expect(classifyWheel(0, 12)).toEqual({ kind: 'zoom', direction: -1 });
  });

  it('classifies horizontal-dominant scroll as scrub: right = forward', () => {
    expect(classifyWheel(12, 0)).toEqual({ kind: 'pan', direction: 1 });
    expect(classifyWheel(-12, 2)).toEqual({ kind: 'pan', direction: -1 });
  });

  it('ignores sub-pixel jitter', () => {
    expect(classifyWheel(0.1, 0.1)).toEqual({ kind: 'none' });
  });

  it('still zooms on a vertical diagonal', () => {
    expect(classifyWheel(3, 30)).toEqual({ kind: 'zoom', direction: -1 });
  });
});

describe('zoomFactorFor / panMsFor', () => {
  it('turns a −100 wheel notch into ×1.25 and +100 into ×0.8', () => {
    expect(zoomFactorFor(-100)).toBeCloseTo(1.25, 10);
    expect(zoomFactorFor(100)).toBeCloseTo(0.8, 10);
  });

  it('clamps flings to the single-event cap', () => {
    expect(zoomFactorFor(-100_000)).toBe(MAX_EVENT_ZOOM);
    expect(zoomFactorFor(100_000)).toBe(1 / MAX_EVENT_ZOOM);
  });

  it('converts pixel deltas proportionally to the visible span', () => {
    expect(panMsFor(100, 1000, 10 * HOUR)).toBe(HOUR);
    expect(panMsFor(100, 0, 10 * HOUR)).toBe(0);
  });
});

describe('needsRefetch / fetchWindowFor (lazy loading)', () => {
  it('accepts a view inside adequately detailed bounds', () => {
    expect(needsRefetch({ from: T0, to: T0 + 12 * HOUR }, BOUNDS)).toBe(false);
  });

  it('refetches when the view leaves the loaded bounds', () => {
    expect(needsRefetch({ from: T0 - HOUR, to: T0 + HOUR }, BOUNDS)).toBe(true);
  });

  it('refetches when the loaded data is too coarse for the view', () => {
    const bounds = { from: T0, to: T0 + 40 * DAY };
    expect(needsRefetch({ from: T0, to: T0 + DAY }, bounds)).toBe(true);
  });

  it('pads the fetch window and clamps it to [now − 1 yr, now]', () => {
    const visible = { from: T0 + 6 * HOUR, to: T0 + 18 * HOUR };
    const win = fetchWindowFor(visible, T0 + DAY);
    expect(win.from).toBe(T0 + 3 * HOUR); // −25% of the 12 h span
    expect(win.to).toBe(T0 + 21 * HOUR);

    const old = { from: T0 - 400 * DAY, to: T0 - 390 * DAY };
    const clamped = fetchWindowFor(old, T0);
    expect(clamped.from).toBe(T0 - MAX_SPAN_MS);
    expect(clamped.to).toBeLessThanOrEqual(T0);
  });
});

describe('sessionsInWindow', () => {
  it('filters sessions to those overlapping the window', () => {
    const inside = session();
    const before = session({ id: 2, plugTsMs: T0 - 3 * DAY, unplugTsMs: T0 - 2 * DAY });
    const after = session({ id: 3, plugTsMs: T0 + 3 * DAY, unplugTsMs: T0 + 4 * DAY });
    const ids = sessionsInWindow([inside, before, after], BOUNDS, T0 + DAY).map((s) => s.id);
    expect(ids).toEqual([1]);
  });
});

describe('formatReadoutTs', () => {
  it('formats MMM DD HH:MM local time with zero padding', () => {
    expect(formatReadoutTs(new Date(2026, 10, 12, 9, 35).getTime())).toBe('Nov 12 09:35');
    expect(formatReadoutTs(new Date(2026, 10, 2, 9, 5).getTime())).toBe('Nov 02 09:05');
    expect(formatReadoutTs(new Date(2026, 11, 31, 23, 59).getTime())).toBe('Dec 31 23:59');
  });
});

describe('formatBsocValue', () => {
  it('rounds to the nearest tenth and renders exactly one decimal', () => {
    expect(formatBsocValue(71.34)).toBe('71.3%');
    expect(formatBsocValue(71.36)).toBe('71.4%');
    expect(formatBsocValue(54)).toBe('54.0%');
    expect(formatBsocValue(9.99)).toBe('10.0%');
  });

  it('renders an em-dash when the sample is absent', () => {
    expect(formatBsocValue(null)).toBe('—');
  });
});

describe('sampleAtOrBefore', () => {
  const points: Array<[number, number]> = [
    [100, 10],
    [200, 20],
    [300, 30],
  ];

  it('returns the sample at the exact timestamp', () => {
    expect(sampleAtOrBefore(points, 200)).toBe(20);
  });

  it('returns the previous sample between timestamps', () => {
    expect(sampleAtOrBefore(points, 250)).toBe(20);
    expect(sampleAtOrBefore(points, 299)).toBe(20);
  });

  it('returns the newest sample past the end', () => {
    expect(sampleAtOrBefore(points, 999)).toBe(30);
  });

  it('returns null before the first sample or with no samples', () => {
    expect(sampleAtOrBefore(points, 99)).toBeNull();
    expect(sampleAtOrBefore([], 150)).toBeNull();
  });
});

describe('newestSampleTs', () => {
  it('returns the newest sample across both series', () => {
    expect(newestSampleTs(series([[100, 1]]), series([[200, 2]]))).toBe(200);
    expect(newestSampleTs(series([[300, 1]]), series([[200, 2]]))).toBe(300);
    expect(newestSampleTs(series([]), series([[200, 2]]))).toBe(200);
  });

  it('returns null when neither series has samples', () => {
    expect(newestSampleTs(series([]), series([]))).toBeNull();
  });
});

describe('readoutAt', () => {
  const ts = new Date(2026, 10, 12, 9, 35).getTime();

  it('shows the ts and both series values at or before it', () => {
    const ev = series([[ts - 30 * MINUTE, 53.96]]);
    const home = series([[ts - MINUTE, 71.34]]);
    expect(readoutAt(ev, home, ts)).toEqual({
      tsMs: ts,
      tsLabel: 'Nov 12 09:35',
      homeLabel: '71.3%',
      evLabel: '54.0%',
    });
  });

  it('shows an em-dash for a series without a sample at or before the ts', () => {
    const ev = series([[ts + MINUTE, 55]]);
    const home = series([[ts - MINUTE, 71]]);
    const readout = readoutAt(ev, home, ts);
    expect(readout.evLabel).toBe('—');
    expect(readout.homeLabel).toBe('71.0%');
  });

  it('shows em-dashes when there is no timestamp at all', () => {
    const emptyEv = series([]);
    const emptyHome = series([]);
    const readout = readoutAt(emptyEv, emptyHome, newestSampleTs(emptyEv, emptyHome));
    expect(readout).toEqual({ tsMs: null, tsLabel: '—', homeLabel: '—', evLabel: '—' });
  });
});

describe('buildBsocOption (requirements 2b)', () => {
  const NOW = T0 + 20 * HOUR;
  /** Structural view of the option — ECharts types are deliberately loose. */
  interface OptionShape {
    color?: string[];
    /** Pinned absent: the readout row below the chart replaces both. */
    legend?: unknown;
    tooltip?: unknown;
    xAxis?: { type?: string; min?: number; max?: number };
    yAxis?: { min?: number; max?: number };
    dataZoom?: Array<{
      type?: string;
      start?: number;
      end?: number;
      minValueSpan?: number;
      maxValueSpan?: number;
      zoomOnMouseWheel?: boolean;
    }>;
    series?: Array<{
      name?: string;
      data?: unknown;
      markLine?: { data?: Array<{ xAxis?: number }> };
      markArea?: { data?: Array<Array<{ xAxis?: number }>> };
    }>;
  }

  const option = (sessions: SessionSummary[], visible: TimeWindow = BOUNDS): OptionShape =>
    buildBsocOption(data(sessions), visible, NOW) as unknown as OptionShape;

  it('plots both BSoC lines with the exported series colors and no legend/tooltip', () => {
    const opt = option([]);
    expect(opt.series?.slice(0, 2).map((s) => s.name)).toEqual([
      EV_SERIES_NAME,
      HOME_SERIES_NAME,
    ]);
    expect(opt.color).toEqual([EV_COLOR, HOME_COLOR]);
    expect(opt.yAxis).toMatchObject({ min: 0, max: 100 });
    expect(opt.xAxis).toMatchObject({ type: 'time', min: BOUNDS.from, max: BOUNDS.to });
    // The static readout row below the chart replaces both.
    expect(opt.legend).toBeUndefined();
    expect(opt.tooltip).toBeUndefined();
  });

  it('wires the inside dataZoom with the 2 h–1 yr clamps and no wheel zoom', () => {
    const zoom = option([]).dataZoom?.[0];
    expect(zoom).toMatchObject({
      type: 'inside',
      start: 0,
      end: 100,
      minValueSpan: MIN_SPAN_MS,
      maxValueSpan: MAX_SPAN_MS,
      zoomOnMouseWheel: false,
    });
  });

  it('maps the initial visible window into dataZoom start/end percent', () => {
    const visible = { from: T0 + 12 * HOUR, to: T0 + 18 * HOUR };
    const zoom = option([], visible).dataZoom?.[0];
    expect(zoom?.start).toBe(50);
    expect(zoom?.end).toBe(75);
  });

  it('draws two markLines for a closed session and one for an open session', () => {
    const open = session({ id: 2, plugTsMs: T0 + 19 * HOUR, unplugTsMs: null, open: true });
    const markers = option([session(), open]).series?.find((s) => s.name === 'Sessions');
    expect(
      markers?.markLine?.data?.map((m) => m.xAxis)
    ).toEqual([
      T0 + 14 * HOUR,
      T0 + 17 * HOUR,
      T0 + 19 * HOUR,
    ]);
    // Bands: closed session spans plug→unplug; open session runs to now.
    expect(markers?.markArea?.data).toEqual([
      [{ xAxis: T0 + 14 * HOUR }, { xAxis: T0 + 17 * HOUR }],
      [{ xAxis: T0 + 19 * HOUR }, { xAxis: NOW }],
    ]);
  });

  it('drops sessions entirely outside the loaded window', () => {
    const outside = session({ id: 9, plugTsMs: T0 - 5 * DAY, unplugTsMs: T0 - 4 * DAY });
    const markers = option([session(), outside]).series?.find((s) => s.name === 'Sessions');
    expect(markers?.markLine?.data).toHaveLength(2);
    expect(markers?.markArea?.data).toHaveLength(1);
  });
});

