/**
 * System commands: status (no-side-effect report), sessions, and the
 * set-home-location confirmation flows. Injected paths/probes/clocks/credential
 * access — tests touch no keychain, no sockets, no real config dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandContext } from '../../src/commands/context.js';
import {
  formatAge,
  formatDuration,
  setHomeLocationCommand,
  showSessions,
  showStatus,
} from '../../src/commands/system.js';
import { openStore } from '../../src/store/database.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';
import * as sessions from '../../src/store/SessionStore.js';
import { acquireLock } from '../../src/daemon/lockfile.js';
import type { TeslaService } from '../../src/services/TeslaService.js';
import type { ResolvedEnergyConfig } from '../../src/utils/config.js';

let dir: string;
let dbPath: string;
let lockFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-syscmd-'));
  dbPath = path.join(dir, 'data.sqlite');
  lockFile = path.join(dir, 'daemon.lock');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ENERGY_OK: ResolvedEnergyConfig = {
  config: {
    batteryCapacityKwh: 13.5,
    evBatteryKwh: 75,
    bufferPercent: 20,
    chargeEfficiency: 0.9,
  },
  missing: [],
  invalid: [],
  partial: {},
};

function makeCtx(answers: string[] = []) {
  const asked: string[] = [];
  const lines: string[] = [];
  const ctx: CommandContext = {
    franklin: null,
    tesla: null,
    config: { resolve: () => ENERGY_OK, setField: () => {}, save: () => {} },
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? 'n';
    },
    interactive: true,
    log: (message) => lines.push(message),
    errorLog: (message) => lines.push(message),
  };
  return { ctx, asked, lines };
}

function seedStore(): void {
  const db = openStore(dbPath);
  homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 1_000, socPercent: 55 });
  const id = sessions.openSession(db, {
    vehicleId: 'VIN',
    homeBatteryId: 'GW',
    plugTsMs: 10_000,
  });
  sessions.closeOpenSession(db, 'VIN', 61_000);
  sessions.finalizeSession(db, id, {
    energyKwh: 5,
    energyPercent: 10,
    elapsedMs: 51_000,
    houseEnergyKwh: 6,
    efficiency: 5 / 6,
  });
  sessions.openSession(db, { vehicleId: 'VIN', homeBatteryId: 'GW', plugTsMs: 90_000 });
  db.close();
}

const STUB_PROXIES = {
  franklinProxyState: async () => ({ state: 'running' as const, pid: 123, port: 3001 }),
  teslaProxyState: async () => ({ state: 'running' as const }),
  vehicleStateProbe: async () => ({ state: 'online' as const }),
};

describe('showStatus', () => {
  it('reports a full machine-readable picture (json)', async () => {
    seedStore();
    const holder = await acquireLock(lockFile);
    const { ctx, lines } = makeCtx();

    const result = await showStatus(ctx, {
      json: true,
      dbPath,
      lockFile,
      nowMs: () => 100_000,
      getHomeLocation: async () => undefined,
      ...STUB_PROXIES,
    });
    holder.release();

    expect(result.ok).toBe(true);
    const report = JSON.parse(lines.join('\n'));
    expect(report.daemon).toMatchObject({ state: 'running', pid: process.pid });
    expect(report.store).toMatchObject({ path: dbPath, exists: true, schemaVersion: 3 });
    expect(report.store.counts).toMatchObject({ batterySamples: 1, sessions: 2, openSessions: 1 });
    expect(report.store.lastSample.battery).toBe('1970-01-01T00:00:01.000Z');
    expect(report.proxies).toEqual({
      franklin: { state: 'running', pid: 123, port: 3001 },
      teslaCommand: { state: 'running' },
    });
    expect(report.vehicle).toEqual({ state: 'online', error: null });
    expect(report.config.homeLocation).toBe('not set');
    // collectStatus resolves the real config file — none exists in the vitest
    // env, so the energy buffer is null here (the human-mode test covers the
    // rendered 20% via the ctx-provided config).
    expect(report.config.energyBufferPercent).toBeNull();
  });

  it('renders every section in human mode, without printing coordinates', async () => {
    seedStore();
    const holder = await acquireLock(lockFile);
    const { ctx, lines } = makeCtx();
    await showStatus(ctx, {
      dbPath,
      lockFile,
      nowMs: () => 100_000,
      getHomeLocation: async () => ({ latitude: 1, longitude: 2 }),
      ...STUB_PROXIES,
    });
    holder.release();

    const out = lines.join('\n');
    for (const section of ['System Status', 'Daemon', 'Proxies', 'Store', 'Config']) {
      expect(out).toContain(section);
    }
    expect(out).toContain('Battery Buffer: 20%');
    expect(out).toContain('home location: set');
    expect(out).not.toContain('1.00000');
  });

  it('renders vehicle probe variants and the unrecorded proxy honestly', async () => {
    const asleep = makeCtx();
    await showStatus(asleep.ctx, {
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      ...STUB_PROXIES,
      vehicleStateProbe: async () => ({ state: 'asleep' }),
      franklinProxyState: async () => ({ state: 'unrecorded' as const, pid: null, port: 3001 }),
    });
    const asleepOut = asleep.lines.join('\n');
    expect(asleepOut).toContain('asleep (live probe)');
    expect(asleepOut).toContain('running but unrecorded');
    expect(asleepOut).toContain('one-shot commands cannot attach (port 3001)');

    const failing = makeCtx();
    await showStatus(failing.ctx, {
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      ...STUB_PROXIES,
      vehicleStateProbe: async () => {
        throw new Error('boom');
      },
    });
    expect(failing.lines.join('\n')).toContain('probe failed (boom)');

    const noCreds = makeCtx();
    await showStatus(noCreds.ctx, {
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      ...STUB_PROXIES,
      vehicleStateProbe: async () => null,
    });
    expect(noCreds.lines.join('\n')).toContain('not probed (no stored credentials)');
  });

  it('reports stale and corrupt locks without crashing', async () => {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999_999, takenAt: 1 }));
    const { ctx, lines } = makeCtx();
    await showStatus(ctx, { dbPath, lockFile, getHomeLocation: async () => undefined, ...STUB_PROXIES });
    expect(lines.join('\n')).toContain('stale');

    fs.writeFileSync(lockFile, 'garbage');
    const second = makeCtx();
    const result = await showStatus(second.ctx, {
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      ...STUB_PROXIES,
    });
    expect(result.ok).toBe(true); // a report, not a failure
    expect(second.lines.join('\n')).toContain('unreadable');
  });

  it('reports a missing store as a valid state', async () => {
    const { ctx, lines } = makeCtx();
    const result = await showStatus(ctx, {
      dbPath,
      lockFile,
      getHomeLocation: async () => undefined,
      ...STUB_PROXIES,
    });
    expect(result.ok).toBe(true);
    expect(lines.join('\n')).toContain('no store yet');
  });
});

describe('showSessions', () => {
  it('lists sessions newest-first with aggregates footer', async () => {
    seedStore();
    const { ctx, lines } = makeCtx();
    const result = await showSessions(ctx, { dbPath });
    expect(result.ok).toBe(true);

    const out = lines.join('\n');
    expect(out).toContain('#2'); // open session, newest plug first
    expect(out).toContain('[open]');
    expect(out).toContain('#1');
    expect(out).toContain('energy 5.000 kWh');
    expect(out).toContain('house 6.000 kWh');
    expect(out).toContain('eff 0.833');
    expect(out).toContain('2 sessions (1 open, 1 closed)');
    const openLine = lines.findIndex((l) => l.includes('[open]'));
    const closedLine = lines.findIndex((l) => l.includes('51s'));
    expect(openLine).toBeLessThan(closedLine);
  });

  it('--open shows only open sessions; --limit caps the list', async () => {
    seedStore();
    const open = makeCtx();
    await showSessions(open.ctx, { dbPath, openOnly: true });
    const openOut = open.lines.join('\n');
    expect(openOut).toContain('[open]');
    expect(openOut).not.toContain('#1');

    const limited = makeCtx();
    await showSessions(limited.ctx, { dbPath, limit: 1 });
    const limitedOut = limited.lines.join('\n');
    expect(limitedOut).toContain('#2');
    expect(limitedOut).not.toContain('#1');
  });

  it('rejects a bad limit and handles empty/missing stores kindly', async () => {
    seedStore();
    const bad = makeCtx();
    const badResult = await showSessions(bad.ctx, { dbPath, limit: 0 });
    expect(badResult.ok).toBe(false);

    const missing = makeCtx();
    const missingResult = await showSessions(missing.ctx, { dbPath: path.join(dir, 'none.sqlite') });
    expect(missingResult.ok).toBe(true);
    expect(missing.lines.join('\n')).toContain('No sessions recorded yet');
  });
});

describe('setHomeLocationCommand', () => {
  function fakeTesla(location = { latitude: 37.7749, longitude: -122.4194 }) {
    const calls = { wakes: 0, reads: 0 };
    const tesla = {
      isAuthenticated: () => true,
      wakeUp: async () => {
        calls.wakes++;
      },
      getVehicleLocation: async () => {
        calls.reads++;
        return location;
      },
    };
    return { tesla: tesla as unknown as TeslaService, calls };
  }

  it('manual mode: y confirms and stores, showing current → new', async () => {
    const stored: number[][] = [];
    const { ctx, asked, lines } = makeCtx(['y']);
    const result = await setHomeLocationCommand(ctx, '37.77490', '-122.41940', {
      getHomeLocation: async () => undefined,
      setHomeLocation: async (lat, lng) => {
        stored.push([lat, lng]);
      },
    });

    expect(result.ok).toBe(true);
    expect(stored).toEqual([[37.7749, -122.4194]]);
    expect(asked[0]).toContain('Current home location: (not set)');
    expect(asked[0]).toContain('Set to 37.77490, -122.41940? (y/n)');
    expect(lines.join('\n')).toContain('stored as a secret');
  });

  it('manual mode: n cancels and stores nothing', async () => {
    let setCalls = 0;
    const { ctx, lines } = makeCtx(['n']);
    const result = await setHomeLocationCommand(ctx, '10', '20', {
      getHomeLocation: async () => ({ latitude: 1, longitude: 2 }),
      setHomeLocation: async () => {
        setCalls++;
      },
    });

    expect(result.ok).toBe(false);
    expect(setCalls).toBe(0);
    expect(lines.join('\n')).toContain('Cancelled — nothing stored');
  });

  it('rejects non-numeric or one-sided arguments before prompting', async () => {
    const { ctx, asked } = makeCtx(['y']);
    const result = await setHomeLocationCommand(ctx, 'abc', '20', {
      setHomeLocation: async () => {},
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/must be numbers/);
    expect(asked).toEqual([]);

    const oneSided = await setHomeLocationCommand(ctx, '10', undefined, {
      setHomeLocation: async () => {},
    });
    expect(oneSided.ok).toBe(false);
    expect((oneSided as { error: string }).error).toMatch(/Usage/);
  });

  it('vehicle flow: wakes, reads, confirms with the coords, stores', async () => {
    const { tesla, calls } = fakeTesla();
    const stored: number[][] = [];
    const { ctx, asked } = makeCtx(['y']);
    const result = await setHomeLocationCommand({ ...ctx, tesla }, undefined, undefined, {
      getHomeLocation: async () => undefined,
      setHomeLocation: async (lat, lng) => {
        stored.push([lat, lng]);
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual({ wakes: 1, reads: 1 });
    expect(stored).toEqual([[37.7749, -122.4194]]);
    expect(asked[0]).toContain('Vehicle reports 37.77490, -122.41940');
    expect(asked[0]).toContain('Current home location: (not set)');
  });

  it('vehicle flow: declining the confirmation stores nothing', async () => {
    const { tesla, calls } = fakeTesla();
    let setCalls = 0;
    const { ctx } = makeCtx(['n']);
    const result = await setHomeLocationCommand({ ...ctx, tesla }, undefined, undefined, {
      setHomeLocation: async () => {
        setCalls++;
      },
    });
    expect(result.ok).toBe(false);
    expect(calls.wakes).toBe(1); // wake happens on invocation, before confirm
    expect(setCalls).toBe(0);
  });

  it('vehicle flow: not connected → error; wake failure → error, nothing stored', async () => {
    const { ctx } = makeCtx(['y']);
    const disconnected = await setHomeLocationCommand(ctx, undefined, undefined, {
      setHomeLocation: async () => {},
    });
    expect(disconnected.ok).toBe(false);
    expect((disconnected as { error: string }).error).toMatch(/Tesla not connected/);

    const failing = {
      isAuthenticated: () => true,
      wakeUp: async () => {
        throw new Error('car unreachable');
      },
      getVehicleLocation: async () => ({ latitude: 1, longitude: 2 }),
    } as unknown as TeslaService;
    let setCalls = 0;
    const real = makeCtx(['y']);
    const result = await setHomeLocationCommand({ ...real.ctx, tesla: failing }, undefined, undefined, {
      setHomeLocation: async () => {
        setCalls++;
      },
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('car unreachable');
    expect(setCalls).toBe(0);
  });

  it('propagates setter validation errors (range)', async () => {
    const { ctx } = makeCtx(['y']);
    const result = await setHomeLocationCommand(ctx, '91', '0', {
      getHomeLocation: async () => undefined,
      setHomeLocation: async (lat) => {
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
          throw new Error(`latitude must be a number between -90 and 90 (got ${lat})`);
        }
      },
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/between -90 and 90/);
  });
});

describe('formatters', () => {
  it('scales units', () => {
    expect(formatAge(45_000)).toBe('45s ago');
    expect(formatAge(5 * 60_000)).toBe('5m ago');
    expect(formatAge(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m ago');
    expect(formatAge(50 * 86_400_000)).toBe('50d ago');
    expect(formatDuration(51_000)).toBe('51s');
    expect(formatDuration(8 * 3_600_000 + 12 * 60_000)).toBe('8h 12m');
  });
});



