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

interface RawSample {
  id: number;
  site_id: string;
  home_battery_id: string;
  ts_ms: number;
  soc_percent: number | null;
  soc_kwh: number | null;
  power_w: number | null;
  home_load_w: number | null;
  solar_w: number | null;
  grid_w: number | null;
}

interface RawCounters {
  id: number;
  site_id: string;
  home_battery_id: string;
  ts_ms: number;
  battery_charge_kwh: number | null;
  battery_discharge_kwh: number | null;
  grid_import_kwh: number | null;
  grid_export_kwh: number | null;
  solar_kwh: number | null;
  home_use_kwh: number | null;
}

const SAMPLE_COLUMNS =
  'id, site_id, home_battery_id, ts_ms, soc_percent, soc_kwh, power_w, home_load_w, solar_w, grid_w';
const COUNTER_COLUMNS =
  'id, site_id, home_battery_id, ts_ms, battery_charge_kwh, battery_discharge_kwh, grid_import_kwh, grid_export_kwh, solar_kwh, home_use_kwh';

function mapSample(row: RawSample): HomeBatterySampleRow {
  return {
    id: Number(row.id),
    siteId: row.site_id as SiteId,
    homeBatteryId: row.home_battery_id,
    tsMs: Number(row.ts_ms),
    socPercent: row.soc_percent,
    socKwh: row.soc_kwh,
    powerW: row.power_w,
    homeLoadW: row.home_load_w,
    solarW: row.solar_w,
    gridW: row.grid_w,
  };
}

function mapCounters(row: RawCounters): HomeEnergyCountersRow {
  return {
    id: Number(row.id),
    siteId: row.site_id as SiteId,
    homeBatteryId: row.home_battery_id,
    tsMs: Number(row.ts_ms),
    batteryChargeKwh: row.battery_charge_kwh,
    batteryDischargeKwh: row.battery_discharge_kwh,
    gridImportKwh: row.grid_import_kwh,
    gridExportKwh: row.grid_export_kwh,
    solarKwh: row.solar_kwh,
    homeUseKwh: row.home_use_kwh,
  };
}

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
    .get(siteId) as RawSample | null | undefined;
  return row ? mapSample(row) : null;
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
    .get(siteId) as RawCounters | null | undefined;
  return row ? mapCounters(row) : null;
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
