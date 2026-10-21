/**
 * Daemon lifecycle: lock → store → tasks → scheduler → cleanup.
 *
 * Two entry points: runDaemonOnce (one pass of every task — `--once` and
 * tests) and startDaemon (continuous; returns a handle so the CLI wires
 * SIGINT/SIGTERM to handle.stop() and the lifecycle stays testable without
 * process signals). runDaemon OWNS the handed-in services' lifecycle: it
 * disconnects them (stopping any proxies they spawned) on teardown.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { FranklinWHService } from '../services/FranklinWHService.js';
import type { TeslaService } from '../services/TeslaService.js';
import type { DaemonConfig } from '../utils/daemonConfig.js';
import { credentialStore, type HomeLocation } from '../utils/credentials.js';
import { openStore, storePath } from '../store/database.js';
import * as homeBattery from '../store/HomeBatteryStore.js';
import * as evStore from '../store/EvStore.js';
import * as sessionStore from '../store/SessionStore.js';
import { acquireLock, lockPath, type LockHandle } from './lockfile.js';
import { createScheduler, type ScheduledTask } from './scheduler.js';
import { createBatterySampler } from './BatterySampler.js';
import { createEvPoller } from './EvPoller.js';
import { createWeatherSampler, type FetchForecast } from './WeatherSampler.js';

export interface RunDaemonOptions {
  services: { franklin: FranklinWHService | null; tesla: TeslaService | null };
  /** Franklin gateway id — row attribution for battery and session rows. */
  homeBatteryId?: string;
  /** VIN — row attribution for EV rows. */
  vehicleId?: string;
  config: DaemonConfig;
  dbPath?: string;
  lockFile?: string;
  getHomeLocation?: () => Promise<HomeLocation | undefined>;
  fetchForecast?: FetchForecast;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
  nowMs?: () => number;
}

export interface DaemonOutcome {
  /** True when every task completed without error (once) or a clean stop. */
  ok: boolean;
  /** Task name → error (null = success); populated by runDaemonOnce. */
  taskResults: Record<string, unknown>;
}

interface Prepared {
  lock: LockHandle;
  db: DatabaseSync;
  tasks: ScheduledTask[];
  eventVehicleId: string;
}

/** Retention prunes daily; the interval only needs to be "roughly a day". */
const RETENTION_TASK_MS = 86_400_000;

async function prepare(options: RunDaemonOptions): Promise<Prepared> {
  const log = options.log ?? console.log;
  const nowMs = options.nowMs ?? Date.now;
  const { franklin, tesla } = options.services;

  if (!franklin && !tesla) {
    throw new Error('No services available — run `start` (or `authenticate`) first.');
  }
  if (franklin && !options.homeBatteryId) {
    throw new Error('homeBatteryId (Franklin gateway id) is required with the Franklin service');
  }
  if (tesla && !options.vehicleId) {
    throw new Error('vehicleId (VIN) is required with the Tesla service');
  }

  const lock = await acquireLock(options.lockFile ?? lockPath());
  let db: DatabaseSync;
  try {
    db = openStore(options.dbPath ?? storePath());
  } catch (error) {
    lock.release();
    throw error;
  }

  const eventVehicleId = options.vehicleId ?? 'daemon';
  const tasks: ScheduledTask[] = [];

  if (franklin && options.homeBatteryId) {
    tasks.push(
      createBatterySampler({
        db,
        franklin,
        homeBatteryId: options.homeBatteryId,
        sampleSec: options.config.batterySampleSec,
        nowMs,
      })
    );
  } else {
    log('[daemon] battery-sample disabled: Franklin service unavailable');
  }

  if (tesla && options.vehicleId) {
    tasks.push(
      createEvPoller({
        db,
        ev: tesla,
        vehicleId: options.vehicleId,
        homeBatteryId: options.homeBatteryId ?? 'unknown',
        statusPollSec: options.config.evStatusPollSec,
        samplePluggedSec: options.config.evSamplePluggedSec,
        sampleIdleSec: options.config.evSampleIdleSec,
        nowMs,
      })
    );
  } else {
    log('[daemon] ev-poll disabled: Tesla service unavailable');
  }

  tasks.push(
    createWeatherSampler({
      db,
      getHomeLocation: options.getHomeLocation ?? (() => credentialStore.getHomeLocation()),
      fetchSec: options.config.weatherFetchSec,
      fetchForecast: options.fetchForecast,
      log,
      nowMs,
    })
  );

  tasks.push({
    name: 'retention-prune',
    everyMs: RETENTION_TASK_MS,
    run: () => {
      const removed =
        homeBattery.prune(db, options.config.retentionDays, nowMs()) +
        evStore.prune(db, options.config.retentionDays, nowMs());
      if (removed > 0) {
        log(`[daemon] retention-prune removed ${removed} raw rows (>${options.config.retentionDays}d)`);
      }
    },
  });

  sessionStore.insertEvent(db, {
    vehicleId: eventVehicleId,
    tsMs: nowMs(),
    kind: 'daemon_start',
  });
  return { lock, db, tasks, eventVehicleId };
}

