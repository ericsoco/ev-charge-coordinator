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
import type { NotificationEvent } from '../../src/notifiers/types.js';
import type { EVStatus } from '../../src/types/ev.js';
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
let commandCalls: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-decision-consumer-'));
  db = openStore(path.join(dir, 'data.sqlite'));
  logs = [];
  commandCalls = [];
  homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 1, socPercent: 90 });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Post-limit status read: only isCharging matters to the start decision. */
function evStatus(isCharging: boolean): EVStatus {
  return {
    vin: 'VIN',
    displayName: 'Test',
    state: 'online',
    battery: {
      soc: 51,
      chargeLimit: 67,
      isCharging,
      chargingState: isCharging ? 'Charging' : 'Stopped',
      chargeEnergyAdded: 0,
    },
  };
}

function consumer(overrides: Partial<DecisionConsumerDeps> = {}) {
  return createDecisionConsumer({
    db,
    getVehicleLocation: async () => ({ ...HOME }),
    getHomeLocation: async () => ({ ...HOME }),
    getStatus: async () => evStatus(false),
    vehicleId: 'VIN',
    homeBatteryId: 'GW',
    // Shipped default: merge dark. Live-actuation tests override enabled: true.
    autoStart: { enabled: false, filters: [{ type: 'geofence', radiusM: 100 }] },
    dryRun: false,
    startRetryDelayMs: 1,
    chargeCommands: {
      setChargeLimit: async (percent) => {
        commandCalls.push(`setChargeLimit:${percent}`);
      },
      startCharging: async () => {
        commandCalls.push('startCharging');
      },
    },
    getEnergyConfig: () => CFG,
    log: (message) => logs.push(message),
    ...overrides,
  });
}

describe('notifications (design §3.7)', () => {
  function recordingConsumer(overrides: Partial<DecisionConsumerDeps> = {}) {
    const events: NotificationEvent[] = [];
    const run = consumer({
      notify: async (event) => {
        events.push(event);
      },
      ...overrides,
    });
    return { events, run };
  }

  it('emits decision-made for the dark dry-run verdict', async () => {
    const { events, run } = recordingConsumer();
    await run(CTX);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'decision-made',
      vehicleId: 'VIN',
      sessionId: 7,
      accepted: false, // dry records the verdict without acting
      dryRun: true,
      reasonCode: 'dry_run',
      evSocPercent: 40,
      targetPercent: expect.any(Number),
    });
  });

  it('emits decision-made for a live start', async () => {
    const { events, run } = recordingConsumer({
      autoStart: { enabled: true, filters: [{ type: 'always' }] },
    });
    await run(CTX);
    expect(commandCalls).toContain('startCharging');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'decision-made',
      accepted: true,
      dryRun: false,
      reasonCode: 'started',
    });
    const event = events[0];
    if (event.type !== 'decision-made') throw new Error('unexpected event type');
    expect(typeof event.targetPercent).toBe('number');
  });

  it('emits nothing for a duplicate-session audit row', async () => {
    const { events, run } = recordingConsumer();
    await run(CTX);
    await run(CTX); // same session: the duplicate guard records, never pushes
    expect(events).toHaveLength(1);
  });

  it('isolates a rejecting notifier: the decision still records', async () => {
    const run = consumer({
      notify: async () => {
        throw new Error('webhook down');
      },
    });
    await expect(run(CTX)).resolves.toBeUndefined();
    expect(decisionStore.decisionForSession(db, 7)).not.toBeNull();
    expect(logs.join('\n')).toContain('[decision] notify failed: webhook down');
  });
});

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

