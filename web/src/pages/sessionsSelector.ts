/**
 * Pure logic for the Then tab's sessions selector (requirements 2026.Nov.07
 * §2b "Sessions history selector"): selector labels, the selected-session
 * readout (re-homes the removed hover-tooltip content), the focus window a
 * selection zooms to, the 1 s eased transition, session-catalog merging for
 * lazy pagination, and the menu-scroll "load more" rule. No DOM/ECharts
 * runtime here (only type + pure-module imports) — everything is unit-tested
 * in web/tests/sessionsSelector.test.ts.
 */
import { clampWindow, formatBsocValue, MIN_SPAN_MS, type TimeWindow } from './bsocChart';
import type { SessionSummary } from '../../../src/api/types';

/** Focus window padding on each side of the session span (decision D3). */
export const FOCUS_PAD_RATIO = 0.1;
/** Focus transition duration (requirements 2b: "over a one-second eased transition"). */
export const FOCUS_DURATION_MS = 1000;
/** Distance from the menu's scroll end that triggers loading the next page. */
export const LIST_END_THRESHOLD_PX = 48;
/** Marker on open sessions' labels (decision D2). */
export const OPEN_MARKER = '🔄';

/** Selector option label: start date+time, `🔄` appended while the session is open. */
export function sessionOptionLabel(session: SessionSummary): string {
  return session.open ? `${session.label} ${OPEN_MARKER}` : session.label;
}

