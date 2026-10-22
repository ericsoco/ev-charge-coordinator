/**
 * System status, session history, and home-location handlers.
 *
 * `showStatus` moved here from vehicle.ts (it was never vehicle-specific) and
 * grew daemon/store/proxy/config sections. Status has a hard no-side-effects
 * rule: no service init, no proxy spawns, no writes — file reads, PRAGMAs and
 * localhost probes only. Coordinates are shown only at set-time (the confirm
 * prompt), never by `status` (it reports set/not-set).
 */
import * as fs from 'fs';
import axios from 'axios';
import { createConnection } from 'node:net';
import {
  describeError,
  log,
  type CommandContext,
  type CommandResult,
} from './context.js';
import * as paint from '../utils/color.js';
import { resolveDaemonConfig, daemonConfigPath } from '../utils/daemonConfig.js';
import { resolveEnergyConfig } from '../utils/config.js';
import { credentialStore, type HomeLocation } from '../utils/credentials.js';
import { storePath, openStoreReadOnly } from '../store/database.js';
import { readLock, lockPath, isPidAlive, type LockInfo } from '../daemon/lockfile.js';
import { readRuntimeState, isProcessAlive } from '../services/ProcessManager.js';
import * as sessionStore from '../store/SessionStore.js';

export interface StatusReport {
  daemon: {
    state: 'running' | 'stale' | 'stopped' | 'unreadable';
    pid: number | null;
    since: string | null;
    detail: string | null;
  };
  store: {
    path: string;
    exists: boolean;
    schemaVersion: number | null;
    sizeBytes: number | null;
    counts: {
      batterySamples: number;
      evSamples: number;
      events: number;
      sessions: number;
      openSessions: number;
      weatherForecasts: number;
    };
    lastSample: {
      battery: string | null;
      ev: string | null;
      weather: string | null;
      event: string | null;
    };
  };
  proxies: {
    franklin: { state: 'running' | 'unhealthy' | 'not running'; pid: number | null; port: number | null };
    teslaCommand: { state: 'running' | 'not running' };
  };
  config: {
    daemon: Record<string, number> | null;
    daemonProblems: string[];
    energyBufferPercent: number | null;
    energyInvalid: string[];
    homeLocation: 'set' | 'not set';
  };
}

export interface StatusOptions {
  json?: boolean;
  dbPath?: string;
  lockFile?: string;
  nowMs?: () => number;
  getHomeLocation?: () => Promise<HomeLocation | undefined>;
  /** Probes injected for tests; defaults probe localhost for real. */
  franklinProxyState?: (
    live: { pid: number; port: number } | null
  ) => Promise<StatusReport['proxies']['franklin']>;
  teslaProxyState?: () => Promise<StatusReport['proxies']['teslaCommand']>;
}

const iso = (ts: number | bigint | null | undefined): string | null =>
  ts === null || ts === undefined ? null : new Date(Number(ts)).toISOString();

/** Compact "3m ago"-style age for humans. */
export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Compact duration ("8h 12m") for session lines. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
  return `${Math.floor(ms / 86_400_000)}d ${Math.floor((ms % 86_400_000) / 3_600_000)}h`;
}

/** Recorded Franklin proxy → health probe (GET /health, 1s budget). */
async function defaultFranklinProxyState(
  live: { pid: number; port: number } | null
): Promise<StatusReport['proxies']['franklin']> {
  if (!live) return { state: 'not running', pid: null, port: null };
  try {
    await axios.get(`http://127.0.0.1:${live.port}/health`, { timeout: 1_000 });
    return { state: 'running', pid: live.pid, port: live.port };
  } catch {
    return { state: 'unhealthy', pid: live.pid, port: live.port };
  }
}

/** Is anything listening on the tesla-http-proxy port? (TCP probe, 500ms.) */
async function defaultTeslaProxyState(): Promise<StatusReport['proxies']['teslaCommand']> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: 4443 });
    const done = (state: 'running' | 'not running') => {
      socket.destroy();
      resolve({ state });
    };
    socket.setTimeout(500, () => done('not running'));
    socket.once('connect', () => done('running'));
    socket.once('error', () => done('not running'));
  });
}

