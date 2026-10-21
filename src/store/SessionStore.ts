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
