/**
 * Tesla schedule wire-mapping (tesla/schedule.ts): legacy charge_state fields,
 * modern blocks, and the defensive skip-unknown contract — a misread must
 * degrade to "no windows", never invent one.
 */
import { describe, expect, it } from 'vitest';
import { mapChargingScheduleSnapshot } from '../../src/services/tesla/schedule.js';
import { DEPARTURE_LOOKBACK_MIN } from '../../src/utils/schedule.js';

describe('mapChargingScheduleSnapshot', () => {
  it('maps the legacy scheduled_charging fields (minutes and epoch)', () => {
    const fromMinutes = mapChargingScheduleSnapshot({
      charge_state: { scheduled_charging_pending: true, scheduled_charging_start_time: 1380 },
    });
    expect(fromMinutes.windows).toEqual([
      { kind: 'charging', daysOfWeek: null, startMinute: 1380, endMinute: null, enabled: true },
    ]);

    // Epoch seconds for 23:00 local — the mapper reads the local clock.
    const at = new Date();
    at.setHours(23, 0, 0, 0);
    const fromEpoch = mapChargingScheduleSnapshot({
      charge_state: {
        scheduled_charging_pending: false,
        scheduled_charging_start_time: Math.floor(at.getTime() / 1000),
      },
    });
    expect(fromEpoch.windows[0]).toMatchObject({ kind: 'charging', startMinute: 23 * 60, enabled: false });
  });

  it('maps the legacy scheduled_departure fields into a lookback window', () => {
    const snap = mapChargingScheduleSnapshot({
      charge_state: { scheduled_departure_pending: true, scheduled_departure_time: 360 },
    });
    expect(snap.windows).toEqual([
      {
        kind: 'departure',
        daysOfWeek: null,
        startMinute: (360 - DEPARTURE_LOOKBACK_MIN + 1440) % 1440,
        endMinute: 360,
        enabled: true,
      },
    ]);
  });

  it('maps modern charge_schedule_data entries (snake_case, days as list)', () => {
    const snap = mapChargingScheduleSnapshot({
      charge_schedule_data: {
        charging: [
          { days_of_week: [1, 2, 3, 4, 5], start_time: 1380, end_time: 360, enabled: true },
          { days_of_week: [6, 0], start_time: 600, end_time: 900, enabled: false },
        ],
      },
    });
    expect(snap.windows).toEqual([
      {
        kind: 'charging',
        daysOfWeek: [1, 2, 3, 4, 5],
        startMinute: 1380,
        endMinute: 360,
        enabled: true,
      },
      {
        kind: 'charging',
        daysOfWeek: [6, 0],
        startMinute: 600,
        endMinute: 900,
        enabled: false,
      },
    ]);
  });

  it('maps days given as a 7-bit mask (bit 0 = Sunday)', () => {
    const snap = mapChargingScheduleSnapshot({
      charge_schedule_data: {
        charging: [{ daysOfWeek: 0b0111110, startTime: 1200, endTime: 300 }],
      },
    });
    expect(snap.windows[0].daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it('maps preconditioning (departure) entries', () => {
    const snap = mapChargingScheduleSnapshot({
      preconditioning_schedule_data: {
        preconditioning: [{ days_of_week: [1], departure_time: 360, enabled: true }],
      },
    });
    expect(snap.windows[0]).toMatchObject({ kind: 'departure', endMinute: 360, enabled: true });
    expect(snap.windows[0].startMinute).toBe((360 - DEPARTURE_LOOKBACK_MIN + 1440) % 1440);
  });

  it('skips unrecognized shapes instead of inventing windows', () => {
    const snap = mapChargingScheduleSnapshot({
      charge_schedule_data: { charging: [{ foo: 'bar' }, 42, null, { start_time: 'late' }] },
      preconditioning_schedule_data: 'nonsense',
      charge_state: { scheduled_charging_start_time: 'nonsense' },
    });
    expect(snap.windows).toEqual([]);
  });

  it('returns no windows when nothing is configured', () => {
    expect(mapChargingScheduleSnapshot({})).toEqual({ windows: [] });
    expect(
      mapChargingScheduleSnapshot({ charge_state: { scheduled_charging_pending: false } })
    ).toEqual({ windows: [] });
  });
});
