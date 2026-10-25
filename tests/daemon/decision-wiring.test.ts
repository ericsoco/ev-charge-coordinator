/**
 * EvPoller's decision seam: onVehiclePlugIn fires once per vehicle plug-in
 * with the fresh session id, never breaks sampling, and is optional
 * (absent = the P1a collect-only behavior).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import {
  createEvPoller,
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
  onVehiclePlugIn?: (ctx: VehiclePlugInContext) => Promise<void>
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
