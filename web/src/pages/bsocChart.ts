/**
 * Pure chart logic for the Then tab's BSoC + Sessions chart (requirements
 * 2026.Nov.07 §2b) — window math, the ECharts option, and the static readout
 * helpers. No DOM/ECharts runtime here (only a type-only import), so every
 * rule below is unit-testable: the 2 h–1 yr zoom clamp, wheel gesture
 * direction (vertical = zoom, horizontal = scrub), session markers, EV gap
 * lines, the readout formatting/lookup, and touch→readout routing.
 *
 * Window model: the DOMAIN (now − 1 yr .. now, fixed at page init) is the
 * coordinate space — zoom/pan clamp into it, the time axis spans it, and the
 * dataZoom percent maps over it. The loaded window (what GET /api/series
 * returned) only gates lazy refetching via needsRefetch/fetchWindowFor.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type { SeriesResult, SessionSummary } from '../../../src/api/types';

/** Maximum zoom-in: 2 hours visible (requirements 2b). */
export const MIN_SPAN_MS = 2 * 60 * 60 * 1000;
/** Maximum zoom-out: 1 year visible (requirements 2b). */
export const MAX_SPAN_MS = 365 * 24 * 60 * 60 * 1000;
/** First paint window before any interaction. */
export const INITIAL_SPAN_MS = 24 * 60 * 60 * 1000;
/** Wheel-notch zoom factor (ECharts-like): deltaY −100 → ×1.25 in. */
export const ZOOM_PER_NOTCH = 1.25;
/** Cap on a single wheel event's zoom factor (fast trackpad flings). */
export const MAX_EVENT_ZOOM = 4;
/** Refetch when loaded span exceeds visible span by more than this. */
export const REFRESH_COARSENESS_RATIO = 16;
/** Padding added to the visible window when (re)fetching. */
export const FETCH_PAD_RATIO = 0.25;
/**
 * Refetch when a visible edge comes within this fraction of the visible span
 * of a loaded edge (or exceeds it) — smaller than FETCH_PAD_RATIO so a refetch
 * loads ahead of the view and cannot loop (the fresh bounds restore the gap).
 */
export const EDGE_BUFFER_RATIO = 0.1;
/** EV samples further apart than this multiple of the bucket width are a gap. */
export const EV_GAP_RATIO = 2.5;
/** Session start/end lines hide once the visible span exceeds one week. */
export const SESSION_EDGE_MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000;

export const EV_SERIES_NAME = 'Vehicle BSoC';
export const HOME_SERIES_NAME = 'Home battery BSoC';
export const EV_COLOR = '#4c6ef5';
export const HOME_COLOR = '#f59e0b';
export const SESSION_LINE_COLOR = '#9aa0a6';
export const SESSION_TINT = 'rgba(76, 110, 245, 0.10)';
/** Axis tick label color (medium-dark grey). Tweak here to restyle the ticks. */
export const AXIS_LABEL_COLOR = '#909090';
/**
 * Floor on the spacing between x-axis ticks, ms (30 min). Tweak here to change
 * tick density: larger = fewer, more widely spaced ticks (ECharts may still
 * space them wider at coarse zoom levels, never closer than this).
 */
export const X_TICK_MIN_INTERVAL_MS = 30 * 60 * 1000;

export interface TimeWindow {
  from: number;
  to: number;
}

