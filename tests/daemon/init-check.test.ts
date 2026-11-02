/**
 * Program-init plug-in check: the first rich read of a poller treats a
 * plugged, not-charging car as a vehicle plug-in (the daemon-off → plug-in →
 * daemon-on sequence), the init wake fires once and only when enabled, and
 * restarts never re-fire an already-decided session.
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
import * as decisionStore from '../../src/store/DecisionStore.js';
import type { NotificationEvent } from '../../src/notifiers/types.js';
import type { EVStatus } from '../../src/types/ev.js';

let dir: string;
let db: DatabaseSync;

const VIN = 'VIN';
const GW = 'GW';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-init-check-'));
  db = openStore(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function evStatus(chargingState: string): EVStatus {
  return {
    vin: VIN,
    displayName: 'Test',
    state: 'online',
    battery: {
      soc: 40,
      chargeLimit: 80,
      isCharging: chargingState === 'Charging',
      chargingState,
      chargeEnergyAdded: 0,
    },
  };
}

/** Fake EV: mutable probe/state, call counters; wakeUp honors its contract. */
function evFake(chargingState: string, probe = 'online') {
  return {
    probe,
    status: evStatus(chargingState),
    probes: 0,
    reads: 0,
    wakes: 0,
    async getVehicleState() {
      this.probes++;
      return { state: this.probe };
    },
    async getStatus(): Promise<EVStatus> {
      this.reads++;
      return this.status;
    },
    async wakeUp() {
      this.wakes++;
      this.probe = 'online';
    },
  };
}

interface PollerOptions {
  onVehiclePlugIn?: (ctx: VehiclePlugInContext) => Promise<void>;
  notify?: (event: NotificationEvent) => Promise<void>;
  wakeAtInit?: boolean;
}

function poller(ev: ReturnType<typeof evFake>, options: PollerOptions = {}) {
  const logs: string[] = [];
  const task = createEvPoller({
    db,
    ev,
    vehicleId: VIN,
    homeBatteryId: GW,
    statusPollSec: 1,
    samplePluggedSec: 0,
    sampleIdleSec: 0,
    nowMs: () => 1_000,
    log: (message) => logs.push(message),
    onVehiclePlugIn: options.onVehiclePlugIn,
    notify: options.notify,
    wakeUp: () => ev.wakeUp(),
    wakeAtInit: options.wakeAtInit,
  });
  return { task, logs };
}

function eventKinds(): string[] {
  const rows = db
    .prepare('SELECT kind FROM events ORDER BY ts_ms, id')
    .all() as unknown as { kind: string }[];
  return rows.map((row) => row.kind);
}

