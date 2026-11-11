/**
 * P2 step 2 wiring: startDaemon hosts the read API on an ephemeral port,
 * logs the URL + token, enforces auth, and shuts the server down with the
 * daemon; `--once` never starts one. Fake services throughout — offline,
 * temp store/lock, explicit token (the credential-store default path is
 * pinned in tests/utils/credentials.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { runDaemonOnce, startDaemon } from '../../src/daemon/runDaemon.js';
import { DEFAULT_DAEMON_CONFIG, type DaemonConfig } from '../../src/utils/daemonConfig.js';
import type { FranklinWHService } from '../../src/services/FranklinWHService.js';
import type { TeslaService } from '../../src/services/TeslaService.js';
import type { BatteryFullStats } from '../../src/types/battery.js';

let dir: string;
let dbPath: string;
let lockFile: string;
let logs: string[];

const VIN = 'VIN-TEST';
const GW = 'GW-TEST';
const TOKEN = 'wired-token-123';

const CONFIG: DaemonConfig = {
  batterySampleSec: 3600,
  evStatusPollSec: 3600,
  evSamplePluggedSec: 3600,
  evSampleIdleSec: 3600,
  weatherFetchSec: 86_400,
  weatherBufferAdjPercent: 0,
  weatherSolarThresholdWhM2: 2000,
  retentionDays: 90,
  notifiers: [{ type: 'log' }],
  autoStart: DEFAULT_DAEMON_CONFIG.autoStart,
};

function franklinStats(): BatteryFullStats {
  return {
    current: {
      solarProduction: 0, generatorProduction: 0, generatorEnabled: false,
      batteryUse: 0, gridUse: 0, homeLoad: 100, batterySoc: 70,
      switch1Load: 0, switch2Load: 0, v2lUse: 0, gridStatus: 'NORMAL',
    },
    totals: {
      batteryCharge: 0, batteryDischarge: 0, gridImport: 0, gridExport: 0,
      solar: 0, generator: 0, homeUse: 0, switch1Use: 0, switch2Use: 0,
      v2lExport: 0, v2lImport: 0,
    },
  };
}

function fakeFranklin() {
  return {
    async getStats(): Promise<BatteryFullStats> {
      return franklinStats();
    },
    async reconnect() {},
    async disconnect() {},
  };
}

function fakeTesla() {
  return {
    async getVehicleState() {
      return { state: 'online' };
    },
    async getStatus() {
      return {
        vin: VIN, displayName: 'Test', state: 'online',
        battery: { soc: 50, chargeLimit: 80, isCharging: false, chargingState: 'Stopped', chargeEnergyAdded: 0 },
      };
    },
    async setChargeLimit(_percent: number) {},
    async startCharging() {},
    async stopCharging() {},
    async disconnect() {},
  };
}

/** Parse the bound port from startDaemon's `[api] read API …` log line. */
function apiPort(): number {
  const line = logs.find((entry) => entry.includes('[api] read API'));
  expect(line, 'expected the [api] log line').toBeDefined();
  const match = line!.match(/127\.0\.0\.1:(\d+)/);
  expect(match).toBeDefined();
  return Number(match![1]);
}

async function get(port: number, pathname: string, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-apiw-'));
  dbPath = path.join(dir, 'data.sqlite');
  lockFile = path.join(dir, 'daemon.lock');
  logs = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('startDaemon with api option', () => {
  it('serves /api/now with the token, then stops serving on stop()', async () => {
    const handle = await startDaemon({
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
      log: (message) => logs.push(message),
      api: { port: 0, token: TOKEN },
    });

    const port = apiPort();
    const authed = await get(port, '/api/now', TOKEN);
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as { nowMs: number; battery: { socPercent: number } | null };
    expect(typeof body.nowMs).toBe('number');
    expect(body.battery?.socPercent).toBe(70);
    expect((await get(port, '/api/now')).status).toBe(401);

    const outcome = await handle.stop();
    expect(outcome.ok).toBe(true);
    await expect(get(port, '/api/now', TOKEN)).rejects.toThrow();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('fails the daemon start when the port is taken, releasing lock and store', async () => {
    const squatter = net.createServer();
    // exclusive: without it macOS/BSD SO_REUSEADDR lets both sockets bind the
    // same port and the conflict never surfaces.
    await new Promise<void>((resolve) =>
      squatter.listen({ port: 0, host: '127.0.0.1', exclusive: true }, resolve)
    );
    const taken = (squatter.address() as net.AddressInfo).port;
    try {
      await expect(
        startDaemon({
          services: {
            franklin: fakeFranklin() as unknown as FranklinWHService,
            tesla: null,
          },
          homeBatteryId: GW,
          config: CONFIG,
          dbPath,
          lockFile,
          getHomeLocation: async () => undefined,
          log: (message) => logs.push(message),
          api: { port: taken, token: TOKEN },
        })
      ).rejects.toThrow(/EADDRINUSE|address already in use/);
      expect(fs.existsSync(lockFile)).toBe(false);
      expect(logs.some((entry) => entry.includes('[api] read API'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});

describe('runDaemonOnce with api option', () => {
  it('runs one cycle without ever starting a server', async () => {
    const outcome = await runDaemonOnce({
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
      log: (message) => logs.push(message),
      api: { port: 0, token: TOKEN },
    });
    expect(outcome.ok).toBe(true);
    expect(logs.some((entry) => entry.includes('[api]'))).toBe(false);
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});

