/**
 * Decision audit (decisions) — one row per evaluated vehicle plug-in decision.
 *
 * The EvPoller chain (daemon) is the only writer: the engine produces the
 * outcome, this module records it, CLI readers answer "why didn't it charge?"
 * read-only. Per-filter detail arrives serialized (FilterResult[] → JSON).
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  HOME_SITE,
  type DecisionRow,
  type NewDecision,
  type SiteId,
} from './types.js';

/**
 * Aliased to camelCase so the driver output *is* the DecisionRow shape — the
 * schema-pin test pins this alias list to the DDL and the interface.
 */
const COLUMNS = [
  'id',
  'site_id AS siteId',
  'vehicle_id AS vehicleId',
  'home_battery_id AS homeBatteryId',
  'ts_ms AS tsMs',
  'session_id AS sessionId',
  'accepted',
  'dry_run AS dryRun',
  'reason_code AS reasonCode',
  'reason_detail AS reasonDetail',
  'filter_results_json AS filterResultsJson',
  'limited_by AS limitedBy',
].join(', ');

/** Record one decision; returns the row id. */
export function insertDecision(
  db: DatabaseSync,
  decision: NewDecision,
  siteId: SiteId = HOME_SITE
): number {
  const result = db
    .prepare(
      `INSERT INTO decisions
         (site_id, vehicle_id, home_battery_id, ts_ms, session_id, accepted,
          dry_run, reason_code, reason_detail, filter_results_json, limited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      siteId,
      decision.vehicleId,
      decision.homeBatteryId ?? null,
      decision.tsMs,
      decision.sessionId ?? null,
      decision.accepted ? 1 : 0,
      decision.dryRun ? 1 : 0,
      decision.reasonCode,
      decision.reasonDetail ?? null,
      decision.filterResultsJson ?? null,
      decision.limitedBy ?? null
    );
  return Number(result.lastInsertRowid);
}

/**
 * The decision recorded for a session, or null (the idempotency read: never
 * re-fire for a session that already has one; newest wins if a session ever
 * carries more than one).
 */
export function decisionForSession(
  db: DatabaseSync,
  sessionId: number,
  siteId: SiteId = HOME_SITE
): DecisionRow | null {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM decisions
       WHERE site_id = ? AND session_id = ?
       ORDER BY ts_ms DESC, id DESC LIMIT 1`
    )
    .get(siteId, sessionId) as DecisionRow | null | undefined;
  return row ?? null;
}
