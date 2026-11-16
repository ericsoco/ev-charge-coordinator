/**
 * Pure window math over a normalized ChargingScheduleSnapshot — the OEM-free
 * policy core behind ownership attribution, the prioritize-scheduled-charging
 * decision decline, and the mid-session hand-over. No I/O; the daemon passes
 * `nowMs` (vehicle-local wall clock is assumed to equal the daemon host's).
 */
import type {
  ChargingScheduleSnapshot,
  ChargingScheduleWindow,
} from '../types/ev.js';

const MINUTES_PER_DAY = 24 * 60;

/**
 * A departure ("charge by T") schedule may start charging hours before its
 * departure time; attribute starts inside this lookback window to
 * 'scheduled'. 12 h generously bounds a full charge.
 */
export const DEPARTURE_LOOKBACK_MIN = 12 * 60;

/**
 * A window's minutes-of-day interval, honoring midnight wrap: a window with
 * `endMinute <= startMinute` spans [start, 1440) ∪ [0, end). `endMinute`
 * null = [start, 1440).
 */
function activeInWindow(minuteOfDay: number, startMinute: number, endMinute: number | null): boolean {
  const end = endMinute ?? MINUTES_PER_DAY;
  if (end > startMinute) return minuteOfDay >= startMinute && minuteOfDay < end;
  return minuteOfDay >= startMinute || minuteOfDay < end;
}

/**
 * Whether the window is active at `at`. Wrapped windows key their early-
 * morning segment to the PREVIOUS day's schedule day (Mon–Fri 22:00→06:00
 * includes Saturday 02:00 but not Sunday 02:00).
 */
export function isWindowActiveAt(window: ChargingScheduleWindow, at: Date): boolean {
  if (!window.enabled) return false;
  const minuteOfDay = at.getHours() * 60 + at.getMinutes();
  const day = at.getDay();
  if (window.daysOfWeek === null) return activeInWindow(minuteOfDay, window.startMinute, window.endMinute);

  const end = window.endMinute ?? MINUTES_PER_DAY;
  if (end > window.startMinute) {
    return (
      activeInWindow(minuteOfDay, window.startMinute, window.endMinute) &&
      window.daysOfWeek.includes(day)
    );
  }
  // Wrapped: the late segment belongs to `day`, the early one to yesterday.
  if (minuteOfDay >= window.startMinute) return window.daysOfWeek.includes(day);
  return window.daysOfWeek.includes((day + 6) % 7);
}

/** The first window active at `nowMs`, or null. */
export function findActiveWindow(
  snapshot: ChargingScheduleSnapshot,
  nowMs: number
): ChargingScheduleWindow | null {
  const at = new Date(nowMs);
  return snapshot.windows.find((window) => isWindowActiveAt(window, at)) ?? null;
}

/**
 * A start-at ('charging') window that is active now or begins within
 * `leadMs` — the "don't start a session that is about to be superseded"
 * test for the plug-in decision. Departure schedules never decline: EVCC
 * charging first and handing over still completes the scheduled charge.
 */
export function findStartingWindow(
  snapshot: ChargingScheduleSnapshot,
  nowMs: number,
  leadMs: number
): ChargingScheduleWindow | null {
  const at = new Date(nowMs);
  for (const window of snapshot.windows) {
    if (window.kind !== 'charging' || !window.enabled) continue;
    if (isWindowActiveAt(window, at)) return window;
    // Candidate start: today's startMinute, else tomorrow's — whichever
    // lands in (now, now + lead] on a day the window belongs to.
    for (const dayOffset of [0, 1]) {
      const start = new Date(nowMs);
      start.setDate(start.getDate() + dayOffset);
      start.setHours(Math.floor(window.startMinute / 60), window.startMinute % 60, 0, 0);
      const startMs = start.getTime();
      if (startMs > nowMs && startMs <= nowMs + leadMs) {
        if (window.daysOfWeek === null || window.daysOfWeek.includes(start.getDay())) {
          return window;
        }
      }
    }
  }
  return null;
}

/**
 * A start-at ('charging') window whose start fell in (fromMs, toMs] — the
 * "the schedule just activated" test for the mid-session hand-over.
 */
export function findActivatedChargingWindow(
  snapshot: ChargingScheduleSnapshot,
  fromMs: number,
  toMs: number
): ChargingScheduleWindow | null {
  for (const window of snapshot.windows) {
    if (window.kind !== 'charging' || !window.enabled) continue;
    for (const dayOffset of [0, -1]) {
      const start = new Date(toMs);
      start.setDate(start.getDate() + dayOffset);
      start.setHours(Math.floor(window.startMinute / 60), window.startMinute % 60, 0, 0);
      const startMs = start.getTime();
      if (startMs > fromMs && startMs <= toMs) {
        if (window.daysOfWeek === null || window.daysOfWeek.includes(start.getDay())) {
          return window;
        }
      }
    }
  }
  return null;
}

/**
 * Whether the daily `handOverAt` ("HH:MM", local) occurrence falls in
 * (fromMs, toMs] — the OEM-agnostic hand-over fallback for OEMs whose
 * schedules cannot be introspected.
 */
export function handOverReached(handOverAt: string, fromMs: number, toMs: number): boolean {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(handOverAt);
  if (match === null) return false;
  const minuteOfDay = Number(match[1]) * 60 + Number(match[2]);
  for (const dayOffset of [0, -1]) {
    const at = new Date(toMs);
    at.setDate(at.getDate() + dayOffset);
    at.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
    const atMs = at.getTime();
    if (atMs > fromMs && atMs <= toMs) return true;
  }
  return false;
}
