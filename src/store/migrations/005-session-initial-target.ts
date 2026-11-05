/**
 * Session-target record (changeset 8): the initial armed target plus the
 * reason current ≠ initial — "initial + final + reason" without a per-change
 * event log (user decision, 2026-11-04).
 *
 * - `initial_target_percent` is write-once (seeded by setSessionTarget's
 *   first write); backfilled from `target_percent` so sessions armed by the
 *   already-landed step-1 code keep a truthful initial.
 * - `target_change_reason` is free text set by whoever re-targets; phrasing
 *   convention (step 4): reference the initial and the new current value, so
 *   initial→final stays derivable from one string. NULL = never re-targeted.
 *
 * Plain ADD COLUMN — no CHECK (free text), same as 004.
 */
import type { DatabaseSync } from 'node:sqlite';

export const version = 5;

export function up(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN initial_target_percent REAL;
    ALTER TABLE sessions ADD COLUMN target_change_reason TEXT;
    UPDATE sessions
       SET initial_target_percent = target_percent
     WHERE target_percent IS NOT NULL;
  `);
}