/**
 * Migration 1 — initial schema: all seven P1a tables + indexes.
 *
 * This file is the storage source of truth; src/store/types.ts mirrors it with
 * TS row interfaces and tests/store round-trips pin the two together. Plain
 * SQL: node:sqlite has no query builder, and the schema should read exactly
 * the way a sqlite3 shell would.
 *
 * Conventions (workplan "Storage design (schema v1)"):
 * - surrogate `id INTEGER PRIMARY KEY` (rowid alias) on every table
 * - `site_id` carries a CHECK enum ('home' only) — Phase 3 widens by migration
 * - timestamps are INTEGER epoch-ms UTC; booleans INTEGER 1/0
 * - unit suffixes: _percent, _kwh, _w, _kw, _ms, _wm2, _c
 */
import type { DatabaseSync } from 'node:sqlite';

export const version = 1;

export function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS home_battery_samples (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL CHECK (site_id = 'home'),
      home_battery_id TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      soc_percent REAL,
      soc_kwh REAL,
      power_w REAL,
      home_load_w REAL,
      solar_w REAL,
      grid_w REAL
    );
    CREATE INDEX IF NOT EXISTS idx_home_battery_samples_site_ts
      ON home_battery_samples (site_id, ts_ms);

    CREATE TABLE IF NOT EXISTS home_energy_counters (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL CHECK (site_id = 'home'),
      home_battery_id TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      battery_charge_kwh REAL,
      battery_discharge_kwh REAL,
      grid_import_kwh REAL,
      grid_export_kwh REAL,
      solar_kwh REAL,
      home_use_kwh REAL
    );
    CREATE INDEX IF NOT EXISTS idx_home_energy_counters_site_ts
      ON home_energy_counters (site_id, ts_ms);

    CREATE TABLE IF NOT EXISTS ev_samples (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL CHECK (site_id = 'home'),
      vehicle_id TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      state TEXT,
      charging_state TEXT,
      soc_percent REAL,
      charge_limit_soc INTEGER,
      charge_rate_kw REAL,
      minutes_to_full INTEGER,
      charge_energy_added_kwh REAL,
      at_home INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ev_samples_site_ts
      ON ev_samples (site_id, ts_ms);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL CHECK (site_id = 'home'),
      vehicle_id TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'plug_in', 'unplug', 'charging_start', 'charging_stop',
        'daemon_start', 'daemon_stop'
      )),
      from_state TEXT,
      to_state TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_site_ts
      ON events (site_id, ts_ms);

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL CHECK (site_id = 'home'),
      vehicle_id TEXT NOT NULL,
      home_battery_id TEXT NOT NULL,
      plug_ts_ms INTEGER NOT NULL,
      unplug_ts_ms INTEGER,
      energy_kwh REAL,
      energy_percent REAL,
      elapsed_ms INTEGER,
      house_energy_kwh REAL,
      efficiency REAL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_site_plug
      ON sessions (site_id, plug_ts_ms);

    CREATE TABLE IF NOT EXISTS weather_forecasts (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL CHECK (site_id = 'home'),
      fetched_ts_ms INTEGER NOT NULL,
      hour_ts_ms INTEGER NOT NULL,
      irradiance_wm2 REAL,
      temperature_c REAL,
      raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_weather_forecasts_site_hour_fetch
      ON weather_forecasts (site_id, hour_ts_ms, fetched_ts_ms);

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL CHECK (site_id = 'home'),
      vehicle_id TEXT NOT NULL,
      home_battery_id TEXT,
      ts_ms INTEGER NOT NULL,
      session_id INTEGER,
      accepted INTEGER NOT NULL,
      dry_run INTEGER NOT NULL,
      reason_code TEXT NOT NULL CHECK (reason_code IN (
        'started', 'dry_run', 'below_buffer', 'already_charging',
        'not_plugged_in', 'duplicate_session', 'compute_error', 'service_error'
      )),
      reason_detail TEXT,
      filter_results_json TEXT,
      limited_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_site_ts
      ON decisions (site_id, ts_ms);
  `);
}
