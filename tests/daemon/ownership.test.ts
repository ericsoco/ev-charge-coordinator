/**
 * Ownership attribution: the pure rule (needsOwnerAttribution /
 * isManagedEpisode) and the EvPoller edge that appends the episode rows
 * (EVCC claims suppress, foreign starts label manual|scheduled, restart
 * reconciliation reuses one rule).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as sessionStore from '../../src/store/SessionStore.js';
import * as evStore from '../../src/store/EvStore.js';
import {
  foreignOwner,
  isManagedEpisode,
  needsOwnerAttribution,
} from '../../src/daemon/ownership.js';
import { createEvPoller, type EvPollerDeps } from '../../src/daemon/EvPoller.js';
import type { ChargingScheduleSnapshot, EVStatus } from '../../src/types/ev.js';

const VEHICLE = 'VIN-TEST';
const BATTERY = 'GW-TEST';

describe('needsOwnerAttribution (pure)', () => {
  const ownerRow = (owner: 'evcc' | 'manual' | 'scheduled', fromTsMs: number) => ({
    id: 1,
    siteId: 'home' as const,
    sessionId: 1,
    owner,
    fromTsMs,
  });

  it('attributes when no row exists yet', () => {
    expect(
      needsOwnerAttribution({ chargingState: 'Charging', lastOwner: null, lastStopTsMs: null })
    ).toBe(true);
  });

  it('a row written after the last stop covers the episode', () => {
    expect(
      needsOwnerAttribution({
        chargingState: 'Charging',
        lastOwner: ownerRow('evcc', 5_000),
        lastStopTsMs: 4_000,
      })
    ).toBe(false);
    expect(
      needsOwnerAttribution({
        chargingState: 'Charging',
        lastOwner: ownerRow('manual', 5_000),
        lastStopTsMs: null,
      })
    ).toBe(false);
  });

  it('a row from before the last stop is stale — the new episode needs one', () => {
    expect(
      needsOwnerAttribution({
        chargingState: 'Charging',
        lastOwner: ownerRow('evcc', 3_000),
        lastStopTsMs: 4_000,
      })
    ).toBe(true);
  });

  it('does nothing when not charging', () => {
    expect(
      needsOwnerAttribution({ chargingState: 'Stopped', lastOwner: null, lastStopTsMs: null })
    ).toBe(false);
  });
});

describe('foreignOwner / isManagedEpisode (pure)', () => {
  const row = (owner: 'evcc' | 'manual' | 'scheduled') => ({
    id: 1,
    siteId: 'home' as const,
    sessionId: 1,
    owner,
    fromTsMs: 1,
  });

  it('labels foreign starts by schedule activity', () => {
    expect(foreignOwner(true)).toBe('scheduled');
    expect(foreignOwner(false)).toBe('manual');
  });

  it('manages only EVCC episodes that were never released', () => {
    expect(isManagedEpisode({ lastOwner: null, releasedTsMs: null })).toBe(true); // pre-attribution
    expect(isManagedEpisode({ lastOwner: row('evcc'), releasedTsMs: null })).toBe(true);
    expect(isManagedEpisode({ lastOwner: row('manual'), releasedTsMs: null })).toBe(false);
    expect(isManagedEpisode({ lastOwner: row('scheduled'), releasedTsMs: null })).toBe(false);
    expect(isManagedEpisode({ lastOwner: row('evcc'), releasedTsMs: 9 })).toBe(false);
  });
});

describe('EvPoller ownership attribution', () => {
  let dir: string;
  let db: DatabaseSync;
  let logs: string[];
  let now: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-ownership-'));
    db = openStore(path.join(dir, 'data.sqlite'));
    logs = [];
    now = 1_000_000;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function status(chargingState: string): EVStatus {
    return {
      vin: VEHICLE,
      displayName: 'Test',
      state: 'online',
      battery: {
        soc: 40,
        chargeLimit: 80,
        isCharging: chargingState === 'Charging',
        chargingState,
      },
    };
  }

  function poller(options: {
    chargingStates: string[];
    schedule?: ChargingScheduleSnapshot | null;
  }) {
    let tick = 0;
    const deps: EvPollerDeps = {
      db,
      ev: {
        getVehicleState: async () => ({ state: 'online' }),
        getStatus: async () =>
          status(options.chargingStates[Math.min(tick++, options.chargingStates.length - 1)]),
        ...(options.schedule === undefined
          ? {}
          : { getChargingSchedule: async () => options.schedule ?? null }),
      },
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      statusPollSec: 60,
      samplePluggedSec: 0,
      sampleIdleSec: 0,
      nowMs: () => now,
      log: (message) => logs.push(message),
    };
    return createEvPoller(deps);
  }

  it('labels an unclaimed start manual (no schedule introspection)', async () => {
    const task = poller({ chargingStates: ['Stopped', 'Charging'] });
    await task.run(); // baseline
    now += 1_000;
    await task.run(); // transition → Charging
    const open = sessionStore.openSessionFor(db, VEHICLE)!;
    expect(sessionStore.sessionOwners(db, open.id)).toMatchObject([{ owner: 'manual' }]);
    expect(logs.join('\n')).toContain('charging episode owned by manual');
  });

  it('labels a start scheduled when a schedule window is active', async () => {
    const at = new Date(now);
    at.setHours(23, 0, 0, 0);
    now = at.getTime(); // inside the 22:00→06:00 window below
    const schedule: ChargingScheduleSnapshot = {
      windows: [
        { kind: 'charging', daysOfWeek: null, startMinute: 22 * 60, endMinute: 6 * 60, enabled: true },
      ],
    };
    const task = poller({ chargingStates: ['Stopped', 'Charging'], schedule });
    await task.run();
    now += 1_000;
    await task.run();
    const open = sessionStore.openSessionFor(db, VEHICLE)!;
    expect(sessionStore.lastSessionOwner(db, open.id)?.owner).toBe('scheduled');
  });

  it('an EVCC claim suppresses attribution', async () => {
    const task = poller({ chargingStates: ['Charging'] });
    const open = sessionStore.openSession(db, {
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      plugTsMs: now - 5_000,
    });
    // The claim the actuation path writes before its start command.
    sessionStore.appendSessionOwner(db, open, 'evcc', now - 1_000);
    await task.run();
    await task.run();
    expect(sessionStore.sessionOwners(db, open)).toHaveLength(1);
  });

  it('attributes a new episode after a stop (stale claim does not cover it)', async () => {
    const task = poller({ chargingStates: ['Charging'] });
    const open = sessionStore.openSession(db, {
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      plugTsMs: now - 20_000,
    });
    sessionStore.appendSessionOwner(db, open, 'evcc', now - 20_000);
    sessionStore.insertEvent(db, {
      vehicleId: VEHICLE,
      tsMs: now - 10_000,
      kind: 'charging_stop',
    });
    await task.run();
    expect(sessionStore.sessionOwners(db, open)).toMatchObject([
      { owner: 'evcc' },
      { owner: 'manual' },
    ]);
  });

  it('restart reconciliation dates the row at the episode start event', async () => {
    const task = poller({ chargingStates: ['Charging'] });
    const open = sessionStore.openSession(db, {
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      plugTsMs: now - 10_000,
    });
    sessionStore.insertEvent(db, {
      vehicleId: VEHICLE,
      tsMs: now - 8_000,
      kind: 'charging_start',
    });
    await task.run();
    expect(sessionStore.lastSessionOwner(db, open)).toMatchObject({
      owner: 'manual',
      fromTsMs: now - 8_000,
    });
  });

  it('a failing schedule read degrades to manual (logged)', async () => {
    let tick = 0;
    const task = createEvPoller({
      db,
      ev: {
        getVehicleState: async () => ({ state: 'online' }),
        getStatus: async () => status(tick++ === 0 ? 'Stopped' : 'Charging'),
        getChargingSchedule: async () => {
          throw new Error('asleep');
        },
      },
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      statusPollSec: 60,
      samplePluggedSec: 0,
      sampleIdleSec: 0,
      nowMs: () => now,
      log: (message) => logs.push(message),
    });
    await task.run(); // baseline (opens the session via init reconcile)
    now += 1_000;
    await task.run(); // transition → Charging
    const open = sessionStore.openSessionFor(db, VEHICLE)!;
    expect(sessionStore.lastSessionOwner(db, open.id)?.owner).toBe('manual');
    expect(logs.join('\n')).toContain('schedule read failed');
  });

  it('does nothing while not charging', async () => {
    const task = poller({ chargingStates: ['Stopped'] });
    await task.run();
    const open = sessionStore.openSessionFor(db, VEHICLE);
    if (open !== null) {
      expect(sessionStore.sessionOwners(db, open.id)).toEqual([]);
    }
    expect(evStore.latestSample(db, VEHICLE)?.chargingState).toBe('Stopped');
  });
});
