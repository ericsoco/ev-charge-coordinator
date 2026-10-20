/**
 * EV time series (ev_samples) — one row per poll while the car is awake.
 *
 * raw coordinates never land here: `at_home` is 1/0/NULL, evaluated at poll
 * time by the P1b geofence against the secret home location.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  HOME_SITE,
  type EvSampleRow,
  type NewEvSample,
  type SiteId,
} from './types.js';

interface RawEvSample {
  id: number;
  site_id: string;
  vehicle_id: string;
  ts_ms: number;
  state: string | null;
  charging_state: string | null;
  soc_percent: number | null;
  charge_limit_soc: number | null;
  charge_rate_kw: number | null;
  minutes_to_full: number | null;
  charge_energy_added_kwh: number | null;
  at_home: number | null;
}

const COLUMNS =
  'id, site_id, vehicle_id, ts_ms, state, charging_state, soc_percent, ' +
  'charge_limit_soc, charge_rate_kw, minutes_to_full, charge_energy_added_kwh, at_home';

function map(row: RawEvSample): EvSampleRow {
  return {
    id: Number(row.id),
    siteId: row.site_id as SiteId,
    vehicleId: row.vehicle_id,
    tsMs: Number(row.ts_ms),
    state: row.state,
    chargingState: row.charging_state,
    socPercent: row.soc_percent,
    chargeLimitSoc: row.charge_limit_soc,
    chargeRateKw: row.charge_rate_kw,
    minutesToFull: row.minutes_to_full,
    chargeEnergyAddedKwh: row.charge_energy_added_kwh,
    atHome: row.at_home,
  };
}

/** Insert one EV reading; returns the row id. */
export function insertSample(
  db: DatabaseSync,
  sample: NewEvSample,
  siteId: SiteId = HOME_SITE
): number {
  const result = db
    .prepare(
      `INSERT INTO ev_samples
         (site_id, vehicle_id, ts_ms, state, charging_state, soc_percent,
          charge_limit_soc, charge_rate_kw, minutes_to_full,
          charge_energy_added_kwh, at_home)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      siteId,
      sample.vehicleId,
      sample.tsMs,
      sample.state ?? null,
      sample.chargingState ?? null,
      sample.socPercent ?? null,
      sample.chargeLimitSoc ?? null,
      sample.chargeRateKw ?? null,
      sample.minutesToFull ?? null,
      sample.chargeEnergyAddedKwh ?? null,
      sample.atHome ?? null
    );
  return Number(result.lastInsertRowid);
}

/** Newest sample for a vehicle, or null (also the state-reconstruction read). */
export function latestSample(
  db: DatabaseSync,
  vehicleId: string,
  siteId: SiteId = HOME_SITE
): EvSampleRow | null {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM ev_samples
        WHERE site_id = ? AND vehicle_id = ?
        ORDER BY ts_ms DESC, id DESC LIMIT 1`
    )
    .get(siteId, vehicleId) as RawEvSample | null | undefined;
  return row ? map(row) : null;
}

/**
 * Delete raw rows older than the retention window. Returns rows deleted.
 * (Both raw-sample tables share the retention policy; HomeBatteryStore.prune
 * covers the battery side.)
 */
export function prune(
  db: DatabaseSync,
  retentionDays: number,
  nowMs: number,
  siteId: SiteId = HOME_SITE
): number {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(`retentionDays must be >= 0 (got ${retentionDays})`);
  }
  const cutoff = nowMs - retentionDays * 86_400_000;
  const result = db
    .prepare('DELETE FROM ev_samples WHERE site_id = ? AND ts_ms < ?')
    .run(siteId, cutoff);
  return Number(result.changes);
}
