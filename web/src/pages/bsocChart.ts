/**
 * Pure chart logic for the Then tab's BSoC + Sessions chart (requirements
 * 2026.Nov.07 §2b) — window math, the ECharts option, and the tooltip
 * formatter. No DOM/ECharts runtime here (only a type-only import), so every
 * rule below is unit-testable: the 2 h–1 yr zoom clamp, wheel gesture
 * direction (vertical = zoom, horizontal = scrub), session markers, and the
 * session tooltip contents.
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

export const EV_SERIES_NAME = 'Vehicle BSoC';
export const HOME_SERIES_NAME = 'Home battery BSoC';
export const EV_COLOR = '#4c6ef5';
export const HOME_COLOR = '#f59e0b';
export const SESSION_LINE_COLOR = '#9aa0a6';
export const SESSION_TINT = 'rgba(76, 110, 245, 0.10)';

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
 * when tighter), then shift into the bounds. Degenerate bounds (span < MIN)
 * collapse to the bounds themselves.
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
 * Zoom by `factor` (>1 zooms in) keeping the window anchored at `anchorTs`
 * (cursor position), clamped to [MIN_SPAN_MS, MAX_SPAN_MS] and the bounds.
 */
export function zoomAt(
  win: TimeWindow,
  bounds: TimeWindow,
  anchorTs: number,
  factor: number
): TimeWindow {
  const span = spanOf(win);
  let nextSpan = clamp(span * factor, MIN_SPAN_MS, MAX_SPAN_MS);
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

/** Loaded window is stale for this view: outside bounds or far too coarse. */
export function needsRefetch(visible: TimeWindow, bounds: TimeWindow): boolean {
  if (visible.from < bounds.from - 1 || visible.to > bounds.to + 1) return true;
  return spanOf(bounds) / Math.max(spanOf(visible), 1) > REFRESH_COARSENESS_RATIO;
}

/** Fetch window for a visible view: padded, clamped to [now − 1 yr, now]. */
export function fetchWindowFor(visible: TimeWindow, nowMs: number): TimeWindow {
  const pad = spanOf(visible) * FETCH_PAD_RATIO;
  return clampWindow(
    { from: visible.from - pad, to: visible.to + pad },
    { from: nowMs - MAX_SPAN_MS, to: nowMs }
  );
}

/** Local `YYYY-MM-DD HH:MM` — matches the API's session label format. */
export function formatDateTime(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** The session under a hover/touch timestamp, if any (bands never overlap). */
export function sessionAt(
  tsMs: number,
  sessions: SessionSummary[],
  nowMs: number
): SessionSummary | null {
  return (
    sessions.find((s) => tsMs >= s.plugTsMs && tsMs <= (s.unplugTsMs ?? nowMs)) ?? null
  );
}

/** Sessions overlapping a window (for markers + tooltips). */
export function sessionsInWindow(
  sessions: SessionSummary[],
  win: TimeWindow,
  nowMs: number
): SessionSummary[] {
  return sessions.filter(
    (s) => s.plugTsMs <= win.to && (s.unplugTsMs ?? nowMs) >= win.from
  );
}

/** Loose shape of ECharts axis-tooltip params (they are typed loosely there). */
export interface TooltipParamLike {
  axisValue?: number;
  seriesName?: string;
  value?: unknown;
}

function socSpan(start: number | null, end: number | null, open: boolean): string {
  if (start === null) return '—';
  if (end === null) return open ? `${start}% → now` : `${start}% → —`;
  return `${start}% → ${end}%`;
}

function sessionEndLabel(session: SessionSummary, nowMs: number): string {
  return session.unplugTsMs === null
    ? `${formatDateTime(nowMs)} (in progress)`
    : formatDateTime(session.unplugTsMs);
}

function paramValue(param: TooltipParamLike): number | null {
  if (Array.isArray(param.value)) {
    const v = param.value[1];
    return typeof v === 'number' ? v : null;
  }
  return typeof param.value === 'number' ? param.value : null;
}

export interface BsocData {
  ev: SeriesResult;
  home: SeriesResult;
  sessions: SessionSummary[];
  /** The fetched (loaded) window — the axis extent and zoom bounds. */
  bounds: TimeWindow;
}

/**
 * Axis tooltip: hovered time, the session block when the cursor sits inside
 * a charging-session band (start/end time, EV % start→end, home % start→end),
 * then both series values. Returns HTML (ECharts renders it as innerHTML).
 */
export function formatBsocTooltip(
  params: TooltipParamLike[],
  data: BsocData,
  nowMs: number
): string {
  const ts = Number(params[0]?.axisValue);
  const lines: string[] = [];
  if (Number.isFinite(ts)) lines.push(`<b>${formatDateTime(ts)}</b>`);

  const session = Number.isFinite(ts) ? sessionAt(ts, data.sessions, nowMs) : null;
  if (session !== null) {
    lines.push('', '<b>Charging session</b>');
    lines.push(`Start: ${formatDateTime(session.plugTsMs)}`);
    lines.push(`End: ${sessionEndLabel(session, nowMs)}`);
    lines.push(
      `Vehicle: ${socSpan(session.evSocStartPercent, session.evSocEndPercent, session.open)}`
    );
    lines.push(
      `Home battery: ${socSpan(session.batterySocStartPercent, session.batterySocEndPercent, session.open)}`
    );
  }

  for (const param of params) {
    const value = paramValue(param);
    if (param.seriesName && value !== null) {
      lines.push(`${param.seriesName}: ${Math.round(value * 10) / 10}%`);
    }
  }
  return lines.join('<br/>');
}

/**
 * The full chart option: dual BSoC lines over one time axis, legend below,
 * inside dataZoom clamped to 2 h–1 yr, and session markers (faint start/end
 * lines + tinted band) for every session overlapping the loaded window.
 */
export function buildBsocOption(
  data: BsocData,
  visible: TimeWindow,
  nowMs: number
): EChartsCoreOption {
  const pct = windowToPercent(visible, data.bounds);
  const sessions = sessionsInWindow(data.sessions, data.bounds, nowMs);
  const markLineData = sessions.flatMap((s) => {
    const marks = [{ xAxis: s.plugTsMs }];
    // An open session has no end yet — start line + band to now only.
    if (s.unplugTsMs !== null) marks.push({ xAxis: s.unplugTsMs });
    return marks;
  });
  const markAreaData = sessions.map((s) => [
    { xAxis: s.plugTsMs },
    { xAxis: s.unplugTsMs ?? nowMs },
  ]);

  const option: EChartsCoreOption = {
    animation: false,
    color: [EV_COLOR, HOME_COLOR],
    grid: { left: 8, right: 16, top: 16, bottom: 44, containLabel: true },
    legend: { bottom: 0, data: [EV_SERIES_NAME, HOME_SERIES_NAME], icon: 'line' },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'line', snap: true },
      formatter: (params: unknown) =>
        formatBsocTooltip(params as TooltipParamLike[], data, nowMs),
    },
    xAxis: { type: 'time', min: data.bounds.from, max: data.bounds.to },
    yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
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
        connectNulls: false,
        lineStyle: { width: 2 },
        data: data.ev.points,
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
        // Marker carrier: no data, not in the legend (legend.data is fixed).
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