async function collectStatus(options: StatusOptions): Promise<StatusReport> {
  const lockFile = options.lockFile ?? lockPath();

  let daemon: StatusReport['daemon'];
  try {
    const lock: LockInfo | null = readLock(lockFile);
    if (lock === null) {
      daemon = { state: 'stopped', pid: null, since: null, detail: null };
    } else if (!isPidAlive(lock.pid)) {
      daemon = {
        state: 'stale',
        pid: lock.pid,
        since: iso(lock.takenAt),
        detail: `remove ${lockFile} if no daemon is running`,
      };
    } else {
      daemon = { state: 'running', pid: lock.pid, since: iso(lock.takenAt), detail: null };
    }
  } catch {
    daemon = {
      state: 'unreadable',
      pid: null,
      since: null,
      detail: `lock file unreadable — remove ${lockFile} if no daemon is running`,
    };
  }

  const dbPath = options.dbPath ?? storePath();
  const exists = fs.existsSync(dbPath);
  const counts: StatusReport['store']['counts'] = {
    batterySamples: 0,
    evSamples: 0,
    events: 0,
    sessions: 0,
    openSessions: 0,
    weatherForecasts: 0,
  };
  const lastSample: StatusReport['store']['lastSample'] = {
    battery: null,
    ev: null,
    weather: null,
    event: null,
  };
  let schemaVersion: number | null = null;
  let sizeBytes: number | null = null;

  if (exists) {
    sizeBytes = fs.statSync(dbPath).size;
    const db = openStoreReadOnly(dbPath);
    try {
      schemaVersion = Number(
        (db.prepare('PRAGMA user_version').get() as { user_version: number | bigint }).user_version
      );
      const count = (table: string): number => {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint };
        return Number(row.n);
      };
      counts.batterySamples = count('home_battery_samples');
      counts.evSamples = count('ev_samples');
      counts.events = count('events');
      counts.sessions = count('sessions');
      counts.weatherForecasts = count('weather_forecasts');
      counts.openSessions = sessionStore.sessionStats(db).open;
      const newestTs = (sql: string): string | null => {
        const row = db.prepare(sql).get() as { ts: number | bigint | null } | undefined;
        return row ? iso(row.ts) : null;
      };
      lastSample.battery = newestTs('SELECT MAX(ts_ms) AS ts FROM home_battery_samples');
      lastSample.ev = newestTs('SELECT MAX(ts_ms) AS ts FROM ev_samples');
      lastSample.weather = newestTs('SELECT MAX(fetched_ts_ms) AS ts FROM weather_forecasts');
      lastSample.event = newestTs('SELECT MAX(ts_ms) AS ts FROM events');
    } finally {
      db.close();
    }
  }

  const runtime = readRuntimeState();
  const live = runtime && isProcessAlive(runtime.pid) ? { pid: runtime.pid, port: runtime.port } : null;
  const franklin = options.franklinProxyState
    ? await options.franklinProxyState(live)
    : await defaultFranklinProxyState(live);
  const teslaCommand = options.teslaProxyState
    ? await options.teslaProxyState()
    : await defaultTeslaProxyState();

  const daemonCfg = resolveDaemonConfig();
  const energyCfg = resolveEnergyConfig();
  const home = await (options.getHomeLocation ?? (() => credentialStore.getHomeLocation()))();

  return {
    daemon,
    store: { path: dbPath, exists, schemaVersion, sizeBytes, counts, lastSample },
    proxies: { franklin, teslaCommand },
    config: {
      daemon: daemonCfg.config as Record<string, number> | null,
      daemonProblems: daemonCfg.problems,
      energyBufferPercent: energyCfg.config?.bufferPercent ?? null,
      energyInvalid: energyCfg.invalid,
      homeLocation: home ? 'set' : 'not set',
    },
  };
}

