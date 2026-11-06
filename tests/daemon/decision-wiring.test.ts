/**
 * EvPoller's chain seams: onVehiclePlugIn fires once per vehicle plug-in
 * with the fresh session id; onChargingProgress (P1c step 1, the session
 * monitor) fires on every rich read. Neither ever breaks sampling, and both
 * are optional (absent = the P1a collect-only behavior).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import {
  createEvPoller,
  type ChargingProgressContext,
  type VehiclePlugInContext,
} from '../../src/daemon/EvPoller.js';
import * as sessionStore from '../../src/store/SessionStore.js';
import * as evStore from '../../src/store/EvStore.js';
import type { EVStatus } from '../../src/types/ev.js';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-evpoller-seam-'));
  db = openStore(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One getStatus answer per tick, cycling through the given states. */
function evFake(chargingStates: string[]) {
  let tick = 0;
  return {
    async getVehicleState() {
      return { state: 'online' };
    },
    async getStatus(): Promise<EVStatus> {
      const chargingState = chargingStates[Math.min(tick, chargingStates.length - 1)];
      tick += 1;
      return {
        vin: 'VIN',
        displayName: 'Test',
        state: 'online',
        battery: {
          soc: 40,
          chargeLimit: 80,
          isCharging: false,
          chargingState,
          chargeEnergyAdded: 0,
        },
      };
    },
  };
}

function poller(
  fake: ReturnType<typeof evFake>,
  onVehiclePlugIn?: (ctx: VehiclePlugInContext) => Promise<void>,
  onChargingProgress?: (ctx: ChargingProgressContext) => Promise<void>
) {
  const logs: string[] = [];
  const task = createEvPoller({
    db,
    ev: fake,
    vehicleId: 'VIN',
    homeBatteryId: 'GW',
    statusPollSec: 1,
    samplePluggedSec: 0,
    sampleIdleSec: 0,
    log: (message) => logs.push(message),
    onVehiclePlugIn,
    onChargingProgress,
  });
  return { task, logs };
}

describe('EvPoller decision seam', () => {
  it('fires exactly once per vehicle plug-in with the fresh session id', async () => {
    const fake = evFake(['Disconnected', 'Stopped', 'Stopped']);
    const seen: VehiclePlugInContext[] = [];
    const { task } = poller(fake, async (ctx) => {
      seen.push(ctx);
    });

    await task.run(); // seeds lastChargingState = Disconnected
    await task.run(); // Disconnected → Stopped = vehicle plug-in
    await task.run(); // unchanged → no second call

    expect(seen).toHaveLength(1);
    const session = sessionStore.openSessionFor(db, 'VIN');
    expect(session).not.toBeNull();
    expect(seen[0]).toMatchObject({
      sessionId: session!.id,
      event: 'plug_in',
      chargingState: 'Stopped',
      evSocPercent: 40,
    });
    expect(evStore.latestSample(db, 'VIN')).not.toBeNull();
  });

  it('a rejecting consumer never breaks sampling', async () => {
    const fake = evFake(['Disconnected', 'Stopped']);
    const { task, logs } = poller(fake, async () => {
      throw new Error('decider down');
    });

    await task.run();
    await expect(task.run()).resolves.toBeUndefined();

    expect(logs.join('\n')).toContain('decision consumer failed');
    expect(sessionStore.openSessionFor(db, 'VIN')).not.toBeNull();
    expect(evStore.latestSample(db, 'VIN')).not.toBeNull();
  });

  it('runs collect-only when no consumer is wired (P1a behavior)', async () => {
    const fake = evFake(['Disconnected', 'Stopped']);
    const { task } = poller(fake);

    await task.run();
    await task.run();

    expect(sessionStore.openSessionFor(db, 'VIN')).not.toBeNull();
    expect(evStore.latestSample(db, 'VIN')).not.toBeNull();
  });
});

describe('EvPoller charging-progress seam (session monitor)', () => {
  it('fires on every rich read with the fresh state', async () => {
    const fake = evFake(['Disconnected', 'Charging', 'Charging']);
    const seen: ChargingProgressContext[] = [];
    const { task } = poller(fake, undefined, async (ctx) => {
      seen.push(ctx);
    });

    await task.run(); // seed read: Disconnected
    await task.run(); // Charging
    await task.run(); // Charging

    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ chargingState: 'Disconnected', evSocPercent: 40 });
    expect(seen[1].chargingState).toBe('Charging');
    expect(seen[2].chargingState).toBe('Charging');
    expect(seen[1].tsMs).toBeGreaterThan(0);
  });

  it('runs after the plug-in decision on the same tick (target armed first)', async () => {
    const fake = evFake(['Disconnected', 'Charging']);
    let monitorSawTarget: number | null = null;
    const { task } = poller(
      fake,
      async (ctx) => {
        sessionStore.setSessionTarget(db, ctx.sessionId, 47);
      },
      async () => {
        monitorSawTarget = sessionStore.openSessionFor(db, 'VIN')?.targetPercent ?? null;
      }
    );

    await task.run(); // seed
    await task.run(); // plug_in: decision arms 47, then the monitor reads it

    expect(monitorSawTarget).toBe(47);
  });

  it('a rejecting monitor never breaks sampling', async () => {
    const fake = evFake(['Disconnected', 'Stopped']);
    const { task, logs } = poller(fake, undefined, async () => {
      throw new Error('monitor down');
    });

    await task.run();
    await expect(task.run()).resolves.toBeUndefined();

    expect(logs.join('\n')).toContain('charging-progress stage failed');
    expect(evStore.latestSample(db, 'VIN')).not.toBeNull();
    expect(sessionStore.openSessionFor(db, 'VIN')).not.toBeNull();
  });
});
