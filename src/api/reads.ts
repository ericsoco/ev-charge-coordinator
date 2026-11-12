/**
 * Store reads for the read API: /api/now, /api/sessions, /api/messages.
 *
 * SQL lives here (precedent: commands/system.ts status queries) — the API
 * reads through the daemon's in-process handle; it never opens its own
 * connection and never spawns a poller. Freshness is computed against the
 * caller's clock so tests can pin it.
 */
import type { DatabaseSync } from 'node:sqlite';
import { HOME_SITE, type SessionStopReason, type SiteId } from '../store/types.js';
import * as evStore from '../store/EvStore.js';
import * as homeBattery from '../store/HomeBatteryStore.js';
import * as sessionStore from '../store/SessionStore.js';
import { formatLocalTimestamp } from '../utils/time.js';
import { ApiError } from './ApiError.js';
import { intParamOr } from './params.js';
import type { NowResponse } from './types.js';

export interface NowDeps {
  db: DatabaseSync;
  /** VIN; undefined (no Tesla service) skips EV/session-by-vehicle reads. */
  vehicleId?: string;
  nowMs: () => number;
  siteId?: SiteId;
}

/** Latest rows only — no live probes (the daemon's samplers own freshness). */
export function readNow(deps: NowDeps): NowResponse {
  const siteId = deps.siteId ?? HOME_SITE;
  const nowMs = deps.nowMs();

  const batteryRow = homeBattery.latestSample(deps.db, siteId);
  const evRow = deps.vehicleId ? evStore.latestSample(deps.db, deps.vehicleId, siteId) : null;
  // With a known vehicle: its open session. Without one: the newest open
  // session (single-vehicle site; openSessions is newest-first).
  const sessionRow = deps.vehicleId
    ? sessionStore.openSessionFor(deps.db, deps.vehicleId, siteId)
    : (sessionStore.openSessions(deps.db, siteId)[0] ?? null);

  return {
    nowMs,
    vehicle:
      evRow === null
        ? null
        : {
            vehicleId: evRow.vehicleId,
            socPercent: evRow.socPercent,
            chargingState: evRow.chargingState,
            chargeLimitSoc: evRow.chargeLimitSoc,
            sampleTsMs: evRow.tsMs,
            ageMs: nowMs - evRow.tsMs,
          },
    battery:
      batteryRow === null
        ? null
        : {
            socPercent: batteryRow.socPercent,
            powerW: batteryRow.powerW,
            homeLoadW: batteryRow.homeLoadW,
            solarW: batteryRow.solarW,
            gridW: batteryRow.gridW,
            sampleTsMs: batteryRow.tsMs,
            ageMs: nowMs - batteryRow.tsMs,
          },
    session:
      sessionRow === null
        ? null
        : {
            id: sessionRow.id,
            plugTsMs: sessionRow.plugTsMs,
            targetPercent: sessionRow.targetPercent,
            stopReason: sessionRow.stopReason,
          },
  };
}

export interface SessionSummary {
  id: number;
  /** Selector label: start date+time, local `YYYY-MM-DD HH:MM`. */
  label: string;
  plugTsMs: number;
  unplugTsMs: number | null;
  open: boolean;
  targetPercent: number | null;
  initialTargetPercent: number | null;
  targetChangeReason: string | null;
  stopReason: SessionStopReason | null;
  energyKwh: number | null;
  energyPercent: number | null;
  efficiency: number | null;
  /** First EV sample SoC at/after plug; null when the car left no samples. */
  evSocStartPercent: number | null;
  /** Last EV sample SoC at/before unplug; null while open or unsampled. */
  evSocEndPercent: number | null;
  batterySocStartPercent: number | null;
  /** Null while open — an open session has no final value yet. */
  batterySocEndPercent: number | null;
}

export interface SessionsResponse {
  total: number;
  limit: number;
  offset: number;
  sessions: SessionSummary[];
}

export const SESSIONS_DEFAULT_LIMIT = 50;
export const SESSIONS_MAX_LIMIT = 200;

interface SessionPageRow {
  id: number;
  vehicleId: string;
  plugTsMs: number;
  unplugTsMs: number | null;
  energyKwh: number | null;
  energyPercent: number | null;
  efficiency: number | null;
  targetPercent: number | null;
  initialTargetPercent: number | null;
  targetChangeReason: string | null;
  stopReason: SessionStopReason | null;
}

