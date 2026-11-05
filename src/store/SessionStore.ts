/**
 * Structured history: events (append-only transitions) and sessions (one
 * plug-in visit each, opened on plug-in, closed on unplug).
 *
 * "At most one open session per vehicle" is the daemon's invariant, not the
 * schema's — closeOpenSession updates the most recently opened open session.
 * Closing aggregates (energy_kwh, efficiency, …) stay NULL until the session
 * closes; P1a never computes them (steps 3–4+ do).
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  HOME_SITE,
  type NewEvent,
  type NewOpenSession,
  type SessionRow,
  type SessionStopReason,
  type SiteId,
} from './types.js';

/**
 * Aliased to camelCase so the driver output *is* the SessionRow shape — no
 * Raw* mirror interface, no per-row mapper. The schema-pin test pins this
 * alias list to the DDL and the interface.
 */
const SESSION_COLUMNS = [
  'id',
  'site_id AS siteId',
  'vehicle_id AS vehicleId',
  'home_battery_id AS homeBatteryId',
  'plug_ts_ms AS plugTsMs',
  'unplug_ts_ms AS unplugTsMs',
  'energy_kwh AS energyKwh',
  'energy_percent AS energyPercent',
  'elapsed_ms AS elapsedMs',
  'house_energy_kwh AS houseEnergyKwh',
  'efficiency',
  'target_percent AS targetPercent',
  'initial_target_percent AS initialTargetPercent',
  'target_change_reason AS targetChangeReason',
  'stop_reason AS stopReason',
].join(', ');

/** Append one transition; returns the row id. Bad kinds fail the CHECK. */
export function insertEvent(
  db: DatabaseSync,
  event: NewEvent,
  siteId: SiteId = HOME_SITE
): number {
  const result = db
    .prepare(
      `INSERT INTO events (site_id, vehicle_id, ts_ms, kind, from_state, to_state)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      siteId,
      event.vehicleId,
      event.tsMs,
      event.kind,
      event.fromState ?? null,
      event.toState ?? null
    );
  return Number(result.lastInsertRowid);
}

/** Open a session (unplug_ts_ms NULL); returns the row id. */
export function openSession(
  db: DatabaseSync,
  session: NewOpenSession,
  siteId: SiteId = HOME_SITE
): number {
  const result = db
    .prepare(
      `INSERT INTO sessions (site_id, vehicle_id, home_battery_id, plug_ts_ms)
       VALUES (?, ?, ?, ?)`
    )
    .run(siteId, session.vehicleId, session.homeBatteryId, session.plugTsMs);
  return Number(result.lastInsertRowid);
}

/** The vehicle's open session, or null. */
export function openSessionFor(
  db: DatabaseSync,
  vehicleId: string,
  siteId: SiteId = HOME_SITE
): SessionRow | null {
  const row = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE site_id = ? AND vehicle_id = ? AND unplug_ts_ms IS NULL
        ORDER BY plug_ts_ms DESC LIMIT 1`
    )
    .get(siteId, vehicleId) as SessionRow | null | undefined;
  return row ?? null;
}

/**
 * Close the most recently opened open session; returns its id, or null when
 * the vehicle has no open session (nothing to close — not an error).
 */
export function closeOpenSession(
  db: DatabaseSync,
  vehicleId: string,
  unplugTsMs: number,
  siteId: SiteId = HOME_SITE
): number | null {
  const row = db
    .prepare(
      `UPDATE sessions SET unplug_ts_ms = ?
        WHERE id = (
          SELECT id FROM sessions
           WHERE site_id = ? AND vehicle_id = ? AND unplug_ts_ms IS NULL
           ORDER BY plug_ts_ms DESC LIMIT 1
        )
        RETURNING id`
    )
    .get(unplugTsMs, siteId, vehicleId) as { id: number } | null | undefined;
  return row ? Number(row.id) : null;
}

/** Most recent sessions, newest first. */
export function recentSessions(
  db: DatabaseSync,
  limit: number,
  siteId: SiteId = HOME_SITE
): SessionRow[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer (got ${limit})`);
  }
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE site_id = ? ORDER BY plug_ts_ms DESC, id DESC LIMIT ?`
    )
    .all(siteId, limit) as unknown as SessionRow[];
  return rows;
}

/**
 * Closing aggregates for a session. Every field nullable: a session can end
 * without enough samples (car slept through it, counters missing), and an
 * uncomputable aggregate is recorded as NULL rather than guessed.
 */
export interface FinalizeSessionInput {
  /** Monotonic-summed charge_energy_added over the session, kWh. */
  energyKwh: number | null;
  /** last − first soc_percent over the session. */
  energyPercent: number | null;
  /** unplug − plug (also derivable from the timestamps; stored for queries). */
  elapsedMs: number | null;
  /** Monotonic-summed battery discharge over the session, kWh. */
  houseEnergyKwh: number | null;
  /** energyKwh / houseEnergyKwh; null when house <= 0. Stored raw. */
  efficiency: number | null;
}