async function teardown(
  prepared: Prepared,
  options: RunDaemonOptions,
  log: (message: string) => void,
  nowMs: () => number
): Promise<void> {
  try {
    sessionStore.insertEvent(prepared.db, {
      vehicleId: prepared.eventVehicleId,
      tsMs: nowMs(),
      kind: 'daemon_stop',
    });
  } finally {
    prepared.db.close();
    prepared.lock.release();
    // The daemon owns the handed-in services: disconnect stops any proxies
    // they spawned (only theirs — disconnect respects ownership).
    await options.services.franklin?.disconnect().catch(() => undefined);
    await options.services.tesla?.disconnect().catch(() => undefined);
  }
}

/** One pass of every task. ok = no task errored; errors come back per task. */
export async function runDaemonOnce(options: RunDaemonOptions): Promise<DaemonOutcome> {
  const log = options.log ?? (() => {});
  const nowMs = options.nowMs ?? Date.now;
  const prepared = await prepare({ ...options, log });
  try {
    const scheduler = createScheduler(prepared.tasks, (task, error) => {
      // runOnce collects errors itself; this guards against anything escaping
      // the collector. Kept identical to the continuous handler.
      (options.errorLog ?? console.error)(
        `[daemon] ${task.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    const taskResults = await scheduler.runOnce();
    const ok = Object.values(taskResults).every((result) => result === null);
    return { ok, taskResults };
  } finally {
    await teardown(prepared, options, log, nowMs);
  }
}

export interface DaemonHandle {
  /** Stop future ticks, drain in-flight work, tear everything down. */
  stop(): Promise<DaemonOutcome>;
  /** Resolves when stopped (via stop()); never rejects. */
  stopped: Promise<DaemonOutcome>;
}

/** Continuous mode. The caller wires SIGINT/SIGTERM to handle.stop(). */
export async function startDaemon(options: RunDaemonOptions): Promise<DaemonHandle> {
  const log = options.log ?? console.log;
  const nowMs = options.nowMs ?? Date.now;
  const prepared = await prepare(options);

  const scheduler = createScheduler(prepared.tasks, (task, error) => {
    (options.errorLog ?? console.error)(
      `[daemon] ${task.name}: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  scheduler.start();
  log(
    `[daemon] started at ${new Date(nowMs()).toISOString()} — tasks: ` +
      prepared.tasks.map((task) => task.name).join(', ')
  );

  let resolveStopped!: (outcome: DaemonOutcome) => void;
  const stopped = new Promise<DaemonOutcome>((resolve) => {
    resolveStopped = resolve;
  });

  let stopping = false;
  return {
    async stop(): Promise<DaemonOutcome> {
      if (stopping) return stopped;
      stopping = true;
      log('[daemon] stopping…');
      await scheduler.stop();
      await teardown(prepared, options, log, nowMs);
      log('[daemon] stopped');
      const outcome: DaemonOutcome = { ok: true, taskResults: {} };
      resolveStopped(outcome);
      return outcome;
    },
    stopped,
  };
}