export function spanOf(win: TimeWindow): number {
  return win.to - win.from;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Fit a window into bounds: span ≤ [MIN_SPAN_MS, MAX_SPAN_MS] (bounds win
 * when tighter), then shift into the bounds. Callers pass the DOMAIN as
 * bounds, so the span clamps land exactly on [MIN_SPAN_MS, MAX_SPAN_MS] and
 * the position clamps to the domain — never to the loaded window.
 */
export function clampWindow(win: TimeWindow, bounds: TimeWindow): TimeWindow {
  const boundsSpan = spanOf(bounds);
  let span = Math.min(spanOf(win), boundsSpan, MAX_SPAN_MS);
  span = Math.max(span, Math.min(MIN_SPAN_MS, boundsSpan));
  let from = win.from;
  if (from < bounds.from) from = bounds.from;
  if (from + span > bounds.to) from = bounds.to - span;
  if (from < bounds.from) from = bounds.from;
  return { from, to: from + span };
}

/**
 * Zoom by `factor` (>1 zooms in — the span shrinks) keeping the window
 * anchored at `anchorTs` (cursor position), clamped to [MIN_SPAN_MS,
 * MAX_SPAN_MS] and the bounds. Matches zoomFactorFor: scroll up (deltaY
 * negative) gives factor > 1 and zooms in.
 */
export function zoomAt(
  win: TimeWindow,
  bounds: TimeWindow,
  anchorTs: number,
  factor: number
): TimeWindow {
  const span = spanOf(win);
  let nextSpan = clamp(span / factor, MIN_SPAN_MS, MAX_SPAN_MS);
  nextSpan = Math.min(nextSpan, spanOf(bounds));
  const frac = span > 0 ? clamp((anchorTs - win.from) / span, 0, 1) : 0.5;
  return clampWindow(
    { from: anchorTs - frac * nextSpan, to: anchorTs + (1 - frac) * nextSpan },
    bounds
  );
}

/** Shift the window by deltaMs, clamped into bounds (span preserved). */
export function panBy(win: TimeWindow, bounds: TimeWindow, deltaMs: number): TimeWindow {
  return clampWindow({ from: win.from + deltaMs, to: win.to + deltaMs }, bounds);
}

/** Displayed window (`win`) → dataZoom start/end percent of the DOMAIN. */
export function windowToPercent(
  win: TimeWindow,
  bounds: TimeWindow
): { start: number; end: number } {
  const span = spanOf(bounds) || 1;
  return {
    start: clamp(((win.from - bounds.from) / span) * 100, 0, 100),
    end: clamp(((win.to - bounds.from) / span) * 100, 0, 100),
  };
}

/** dataZoom start/end percent of the DOMAIN → displayed window. */
export function percentToWindow(
  start: number,
  end: number,
  bounds: TimeWindow
): TimeWindow {
  const span = spanOf(bounds);
  return {
    from: bounds.from + (start / 100) * span,
    to: bounds.from + (end / 100) * span,
  };
}

export type WheelGesture =
  | { kind: 'zoom'; direction: 1 | -1 }
  | { kind: 'pan'; direction: 1 | -1 }
  | { kind: 'none' };

/**
 * Requirements 2b: scrolling vertically zooms the time scale, scrolling
 * horizontally scrubs it. Dominant-axis classification; sub-pixel jitter is
 * ignored.
 */
export function classifyWheel(deltaX: number, deltaY: number): WheelGesture {
  const ax = Math.abs(deltaX);
  const ay = Math.abs(deltaY);
  if (ax < 0.5 && ay < 0.5) return { kind: 'none' };
  if (ax >= ay) return { kind: 'pan', direction: deltaX >= 0 ? 1 : -1 };
  return { kind: 'zoom', direction: deltaY >= 0 ? -1 : 1 };
}

/** deltaY → zoom factor: −100 → ×ZOOM_PER_NOTCH, clamped to MAX_EVENT_ZOOM. */
export function zoomFactorFor(deltaY: number): number {
  return clamp(Math.pow(ZOOM_PER_NOTCH, -deltaY / 100), 1 / MAX_EVENT_ZOOM, MAX_EVENT_ZOOM);
}

/** Horizontal pixel delta → time delta (positive = scrub forward). */
export function panMsFor(deltaX: number, pxWidth: number, span: number): number {
  return pxWidth > 0 ? (deltaX / pxWidth) * span : 0;
}

/**
 * Loaded window is stale for this view: a visible edge is within the buffer of
 * a loaded edge (or past it) while more of the domain can still load, or the
 * loaded data is far too coarse for the view. `domain` edges are excluded from
 * the buffer check — data can never load past them, so a view parked at an
 * edge cannot loop refetches.
 */
export function needsRefetch(
  visible: TimeWindow,
  loaded: TimeWindow,
  domain: TimeWindow
): boolean {
  if (spanOf(loaded) / Math.max(spanOf(visible), 1) > REFRESH_COARSENESS_RATIO) return true;
  const buffer = spanOf(visible) * EDGE_BUFFER_RATIO;
  const leftNeeds = loaded.from > domain.from && visible.from - loaded.from < buffer;
  const rightNeeds = loaded.to < domain.to && loaded.to - visible.to < buffer;
  return leftNeeds || rightNeeds;
}

/** Fetch window for a visible view: padded, clamped into the domain. */
export function fetchWindowFor(visible: TimeWindow, domain: TimeWindow): TimeWindow {
  const pad = spanOf(visible) * FETCH_PAD_RATIO;
  // Round: zoom/pan windows are fractional and GET /api/series rejects
  // non-integer epoch ms (the 400 that froze the chart at 24 h).
  const win = clampWindow({ from: visible.from - pad, to: visible.to + pad }, domain);
  return { from: Math.round(win.from), to: Math.round(win.to) };
}

/** Sessions overlapping a window (for markers). */
export function sessionsInWindow(
  sessions: SessionSummary[],
  win: TimeWindow,
  nowMs: number
): SessionSummary[] {
  return sessions.filter(
    (s) => s.plugTsMs <= win.to && (s.unplugTsMs ?? nowMs) >= win.from
  );
}

/**
 * Whether session start/end lines render: at spans wider than one week the
 * edge lines clutter the chart (the tinted bands alone mark the sessions).
 */
export function sessionEdgesVisible(visible: TimeWindow): boolean {
  return spanOf(visible) <= SESSION_EDGE_MAX_SPAN_MS;
}

const MONTH_ABBRS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Local `MMM DD HH:MM` for the readout timestamp (e.g. `Nov 12 09:35`). */
export function formatReadoutTs(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${MONTH_ABBRS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Readout value label: one decimal + `%`, em-dash when the sample is absent. */
export function formatBsocValue(value: number | null): string {
  return value === null ? '—' : `${(Math.round(value * 10) / 10).toFixed(1)}%`;
}

/**
 * X-axis tick label: local `(H)H(:MM) am/pm` — no leading zero, no trailing
 * `:00` (e.g. `8am`, `8:30am`, `11pm`); `12am`/`12pm` at midnight/noon.
 */
export function formatXTick(tsMs: number): string {
  const d = new Date(tsMs);
  const hour12 = d.getHours() % 12 || 12;
  const suffix = d.getHours() < 12 ? 'am' : 'pm';
  const minutes = d.getMinutes();
  return minutes === 0
    ? `${hour12}${suffix}`
    : `${hour12}:${String(minutes).padStart(2, '0')}${suffix}`;
}

/**
 * Value of the nearest sample at or before `tsMs` (points sorted oldest
 * first); null before the first sample or with no samples.
 */
export function sampleAtOrBefore(
  points: Array<[number, number]>,
  tsMs: number
): number | null {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= tsMs) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? points[lo - 1][1] : null;
}

/** Newest loaded sample timestamp across both series, if any. */
export function newestSampleTs(ev: SeriesResult, home: SeriesResult): number | null {
  const lastTs = (points: Array<[number, number]>): number | null =>
    points.length > 0 ? points[points.length - 1][0] : null;
  const newest = Math.max(
    lastTs(ev.points) ?? Number.NEGATIVE_INFINITY,
    lastTs(home.points) ?? Number.NEGATIVE_INFINITY
  );
  return Number.isFinite(newest) ? newest : null;
}

export interface BsocReadout {
  /** Timestamp of the displayed values; null when no samples are loaded. */
  tsMs: number | null;
  tsLabel: string;
  homeLabel: string;
  evLabel: string;
}

/** Static readout row content: ts + both series values at `tsMs`. */
export function readoutAt(
  ev: SeriesResult,
  home: SeriesResult,
  tsMs: number | null
): BsocReadout {
  return {
    tsMs,
    tsLabel: tsMs === null ? '—' : formatReadoutTs(tsMs),
    homeLabel: tsMs === null ? '—' : formatBsocValue(sampleAtOrBefore(home.points, tsMs)),
    evLabel: tsMs === null ? '—' : formatBsocValue(sampleAtOrBefore(ev.points, tsMs)),
  };
}

/** Touch gesture state for routing chart touches to the readout (pure). */
export interface TouchPhase {
  /** Fingers currently down. */
  fingers: number;
  /** A multi-finger moment occurred in this gesture — frozen until full lift. */
  multi: boolean;
}

export type TouchAction =
  /** Set the readout to the gesture's x position (tap / single-finger drag). */
  | 'pin'
  /** Leave the readout untouched (mid-pinch: the scale is moving). */
  | 'freeze'
  /** Single-finger gesture over: the pinned value persists so it can be read. */
  | 'keep'
  /** Multi-finger gesture over: fall back to the newest sample. */
  | 'reset';

/**
 * Decide how a touch event moves the static readout. Single-finger tap/drag
 * pins values at the touched x (tooltip-like); a second finger freezes
 * updates and, on full lift, resets — the pre-pinch position is stale once
 * the scale has moved. `fingerCount` = `event.touches.length` (for `end`,
 * the fingers still down).
 */
export function touchReadout(
  phase: TouchPhase,
  kind: 'start' | 'move' | 'end',
  fingerCount: number
): { phase: TouchPhase; action: TouchAction } {
  if (kind === 'end' && fingerCount === 0) {
    return { phase: { fingers: 0, multi: false }, action: phase.multi ? 'reset' : 'keep' };
  }
  if (fingerCount === 0) return { phase, action: 'freeze' }; // no position to read
  const multi = phase.multi || fingerCount > 1;
  return { phase: { fingers: fingerCount, multi }, action: multi ? 'freeze' : 'pin' };
}

export interface BsocData {
  ev: SeriesResult;
  home: SeriesResult;
  sessions: SessionSummary[];
  /** The fetched (loaded) window — gates refetching and session filtering. */
  bounds: TimeWindow;
}

/** `[epochMs, value]` sample, as served by GET /api/series. */
export type BsocPoint = [number, number];
/** Dashed segment endpoints (gap bridge or edge extension). */
export type BsocSegment = [BsocPoint, BsocPoint];

export interface EvGapLine {
  /** EV series data: contiguous runs separated by `null` line breaks. */
  solid: Array<BsocPoint | null>;
  /** Dashed segments bridging gaps and extending to the chart edges. */
  dashed: BsocSegment[];
}

/**
 * Split EV points (oldest first) into contiguous runs wherever consecutive
 * samples are more than `gapThresholdMs` apart. Runs render solid (separated by
 * `null` breaks so ECharts does not connect across gaps); each gap renders as a
 * dashed bridge, and the space before the first / after the last sample renders
 * as a dashed extension at that sample's value when the `edgeFrom`/`edgeTo`
 * chart edge is itself more than one gap away ("as needed" — a stub shorter
 * than a gap would just flicker at the edge of live data).
 */
export function evGapLine(
  points: BsocPoint[],
  gapThresholdMs: number,
  edgeFrom: number,
  edgeTo: number
): EvGapLine {
  const solid: Array<BsocPoint | null> = [];
  const dashed: BsocSegment[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i][0] - points[i - 1][0] > gapThresholdMs) {
      dashed.push([points[i - 1], points[i]]);
      solid.push(null);
    }
    solid.push(points[i]);
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (first !== undefined && first[0] - edgeFrom > gapThresholdMs) {
    dashed.push([[edgeFrom, first[1]], first]);
  }
  if (last !== undefined && edgeTo - last[0] > gapThresholdMs) {
    dashed.push([last, [edgeTo, last[1]]]);
  }
  return { solid, dashed };
}

/**
 * The full chart option: dual BSoC lines over one time axis spanning the
 * DOMAIN (the visible window rides the dataZoom), inside dataZoom clamped to
 * 2 h–1 yr, session markers (tinted band; faint start/end lines only at
 * spans of a week or less — see `sessionEdgesVisible`) for every session
 * overlapping the loaded window, and dashed EV gap segments. No tooltip/
 * legend — the page renders a static readout row below the chart.
 */
export function buildBsocOption(
  data: BsocData,
  visible: TimeWindow,
  domain: TimeWindow,
  nowMs: number
): EChartsCoreOption {
  const pct = windowToPercent(visible, domain);
  const evGaps = evGapLine(
    data.ev.points,
    EV_GAP_RATIO * data.ev.bucketMs,
    domain.from,
    domain.to
  );
  const sessions = sessionsInWindow(data.sessions, data.bounds, nowMs);
  const markLineData = sessionEdgesVisible(visible)
    ? sessions.flatMap((s) => {
        const marks = [{ xAxis: s.plugTsMs }];
        // An open session has no end yet — start line + band to now only.
        if (s.unplugTsMs !== null) marks.push({ xAxis: s.unplugTsMs });
        return marks;
      })
    : [];
  const markAreaData = sessions.map((s) => [
    { xAxis: s.plugTsMs },
    { xAxis: s.unplugTsMs ?? nowMs },
  ]);

  const option: EChartsCoreOption = {
    animation: false,
    color: [EV_COLOR, HOME_COLOR],
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    xAxis: {
      type: 'time',
      // The DOMAIN, not the loaded bounds: the visible window must be able to
      // ride past loaded data (lazy loading refetches it promptly).
      min: domain.from,
      max: domain.to,
      // Tick look: spacing floor + label style/format — tweak
      // X_TICK_MIN_INTERVAL_MS and AXIS_LABEL_COLOR at the top of this module.
      minInterval: X_TICK_MIN_INTERVAL_MS,
      axisLabel: {
        color: AXIS_LABEL_COLOR,
        formatter: (value: unknown) => formatXTick(Number(value)),
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: { color: AXIS_LABEL_COLOR, formatter: '{value}%' },
      interval: 25
    },
    dataZoom: [
      {
        type: 'inside',
        start: pct.start,
        end: pct.end,
        // The component owns the wheel (direction-aware, see classifyWheel);
        // ECharts keeps pinch zoom + mouse-drag scrub.
        zoomOnMouseWheel: false,
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
        preventDefaultMouseMove: true,
        minValueSpan: MIN_SPAN_MS,
        maxValueSpan: MAX_SPAN_MS,
      },
    ],
    series: [
      {
        name: EV_SERIES_NAME,
        type: 'line',
        showSymbol: false,
        // Gaps between runs stay disconnected (null breaks); the dashed
        // markLine below bridges them and extends to the chart edges.
        connectNulls: false,
        lineStyle: { width: 2 },
        data: evGaps.solid,
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          animation: false,
          lineStyle: { color: EV_COLOR, type: 'dashed', width: 2 },
          label: { show: false },
          // Point→point segments: each entry is a [from, to] marker-item pair.
          data: evGaps.dashed.map(([from, to]) => [{ coord: from }, { coord: to }]),
        },
      },
      {
        name: HOME_SERIES_NAME,
        type: 'line',
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 2 },
        data: data.home.points,
      },
      {
        // Marker carrier: no data of its own.
        name: 'Sessions',
        type: 'line',
        data: [],
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          animation: false,
          lineStyle: { color: SESSION_LINE_COLOR, type: 'dashed', width: 1, opacity: 0.6 },
          label: { show: false },
          data: markLineData,
        },
        markArea: {
          itemStyle: { color: SESSION_TINT },
          label: { show: false },
          data: markAreaData,
        },
      },
    ],
  };
  return option;
}