/** Local `YYYY-MM-DD HH:MM` — matches the API's session `label` format. */
export function formatLocalDateTime(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Session end label: `HH:MM` when the session ends on its start day (short
 * reads well on mobile), full `YYYY-MM-DD HH:MM` otherwise.
 */
export function formatSessionEnd(plugTsMs: number, unplugTsMs: number): string {
  const start = new Date(plugTsMs);
  const end = new Date(unplugTsMs);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  return sameDay
    ? `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
    : formatLocalDateTime(unplugTsMs);
}

/** `target_reached` / `battery_buffer` → display copy. */
export function formatStopReason(reason: 'target_reached' | 'battery_buffer'): string {
  return reason === 'target_reached' ? 'target reached' : 'battery buffer';
}

export interface SessionReadout {
  /** `2026-11-12 16:51 → 18:01`, open: `2026-11-12 16:51 → now 🔄`. */
  timeLabel: string;
  /** `target 60 → 62% · stopped: target reached · 6.3 kWh`; '' when nothing applies. */
  metaLabel: string;
  /** `32.0% → 42.0%` (vehicle); open end falls back to `live` when given. */
  evLabel: string;
  /** `71.3% → 65.1%` (home battery); open end falls back to `live` when given. */
  homeLabel: string;
}

/**
 * Selected-session readout content. `live` supplies the current SoC values so
 * an open session can show `start → now` instead of `start → —`.
 */
export function sessionReadout(
  session: SessionSummary,
  live?: { evSoc: number | null; batterySoc: number | null }
): SessionReadout {
  const timeLabel = `${session.label} → ${
    session.unplugTsMs === null
      ? `now ${OPEN_MARKER}`
      : formatSessionEnd(session.plugTsMs, session.unplugTsMs)
  }`;
  const meta: string[] = [];
  if (session.targetPercent !== null) {
    const initial = session.initialTargetPercent;
    meta.push(
      initial !== null && initial !== session.targetPercent
        ? `target ${initial} → ${session.targetPercent}%`
        : `target ${session.targetPercent}%`
    );
  }
  if (session.stopReason !== null) meta.push(`stopped: ${formatStopReason(session.stopReason)}`);
  if (session.energyKwh !== null) meta.push(`${session.energyKwh.toFixed(1)} kWh`);
  const evEnd = session.unplugTsMs === null ? (live?.evSoc ?? null) : session.evSocEndPercent;
  const homeEnd =
    session.unplugTsMs === null ? (live?.batterySoc ?? null) : session.batterySocEndPercent;
  return {
    timeLabel,
    metaLabel: meta.join(' · '),
    evLabel: `${formatBsocValue(session.evSocStartPercent)} → ${formatBsocValue(evEnd)}`,
    homeLabel: `${formatBsocValue(session.batterySocStartPercent)} → ${formatBsocValue(homeEnd)}`,
  };
}

/**
 * Window a selection focuses: covers plug→unplug (open → now) with
 * FOCUS_PAD_RATIO of the session span on each side, a MIN_SPAN_MS floor
 * centered on the session (tiny plug-ins stay readable), clamped into the
 * domain like every other window.
 */
export function sessionFocusWindow(
  session: SessionSummary,
  nowMs: number,
  domain: TimeWindow
): TimeWindow {
  const start = session.plugTsMs;
  const end = session.unplugTsMs ?? nowMs;
  const pad = Math.max(end - start, 0) * FOCUS_PAD_RATIO;
  let from = start - pad;
  let to = end + pad;
  if (to - from < MIN_SPAN_MS) {
    const mid = (start + end) / 2;
    from = mid - MIN_SPAN_MS / 2;
    to = mid + MIN_SPAN_MS / 2;
  }
  return clampWindow({ from, to }, domain);
}

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

/** Ease-in-out cubic over [0, 1]: 0→0, 0.5→0.5, 1→1; slow at both ends. */
export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Window at eased progress `t` between `from` and `to` (0 → from, 1 → to). */
export function easedWindow(from: TimeWindow, to: TimeWindow, t: number): TimeWindow {
  const e = easeInOutCubic(t);
  return {
    from: from.from + (to.from - from.from) * e,
    to: from.to + (to.to - from.to) * e,
  };
}

/** Time/frame seam for the eased transition — injected so tests drive it. */
export interface TransitionClock {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  reducedMotion(): boolean;
}

/**
 * Drive `apply` through easedWindow(from, to, t) once per frame for
 * `durationMs`, then stop. Returns a cancel function (user interaction
 * supersedes). Reduced motion (or a zero duration) applies the target at once.
 */
export function startTransition(
  clock: TransitionClock,
  from: TimeWindow,
  to: TimeWindow,
  apply: (win: TimeWindow) => void,
  durationMs: number = FOCUS_DURATION_MS
): () => void {
  if (clock.reducedMotion() || durationMs <= 0) {
    apply(to);
    return () => {};
  }
  let handle: number | null = null;
  let cancelled = false;
  const start = clock.now();
  const step = (): void => {
    if (cancelled) return;
    const t = clamp01((clock.now() - start) / durationMs);
    apply(easedWindow(from, to, t));
    handle = t < 1 ? clock.requestFrame(step) : null;
  };
  handle = clock.requestFrame(step);
  return () => {
    cancelled = true;
    if (handle !== null) clock.cancelFrame(handle);
    handle = null;
  };
}

/**
 * Union of two session lists keyed by id — the incoming row wins (fresher),
 * sorted newest-first like GET /api/sessions. Lets the chart-coverage fetch
 * and the selector's pagination share one catalog.
 */
export function mergeSessions(
  existing: SessionSummary[],
  incoming: SessionSummary[]
): SessionSummary[] {
  const byId = new Map<number, SessionSummary>();
  for (const s of existing) byId.set(s.id, s);
  for (const s of incoming) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => b.plugTsMs - a.plugTsMs || b.id - a.id);
}

/**
 * Whether a scrollable list is at (or within `thresholdPx` of) its end — the
 * pagination trigger. `clientHeight > 0` guards closed/hidden menus (a zero-
 * sized box can never be "scrolled to the end").
 */
export function nearListEnd(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  thresholdPx: number = LIST_END_THRESHOLD_PX
): boolean {
  return clientHeight > 0 && scrollTop + clientHeight >= scrollHeight - thresholdPx;
}
