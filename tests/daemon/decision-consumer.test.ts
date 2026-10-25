/**
 * Decision consumer per vehicle plug-in: Option-B location fetch,
 * deny-by-default declines, idempotency, never-throws isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as decisionStore from '../../src/store/DecisionStore.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';
import { createDecisionConsumer, type DecisionConsumerDeps } from '../../src/daemon/decisionConsumer.js';
import type { VehiclePlugInContext } from '../../src/daemon/EvPoller.js';
import type { EnergyConfig } from '../../src/utils/energy.js';

const HOME = { latitude: 37.7749, longitude: -122.4194 };
const CFG: EnergyConfig = {
  batteryCapacityKwh: 13.5,
  evBatteryKwh: 75,
  bufferPercent: 20,
  chargeEfficiency: 0.9,
};

let dir: string;
let db: DatabaseSync;
let logs: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-decision-consumer-'));
  db = openStore(path.join(dir, 'data.sqlite'));
  logs = [];
  homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 1, socPercent: 90 });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function consumer(overrides: Partial<DecisionConsumerDeps> = {}) {
  return createDecisionConsumer({
    db,
    getVehicleLocation: async () => ({ ...HOME }),
    getHomeLocation: async () => ({ ...HOME }),
    vehicleId: 'VIN',
    homeBatteryId: 'GW',
    autoStart: { enabled: true, filters: [{ type: 'geofence', radiusM: 100 }] },
    getEnergyConfig: () => CFG,
    log: (message) => logs.push(message),
    ...overrides,
  });
}

const CTX: VehiclePlugInContext = {
  tsMs: 1000,
  sessionId: 7,
  event: 'plug_in',
  chargingState: 'Stopped',
  evSocPercent: 40,
};

describe('decision consumer (per vehicle plug-in)', () => {
  it('records a dry-run decision with the full geofence audit (dark until actuation)', async () => {
    await consumer()(CTX);
    const row = decisionStore.decisionForSession(db, 7);
    expect(row).toMatchObject({
      siteId: 'home',
      vehicleId: 'VIN',
      homeBatteryId: 'GW',
      tsMs: 1000,
      sessionId: 7,
      accepted: 0,
      dryRun: 1,
      reasonCode: 'dry_run',
      limitedBy: 'none',
    });
    const audit = JSON.parse(row!.filterResultsJson!);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ type: 'geofence', pass: true, distanceM: 0 });
    expect(row!.reasonDetail).toContain('charge limit');
  });

  it('a failed location read declines location_unavailable (deny-by-default)', async () => {
    const decide = consumer({
      getVehicleLocation: async () => {
        throw new Error('scope missing');
      },
    });
    await decide(CTX);
    const row = decisionStore.decisionForSession(db, 7)!;
    expect(row.reasonCode).toBe('filter_declined');
    expect(JSON.parse(row.filterResultsJson!)[0].reason).toBe('location_unavailable');
    expect(logs.join('\n')).toContain('location read failed');
  });

  it('an unset home secret declines home_unset', async () => {
    await consumer({ getHomeLocation: async () => undefined })(CTX);
    const row = decisionStore.decisionForSession(db, 7)!;
    expect(row.reasonCode).toBe('filter_declined');
    expect(JSON.parse(row.filterResultsJson!)[0].reason).toBe('home_unset');
  });

  it('a second decision for the session records duplicate_session with no filters', async () => {
    const decide = consumer();
    await decide(CTX);
    await decide(CTX);
    const row = decisionStore.decisionForSession(db, 7)!;
    expect(row.reasonCode).toBe('duplicate_session');
    expect(JSON.parse(row.filterResultsJson!)).toEqual([]);
  });

  it('a home battery under the buffer declines below_buffer', async () => {
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 2, socPercent: 15 });
    await consumer()(CTX);
    expect(decisionStore.decisionForSession(db, 7)!.reasonCode).toBe('below_buffer');
  });

  it('never throws: failing secret and location reads still resolve', async () => {
    const decide = consumer({
      getVehicleLocation: async () => {
        throw new Error('car asleep');
      },
      getHomeLocation: async () => {
        throw new Error('keychain down');
      },
    });
    await expect(decide(CTX)).resolves.toBeUndefined();
    expect(decisionStore.decisionForSession(db, 7)!.reasonCode).toBe('filter_declined');
    expect(logs.join('\n')).toContain('home location read failed');
  });
});