describe('init plug-in check', () => {
  it('treats a plugged, not-charging car with no store baseline as a vehicle plug-in', async () => {
    const seen: VehiclePlugInContext[] = [];
    const events: NotificationEvent[] = [];
    const ev = evFake('Stopped');
    const { task, logs } = poller(ev, {
      onVehiclePlugIn: async (ctx) => {
        seen.push(ctx);
      },
      notify: async (event) => {
        events.push(event);
      },
    });

    await task.run(); // first rich read: no baseline → reconciliation
    await task.run(); // unchanged state → the check never re-runs

    const session = sessionStore.openSessionFor(db, VIN);
    expect(session).not.toBeNull();
    expect(eventKinds()).toEqual(['plug_in']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sessionId: session!.id,
      event: 'plug_in',
      chargingState: 'Stopped',
      evSocPercent: 40,
    });
    expect(events.map((event) => event.type)).toEqual(['plug-in-detected']);
    expect(logs.join('\n')).toContain('treating as vehicle plug-in');
    expect(evStore.latestSample(db, VIN)?.chargingState).toBe('Stopped');
  });

  it('does not double-fire when the store baseline shows the plug-in transition', async () => {
    // Baseline from a previous run: the transition path owns this plug-in;
    // the reconciliation must stay out of its way in the same tick.
    evStore.insertSample(db, {
      vehicleId: VIN,
      tsMs: 1,
      chargingState: 'Disconnected',
      socPercent: 40,
    });
    const seen: VehiclePlugInContext[] = [];
    const events: NotificationEvent[] = [];
    const ev = evFake('Stopped');
    const { task } = poller(ev, {
      onVehiclePlugIn: async (ctx) => {
        seen.push(ctx);
      },
      notify: async (event) => {
        events.push(event);
      },
    });

    await task.run();

    expect(seen).toHaveLength(1);
    expect(sessionStore.recentSessions(db, 5)).toHaveLength(1);
    expect(eventKinds()).toEqual(['plug_in']);
    expect(events.map((event) => event.type)).toEqual(['plug-in-detected']);
  });

  it('leaves an already-decided session alone on restart', async () => {
    const sessionId = sessionStore.openSession(db, {
      vehicleId: VIN,
      homeBatteryId: GW,
      plugTsMs: 500,
    });
    decisionStore.insertDecision(db, {
      vehicleId: VIN,
      homeBatteryId: GW,
      tsMs: 600,
      sessionId,
      accepted: false,
      dryRun: false,
      reasonCode: 'below_buffer',
    });
    const seen: VehiclePlugInContext[] = [];
    const events: NotificationEvent[] = [];
    const ev = evFake('Stopped');
    const { task, logs } = poller(ev, {
      onVehiclePlugIn: async (ctx) => {
        seen.push(ctx);
      },
      notify: async (event) => {
        events.push(event);
      },
    });

    await task.run();

    expect(seen).toHaveLength(0);
    expect(events).toEqual([]); // no duplicate plug-in notification
    expect(sessionStore.recentSessions(db, 5)).toHaveLength(1);
    expect(eventKinds()).toEqual([]); // nothing synthesized
    expect(logs.join('\n')).toContain('already decided');
  });

  it('completes the decision for an open session that never got one', async () => {
    const sessionId = sessionStore.openSession(db, {
      vehicleId: VIN,
      homeBatteryId: GW,
      plugTsMs: 500,
    });
    const seen: VehiclePlugInContext[] = [];
    const events: NotificationEvent[] = [];
    const ev = evFake('Stopped');
    const { task } = poller(ev, {
      onVehiclePlugIn: async (ctx) => {
        seen.push(ctx);
      },
      notify: async (event) => {
        events.push(event);
      },
    });

    await task.run();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId, event: 'plug_in' });
    expect(events).toEqual([]); // same visit — no second notification
    expect(sessionStore.recentSessions(db, 5)).toHaveLength(1);
    expect(eventKinds()).toEqual([]);
  });

  it('does not open a session for a charging car at init', async () => {
    const seen: VehiclePlugInContext[] = [];
    const ev = evFake('Charging');
    const { task } = poller(ev, {
      onVehiclePlugIn: async (ctx) => {
        seen.push(ctx);
      },
    });

    await task.run();

    expect(seen).toHaveLength(0);
    expect(sessionStore.openSessionFor(db, VIN)).toBeNull();
    expect(eventKinds()).toEqual([]);
  });

  it('does nothing for a disconnected car at init', async () => {
    const seen: VehiclePlugInContext[] = [];
    const ev = evFake('Disconnected');
    const { task, logs } = poller(ev, {
      onVehiclePlugIn: async (ctx) => {
        seen.push(ctx);
      },
    });

    await task.run();

    expect(seen).toHaveLength(0);
    expect(sessionStore.openSessionFor(db, VIN)).toBeNull();
    expect(eventKinds()).toEqual([]);
    expect(logs.join('\n')).not.toContain('treating as vehicle plug-in');
  });
});

describe('init wake', () => {
  it('wakes a sleeping car once when enabled, then runs the check', async () => {
    const seen: VehiclePlugInContext[] = [];
    const ev = evFake('Stopped', 'asleep');
    const { task, logs } = poller(ev, {
      wakeAtInit: true,
      onVehiclePlugIn: async (ctx) => {
        seen.push(ctx);
      },
    });

    await task.run();

    expect(ev.wakes).toBe(1);
    expect(ev.reads).toBe(1); // the check ran against the woken car
    expect(seen).toHaveLength(1);
    expect(logs.join('\n')).toContain('waking once to check plug-in state');

    // The car sleeps again later — the init wake is spent, never repeated.
    ev.probe = 'asleep';
    await task.run();
    expect(ev.wakes).toBe(1);
    expect(logs.join('\n')).toContain('waiting'); // heartbeat, not a wake
  });

  it('never wakes when the init check is not enabled', async () => {
    const ev = evFake('Stopped', 'asleep');
    const { task, logs } = poller(ev); // wakeAtInit absent = collect-only

    await task.run();

    expect(ev.wakes).toBe(0);
    expect(ev.reads).toBe(0);
    expect(logs.join('\n')).toContain('waiting');
  });

  it('logs a failed init wake and keeps sampling without retrying', async () => {
    const ev = evFake('Stopped', 'asleep');
    ev.wakeUp = async () => {
      ev.wakes++;
      throw new Error('out of coverage');
    };
    const { task, logs } = poller(ev, { wakeAtInit: true });

    await task.run();

    expect(ev.wakes).toBe(1);
    expect(ev.reads).toBe(0);
    expect(logs.join('\n')).toContain('init wake failed: out of coverage');

    await task.run();
    expect(ev.wakes).toBe(1); // never retried
    expect(ev.reads).toBe(0);
  });

  it('does not wake after the init check has run', async () => {
    const ev = evFake('Stopped'); // online at init
    const { task } = poller(ev, { wakeAtInit: true });

    await task.run(); // init check completes on the first rich read
    ev.probe = 'asleep';
    await task.run();

    expect(ev.wakes).toBe(0);
  });
});

