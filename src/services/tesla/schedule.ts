/**
 * Tesla wire-format → normalized charging-schedule mapping.
 *
 * Deliberately defensive: firmware generations expose three different
 * surfaces for the same concept and the modern block shapes are not
 * documented, so anything unrecognized is SKIPPED (never invented). A
 * misread degrades to 'manual' attribution — safe under the ownership rule.
 *
 * Sources mapped:
 * - legacy charge_state: scheduled_charging_pending/start_time (start-at),
 *   scheduled_departure_pending/departure_time (charge-by);
 * - charge_schedule_data: modern start-at windows (minutes after midnight);
 * - preconditioning_schedule_data: modern departure schedules.
 */
import type {
  ChargingScheduleSnapshot,
  ChargingScheduleWindow,
} from '../../types/ev.js';
import { DEPARTURE_LOOKBACK_MIN } from '../../utils/schedule.js';

const MINUTES_PER_DAY = 24 * 60;

interface RawWindow {
  kind: 'charging' | 'departure';
  daysOfWeek: number[] | null;
  startMinute: number;
  endMinute: number | null;
  enabled: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pick(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  return undefined;
}

function asMinute(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= 0 && value < MINUTES_PER_DAY) return Math.trunc(value); // minutes after midnight
  // Epoch fallback (legacy fields): seconds or milliseconds.
  const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : null;
  if (ms === null) return null;
  const at = new Date(ms);
  return at.getHours() * 60 + at.getMinutes();
}

/** days_of_week as an array of day numbers, or a 7-bit mask (bit 0 = Sunday). */
function asDays(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const days = value.filter(
      (day): day is number => typeof day === 'number' && day >= 0 && day <= 6
    );
    return days.length > 0 ? days : null;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 127) {
    const days = [0, 1, 2, 3, 4, 5, 6].filter((day) => (value & (1 << day)) !== 0);
    return days.length > 0 ? days : null;
  }
  return null;
}

function mapEntry(value: unknown, kind: 'charging' | 'departure'): RawWindow | null {
  const record = asRecord(value);
  if (record === null) return null;
  const enabled = pick(record, 'enabled', 'active');
  const startMinute = asMinute(pick(record, 'start_time', 'startTime'));
  const departureMinute = asMinute(pick(record, 'departure_time', 'departureTime'));
  const endMinute = asMinute(pick(record, 'end_time', 'endTime'));
  const days = asDays(pick(record, 'days_of_week', 'daysOfWeek', 'days'));

  if (kind === 'charging') {
    if (startMinute === null) return null;
    return {
      kind,
      daysOfWeek: days,
      startMinute,
      endMinute,
      enabled: enabled !== false,
    };
  }
  // Departure: charge-by `departureMinute`; the car picks its start inside
  // the lookback window before it (wrapped).
  if (departureMinute === null) return null;
  return {
    kind,
    daysOfWeek: days,
    startMinute: (departureMinute - DEPARTURE_LOOKBACK_MIN + MINUTES_PER_DAY) % MINUTES_PER_DAY,
    endMinute: departureMinute,
    enabled: enabled !== false,
  };
}

function mapEntries(value: unknown, kind: 'charging' | 'departure'): RawWindow[] {
  const entries = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return entries
    .map((entry) => mapEntry(entry, kind))
    .filter((entry): entry is RawWindow => entry !== null);
}

/**
 * Map one `vehicle_data?endpoints=charge_state,charge_schedule_data,
 * preconditioning_schedule_data` response body to the normalized snapshot.
 * Exported pure for tests; unknown shapes are skipped, never guessed.
 */
export function mapChargingScheduleSnapshot(response: {
  charge_state?: unknown;
  charge_schedule_data?: unknown;
  preconditioning_schedule_data?: unknown;
}): ChargingScheduleSnapshot {
  const windows: ChargingScheduleWindow[] = [];

  const chargeState = asRecord(response.charge_state);
  if (chargeState !== null) {
    const scheduledChargingPending = pick(chargeState, 'scheduled_charging_pending') === true;
    const startMinute = asMinute(pick(chargeState, 'scheduled_charging_start_time'));
    if (startMinute !== null) {
      windows.push({
        kind: 'charging',
        daysOfWeek: null,
        startMinute,
        endMinute: null,
        enabled: scheduledChargingPending,
      });
    }
    const departurePending = pick(chargeState, 'scheduled_departure_pending') === true;
    const departureMinute = asMinute(pick(chargeState, 'scheduled_departure_time'));
    if (departureMinute !== null) {
      windows.push({
        kind: 'departure',
        daysOfWeek: null,
        startMinute: (departureMinute - DEPARTURE_LOOKBACK_MIN + MINUTES_PER_DAY) % MINUTES_PER_DAY,
        endMinute: departureMinute,
        enabled: departurePending,
      });
    }
  }

  const chargeSchedule = asRecord(response.charge_schedule_data);
  if (chargeSchedule !== null) {
    windows.push(...mapEntries(pick(chargeSchedule, 'charging', 'schedules'), 'charging'));
    windows.push(...mapEntries(pick(chargeSchedule, 'preconditioning', 'departures'), 'departure'));
  } else if (Array.isArray(response.charge_schedule_data)) {
    windows.push(...mapEntries(response.charge_schedule_data, 'charging'));
  }

  const preconditioning = asRecord(response.preconditioning_schedule_data);
  if (preconditioning !== null) {
    windows.push(
      ...mapEntries(pick(preconditioning, 'preconditioning', 'departures', 'schedules'), 'departure')
    );
  } else if (Array.isArray(response.preconditioning_schedule_data)) {
    windows.push(...mapEntries(response.preconditioning_schedule_data, 'departure'));
  }

  return { windows };
}