export async function showStatus(
  ctx: CommandContext,
  options: StatusOptions = {}
): Promise<CommandResult> {
  const report = await collectStatus(options);
  if (options.json) {
    log(ctx, JSON.stringify(report, null, 2));
    return { ok: true };
  }

  const nowMs = (options.nowMs ?? Date.now)();
  log(ctx, paint.info('\n--- System Status ---'));
  log(
    ctx,
    `FranklinWH: ${
      ctx.franklin?.isAuthenticated()
        ? paint.positive('✓ Connected')
        : paint.info('(not signed in this process)')
    }`
  );
  log(
    ctx,
    `Tesla: ${
      ctx.tesla?.isAuthenticated()
        ? paint.positive('✓ Connected')
        : paint.info('(not signed in this process)')
    }`
  );
  const energy = ctx.config.resolve();
  let buffer = '(unset)';
  if (energy.config) buffer = `${energy.config.bufferPercent}%`;
  else if (energy.invalid.length > 0) buffer = '(invalid -- see `config`)';
  log(ctx, `Battery Buffer: ${buffer}`);

  log(ctx, '');
  log(ctx, paint.info('--- Daemon ---'));
  const daemonLine =
    report.daemon.state === 'running'
      ? paint.positive(
          `running (pid ${report.daemon.pid}, since ${report.daemon.since}, ${formatAge(nowMs - Date.parse(report.daemon.since ?? ''))})`
        )
      : paint.warning(
          `${report.daemon.state}${report.daemon.detail ? ` — ${report.daemon.detail}` : ''}`
        );
  log(ctx, `daemon: ${daemonLine}`);

  log(ctx, '');
  log(ctx, paint.info('--- Proxies ---'));
  const franklin = report.proxies.franklin;
  log(
    ctx,
    `Franklin proxy: ${
      franklin.state === 'running'
        ? paint.positive(`running (port ${franklin.port}, pid ${franklin.pid})`)
        : franklin.state === 'unhealthy'
          ? paint.warning(`running but unhealthy (port ${franklin.port}, pid ${franklin.pid})`)
          : paint.info('not running')
    }`
  );
  log(
    ctx,
    `Tesla command proxy: ${
      report.proxies.teslaCommand.state === 'running'
        ? paint.positive('running (port 4443)')
        : paint.info('not running')
    }`
  );

  log(ctx, '');
  log(ctx, paint.info('--- Store ---'));
  if (!report.store.exists) {
    log(ctx, paint.warning(`no store yet at ${report.store.path} — run \`daemon\` to create it`));
  } else {
    log(
      ctx,
      `${report.store.path} (schema v${report.store.schemaVersion}, ${Math.round((report.store.sizeBytes ?? 0) / 1024)} KB)`
    );
    const age = (isoTs: string | null): string =>
      isoTs === null ? 'never' : formatAge(nowMs - Date.parse(isoTs));
    log(
      ctx,
      `battery: ${report.store.counts.batterySamples} rows, last ${age(report.store.lastSample.battery)} · ` +
        `ev: ${report.store.counts.evSamples} rows, last ${age(report.store.lastSample.ev)}`
    );
    log(
      ctx,
      `weather: ${report.store.counts.weatherForecasts} rows, last ${age(report.store.lastSample.weather)} · ` +
        `events: ${report.store.counts.events}, last ${age(report.store.lastSample.event)}`
    );
    log(ctx, `sessions: ${report.store.counts.sessions} (${report.store.counts.openSessions} open)`);
  }

  log(ctx, '');
  log(ctx, paint.info('--- Config ---'));
  log(
    ctx,
    `home location: ${
      report.config.homeLocation === 'set' ? paint.positive('set') : paint.info('not set')
    }`
  );
  if (report.config.daemonProblems.length > 0) {
    for (const problem of report.config.daemonProblems) log(ctx, paint.error(problem));
  } else if (report.config.daemon) {
    const cfg = report.config.daemon;
    // Label honestly: these values may come from defaults, not a file.
    const label = fs.existsSync(daemonConfigPath()) ? 'daemon.json' : 'daemon defaults';
    log(
      ctx,
      `${label}: battery ${cfg.batterySampleSec}s · ev ${cfg.evStatusPollSec}s ` +
        `(plugged ${cfg.evSamplePluggedSec}s / idle ${cfg.evSampleIdleSec}s) · ` +
        `weather ${cfg.weatherFetchSec}s · retention ${cfg.retentionDays}d`
    );
  } else {
    log(ctx, 'daemon config: (unavailable — see problems above)');
  }
  if (report.config.energyInvalid.length > 0) {
    for (const problem of report.config.energyInvalid) log(ctx, paint.error(problem));
  }

  return { ok: true };
}

export interface SessionsOptions {
  /** Most recent sessions to show; default 10. */
  limit?: number;
  /** Only sessions still open. */
  openOnly?: boolean;
  dbPath?: string;
}

export async function showSessions(
  ctx: CommandContext,
  options: SessionsOptions = {}
): Promise<CommandResult> {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1) {
    const message = `--limit must be a positive integer (got ${options.limit})`;
    log(ctx, paint.error(message));
    return { ok: false, error: message };
  }

  const dbPath = options.dbPath ?? storePath();
  if (!fs.existsSync(dbPath)) {
    log(ctx, 'No sessions recorded yet — run `node dist/index.js daemon` to start collecting.');
    return { ok: true };
  }

  const db = openStoreReadOnly(dbPath);
  try {
    const rows = (
      options.openOnly ? sessionStore.openSessions(db) : sessionStore.recentSessions(db, limit)
    ).slice(0, limit);

    if (rows.length === 0) {
      log(
        ctx,
        options.openOnly
          ? 'No sessions are open right now.'
          : 'No sessions recorded yet — run `node dist/index.js daemon` to start collecting.'
      );
      return { ok: true };
    }

    for (const row of rows) {
      const plugged = new Date(row.plugTsMs).toLocaleString();
      const duration =
        row.unplugTsMs === null ? paint.info('[open]') : formatDuration(row.unplugTsMs - row.plugTsMs);
      const energy = row.energyKwh === null ? '—' : `${row.energyKwh.toFixed(3)} kWh`;
      const house = row.houseEnergyKwh === null ? '—' : `${row.houseEnergyKwh.toFixed(3)} kWh`;
      const eff = row.efficiency === null ? '—' : row.efficiency.toFixed(3);
      log(
        ctx,
        `#${row.id}  plugged ${plugged}  ${duration}  ` +
          `energy ${energy} · house ${house} · eff ${eff}`
      );
    }

    const stats = sessionStore.sessionStats(db);
    if (stats.total > 0) {
      const avgEnergy = stats.avgEnergyKwh === null ? '—' : `${stats.avgEnergyKwh.toFixed(3)} kWh`;
      const avgEff = stats.avgEfficiency === null ? '—' : stats.avgEfficiency.toFixed(3);
      const avgElapsed = stats.avgElapsedMs === null ? '—' : formatDuration(stats.avgElapsedMs);
      log(
        ctx,
        paint.info(
          `${stats.total} sessions (${stats.open} open, ${stats.closed} closed) · ` +
            `avg energy ${avgEnergy} · avg eff ${avgEff} · avg elapsed ${avgElapsed}`
        )
      );
    }
    return { ok: true };
  } finally {
    db.close();
  }
}

