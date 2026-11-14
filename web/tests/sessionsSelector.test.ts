import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/api/types';
import { MIN_SPAN_MS, type TimeWindow } from '../src/pages/bsocChart';
import {
  easeInOutCubic,
  easedWindow,
  formatLocalDateTime,
  formatSessionEnd,
  formatStopReason,
  LIST_END_THRESHOLD_PX,
  mergeSessions,
  nearListEnd,
  sessionFocusWindow,
  sessionOptionLabel,
  sessionReadout,
  startTransition,
  type TransitionClock,
} from '../src/pages/sessionsSelector';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 10, 0, 0, 0);
const DOMAIN: TimeWindow = { from: T0, to: T0 + 365 * 24 * HOUR };
// Local-time construction (matches the API label) keeps time-label
// expectations timezone-independent across dev machines and CI.
const PLUG = new Date(2026, 10, 10, 14, 3).getTime();
const UNPLUG = new Date(2026, 10, 10, 17, 0).getTime();

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    label: '2026-11-10 14:03',
    plugTsMs: PLUG,
    unplugTsMs: UNPLUG,
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

describe('sessionOptionLabel', () => {
  it('uses the API label for a closed session', () => {
    expect(sessionOptionLabel(session())).toBe('2026-11-10 14:03');
  });

  it('marks open sessions with the 🔄 icon (decision D2)', () => {
    expect(sessionOptionLabel(session({ open: true, unplugTsMs: null }))).toBe(
      '2026-11-10 14:03 🔄'
    );
  });
});

describe('date formatting', () => {
  // Local-time construction keeps expectations timezone-independent.
  const ts = new Date(2026, 10, 12, 16, 51).getTime();

  it('formatLocalDateTime matches the API label format', () => {
    expect(formatLocalDateTime(ts)).toBe('2026-11-12 16:51');
  });

  it('formatSessionEnd shortens a same-day end to HH:MM', () => {
    const plug = new Date(2026, 10, 12, 16, 51).getTime();
    const unplug = new Date(2026, 10, 12, 18, 1).getTime();
    expect(formatSessionEnd(plug, unplug)).toBe('18:01');
  });

  it('formatSessionEnd keeps full date+time for a cross-day end', () => {
    const plug = new Date(2026, 10, 10, 19, 27).getTime();
    const unplug = new Date(2026, 10, 11, 16, 54).getTime();
    expect(formatSessionEnd(plug, unplug)).toBe('2026-11-11 16:54');
  });

  it('formatStopReason renders display copy', () => {
    expect(formatStopReason('target_reached')).toBe('target reached');
    expect(formatStopReason('battery_buffer')).toBe('battery buffer');
  });
});

describe('sessionReadout', () => {
  it('re-homes the removed tooltip content for a closed session', () => {
    const r = sessionReadout(session());
    expect(r.timeLabel).toBe('2026-11-10 14:03 → 17:00');
    expect(r.metaLabel).toBe('target 60% · stopped: target reached · 12.5 kWh');
    expect(r.evLabel).toBe('54.0% → 62.0%');
    expect(r.homeLabel).toBe('71.0% → 58.0%');
  });

  it('shows a changed target as initial → final', () => {
    const r = sessionReadout(session({ initialTargetPercent: 60, targetPercent: 62 }));
    expect(r.metaLabel).toContain('target 60 → 62%');
  });

  it('omits missing meta parts entirely', () => {
    const r = sessionReadout(
      session({ targetPercent: null, stopReason: null, energyKwh: null })
    );
    expect(r.metaLabel).toBe('');
  });

  it('open session reads → now 🔄 and falls back to live SoC values', () => {
    const r = sessionReadout(session({ open: true, unplugTsMs: null }), {
      evSoc: 36.4,
      batterySoc: 80.2,
    });
    expect(r.timeLabel).toBe('2026-11-10 14:03 → now 🔄');
    expect(r.evLabel).toBe('54.0% → 36.4%');
    expect(r.homeLabel).toBe('71.0% → 80.2%');
  });

  it('renders em-dashes for absent SoC edges', () => {
    const r = sessionReadout(
      session({ evSocStartPercent: null, evSocEndPercent: null, batterySocEndPercent: null })
    );
    expect(r.evLabel).toBe('— → —');
    expect(r.homeLabel).toBe('71.0% → —');
  });
});

describe('sessionFocusWindow', () => {
  it('pads a session by FOCUS_PAD_RATIO on each side', () => {
    const s = session({ plugTsMs: T0 + 10 * HOUR, unplugTsMs: T0 + 13 * HOUR });
    const win = sessionFocusWindow(s, T0 + 20 * HOUR, DOMAIN);
    expect(win.from).toBe(T0 + 10 * HOUR - 0.3 * HOUR);
    expect(win.to).toBe(T0 + 13 * HOUR + 0.3 * HOUR);
  });

  it('floors tiny sessions at MIN_SPAN_MS centered on the session', () => {
    const s = session({ plugTsMs: T0 + 10 * HOUR, unplugTsMs: T0 + 10 * HOUR + 10 * MINUTE });
    const win = sessionFocusWindow(s, T0 + 20 * HOUR, DOMAIN);
    const mid = T0 + 10 * HOUR + 5 * MINUTE;
    expect(win.to - win.from).toBe(MIN_SPAN_MS);
    expect(win.from).toBe(mid - MIN_SPAN_MS / 2);
    expect(win.to).toBe(mid + MIN_SPAN_MS / 2);
  });

  it('runs an open session to now', () => {
    const nowMs = T0 + 20 * HOUR;
    const s = session({ plugTsMs: T0 + 18 * HOUR, unplugTsMs: null, open: true });
    const win = sessionFocusWindow(s, nowMs, DOMAIN);
    expect(win.to).toBe(nowMs + 0.2 * HOUR);
    expect(win.from).toBe(T0 + 18 * HOUR - 0.2 * HOUR);
  });

  it('clamps into the domain at the recent edge', () => {
    const s = session({
      plugTsMs: DOMAIN.to - 30 * MINUTE,
      unplugTsMs: null,
      open: true,
    });
    const win = sessionFocusWindow(s, DOMAIN.to, DOMAIN);
    expect(win.to).toBe(DOMAIN.to);
    expect(win.to - win.from).toBe(MIN_SPAN_MS);
  });
});

