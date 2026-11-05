/**
 * Session monitor: the pure stop-verdict matrix (evaluateSessionStop) and the
 * I/O edge (mode gating, stop_reason writes, once-per-episode logging, failure
 * isolation, mutable-target re-reads).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as sessionStore from '../../src/store/SessionStore.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';
import {
  createSessionMonitor,
  evaluateSessionStop,
  type SessionMonitorDeps,
} from '../../src/daemon/sessionMonitor.js';
import type { NotificationEvent } from '../../src/notifiers/types.js';
import type { EnergyConfig } from '../../src/utils/energy.js';

const CFG: EnergyConfig = {
  batteryCapacityKwh: 13.5,
  evBatteryKwh: 75,
  bufferPercent: 20,
  chargeEfficiency: 0.9,
};

describe('evaluateSessionStop (pure)', () => {
  const charging = {
    chargingState: 'Charging',
    evSocPercent: 50,
    sessionTargetPercent: 60,
    homeBatterySocPercent: 60,
    bufferPercent: 20,
  };

  it('not charging never stops, even with every condition met', () => {
    expect(
      evaluateSessionStop({
        ...charging,
        chargingState: 'Stopped',
        evSocPercent: 90,
        sessionTargetPercent: 45,
        homeBatterySocPercent: 10,
      })
    ).toEqual({ stop: false });
  });

  it('stops at the battery buffer, equality included', () => {
    const verdict = evaluateSessionStop({ ...charging, homeBatterySocPercent: 20 });
    expect(verdict).toMatchObject({ stop: true, reason: 'battery_buffer' });
    expect((verdict as { detail: string }).detail).toContain('20%');
  });

  it('stops at the session target, equality included', () => {
    expect(evaluateSessionStop({ ...charging, evSocPercent: 60 })).toMatchObject({
      stop: true,
      reason: 'target_reached',
    });
  });

  it('buffer wins the reason when both conditions hold (safety first)', () => {
    expect(
      evaluateSessionStop({
        ...charging,
        evSocPercent: 90,
        sessionTargetPercent: 45,
        homeBatterySocPercent: 15,
      })
    ).toMatchObject({ stop: true, reason: 'battery_buffer' });
  });

  it('no stop while above the buffer and below the target', () => {
    expect(evaluateSessionStop(charging)).toEqual({ stop: false });
  });

  it('unreadable values skip their check — missing data never stops', () => {
    // Battery/config unknown: the target still enforces.
    expect(
      evaluateSessionStop({
        ...charging,
        homeBatterySocPercent: null,
        bufferPercent: null,
        evSocPercent: 70,
        sessionTargetPercent: 60,
      })
    ).toMatchObject({ stop: true, reason: 'target_reached' });
    // Target and EV SoC unknown: the buffer still enforces.
    expect(
      evaluateSessionStop({
        ...charging,
        sessionTargetPercent: null,
        evSocPercent: null,
        homeBatterySocPercent: 10,
      })
    ).toMatchObject({ stop: true, reason: 'battery_buffer' });
    // Everything unknown: no stop.
    expect(
      evaluateSessionStop({
        chargingState: 'Charging',
        evSocPercent: null,
        sessionTargetPercent: null,
        homeBatterySocPercent: null,
        bufferPercent: null,
      })
    ).toEqual({ stop: false });
  });
});

describe('createSessionMonitor (edge)', () => {
  let dir: string;
  let db: DatabaseSync;
  let logs: string[];
  let stopCalls: number;
  let events: NotificationEvent[];
  let sessionId: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-monitor-'));
    db = openStore(path.join(dir, 'data.sqlite'));
    logs = [];
    stopCalls = 0;
    events = [];
    sessionId = sessionStore.openSession(db, {
      vehicleId: 'VIN', homeBatteryId: 'GW', plugTsMs: 500,
    });
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 1, socPercent: 60 });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function monitor(overrides: Partial<SessionMonitorDeps> = {}) {
    return createSessionMonitor({
      db,
      vehicleId: 'VIN',
      autoStart: { enabled: true, filters: [] },
      dryRun: false,
      stopCharging: async () => {
        stopCalls += 1;
      },
      getEnergyConfig: () => CFG,
      log: (message) => logs.push(message),
      notify: async (event) => {
        events.push(event);
      },
      ...overrides,
    });
  }

  const charging = (tsMs: number, soc: number | null = 50) => ({
    tsMs,
    evSocPercent: soc,
    chargingState: 'Charging',
  });
  const notCharging = (tsMs: number) => ({
    tsMs,
    evSocPercent: 40,
    chargingState: 'Stopped',
  });

  it('live: stops at the battery buffer and records the reason', async () => {
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 2, socPercent: 15 });
    await monitor()(charging(1_000));
    expect(stopCalls).toBe(1);
    expect(sessionStore.openSessionFor(db, 'VIN')!.stopReason).toBe('battery_buffer');
    expect(logs.join('\n')).toContain('stopped charging (battery_buffer)');
    expect(events).toHaveLength(0); // the transition event carries the reason (commit 4)
  });

  it('live: stops at the session target and records the reason', async () => {
    sessionStore.setSessionTarget(db, sessionId, 45);
    await monitor()(charging(1_000, 45));
    expect(stopCalls).toBe(1);
    expect(sessionStore.openSessionFor(db, 'VIN')!.stopReason).toBe('target_reached');
    expect(logs.join('\n')).toContain('stopped charging (target_reached)');
  });

  it('live: no stop while above the buffer and below the target', async () => {
    sessionStore.setSessionTarget(db, sessionId, 60);
    await monitor()(charging(1_000, 50));
    expect(stopCalls).toBe(0);
    expect(sessionStore.openSessionFor(db, 'VIN')!.stopReason).toBeNull();
    expect(logs).toEqual([]);
  });

  it('shadow (autoStart disabled): logs would-stop once per episode, never actuates', async () => {
    sessionStore.setSessionTarget(db, sessionId, 45);
    const run = monitor({ autoStart: { enabled: false, filters: [] } });
    await run(charging(1_000, 50));
    await run(charging(2_000, 50)); // condition persists — no duplicate line
    expect(stopCalls).toBe(0);
    expect(logs.filter((l) => l.includes('would stop'))).toHaveLength(1);
    expect(sessionStore.openSessionFor(db, 'VIN')!.stopReason).toBeNull();

    await run(notCharging(3_000)); // episode ends
    await run(charging(4_000, 50)); // new episode logs again
    expect(logs.filter((l) => l.includes('would stop'))).toHaveLength(2);
  });

  it('shadow (--dry-run flag): identical verdict, zero actuation', async () => {
    sessionStore.setSessionTarget(db, sessionId, 45);
    await monitor({ dryRun: true })(charging(1_000, 50));
    expect(stopCalls).toBe(0);
    expect(logs.join('\n')).toContain('would stop (target_reached)');
  });

  it('live: a failed stop logs every attempt but notifies once per episode', async () => {
    sessionStore.setSessionTarget(db, sessionId, 45);
    let failing = true;
    const run = monitor({
      stopCharging: async () => {
        stopCalls += 1;
        if (failing) throw new Error('proxy down');
      },
    });
    await run(charging(1_000, 50));
    await run(charging(2_000, 50));
    expect(stopCalls).toBe(2);
    expect(logs.filter((l) => l.includes('stop failed'))).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'failure', component: 'session-monitor' });

    failing = false; // next tick retries and succeeds
    await run(charging(3_000, 50));
    expect(stopCalls).toBe(3);
    expect(sessionStore.openSessionFor(db, 'VIN')!.stopReason).toBe('target_reached');
    expect(events).toHaveLength(1); // still just the one failure event
  });

  it('mutability seam: re-reads the current target every tick', async () => {
    sessionStore.setSessionTarget(db, sessionId, 60);
    const run = monitor();
    await run(charging(1_000, 50)); // below the original target — no stop
    expect(stopCalls).toBe(0);

    // A later re-targeting step lowers the target mid-session…
    sessionStore.setSessionTarget(db, sessionId, 45);
    await run(charging(2_000, 50)); // …and the very next tick enforces it
    expect(stopCalls).toBe(1);
    expect(sessionStore.openSessionFor(db, 'VIN')!.stopReason).toBe('target_reached');
  });

  it('missing battery sample: warns once, target stop still works', async () => {
    db.exec('DELETE FROM home_battery_samples');
    sessionStore.setSessionTarget(db, sessionId, 45);
    const run = monitor();
    await run(charging(1_000, 50));
    expect(stopCalls).toBe(1);
    expect(logs.filter((l) => l.includes('no home-battery sample'))).toHaveLength(1);
    expect(logs.join('\n')).toContain('stopped charging (target_reached)');
  });

  it('missing energy config: warns once, buffer skipped, target still enforces', async () => {
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 2, socPercent: 10 });
    sessionStore.setSessionTarget(db, sessionId, 45);
    const run = monitor({ getEnergyConfig: () => null });
    await run(charging(1_000, 50)); // battery below buffer, but config unreadable
    expect(stopCalls).toBe(1); // the target (50 >= 45) stops, not the buffer
    expect(logs.filter((l) => l.includes('energy config unavailable'))).toHaveLength(1);
    expect(sessionStore.openSessionFor(db, 'VIN')!.stopReason).toBe('target_reached');
  });

  it('no open session: buffer stop still runs (authority: any charging)', async () => {
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 2, socPercent: 15 });
    sessionStore.closeOpenSession(db, 'VIN', 900);
    await monitor()(charging(1_000, 50));
    expect(stopCalls).toBe(1);
    expect(logs.join('\n')).toContain('stopped charging (battery_buffer)');
  });

  it('never throws: an exploding config read is logged, sampling survives', async () => {
    const run = monitor({
      getEnergyConfig: () => {
        throw new Error('config read blew up');
      },
    });
    await expect(run(charging(1_000, 50))).resolves.toBeUndefined();
    expect(stopCalls).toBe(0);
    expect(logs.join('\n')).toContain('[session-monitor] failed: config read blew up');
  });

  it('stale sample (post-sleep) reads as missing: no spurious stop, warn once', async () => {
    // Below the buffer — but the row predates the sleep, so acting on it would
    // spuriously stop a healthy charge.
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 1, socPercent: 15 });
    const run = monitor({ batterySampleMaxAgeMs: 500 });
    await run({ tsMs: 100_000, evSocPercent: 40, chargingState: 'Charging' });
    expect(stopCalls).toBe(0);
    expect(sessionStore.openSessionFor(db, 'VIN')!.stopReason).toBeNull();
    expect(logs.filter((l) => l.includes('min old'))).toHaveLength(1);

    await run({ tsMs: 101_000, evSocPercent: 40, chargingState: 'Charging' });
    expect(logs.filter((l) => l.includes('min old'))).toHaveLength(1); // once per episode
  });

  it('the sampler\u2019s first fresh sample lands and the buffer enforces next tick', async () => {
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 1, socPercent: 15 });
    const run = monitor({ batterySampleMaxAgeMs: 5_000 }); // 99 s → stale, 1 s → fresh
    await run({ tsMs: 100_000, evSocPercent: 40, chargingState: 'Charging' });
    expect(stopCalls).toBe(0);

    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 100_000, socPercent: 15 });
    await run({ tsMs: 101_000, evSocPercent: 40, chargingState: 'Charging' });
    expect(stopCalls).toBe(1);
    expect(sessionStore.openSessionFor(db, 'VIN')!.stopReason).toBe('battery_buffer');
  });

  it('staleness never blocks the target stop (EV SoC is fresh from the rich read)', async () => {
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 1, socPercent: 15 });
    sessionStore.setSessionTarget(db, sessionId, 45);
    const run = monitor({ batterySampleMaxAgeMs: 500 });
    await run({ tsMs: 100_000, evSocPercent: 50, chargingState: 'Charging' });
    expect(stopCalls).toBe(1);
    expect(sessionStore.openSessionFor(db, 'VIN')!.stopReason).toBe('target_reached');
  });
});