export interface HomeLocationDeps {
  getHomeLocation?: () => Promise<HomeLocation | undefined>;
  setHomeLocation?: (latitude: number, longitude: number) => Promise<void>;
}

const fmtCoord = (value: { latitude: number; longitude: number }): string =>
  `${value.latitude.toFixed(5)}, ${value.longitude.toFixed(5)}`;

/**
 * Set the home location (a secret). With arguments: manual mode. With no
 * arguments: the vehicle flow — wake, read drive_state, confirm. EVERY write
 * goes through a confirmation prompt that shows current → new, because the
 * stored value is otherwise invisible.
 */
export async function setHomeLocationCommand(
  ctx: CommandContext,
  latitudeArg?: string,
  longitudeArg?: string,
  deps: HomeLocationDeps = {}
): Promise<CommandResult> {
  const get = deps.getHomeLocation ?? (() => credentialStore.getHomeLocation());
  const set =
    deps.setHomeLocation ?? ((latitude: number, longitude: number) => credentialStore.setHomeLocation(latitude, longitude));

  if ((latitudeArg === undefined) !== (longitudeArg === undefined)) {
    const message = 'Usage: set-home-location <latitude> <longitude>  (or no arguments to use the vehicle)';
    log(ctx, paint.error(message));
    return { ok: false, error: message };
  }

  let proposed: { latitude: number; longitude: number };
  const current = await get();
  const currentText = current ? fmtCoord(current) : '(not set)';

  if (latitudeArg !== undefined && longitudeArg !== undefined) {
    proposed = { latitude: Number(latitudeArg), longitude: Number(longitudeArg) };
    if (!Number.isFinite(proposed.latitude) || !Number.isFinite(proposed.longitude)) {
      const message = `latitude/longitude must be numbers (got ${latitudeArg}, ${longitudeArg})`;
      log(ctx, paint.error(message));
      return { ok: false, error: message };
    }
    const answer = (
      await ctx.ask(
        `Current home location: ${currentText}. Set to ${fmtCoord(proposed)}? (y/n): `
      )
    )
      .trim()
      .toLowerCase();
    if (answer !== 'y') {
      log(ctx, 'Cancelled — nothing stored.');
      return { ok: false, error: 'Cancelled — nothing stored' };
    }
  } else {
    if (!ctx.tesla?.isAuthenticated()) {
      const message =
        'Tesla not connected — the vehicle flow needs `start` (REPL) or `authenticate` first';
      log(ctx, paint.warning(message));
      return { ok: false, error: message };
    }
    log(
      ctx,
      paint.info('Reading the vehicle position (waking it if needed; asleep cars take up to a minute)...')
    );
    try {
      await ctx.tesla.wakeUp();
      proposed = await ctx.tesla.getVehicleLocation();
    } catch (error) {
      const message = describeError(error);
      log(ctx, paint.error(`Error: ${message}`));
      return { ok: false, error: message };
    }
    const answer = (
      await ctx.ask(
        `Vehicle reports ${fmtCoord(proposed)}. Current home location: ${currentText}. ` +
          `Set as home location? (y/n): `
      )
    )
      .trim()
      .toLowerCase();
    if (answer !== 'y') {
      log(ctx, 'Cancelled — nothing stored.');
      return { ok: false, error: 'Cancelled — nothing stored' };
    }
  }

  try {
    await set(proposed.latitude, proposed.longitude);
    log(
      ctx,
      paint.success(
        `✓ Home location set to ${fmtCoord(proposed)} — stored as a secret (never config.json, never the store).`
      )
    );
    log(ctx, paint.info('  weather-fetch will collect on the next daemon cycle.'));
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, paint.error(`Error: ${message}`));
    return { ok: false, error: message };
  }
}