describe('easeInOutCubic / easedWindow', () => {
  it('pins the easing endpoints and midpoint', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it('eases slowly at both ends (in-out)', () => {
    expect(easeInOutCubic(0.25)).toBeLessThan(0.25);
    expect(easeInOutCubic(0.75)).toBeGreaterThan(0.75);
  });

  it('clamps progress outside [0, 1]', () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });

  it('easedWindow interpolates both endpoints monotonically', () => {
    const from = { from: 0, to: 1000 };
    const to = { from: 8000, to: 12_000 };
    expect(easedWindow(from, to, 0)).toEqual(from);
    expect(easedWindow(from, to, 1)).toEqual(to);
    expect(easedWindow(from, to, 0.5)).toEqual({ from: 4000, to: 6500 });
    let prev = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const w = easedWindow(from, to, t);
      expect(w.from).toBeGreaterThanOrEqual(prev);
      prev = w.from;
    }
  });
});

/** Deterministic TransitionClock: time only moves when the test ticks it. */
function fakeClock(reducedMotion = false) {
  let time = 0;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const clock: TransitionClock & {
    tick(ms: number): void;
    pendingFrames(): number;
  } = {
    now: () => time,
    requestFrame(callback) {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      frames.delete(handle);
    },
    reducedMotion: () => reducedMotion,
    tick(ms) {
      time += ms;
      // Run the callbacks scheduled for this frame (each may schedule the next).
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
    pendingFrames: () => frames.size,
  };
  return clock;
}

describe('startTransition', () => {
  const from = { from: 0, to: 1000 };
  const to = { from: 8000, to: 12_000 };

  it('applies eased windows per frame and lands exactly on the target', () => {
    const clock = fakeClock();
    const applied: TimeWindow[] = [];
    startTransition(clock, from, to, (win) => applied.push(win), 1000);
    clock.tick(0); // first frame fires at t = 0
    for (let i = 0; i < 5; i++) clock.tick(100);
    clock.tick(500); // t = 1.0
    expect(applied[0]).toEqual(from);
    expect(applied[applied.length - 1]).toEqual(to);
    expect(applied.length).toBe(7); // t = 0, 0.1 … 0.5, finish frame at 1.0
    expect(clock.pendingFrames()).toBe(0);
  });

  it('cancel stops the transition mid-flight', () => {
    const clock = fakeClock();
    const applied: TimeWindow[] = [];
    const cancel = startTransition(clock, from, to, (win) => applied.push(win), 1000);
    clock.tick(200);
    const before = applied.length;
    cancel();
    clock.tick(10_000);
    expect(applied.length).toBe(before);
    expect(clock.pendingFrames()).toBe(0);
  });

  it('reduced motion jumps straight to the target', () => {
    const clock = fakeClock(true);
    const applied: TimeWindow[] = [];
    startTransition(clock, from, to, (win) => applied.push(win), 1000);
    expect(applied).toEqual([to]);
    expect(clock.pendingFrames()).toBe(0);
  });

  it('a zero duration jumps straight to the target', () => {
    const clock = fakeClock();
    const applied: TimeWindow[] = [];
    startTransition(clock, from, to, (win) => applied.push(win), 0);
    expect(applied).toEqual([to]);
    expect(clock.pendingFrames()).toBe(0);
  });
});

describe('mergeSessions', () => {
  it('dedupes by id with the incoming row winning and sorts newest first', () => {
    const older = session({ id: 1, plugTsMs: T0 + 1 * HOUR });
    const newer = session({ id: 2, plugTsMs: T0 + 5 * HOUR });
    const fresher = session({ id: 1, plugTsMs: T0 + 1 * HOUR, open: true, unplugTsMs: null });
    const merged = mergeSessions([older, newer], [fresher]);
    expect(merged.map((s) => s.id)).toEqual([2, 1]);
    expect(merged[1].open).toBe(true);
  });

  it('unions disjoint pages and tie-breaks equal plug times by id', () => {
    const a = session({ id: 3, plugTsMs: T0 + 2 * HOUR });
    const b = session({ id: 7, plugTsMs: T0 + 2 * HOUR });
    const c = session({ id: 5, plugTsMs: T0 + 9 * HOUR });
    const merged = mergeSessions([a], [b, c]);
    expect(merged.map((s) => s.id)).toEqual([5, 7, 3]);
  });
});

describe('nearListEnd', () => {
  it('is true within the threshold of the scroll end', () => {
    expect(nearListEnd(900, 100, 1000)).toBe(true);
    expect(nearListEnd(900 - LIST_END_THRESHOLD_PX, 100, 1000)).toBe(true);
    expect(nearListEnd(500, 100, 1000)).toBe(false);
  });

  it('ignores zero-sized boxes (closed menus never page)', () => {
    expect(nearListEnd(0, 0, 0)).toBe(false);
    expect(nearListEnd(100, 0, 1000)).toBe(false);
  });
});
