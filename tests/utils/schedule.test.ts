/**
 * Pure schedule-window math (utils/schedule.ts): activation incl. midnight
 * wrap and start-day semantics, the plug-in lead test, the activation test
 * for hand-over, and the handOverAt fallback.
 */
import { describe, expect, it } from 'vitest';
import type { ChargingScheduleSnapshot, ChargingScheduleWindow } from '../../src/types/ev.js';
import {
  findActivatedChargingWindow,
  findActiveWindow,
  findStartingWindow,
  handOverReached,
  isWindowActiveAt,
} from '../../src/utils/schedule.js';

function window(overrides: Partial<ChargingScheduleWindow> = {}): ChargingScheduleWindow {
  return {
    kind: 'charging',
    daysOfWeek: null,
    startMinute: 22 * 60,
    endMinute: 6 * 60,
    enabled: true,
    ...overrides,
  };
}

function snapshot(...windows: ChargingScheduleWindow[]): ChargingScheduleSnapshot {
  return { windows };
}

const MIN = 60_000;

describe('isWindowActiveAt', () => {
  it('honors the [start, end) interval incl. midnight wrap', () => {
    const w = window(); // 22:00 → 06:00
    const at = (h: number, m: number) => new Date(2026, 10, 16, h, m).getTime();
    expect(isWindowActiveAt(w, new Date(at(21, 59)))).toBe(false);
    expect(isWindowActiveAt(w, new Date(at(22, 0)))).toBe(true);
    expect(isWindowActiveAt(w, new Date(at(2, 0)))).toBe(true); // wrapped
    expect(isWindowActiveAt(w, new Date(at(5, 59)))).toBe(true);
    expect(isWindowActiveAt(w, new Date(at(6, 0)))).toBe(false);
  });

  it('keys the wrapped early segment to the PREVIOUS day', () => {
    const at = new Date(2026, 10, 16, 2, 0); // 02:00
    const day = at.getDay();
    const yesterday = (day + 6) % 7;
    expect(isWindowActiveAt(window({ daysOfWeek: [yesterday] }), at)).toBe(true);
    expect(isWindowActiveAt(window({ daysOfWeek: [day] }), at)).toBe(false);
    // The late segment keys to the day itself.
    const late = new Date(2026, 10, 16, 23, 0);
    expect(isWindowActiveAt(window({ daysOfWeek: [late.getDay()] }), late)).toBe(true);
    expect(isWindowActiveAt(window({ daysOfWeek: [(late.getDay() + 6) % 7] }), late)).toBe(false);
  });

  it('skips disabled windows and treats endMinute null as open-ended', () => {
    const at = new Date(2026, 10, 16, 12, 0);
    expect(isWindowActiveAt(window({ enabled: false }), at)).toBe(false);
    expect(
      isWindowActiveAt(window({ startMinute: 8 * 60, endMinute: null }), at)
    ).toBe(true);
  });
});

describe('findActiveWindow / findStartingWindow', () => {
  it('finds the active window (any kind, incl. departure)', () => {
    const at = new Date(2026, 10, 16, 23, 0).getTime();
    const departure = window({ kind: 'departure', startMinute: 12 * 60, endMinute: 6 * 60 });
    expect(findActiveWindow(snapshot(departure), at)).toBe(departure);
    expect(findActiveWindow(snapshot(window({ enabled: false })), at)).toBeNull();
  });

  it('findStartingWindow: active now or beginning within the lead', () => {
    const now = new Date(2026, 10, 16, 21, 50).getTime(); // 10 min before 22:00
    const w = window();
    expect(findStartingWindow(snapshot(w), now, 15 * MIN)).toBe(w);
    expect(findStartingWindow(snapshot(w), now, 5 * MIN)).toBeNull();
    // Active also counts.
    const nowActive = now + 20 * MIN;
    expect(findStartingWindow(snapshot(w), nowActive, 0)).toBe(w);
  });

  it('findStartingWindow ignores departure and disabled windows', () => {
    const now = new Date(2026, 10, 16, 21, 55).getTime();
    expect(
      findStartingWindow(snapshot(window({ kind: 'departure' })), now, 30 * MIN)
    ).toBeNull();
    expect(findStartingWindow(snapshot(window({ enabled: false })), now, 30 * MIN)).toBeNull();
  });

  it('findStartingWindow respects the window day', () => {
    const now = new Date(2026, 10, 16, 21, 50);
    const onDay = window({ daysOfWeek: [now.getDay()] });
    const offDay = window({ daysOfWeek: [(now.getDay() + 1) % 7] });
    expect(findStartingWindow(snapshot(onDay), now.getTime(), 15 * MIN)).toBe(onDay);
    expect(findStartingWindow(snapshot(offDay), now.getTime(), 15 * MIN)).toBeNull();
  });
});

describe('findActivatedChargingWindow / handOverReached', () => {
  it('detects a start-at window that began inside the interval', () => {
    const w = window(); // start 22:00
    const before = new Date(2026, 10, 16, 21, 59).getTime();
    const after = new Date(2026, 10, 16, 22, 1).getTime();
    expect(findActivatedChargingWindow(snapshot(w), before, after)).toBe(w);
    expect(findActivatedChargingWindow(snapshot(w), before - 30 * MIN, before)).toBeNull();
    // Departure windows never trigger activation hand-over.
    expect(
      findActivatedChargingWindow(snapshot(window({ kind: 'departure' })), before, after)
    ).toBeNull();
  });

  it('detects a wrap-crossing activation (start 23:30, interval 23:29→23:31)', () => {
    const w = window({ startMinute: 23 * 60 + 30, endMinute: 5 * 60 });
    const from = new Date(2026, 10, 16, 23, 29).getTime();
    const to = new Date(2026, 10, 16, 23, 31).getTime();
    expect(findActivatedChargingWindow(snapshot(w), from, to)).toBe(w);
  });

  it('handOverReached fires once per day, including across midnight', () => {
    const from = new Date(2026, 10, 16, 22, 29).getTime();
    const to = new Date(2026, 10, 16, 22, 31).getTime();
    expect(handOverReached('22:30', from, to)).toBe(true);
    expect(handOverReached('22:45', from, to)).toBe(false);
    const midnightFrom = new Date(2026, 10, 16, 23, 59).getTime();
    const midnightTo = new Date(2026, 10, 17, 0, 1).getTime();
    expect(handOverReached('00:00', midnightFrom, midnightTo)).toBe(true);
    expect(handOverReached('nonsense', from, to)).toBe(false);
  });
});
