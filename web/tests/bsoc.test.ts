import { describe, expect, it } from 'vitest';
import type { SeriesResult, SessionSummary } from '../../src/api/types';
import {
  AXIS_LABEL_COLOR,
  AXIS_TICK_LENGTH,
  buildBsocOption,
  classifyWheel,
  clampWindow,
  EV_COLOR,
  EV_SERIES_NAME,
  evGapLine,
  fetchWindowFor,
  formatBsocValue,
  formatReadoutTs,
  formatXTick,
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
  SESSION_EDGE_MAX_SPAN_MS,
  sessionEdgesVisible,
  sessionsInWindow,
  spanOf,
  touchReadout,
  windowToPercent,
  X_TICK_EDGE_MARGIN_PX,
  X_TICK_MIN_GAP_PX,
  X_TICK_MIN_INTERVAL_MS,
  xTickStepMs,
  xTicksMs,
  zoomAt,
  zoomFactorFor,
  type BsocData,
  type SeriesVisibility,
  type TimeWindow,
  type TouchPhase,
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
  it('keeps the anchor fraction under zoom-in (factor > 1 shrinks the span)', () => {
    const anchor = T0 + 6 * HOUR; // 25% into the 24 h window
    const win = zoomAt(BOUNDS, BOUNDS, anchor, 2);
    expect(spanOf(win)).toBe(12 * HOUR);
    expect(win.from).toBe(T0 + 3 * HOUR);
    expect(win.to).toBe(T0 + 15 * HOUR);
  });

  it('never zooms past the 2 h floor', () => {
    const win = zoomAt(BOUNDS, BOUNDS, T0 + 12 * HOUR, 1e9);
    expect(spanOf(win)).toBe(MIN_SPAN_MS);
  });

  it('never zooms out past the 1 yr ceiling', () => {
    const bounds = { from: T0, to: T0 + 500 * DAY };
    const win = zoomAt({ from: T0, to: T0 + 300 * DAY }, bounds, T0 + 150 * DAY, 0.01);
    expect(spanOf(win)).toBe(MAX_SPAN_MS);
  });

  it('clamps the anchored window into the bounds', () => {
    // Anchored at the right edge: zoom-out must not spill past bounds.to.
    const win = zoomAt(BOUNDS, BOUNDS, T0 + DAY, 2);
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
  const DOMAIN: TimeWindow = { from: T0 - 100 * DAY, to: T0 + 2 * DAY };

  it('accepts a view well inside adequately detailed bounds', () => {
    const loaded = { from: T0 - 10 * HOUR, to: T0 + 10 * HOUR };
    expect(needsRefetch({ from: T0, to: T0 + 6 * HOUR }, loaded, DOMAIN)).toBe(false);
  });

  it('refetches when the view moves within the buffer of a loadable edge', () => {
    const loaded = { from: T0, to: T0 + DAY };
    // 18 h visible → 1.8 h buffer; 1 h of headroom on the left is inside it.
    expect(needsRefetch({ from: T0 + 1 * HOUR, to: T0 + 19 * HOUR }, loaded, DOMAIN)).toBe(true);
  });

  it('refetches when the view exceeds the loaded bounds', () => {
    const loaded = { from: T0, to: T0 + DAY };
    expect(needsRefetch({ from: T0 - HOUR, to: T0 + 12 * HOUR }, loaded, DOMAIN)).toBe(true);
  });

  it('does not loop at the domain edge (nothing left to load there)', () => {
    // Parked at the right edge: fetchWindowFor's clamp lands exactly on
    // domain.to and the loaded edge can never move again.
    const visible = { from: DOMAIN.to - 10 * DAY, to: DOMAIN.to };
    const loaded = fetchWindowFor(visible, DOMAIN);
    expect(loaded.to).toBe(DOMAIN.to);
    expect(needsRefetch(visible, loaded, DOMAIN)).toBe(false);
  });

  it('still refetches away from the edge even when one side sits on the domain', () => {
    const loaded = { from: DOMAIN.from, to: DOMAIN.from + 20 * HOUR };
    const visible = { from: DOMAIN.from + 12 * HOUR, to: DOMAIN.from + 20 * HOUR };
    expect(needsRefetch(visible, loaded, DOMAIN)).toBe(true);
  });

  it('refetches when the loaded data is too coarse for the view', () => {
    const loaded = { from: T0, to: T0 + 40 * DAY };
    expect(needsRefetch({ from: T0, to: T0 + DAY }, loaded, DOMAIN)).toBe(true);
  });

  it('never loops: the fetch window it asks for satisfies it afterwards', () => {
    const visible = { from: T0 + 6 * HOUR, to: T0 + 18 * HOUR };
    const loaded = fetchWindowFor(visible, DOMAIN);
    expect(needsRefetch(visible, loaded, DOMAIN)).toBe(false);
  });

  it('pads the fetch window and clamps it into the domain', () => {
    const visible = { from: T0 + 6 * HOUR, to: T0 + 18 * HOUR };
    const win = fetchWindowFor(visible, DOMAIN);
    expect(win.from).toBe(T0 + 3 * HOUR); // −25% of the 12 h span
    expect(win.to).toBe(T0 + 21 * HOUR);

    const old = { from: DOMAIN.from + DAY, to: DOMAIN.from + 11 * DAY };
    const clamped = fetchWindowFor(old, DOMAIN);
    expect(clamped.from).toBe(DOMAIN.from);
    expect(clamped.to).toBe(DOMAIN.from + 15 * DAY); // padded span shifts in, span preserved
  });

  it('rounds a fractional visible window to integer bounds (API contract)', () => {
    // dataZoom percent→time math yields fractions; the API 400s on them.
    const visible = { from: T0 + 6 * HOUR + 0.4, to: T0 + 18 * HOUR + 0.4 };
    const win = fetchWindowFor(visible, DOMAIN);
    expect(win).toEqual({ from: T0 + 3 * HOUR, to: T0 + 21 * HOUR });
    expect(Number.isInteger(win.from)).toBe(true);
    expect(Number.isInteger(win.to)).toBe(true);
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

describe('formatXTick', () => {
  /** Local-time wall clock → timestamp, so expectations hold in any TZ. */
  const ts = (h: number, m: number): number => new Date(2026, 10, 12, h, m).getTime();

  it('renders (H)H am/pm with no leading zero and no trailing :00', () => {
    expect(formatXTick(ts(8, 0))).toBe('8am');
    expect(formatXTick(ts(9, 0))).toBe('9am');
    expect(formatXTick(ts(23, 0))).toBe('11pm');
    expect(formatXTick(ts(12, 0))).toBe('12pm');
  });

  it('renders :MM when the tick is not on the hour', () => {
    expect(formatXTick(ts(8, 30))).toBe('8:30am');
    expect(formatXTick(ts(8, 5))).toBe('8:05am');
    expect(formatXTick(ts(23, 45))).toBe('11:45pm');
    expect(formatXTick(ts(0, 15))).toBe('12:15am');
  });

  it('renders zero-padded MMM-DD at day boundaries (midnight ticks)', () => {
    expect(formatXTick(ts(0, 0))).toBe('Nov-12');
    expect(formatXTick(new Date(2026, 10, 2, 0, 0).getTime())).toBe('Nov-02');
    expect(formatXTick(new Date(2026, 11, 31, 0, 0).getTime())).toBe('Dec-31');
    expect(formatXTick(new Date(2027, 0, 1, 0, 0).getTime())).toBe('Jan-01');
    // A non-zero sub-minute component is not a day boundary.
    expect(formatXTick(new Date(2026, 10, 12, 0, 0, 0, 1).getTime())).toBe('12am');
  });
});

describe('xTickStepMs', () => {
  it('takes the smallest tick step clearing the pixel floor', () => {
    // 1 d on 350 px → 5.5 h desired → the 6 h step.
    expect(xTickStepMs(DAY, 350)).toBe(6 * HOUR);
    // 1 d on 800 px → 2.4 h desired → the 4 h step.
    expect(xTickStepMs(DAY, 800)).toBe(4 * HOUR);
    // 8 d on 800 px → 19.2 h desired → the 1 d step.
    expect(xTickStepMs(8 * DAY, 800)).toBe(DAY);
  });

  it('never goes below the X_TICK_MIN_INTERVAL_MS time floor', () => {
    expect(xTickStepMs(2 * HOUR, 2560)).toBe(30 * MINUTE);
  });

  it('grows the step as the chart narrows (pixel floor, not time floor)', () => {
    const wide = xTickStepMs(DAY, 1400);
    const narrow = xTickStepMs(DAY, 350);
    expect(narrow).toBeGreaterThan(wide);
  });

  it('falls back to the time floor when the width is unusable', () => {
    expect(xTickStepMs(DAY, 0)).toBe(30 * MINUTE);
    expect(xTickStepMs(DAY, -5)).toBe(30 * MINUTE);
  });

  it('clears both floors for any span/width', () => {
    for (const spanMs of [2 * HOUR, DAY, 30 * DAY, 365 * DAY]) {
      for (const widthPx of [200, 350, 800, 1400, 2560]) {
        const step = xTickStepMs(spanMs, widthPx);
        expect(step).toBeGreaterThanOrEqual(X_TICK_MIN_INTERVAL_MS);
        expect(step).toBeGreaterThanOrEqual((spanMs * X_TICK_MIN_GAP_PX) / widthPx);
      }
    }
  });
});

describe('xTicksMs', () => {
  /** Local-time window helpers so expectations hold in any TZ. */
  const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
    new Date(y, mo, d, h, mi).getTime();

  it('lands day-or-coarser steps on local midnights (so labels read MMM-DD)', () => {
    // 5.5 d on 800 px → 13.2 h desired → the 1 d step: one tick per midnight
    // in range (the window's own edges are not midnights).
    const visible = { from: at(2026, 10, 10, 3), to: at(2026, 10, 15, 15) };
    const ticks = xTicksMs(visible, 800);
    expect(ticks.map((t) => formatXTick(t))).toEqual([
      'Nov-11',
      'Nov-12',
      'Nov-13',
      'Nov-14',
      'Nov-15',
    ]);
  });

  it('lands sub-day steps on round local times', () => {
    // 2 h on 800 px → the 30 min floor: ticks on :00/:30.
    const visible = { from: at(2026, 10, 12, 8, 7), to: at(2026, 10, 12, 10, 7) };
    const ticks = xTicksMs(visible, 800);
    expect(ticks.map((t) => formatXTick(t))).toEqual(['8:30am', '9am', '9:30am', '10am']);
  });

  it('keeps consecutive ticks at least X_TICK_MIN_GAP_PX apart', () => {
    for (const [from, to] of [
      [at(2026, 10, 10, 0), at(2026, 10, 10, 2)],
      [at(2026, 10, 10, 0), at(2026, 10, 11, 0)],
      [at(2026, 10, 10, 0), at(2026, 10, 13, 0)],
      [at(2026, 10, 10, 0), at(2026, 11, 9, 0)],
    ]) {
      for (const widthPx of [350, 800, 1400]) {
        const visible = { from, to };
        const ticks = xTicksMs(visible, widthPx);
        for (let i = 1; i < ticks.length; i++) {
          const gapPx = ((ticks[i] - ticks[i - 1]) / spanOf(visible)) * widthPx;
          expect(gapPx).toBeGreaterThanOrEqual(X_TICK_MIN_GAP_PX);
        }
      }
    }
  });

  it('drops ticks within X_TICK_EDGE_MARGIN_PX of either edge', () => {
    const visible = { from: at(2026, 10, 12, 0, 15), to: at(2026, 10, 12, 23, 45) };
    const ticks = xTicksMs(visible, 800);
    const marginMs = (spanOf(visible) * X_TICK_EDGE_MARGIN_PX) / 800;
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t - visible.from).toBeGreaterThanOrEqual(marginMs);
      expect(visible.to - t).toBeGreaterThanOrEqual(marginMs);
    }
  });

  it('anchors the grid globally so panning does not slide the ticks', () => {
    const a = xTicksMs({ from: at(2026, 10, 10, 0), to: at(2026, 10, 12, 0) }, 800);
    const b = xTicksMs({ from: at(2026, 10, 11, 0), to: at(2026, 10, 13, 0) }, 800);
    const shared = a.filter((t) => b.includes(t));
    expect(shared.length).toBeGreaterThanOrEqual(2);
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

describe('touchReadout (touch → static readout)', () => {
  const IDLE: TouchPhase = { fingers: 0, multi: false };

  it('pins on a single-finger tap and keeps the value when it lifts', () => {
    const down = touchReadout(IDLE, 'start', 1);
    expect(down).toEqual({ phase: { fingers: 1, multi: false }, action: 'pin' });
    const up = touchReadout(down.phase, 'end', 0);
    expect(up).toEqual({ phase: { fingers: 0, multi: false }, action: 'keep' });
  });

  it('keeps pinning along a single-finger drag', () => {
    const move = touchReadout({ fingers: 1, multi: false }, 'move', 1);
    expect(move.action).toBe('pin');
    expect(move.phase).toEqual({ fingers: 1, multi: false });
  });

  it('freezes when a second finger lands and stays frozen while any remains', () => {
    const two = touchReadout({ fingers: 1, multi: false }, 'start', 2);
    expect(two).toEqual({ phase: { fingers: 2, multi: true }, action: 'freeze' });
    const oneLeft = touchReadout(two.phase, 'end', 1);
    expect(oneLeft).toEqual({ phase: { fingers: 1, multi: true }, action: 'freeze' });
  });

  it('resets to the newest sample when a multi-finger gesture fully lifts', () => {
    const up = touchReadout({ fingers: 1, multi: true }, 'end', 0);
    expect(up).toEqual({ phase: { fingers: 0, multi: false }, action: 'reset' });
  });

  it('stays frozen mid-pinch even with one finger left', () => {
    expect(touchReadout({ fingers: 2, multi: true }, 'move', 1).action).toBe('freeze');
  });
});
describe('evGapLine (dashed EV gap segments)', () => {
  const THRESHOLD = 12 * MINUTE; // 2.5 × a 5 min bucket in these fixtures
  const pts = (...entries: Array<[number, number]>) => entries;

  it('keeps close samples in one run and extends both edges past the threshold', () => {
    const points = pts([T0 + 2 * HOUR, 50], [T0 + 2 * HOUR + 5 * MINUTE, 51]);
    const line = evGapLine(points, THRESHOLD, T0, T0 + DAY);
    expect(line.solid).toEqual(points);
    expect(line.dashed).toEqual([
      [[T0, 50], points[0]],
      [points[1], [T0 + DAY, 51]],
    ]);
  });

  it('bridges a gap with a dashed segment and breaks the solid run', () => {
    const points = pts(
      [T0 + HOUR, 50],
      [T0 + HOUR + 5 * MINUTE, 51],
      [T0 + 6 * HOUR, 60],
      [T0 + 6 * HOUR + 5 * MINUTE, 61]
    );
    const line = evGapLine(points, THRESHOLD, T0, T0 + DAY);
    expect(line.solid).toEqual([points[0], points[1], null, points[2], points[3]]);
    // Bridge first (run order), then the two edge extensions.
    expect(line.dashed).toEqual([
      [points[1], points[2]],
      [[T0, 50], points[0]],
      [points[3], [T0 + DAY, 61]],
    ]);
  });

  it('splits every sample into its own run when all gaps exceed the threshold', () => {
    const points = pts([T0 + HOUR, 50], [T0 + 3 * HOUR, 55], [T0 + 5 * HOUR, 60]);
    const line = evGapLine(points, THRESHOLD, T0, T0 + DAY);
    expect(line.solid).toEqual([points[0], null, points[1], null, points[2]]);
    expect(line.dashed).toHaveLength(2 + 2); // 2 bridges + 2 extensions
  });

  it('skips edge extensions shorter than a gap ("as needed")', () => {
    const points = pts([T0 + 5 * MINUTE, 50], [T0 + 3 * HOUR, 60]);
    const line = evGapLine(points, THRESHOLD, T0, T0 + 3 * HOUR + 5 * MINUTE);
    expect(line.dashed).toEqual([[points[0], points[1]]]);
  });

  it('extends from a lone sample and renders no solid line', () => {
    const points = pts([T0 + 12 * HOUR, 42]);
    const line = evGapLine(points, THRESHOLD, T0, T0 + DAY);
    expect(line.solid).toEqual(points);
    expect(line.dashed).toEqual([
      [[T0, 42], points[0]],
      [points[0], [T0 + DAY, 42]],
    ]);
  });

  it('returns nothing without samples', () => {
    expect(evGapLine([], THRESHOLD, T0, T0 + DAY)).toEqual({ solid: [], dashed: [] });
  });
});

describe('sessionEdgesVisible', () => {
  it('is true at spans up to one week and false beyond', () => {
    expect(sessionEdgesVisible({ from: T0, to: T0 + DAY })).toBe(true);
    expect(sessionEdgesVisible({ from: T0, to: T0 + SESSION_EDGE_MAX_SPAN_MS })).toBe(true);
    expect(sessionEdgesVisible({ from: T0, to: T0 + SESSION_EDGE_MAX_SPAN_MS + 1 })).toBe(false);
    expect(sessionEdgesVisible({ from: T0, to: T0 + 8 * DAY })).toBe(false);
  });
});



describe('buildBsocOption (requirements 2b)', () => {
  const NOW = T0 + 20 * HOUR;
  /** Chart width passed to the option builder (tick spacing is pixel-based). */
  const WIDTH = 800;
  /** The DOMAIN — the axis extent and dataZoom percent base. */
  const DOMAIN: TimeWindow = { from: T0, to: T0 + DAY };
  /** Structural view of the option — ECharts types are deliberately loose. */
  interface OptionShape {
    color?: string[];
    /** Pinned absent: the readout row below the chart replaces both. */
    legend?: unknown;
    tooltip?: unknown;
    xAxis?: {
      type?: string;
      min?: number;
      max?: number;
      axisLine?: { show?: boolean };
      axisTick?: { length?: number; lineStyle?: { color?: string }; customValues?: number[] };
      axisLabel?: {
        color?: string;
        customValues?: number[];
        formatter?: (value: unknown) => string;
      };
    };
    yAxis?: {
      min?: number;
      max?: number;
      axisLine?: { show?: boolean };
      axisTick?: { length?: number; lineStyle?: { color?: string } };
      axisLabel?: { color?: string };
    };
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
      data?: Array<[number, number] | null>;
      markLine?: {
        data?: Array<
          { xAxis?: number } | [{ coord: [number, number] }, { coord: [number, number] }]
        >;
      };
      markArea?: { data?: Array<Array<{ xAxis?: number }>> };
    }>;
  }

  const option = (
    sessions: SessionSummary[],
    visible: TimeWindow = BOUNDS,
    evPoints: Array<[number, number]> = [[T0 + HOUR, 54]],
    shown: SeriesVisibility = { ev: true, home: true }
  ): OptionShape => {
    const base = data(sessions);
    return buildBsocOption(
      { ...base, ev: { ...base.ev, points: evPoints } },
      visible,
      DOMAIN,
      NOW,
      WIDTH,
      shown
    ) as unknown as OptionShape;
  };

  it('plots both BSoC lines with the exported series colors and no legend/tooltip', () => {
    const opt = option([]);
    expect(opt.series?.slice(0, 2).map((s) => s.name)).toEqual([
      EV_SERIES_NAME,
      HOME_SERIES_NAME,
    ]);
    expect(opt.color).toEqual([EV_COLOR, HOME_COLOR]);
    expect(opt.yAxis).toMatchObject({ min: 0, max: 100 });
    expect(opt.xAxis).toMatchObject({ type: 'time', min: DOMAIN.from, max: DOMAIN.to });
    // The static readout row below the chart replaces both.
    expect(opt.legend).toBeUndefined();
    expect(opt.tooltip).toBeUndefined();
  });

  it('renders x ticks at the xTicksMs positions and styles axis labels', () => {
    const opt = option([]);
    const ticks = xTicksMs(BOUNDS, WIDTH);
    expect(opt.xAxis?.axisTick?.customValues).toEqual(ticks);
    expect(opt.xAxis?.axisLabel?.customValues).toEqual(ticks);
    expect(opt.xAxis?.axisLabel?.color).toBe(AXIS_LABEL_COLOR);
    expect(opt.yAxis?.axisLabel?.color).toBe(AXIS_LABEL_COLOR);
  });

  it('suppresses both axis lines and draws half-length label-colored ticks', () => {
    const opt = option([]);
    expect(opt.xAxis?.axisLine?.show).toBe(false);
    expect(opt.yAxis?.axisLine?.show).toBe(false);
    const tick = { length: AXIS_TICK_LENGTH, lineStyle: { color: AXIS_LABEL_COLOR } };
    expect(opt.xAxis?.axisTick).toEqual({ ...tick, customValues: xTicksMs(BOUNDS, WIDTH) });
    expect(opt.yAxis?.axisTick).toEqual(tick);
  });

  it('formats x tick labels as (H)H(:MM) am/pm', () => {
    const formatter = option([]).xAxis?.axisLabel?.formatter;
    expect(typeof formatter).toBe('function');
    // Local wall clock so the expectation holds in any TZ.
    expect(formatter?.(new Date(2026, 10, 12, 8, 30).getTime())).toBe('8:30am');
    expect(formatter?.(new Date(2026, 10, 12, 8, 0).getTime())).toBe('8am');
  });

  it('spans the DOMAIN on the x axis even when the loaded bounds differ', () => {
    const base = data([]);
    const loadedElsewhere: BsocData = {
      ...base,
      bounds: { from: T0 + 2 * HOUR, to: T0 + 3 * HOUR },
    };
    const opt = buildBsocOption(loadedElsewhere, BOUNDS, DOMAIN, NOW, WIDTH) as unknown as OptionShape;
    expect(opt.xAxis).toMatchObject({ min: DOMAIN.from, max: DOMAIN.to });
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

  it('maps the visible window into dataZoom start/end percent of the DOMAIN', () => {
    const visible = { from: T0 + 12 * HOUR, to: T0 + 18 * HOUR };
    const zoom = option([], visible).dataZoom?.[0];
    expect(zoom?.start).toBe(50);
    expect(zoom?.end).toBe(75);
  });

  it('renders EV gaps as solid runs plus a dashed markLine of segments', () => {
    const evPoints: Array<[number, number]> = [
      [T0 + 2 * HOUR, 50],
      [T0 + 2 * HOUR + 5 * MINUTE, 51],
      [T0 + 6 * HOUR, 60],
    ];
    const opt = option([], BOUNDS, evPoints);
    const ev = opt.series?.[0];
    expect(ev?.data).toEqual([evPoints[0], evPoints[1], null, evPoints[2]]);
    expect(ev?.markLine?.data).toEqual([
      [{ coord: evPoints[1] }, { coord: evPoints[2] }],
      [{ coord: [T0, 50] }, { coord: evPoints[0] }],
      [{ coord: evPoints[2] }, { coord: [T0 + DAY, 60] }],
    ]);
    // Home battery series is untouched (plain points, no gap decoration).
    expect(opt.series?.[1].data).toEqual([[T0 + HOUR, 71]]);
    expect(opt.series?.[1].markLine).toBeUndefined();
  });

  it('draws two markLines for a closed session and one for an open session', () => {
    const open = session({ id: 2, plugTsMs: T0 + 19 * HOUR, unplugTsMs: null, open: true });
    const markers = option([session(), open]).series?.find((s) => s.name === 'Sessions');
    expect(
      markers?.markLine?.data?.map((m) => ('xAxis' in m ? m.xAxis : null))
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

  it('hides session edge markLines at spans wider than a week, keeping the bands', () => {
    const wideDomain: TimeWindow = { from: T0, to: T0 + 30 * DAY };
    const wide: TimeWindow = { from: T0, to: T0 + 8 * DAY };
    const opt = buildBsocOption(data([session()]), wide, wideDomain, NOW, WIDTH) as unknown as OptionShape;
    const markers = opt.series?.find((s) => s.name === 'Sessions');
    expect(markers?.markLine?.data).toEqual([]);
    expect(markers?.markArea?.data).toEqual([
      [{ xAxis: T0 + 14 * HOUR }, { xAxis: T0 + 17 * HOUR }],
    ]);
  });

  it('keeps session edge markLines at a visible span of exactly one week', () => {
    const wideDomain: TimeWindow = { from: T0, to: T0 + 30 * DAY };
    const week: TimeWindow = { from: T0, to: T0 + 7 * DAY };
    const opt = buildBsocOption(data([session()]), week, wideDomain, NOW, WIDTH) as unknown as OptionShape;
    const markers = opt.series?.find((s) => s.name === 'Sessions');
    expect(
      markers?.markLine?.data?.map((m) => ('xAxis' in m ? m.xAxis : null))
    ).toEqual([T0 + 14 * HOUR, T0 + 17 * HOUR]);
  });

  it('hides the EV line and its dashed gap segments when toggled off', () => {
    const evPoints: Array<[number, number]> = [
      [T0 + 2 * HOUR, 50],
      [T0 + 6 * HOUR, 60],
    ];
    const opt = option([], BOUNDS, evPoints, { ev: false, home: true });
    const ev = opt.series?.[0];
    // Name/color slot stays put; nothing renders.
    expect(ev?.name).toBe(EV_SERIES_NAME);
    expect(ev?.data).toEqual([]);
    expect(ev?.markLine?.data).toEqual([]);
    // The home line is untouched.
    expect(opt.series?.[1].data).toEqual([[T0 + HOUR, 71]]);
  });

  it('hides the home line when toggled off, keeping names and colors stable', () => {
    const opt = option([], BOUNDS, [[T0 + HOUR, 54]], { ev: true, home: false });
    expect(opt.series?.slice(0, 2).map((s) => s.name)).toEqual([
      EV_SERIES_NAME,
      HOME_SERIES_NAME,
    ]);
    expect(opt.series?.[0].data).toEqual([[T0 + HOUR, 54]]);
    expect(opt.series?.[1].data).toEqual([]);
    expect(opt.color).toEqual([EV_COLOR, HOME_COLOR]);
  });
});
