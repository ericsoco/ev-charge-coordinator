/**
 * runDaemon lifecycle: validation, lock, tasks landing rows, lifecycle
 * events bracketing the run, teardown. Fake services throughout — no
 * network, no keychain; continuous mode uses real timers at tiny intervals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openStore } from '../../src/store/database.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';
import * as evStore from '../../src/store/EvStore.js';
import * as sessionStore from '../../src/store/SessionStore.js';
import { acquireLock } from '../../src/daemon/lockfile.js';
import { runDaemonOnce, startDaemon } from '../../src/daemon/runDaemon.js';
import { DEFAULT_DAEMON_CONFIG, type DaemonConfig } from '../../src/utils/daemonConfig.js';
import type { FranklinWHService } from '../../src/services/FranklinWHService.js';
import type { TeslaService } from '../../src/services/TeslaService.js';
import type { BatteryFullStats } from '../../src/types/battery.js';
import type { EVStatus } from '../../src/types/ev.js';

let dir: string;
let dbPath: string;
let lockFile: string;

const VIN = 'VIN-TEST';
const GW = 'GW-TEST';

const CONFIG: DaemonConfig = {
  batterySampleSec: 60,
  evStatusPollSec: 1,
  evSamplePluggedSec: 0,
  evSampleIdleSec: 0,
  weatherFetchSec: 3600,
  retentionDays: 90,
  notifiers: [{ type: 'log' }],
  autoStart: DEFAULT_DAEMON_CONFIG.autoStart,
};
const FAST: DaemonConfig = { ...CONFIG, batterySampleSec: 0.02 };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-daemon-'));
  dbPath = path.join(dir, 'data.sqlite');
  lockFile = path.join(dir, 'daemon.lock');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function franklinStats(): BatteryFullStats {
  return {
    current: {
      solarProduction: 100, generatorProduction: 0, generatorEnabled: false,
      batteryUse: -300, gridUse: 0, homeLoad: 400, batterySoc: 70,
      switch1Load: 0, switch2Load: 0, v2lUse: 0, gridStatus: 'NORMAL',
    },
    totals: {
      batteryCharge: 1, batteryDischarge: 2, gridImport: 0, gridExport: 0,
      solar: 3, generator: 0, homeUse: 4, switch1Use: 0, switch2Use: 0,
      v2lExport: 0, v2lImport: 0,
    },
  };
}

function evStatus(chargingState: string): EVStatus {
  return {
    vin: VIN, displayName: 'Test', state: 'online',
    battery: { soc: 50, chargeLimit: 80, isCharging: false, chargingState, chargeEnergyAdded: 0 },
  };
}

function fakeFranklin(shouldThrow = false) {
  return {
    disconnected: false,
    async getStats(): Promise<BatteryFullStats> {
      if (shouldThrow) throw new Error('gateway down');
      return franklinStats();
    },
    async reconnect() {
      // Recovery itself succeeds; the retry below still fails, so the task's
      // reported error stays the read failure the assertion pins.
    },
    async disconnect() {
      this.disconnected = true;
    },
  };
}

function fakeTesla() {
  return {
    disconnected: false,
    async getVehicleState() {
      return { state: 'online' };
    },
    async getStatus() {
      return evStatus('Disconnected');
    },
    async disconnect() {
      this.disconnected = true;
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Reopen the (daemon-closed) store to inspect final state. */
function inspect() {
  const db = openStore(dbPath);
  const kinds = (db.prepare('SELECT kind FROM events ORDER BY ts_ms, id').all() as unknown as {
    kind: string;
  }[]).map((row) => row.kind);
  return {
    kinds,
    battery: homeBattery.latestSample(db),
    ev: evStore.latestSample(db, VIN),
    sessions: sessionStore.recentSessions(db, 5),
    db,
  };
}

