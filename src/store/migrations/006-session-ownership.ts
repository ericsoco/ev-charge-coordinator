/**
 * Session ownership (the "who started charging" timeline) plus the two
 * fields the ownership policy needs on the session itself:
 *
 * - `session_owners` — one row per charging episode: `owner` is
 *   'evcc' | 'manual' | 'scheduled' (who triggered the start), `from_ts_ms`
 *   the episode's start; the next row's `from_ts_ms` ends the previous
 *   episode (the last row ends at unplug). Append-only audit.
 * - `sessions.user_charge_limit_percent` — the vehicle's charge limit before
 *   EVCC's first limit write for this plug-in (write-once); restoring it is
 *   how EVCC hands the car back to its user-set limit.
 * - `sessions.released_ts_ms` — set when EVCC releases control of the
 *   plug-in (explicit `release-charging` or scheduled-charging hand-over);
 *   after it, EVCC never manages this plug-in again.
 *
 * Also grows the decisions vocabulary with `scheduled_window` (the
 * prioritize-scheduled-charging decline) — same table-rebuild pattern as
 * 002/003: SQLite cannot ALTER a CHECK constraint.
 */
import type { DatabaseSync } from 'node:sqlite';

export const version = 6;

export function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session_owners (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL CHECK (site_id = 'home'),
      session_id INTEGER NOT NULL,
      owner TEXT NOT NULL CHECK (owner IN ('evcc', 'manual', 'scheduled')),
      from_ts_ms INTEGER NOT NULL
    );
    CREATE INDEX idx_session_owners_session ON session_owners (session_id, from_ts_ms);

    ALTER TABLE sessions ADD COLUMN user_charge_limit_percent REAL;
    ALTER TABLE sessions ADD COLUMN released_ts_ms INTEGER;

    CREATE TABLE decisions_v6 (
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
        'insufficient_energy', 'scheduled_window'
      )),
      reason_detail TEXT,
      filter_results_json TEXT,
      limited_by TEXT
    );
    INSERT INTO decisions_v6
      (id, site_id, vehicle_id, home_battery_id, ts_ms, session_id, accepted,
       dry_run, reason_code, reason_detail, filter_results_json, limited_by)
    SELECT
      id, site_id, vehicle_id, home_battery_id, ts_ms, session_id, accepted,
      dry_run, reason_code, reason_detail, filter_results_json, limited_by
    FROM decisions;
    DROP TABLE decisions;
    ALTER TABLE decisions_v6 RENAME TO decisions;
    CREATE INDEX idx_decisions_site_ts ON decisions (site_id, ts_ms);
  `);
}
