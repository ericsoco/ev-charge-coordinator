/**
 * Decisions reason vocabulary grows for the P1b engine: `filter_declined`
 * (a configured filter failed — per-filter reasons live in
 * filter_results_json) and `config_error` (safety inputs unreadable: energy
 * config or home-battery SoC — deny loudly instead of guessing).
 *
 * SQLite cannot ALTER a CHECK constraint: rebuild the table inside the
 * migration transaction (copy rows, drop, rename, recreate the index).
 */
import type { DatabaseSync } from 'node:sqlite';

export const version = 2;

export function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE decisions_v2 (
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
        'service_error', 'filter_declined', 'config_error'
      )),
      reason_detail TEXT,
      filter_results_json TEXT,
      limited_by TEXT
    );
    INSERT INTO decisions_v2
      (id, site_id, vehicle_id, home_battery_id, ts_ms, session_id, accepted,
       dry_run, reason_code, reason_detail, filter_results_json, limited_by)
    SELECT
      id, site_id, vehicle_id, home_battery_id, ts_ms, session_id, accepted,
      dry_run, reason_code, reason_detail, filter_results_json, limited_by
    FROM decisions;
    DROP TABLE decisions;
    ALTER TABLE decisions_v2 RENAME TO decisions;
    CREATE INDEX idx_decisions_site_ts ON decisions (site_id, ts_ms);
  `);
}