describe('runDaemonOnce', () => {
  it('runs every task, lands rows, brackets with lifecycle events, tears down', async () => {
    const franklin = fakeFranklin();
    const tesla = fakeTesla();
    const outcome = await runDaemonOnce({
      services: {
        franklin: franklin as unknown as FranklinWHService,
        tesla: tesla as unknown as TeslaService,
      },
      homeBatteryId: GW,
      vehicleId: VIN,
      config: CONFIG,
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined, // weather skips; nothing touches the network
      log: () => {},
    });

    expect(outcome.ok).toBe(true);
    expect(Object.values(outcome.taskResults)).toEqual([null, null, null, null]);

    const state = inspect();
    state.db.close();
    expect(state.battery?.socPercent).toBe(70);
    expect(state.ev?.chargingState).toBe('Disconnected');
    expect(state.kinds).toEqual(['daemon_start', 'daemon_stop']);
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(franklin.disconnected).toBe(true);
    expect(tesla.disconnected).toBe(true);
  });

  it('reports a failed task while the others still run', async () => {
    const outcome = await runDaemonOnce({
      services: {
        franklin: fakeFranklin(true) as unknown as FranklinWHService,
        tesla: fakeTesla() as unknown as TeslaService,
      },
      homeBatteryId: GW,
      vehicleId: VIN,
      config: CONFIG,
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      log: () => {},
    });

    expect(outcome.ok).toBe(false);
    expect((outcome.taskResults['battery-sample'] as Error).message).toBe('gateway down');

    const state = inspect();
    state.db.close();
    expect(state.battery).toBeNull();
    expect(state.ev).not.toBeNull(); // EV side unaffected
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('records its spawned franklin proxy and clears its own record on teardown', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const cleared: number[] = [];
    const franklin = {
      ...fakeFranklin(),
      spawnedProxyPid: 4321,
      sharedToken: 'tok',
      listeningPort: 3001,
    };

    const outcome = await runDaemonOnce({
      services: {
        franklin: franklin as unknown as FranklinWHService,
        tesla: null,
      },
      homeBatteryId: GW,
      config: CONFIG,
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      nowMs: () => 1_000_000,
      log: () => {},
      runtimeState: {
        write: (state) => writes.push(state),
        read: () => ({ pid: 4321 }),
        clear: () => cleared.push(1),
      },
    });

    expect(outcome.ok).toBe(true);
    expect(writes).toEqual([{ pid: 4321, port: 3001, startedAt: 1_000_000, token: 'tok' }]);
    expect(cleared).toEqual([1]);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('writes no record when it did not spawn the proxy (attached)', async () => {
    const writes: number[] = [];
    const cleared: number[] = [];
    const franklin = fakeFranklin(); // no spawnedProxyPid → attached or none

    await runDaemonOnce({
      services: {
        franklin: franklin as unknown as FranklinWHService,
        tesla: null,
      },
      homeBatteryId: GW,
      config: CONFIG,
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      log: () => {},
      runtimeState: {
        write: () => writes.push(1),
        read: () => ({ pid: 999 }),
        clear: () => cleared.push(1),
      },
    });

    expect(writes).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it('leaves a record someone else has since written (never clears theirs)', async () => {
    const cleared: number[] = [];
    const franklin = {
      ...fakeFranklin(),
      spawnedProxyPid: 4321,
      sharedToken: 'tok',
      listeningPort: 3001,
    };

    await runDaemonOnce({
      services: {
        franklin: franklin as unknown as FranklinWHService,
        tesla: null,
      },
      homeBatteryId: GW,
      config: CONFIG,
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      log: () => {},
      runtimeState: {
        write: () => undefined,
        read: () => ({ pid: 999 }), // someone re-recorded the slot
        clear: () => cleared.push(1),
      },
    });

    expect(cleared).toEqual([]);
  });

  it('refuses both-services-missing and missing ids', async () => {
    const base = {
      config: CONFIG,
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      log: () => {},
    };
    await expect(
      runDaemonOnce({ ...base, services: { franklin: null, tesla: null } })
    ).rejects.toThrow(/No services available/);
    await expect(
      runDaemonOnce({
        ...base,
        services: { franklin: fakeFranklin() as unknown as FranklinWHService, tesla: null },
      })
    ).rejects.toThrow(/homeBatteryId/);
    await expect(
      runDaemonOnce({
        ...base,
        services: { franklin: null, tesla: fakeTesla() as unknown as TeslaService },
      })
    ).rejects.toThrow(/vehicleId/);
  });

  it('refuses to start when another holder owns the lock', async () => {
    const holder = await acquireLock(lockFile);
    await expect(
      runDaemonOnce({
        services: {
          franklin: fakeFranklin() as unknown as FranklinWHService,
          tesla: fakeTesla() as unknown as TeslaService,
        },
        homeBatteryId: GW,
        vehicleId: VIN,
        config: CONFIG,
        dbPath,
        lockFile,
        getHomeLocation: async () => undefined,
        log: () => {},
      })
    ).rejects.toThrow(/already running/i);
    holder.release();
  });
});

describe('startDaemon (continuous)', () => {
  it('samples on its own cadence and tears down cleanly on stop()', async () => {
    const franklin = fakeFranklin();
    const tesla = fakeTesla();
    const handle = await startDaemon({
      services: {
        franklin: franklin as unknown as FranklinWHService,
        tesla: tesla as unknown as TeslaService,
      },
      homeBatteryId: GW,
      vehicleId: VIN,
      config: FAST, // battery every 20ms
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      log: () => {},
    });

    // Rows accumulate while running.
    const running = openStoreReadOnlyForWait();
    await waitFor(() => homeBattery.latestSample(running) !== null);
    running.close();

    const outcome = await handle.stop();
    expect(outcome.ok).toBe(true);

    const state = inspect();
    state.db.close();
    expect(state.kinds).toEqual(['daemon_start', 'daemon_stop']);
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(franklin.disconnected).toBe(true);
    expect(tesla.disconnected).toBe(true);

    // Quiet after stop: reopening later must not reveal fresh rows... rows are
    // whatever existed at stop; the lock's release proves full teardown.
  });

  it('a persistently failing task logs errors while the daemon keeps sampling', async () => {
    const errors: string[] = [];
    const handle = await startDaemon({
      services: {
        franklin: fakeFranklin(true) as unknown as FranklinWHService,
        tesla: fakeTesla() as unknown as TeslaService,
      },
      homeBatteryId: GW,
      vehicleId: VIN,
      config: FAST,
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      log: () => {},
      errorLog: (message) => errors.push(message),
    });

    const running = openStoreReadOnlyForWait();
    await waitFor(() => evStore.latestSample(running, VIN) !== null);
    await waitFor(() => errors.some((message) => message.includes('battery-sample')));

    await handle.stop();
    running.close();

    const state = inspect();
    state.db.close();
    expect(state.ev).not.toBeNull(); // the healthy task kept landing rows
    expect(state.battery).toBeNull();
  });
});

/** Live wait-connection for polling inside a running daemon (WAL readers). */
function openStoreReadOnlyForWait() {
  return openStore(dbPath);
}