/** First/last non-null SoC in the window; null when the window holds none. */
function socEdge(
  db: DatabaseSync,
  table: 'ev_samples' | 'home_battery_samples',
  fromMs: number,
  toMs: number | null,
  vehicleId: string | null,
  order: 'first' | 'last',
  siteId: SiteId
): number | null {
  const dir = order === 'first' ? 'ASC' : 'DESC';
  const upper = toMs === null ? '' : ' AND ts_ms <= ?';
  const byVehicle = vehicleId === null ? '' : ' AND vehicle_id = ?';
  const params: Array<string | number> = [siteId, fromMs];
  if (toMs !== null) params.push(toMs);
  if (vehicleId !== null) params.push(vehicleId);
  // Table/order/vehicle fragments are literals or this file's own values —
  // never request input.
  const row = db
    .prepare(
      `SELECT soc_percent AS v FROM ${table}
        WHERE site_id = ? AND ts_ms >= ?${upper}${byVehicle}
          AND soc_percent IS NOT NULL
        ORDER BY ts_ms ${dir}, id ${dir} LIMIT 1`
    )
    .get(...params) as { v: number } | undefined;
  return row ? Number(row.v) : null;
}

/** Paginated session list, newest first, with SoC edges for chart tooltips. */
export function readSessions(
  db: DatabaseSync,
  query: Record<string, unknown>,
  siteId: SiteId = HOME_SITE
): SessionsResponse {
  const limit = intParamOr(query, 'limit', SESSIONS_DEFAULT_LIMIT);
  if (limit < 1 || limit > SESSIONS_MAX_LIMIT) {
    throw new ApiError(400, `limit must be between 1 and ${SESSIONS_MAX_LIMIT}`);
  }
  const offset = intParamOr(query, 'offset', 0);
  if (offset < 0) throw new ApiError(400, 'offset must be >= 0');

  const totalRow = db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE site_id = ?')
    .get(siteId) as { n: number | bigint };
  const rows = db
    .prepare(
      `SELECT id, vehicle_id AS vehicleId, plug_ts_ms AS plugTsMs,
              unplug_ts_ms AS unplugTsMs, energy_kwh AS energyKwh,
              energy_percent AS energyPercent, efficiency,
              target_percent AS targetPercent,
              initial_target_percent AS initialTargetPercent,
              target_change_reason AS targetChangeReason,
              stop_reason AS stopReason
         FROM sessions
        WHERE site_id = ?
        ORDER BY plug_ts_ms DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(siteId, limit, offset) as unknown as SessionPageRow[];

  const sessions: SessionSummary[] = rows.map((row) => {
    const open = row.unplugTsMs === null;
    return {
      id: row.id,
      // Seconds dropped: the selector labels with date+time, not clock precision.
      label: formatLocalTimestamp(row.plugTsMs).slice(0, 16),
      plugTsMs: row.plugTsMs,
      unplugTsMs: row.unplugTsMs,
      open,
      targetPercent: row.targetPercent,
      initialTargetPercent: row.initialTargetPercent,
      targetChangeReason: row.targetChangeReason,
      stopReason: row.stopReason,
      energyKwh: row.energyKwh,
      energyPercent: row.energyPercent,
      efficiency: row.efficiency,
      evSocStartPercent: socEdge(db, 'ev_samples', row.plugTsMs, row.unplugTsMs, row.vehicleId, 'first', siteId),
      evSocEndPercent: open
        ? null
        : socEdge(db, 'ev_samples', row.plugTsMs, row.unplugTsMs, row.vehicleId, 'last', siteId),
      batterySocStartPercent: socEdge(db, 'home_battery_samples', row.plugTsMs, row.unplugTsMs, null, 'first', siteId),
      batterySocEndPercent: open
        ? null
        : socEdge(db, 'home_battery_samples', row.plugTsMs, row.unplugTsMs, null, 'last', siteId),
    };
  });

  return { total: Number(totalRow.n), limit, offset, sessions };
}

/**
 * A future Messages-tab row (P2 step 7 lands the `notifications` table and
 * the notifier-fanout writes). Documented now so the app can bind to the
 * final shape; the list is empty until then.
 */
export interface ApiMessage {
  id: number;
  tsMs: number;
  /** NotificationEvent.type ('plug-in-detected', 'decision-made', …). */
  type: string;
  /** Human headline, e.g. "Charging started". */
  title: string;
  /** Rendered detail: reason, SoC, target — what ntfy/Slack would show. */
  body: string;
}

export interface MessagesResponse {
  messages: ApiMessage[];
}

/** Always empty until the notifications table lands (P2 step 7). */
export function readMessages(): MessagesResponse {
  return { messages: [] };
}

