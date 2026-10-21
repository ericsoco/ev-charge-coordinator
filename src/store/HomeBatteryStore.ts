/**
 * Home battery time series: instantaneous samples + day-so-far counters.
 *
 * The two tables are written on the same sampler tick (the daemon wraps both
 * inserts in one transaction); they are split because they are different
 * measurement classes — instantaneous readings vs cumulative gateway
 * counters. Session energy = last − first counter row across the session.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  HOME_SITE,
  type HomeBatterySampleRow,
  type HomeEnergyCountersRow,
  type NewHomeBatterySample,
  type NewHomeEnergyCounters,
  type SiteId,
} from './types.js';

/**
 * Aliased to camelCase so the driver output *is* the row shape — no Raw*
 * mirror interfaces, no per-row mappers. The schema-pin test pins these
 * alias lists to the DDL and the types.ts interfaces.
 */
const SAMPLE_COLUMNS = [
  'id',
  'site_id AS siteId',
  'home_battery_id AS homeBatteryId',
  'ts_ms AS tsMs',
  'soc_percent AS socPercent',
  'soc_kwh AS socKwh',
  'power_w AS powerW',
  'home_load_w AS homeLoadW',
  'solar_w AS solarW',
  'grid_w AS gridW',
].join(', ');

const COUNTER_COLUMNS = [
  'id',
  'site_id AS siteId',
  'home_battery_id AS homeBatteryId',
  'ts_ms AS tsMs',
  'battery_charge_kwh AS batteryChargeKwh',
  'battery_discharge_kwh AS batteryDischargeKwh',
  'grid_import_kwh AS gridImportKwh',
  'grid_export_kwh AS gridExportKwh',
  'solar_kwh AS solarKwh',
  'home_use_kwh AS homeUseKwh',
].join(', ');

/** Insert one instantaneous reading; returns the row id. */
export function insertSample(
  db: DatabaseSync,
  sample: NewHomeBatterySample,
  siteId: SiteId = HOME_SITE
): number {
  const result = db
    .prepare(
      `INSERT INTO home_battery_samples
         (site_id, home_battery_id, ts_ms, soc_percent, soc_kwh,
          power_w, home_load_w, solar_w, grid_w)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      siteId,
      sample.homeBatteryId,
      sample.tsMs,
      sample.socPercent ?? null,
      sample.socKwh ?? null,
      sample.powerW ?? null,
      sample.homeLoadW ?? null,
      sample.solarW ?? null,
      sample.gridW ?? null
    );
  return Number(result.lastInsertRowid);
}

/** Insert one day-so-far counter snapshot; returns the row id. */
export function insertCounters(
  db: DatabaseSync,
  counters: NewHomeEnergyCounters,
  siteId: SiteId = HOME_SITE
): number {
  const result = db
    .prepare(
      `INSERT INTO home_energy_counters
         (site_id, home_battery_id, ts_ms, battery_charge_kwh, battery_discharge_kwh,
          grid_import_kwh, grid_export_kwh, solar_kwh, home_use_kwh)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      siteId,
      counters.homeBatteryId,
      counters.tsMs,
      counters.batteryChargeKwh ?? null,
      counters.batteryDischargeKwh ?? null,
      counters.gridImportKwh ?? null,
      counters.gridExportKwh ?? null,
      counters.solarKwh ?? null,
      counters.homeUseKwh ?? null
    );
  return Number(result.lastInsertRowid);
}

/** Newest sample for the site, or null when nothing is recorded yet. */
export function latestSample(
  db: DatabaseSync,
  siteId: SiteId = HOME_SITE
): HomeBatterySampleRow | null {
  const row = db
    .prepare(
      `SELECT ${SAMPLE_COLUMNS} FROM home_battery_samples
        WHERE site_id = ? ORDER BY ts_ms DESC, id DESC LIMIT 1`
    )
    .get(siteId) as HomeBatterySampleRow | null | undefined;
  return row ?? null;
}

/** Newest counter snapshot for the site, or null. */
export function latestCounters(
  db: DatabaseSync,
  siteId: SiteId = HOME_SITE
): HomeEnergyCountersRow | null {
  const row = db
    .prepare(
      `SELECT ${COUNTER_COLUMNS} FROM home_energy_counters
        WHERE site_id = ? ORDER BY ts_ms DESC, id DESC LIMIT 1`
    )
    .get(siteId) as HomeEnergyCountersRow | null | undefined;
  return row ?? null;
}

/**
 * Delete raw rows older than the retention window from both tables
 * (sessions/events/decisions are never pruned). Returns rows deleted.
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
  const samples = db
    .prepare('DELETE FROM home_battery_samples WHERE site_id = ? AND ts_ms < ?')
    .run(siteId, cutoff);
  const counters = db
    .prepare('DELETE FROM home_energy_counters WHERE site_id = ? AND ts_ms < ?')
    .run(siteId, cutoff);
  return Number(samples.changes) + Number(counters.changes);
}

/**
 * Counter snapshots within [fromMs, toMs], oldest first — feeds the session
 * house-energy aggregation (which tolerates a midnight reset inside the
 * range; see daemon/sessionAggregates).
 */
export function countersInRange(
  db: DatabaseSync,
  fromMs: number,
  toMs: number,
  siteId: SiteId = HOME_SITE
): HomeEnergyCountersRow[] {
  const rows = db
    .prepare(
      `SELECT ${COUNTER_COLUMNS} FROM home_energy_counters
        WHERE site_id = ? AND ts_ms >= ? AND ts_ms <= ?
        ORDER BY ts_ms, id`
    )
    .all(siteId, fromMs, toMs) as unknown as HomeEnergyCountersRow[];
  return rows;
}