describe('actuation (live mode only)', () => {
  const LIVE: Partial<DecisionConsumerDeps> = { autoStart: { enabled: true, filters: [] } };

  it('a live accepted decision sets the limit first, then starts charging', async () => {
    await consumer(LIVE)(CTX);
    expect(commandCalls).toEqual(['setChargeLimit:51', 'startCharging']);
    const row = decisionStore.decisionForSession(db, 7)!;
    expect(row).toMatchObject({
      accepted: 1,
      dryRun: 0,
      reasonCode: 'started',
      limitedBy: 'none',
    });
    expect(row.reasonDetail).toContain('51%');
  });

  it('the dry-run flag records dry_run with zero command calls', async () => {
    await consumer({ ...LIVE, dryRun: true })(CTX);
    expect(commandCalls).toEqual([]);
    const row = decisionStore.decisionForSession(db, 7)!;
    expect(row).toMatchObject({ accepted: 0, dryRun: 1, reasonCode: 'dry_run' });
  });

  it('disabled mode makes zero command calls (merge dark)', async () => {
    await consumer()(CTX); // default autoStart.enabled: false
    expect(commandCalls).toEqual([]);
    expect(decisionStore.decisionForSession(db, 7)!.dryRun).toBe(1);
  });

  it('a declined decision (live) makes zero command calls', async () => {
    await consumer({
      autoStart: { enabled: true, filters: [{ type: 'geofence', radiusM: 100 }] },
      getHomeLocation: async () => undefined,
    })(CTX);
    expect(commandCalls).toEqual([]);
    expect(decisionStore.decisionForSession(db, 7)!.reasonCode).toBe('filter_declined');
  });

  it('setChargeLimit failing records service_error and never starts charging', async () => {
    const decide = consumer({
      ...LIVE,
      chargeCommands: {
        setChargeLimit: async () => {
          commandCalls.push('setChargeLimit:51');
          throw new Error('proxy not reachable');
        },
        startCharging: async () => {
          commandCalls.push('startCharging');
        },
      },
    });
    await decide(CTX);
    expect(commandCalls).toEqual(['setChargeLimit:51']);
    const row = decisionStore.decisionForSession(db, 7)!;
    expect(row).toMatchObject({ accepted: 0, dryRun: 0, reasonCode: 'service_error' });
    expect(row.reasonDetail).toContain('proxy not reachable');
    expect(row.reasonDetail).toContain('51%');
  });

  it('startCharging failing records service_error with the target as evidence', async () => {
    const decide = consumer({
      ...LIVE,
      chargeCommands: {
        setChargeLimit: async (percent) => {
          commandCalls.push(`setChargeLimit:${percent}`);
        },
        startCharging: async () => {
          commandCalls.push('startCharging');
          throw new Error('vehicle accepted but is not charging (state: Disconnected)');
        },
      },
    });
    await decide(CTX);
    expect(commandCalls).toEqual(['setChargeLimit:51', 'startCharging']);
    const row = decisionStore.decisionForSession(db, 7)!;
    expect(row).toMatchObject({
      accepted: 0,
      dryRun: 0,
      reasonCode: 'service_error',
      limitedBy: 'none',
    });
    expect(row.reasonDetail).toContain('not charging');
    expect(row.reasonDetail).toContain('51%');
  });

  it('an auto-resumed car skips the start command (post-limit status read)', async () => {
    await consumer({ ...LIVE, getStatus: async () => evStatus(true) })(CTX);
    expect(commandCalls).toEqual(['setChargeLimit:51']);
    const row = decisionStore.decisionForSession(db, 7)!;
    expect(row.reasonCode).toBe('started');
    expect(row.reasonDetail).toContain('auto-resumed');
  });

  it('a complete-rejection race retries the start once and succeeds', async () => {
    let starts = 0;
    const decide = consumer({
      ...LIVE,
      chargeCommands: {
        setChargeLimit: async (percent) => {
          commandCalls.push(`setChargeLimit:${percent}`);
        },
        startCharging: async () => {
          commandCalls.push('startCharging');
          starts += 1;
          if (starts < 2) {
            throw new Error(
              'Vehicle rejected the command: car could not execute command: complete (charging has already completed)'
            );
          }
        },
      },
    });
    await decide(CTX);
    expect(commandCalls).toEqual(['setChargeLimit:51', 'startCharging', 'startCharging']);
    expect(decisionStore.decisionForSession(db, 7)!.reasonCode).toBe('started');
  });

  it('a persistent complete-rejection stays an honest service_error', async () => {
    const decide = consumer({
      ...LIVE,
      chargeCommands: {
        setChargeLimit: async (percent) => {
          commandCalls.push(`setChargeLimit:${percent}`);
        },
        startCharging: async () => {
          commandCalls.push('startCharging');
          throw new Error(
            'Vehicle rejected the command: car could not execute command: complete (charging has already completed)'
          );
        },
      },
    });
    await decide(CTX);
    expect(commandCalls).toEqual(['setChargeLimit:51', 'startCharging', 'startCharging']);
    const row = decisionStore.decisionForSession(db, 7)!;
    expect(row.reasonCode).toBe('service_error');
    expect(row.reasonDetail).toContain('complete');
  });
});

