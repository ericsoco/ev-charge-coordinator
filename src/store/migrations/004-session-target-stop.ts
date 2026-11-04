/**
 * Session monitor columns (P1c step 1): the stop target the monitor enforces
 * and why it stopped charging. Both nullable — sessions that predate the
 * monitor (and non-charging ones) simply never set them.
 *
 * `target_percent` is **mutable by design** (last write wins): the decision
 * consumer writes it at plug-in, and a later re-targeting step rewrites it
 * mid-session — no write-once guard anywhere.
 *
 * Plain ADD COLUMN is enough here: SQLite supports CHECK constraints on added
 * columns (probed), unlike 002/003 which had to rebuild to *change* a CHECK.
 */
import type { DatabaseSync } from 'node:sqlite';

export const version = 4;

export function up(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN target_percent REAL;
    ALTER TABLE sessions ADD COLUMN stop_reason TEXT
      CHECK (stop_reason IN ('target_reached', 'battery_buffer'));
  `);
}