/**
 * Write the closing aggregates once the session closes. Returns the session
 * id, or null when no such session exists (site-scoped). Not guarded against
 * re-finalization: the close flow only reaches this when closeOpenSession
 * succeeded, which happens at most once per session.
 */
export function finalizeSession(
  db: DatabaseSync,
  sessionId: number,
  input: FinalizeSessionInput,
  siteId: SiteId = HOME_SITE
): number | null {
  const row = db
    .prepare(
      `UPDATE sessions SET
         energy_kwh = ?, energy_percent = ?, elapsed_ms = ?,
         house_energy_kwh = ?, efficiency = ?
       WHERE id = ? AND site_id = ?
       RETURNING id`
    )
    .get(
      input.energyKwh,
      input.energyPercent,
      input.elapsedMs,
      input.houseEnergyKwh,
      input.efficiency,
      sessionId,
      siteId
    ) as { id: number } | null | undefined;
  return row ? Number(row.id) : null;
}

/**
 * Write the monitor's stop target for a session; returns the session id, or
 * null when no such session exists (site-scoped).
 *
 * Contract (changeset 8):
 * - **First write (arming)** seeds `initial_target_percent` write-once; the
 *   reason is untouched — arming is not a change.
 * - **Later writes (re-targets)** update `target_percent` (last write wins;
 *   the monitor re-reads it every tick) and, only when `changeReason` is
 *   provided, overwrite `target_change_reason` — omitted leaves any earlier
 *   reason intact. Convention: phrase the reason from the initial to the new
 *   current value so initial→final stays derivable from one string.
 */
export function setSessionTarget(
  db: DatabaseSync,
  sessionId: number,
  targetPercent: number,
  changeReason?: string,
  siteId: SiteId = HOME_SITE
): number | null {
  const row = db
    .prepare(
      `SELECT initial_target_percent FROM sessions
        WHERE id = ? AND site_id = ?`
    )
    .get(sessionId, siteId) as { initial_target_percent: number | null } | null | undefined;
  if (!row) return null;

  if (row.initial_target_percent === null) {
    db.prepare(
      `UPDATE sessions SET target_percent = ?, initial_target_percent = ?
        WHERE id = ? AND site_id = ?`
    ).run(targetPercent, targetPercent, sessionId, siteId);
  } else {
    db.prepare(
      `UPDATE sessions
          SET target_percent = ?,
              target_change_reason = COALESCE(?, target_change_reason)
        WHERE id = ? AND site_id = ?`
    ).run(targetPercent, changeReason ?? null, sessionId, siteId);
  }
  return sessionId;
}

/**
 * Record (or clear, with null) why the monitor stopped charging; returns the
 * session id, or null when no such session exists. Written only after a stop
 * actually succeeded, cleared on the next charging_start so a resumed session
 * never shows a stale reason.
 */
export function setSessionStopReason(
  db: DatabaseSync,
  sessionId: number,
  reason: SessionStopReason | null,
  siteId: SiteId = HOME_SITE
): number | null {
  const row = db
    .prepare(
      `UPDATE sessions SET stop_reason = ?
        WHERE id = ? AND site_id = ?
        RETURNING id`
    )
    .get(reason, sessionId, siteId) as { id: number } | null | undefined;
  return row ? Number(row.id) : null;
}

/** Aggregate view for the `sessions` CLI footer; NULL averages = no data. */
export interface SessionStats {
  total: number;
  open: number;
  closed: number;
  avgEnergyKwh: number | null;
  avgEfficiency: number | null;
  avgElapsedMs: number | null;
}

export function sessionStats(db: DatabaseSync, siteId: SiteId = HOME_SITE): SessionStats {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN unplug_ts_ms IS NULL THEN 1 ELSE 0 END) AS open_count,
              AVG(energy_kwh) AS avg_energy_kwh,
              AVG(efficiency) AS avg_efficiency,
              AVG(elapsed_ms) AS avg_elapsed_ms
         FROM sessions WHERE site_id = ?`
    )
    .get(siteId) as {
    total: number | bigint;
    open_count: number | bigint | null;
    avg_energy_kwh: number | null;
    avg_efficiency: number | null;
    avg_elapsed_ms: number | null;
  };
  const total = Number(row.total);
  const open = Number(row.open_count ?? 0);
  return {
    total,
    open,
    closed: total - open,
    avgEnergyKwh: row.avg_energy_kwh,
    avgEfficiency: row.avg_efficiency,
    avgElapsedMs: row.avg_elapsed_ms,
  };
}

/** Sessions still open (unplug_ts_ms NULL), newest first. */
export function openSessions(
  db: DatabaseSync,
  siteId: SiteId = HOME_SITE
): SessionRow[] {
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE site_id = ? AND unplug_ts_ms IS NULL
        ORDER BY plug_ts_ms DESC, id DESC`
    )
    .all(siteId) as unknown as SessionRow[];
  return rows;
}
