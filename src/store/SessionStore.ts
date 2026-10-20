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

interface RawSession {
  id: number;
  site_id: string;
  vehicle_id: string;
  home_battery_id: string;
  plug_ts_ms: number;
  unplug_ts_ms: number | null;
  energy_kwh: number | null;
  energy_percent: number | null;
  elapsed_ms: number | null;
  house_energy_kwh: number | null;
  efficiency: number | null;
}

const SESSION_COLUMNS =
  'id, site_id, vehicle_id, home_battery_id, plug_ts_ms, unplug_ts_ms, ' +
  'energy_kwh, energy_percent, elapsed_ms, house_energy_kwh, efficiency';

function mapSession(row: RawSession): SessionRow {
  return {
    id: Number(row.id),
    siteId: row.site_id as SiteId,
    vehicleId: row.vehicle_id,
    homeBatteryId: row.home_battery_id,
    plugTsMs: Number(row.plug_ts_ms),
    unplugTsMs: row.unplug_ts_ms === null ? null : Number(row.unplug_ts_ms),
    energyKwh: row.energy_kwh,
    energyPercent: row.energy_percent,
    elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
    houseEnergyKwh: row.house_energy_kwh,
    efficiency: row.efficiency,
  };
}

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
    .get(siteId, vehicleId) as RawSession | null | undefined;
  return row ? mapSession(row) : null;
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
    .all(siteId, limit) as unknown as RawSession[];
  return rows.map(mapSession);
}
