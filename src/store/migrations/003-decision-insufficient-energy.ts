/**
 * The engine's no-gain verdict: the energy math cannot raise the charge limit
 * above the vehicle's current SoC (integer-rounding tie, the tesla-minimum
 * clamp, a full pack). Same rebuild pattern as 002 — SQLite cannot ALTER a
 * CHECK constraint.
 */
import type { DatabaseSync } from 'node:sqlite';

export const version = 3;

export function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE decisions_v3 (
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
        'not_plugged_in', 'duplicate_session', 'compute_error',
        'service_error', 'filter_declined', 'config_error',
        'insufficient_energy'
      )),
      reason_detail TEXT,
      filter_results_json TEXT,
      limited_by TEXT
    );
    INSERT INTO decisions_v3
      (id, site_id, vehicle_id, home_battery_id, ts_ms, session_id, accepted,
       dry_run, reason_code, reason_detail, filter_results_json, limited_by)
    SELECT
      id, site_id, vehicle_id, home_battery_id, ts_ms, session_id, accepted,
      dry_run, reason_code, reason_detail, filter_results_json, limited_by
    FROM decisions;
    DROP TABLE decisions;
    ALTER TABLE decisions_v3 RENAME TO decisions;
    CREATE INDEX idx_decisions_site_ts ON decisions (site_id, ts_ms);
  `);
}
