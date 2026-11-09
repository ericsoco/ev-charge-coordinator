/**
 * Re-target verdict matrix (pure): deadband raise/lower incl. sub-50,
 * guards, and the resume rules (monitor-stop-only, recovery margin,
 * strict room-below-target). The I/O edge lands with the wiring commit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import {
  RESUME_MIN_RECOVERY_PERCENT,
  createReTargeter,
  evaluateReTarget,
  type ReTargeterDeps,
  type ReTargetInput,
} from '../../src/daemon/reTarget.js';
import { openStore } from '../../src/store/database.js';
import * as sessionStore from '../../src/store/SessionStore.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';
import * as evStore from '../../src/store/EvStore.js';
import * as weatherStore from '../../src/store/WeatherForecastStore.js';
import { DEFAULT_WEATHER_POLICY, type WeatherPolicy } from '../../src/utils/weather.js';
import type { NotificationEvent } from '../../src/notifiers/types.js';
import type { EnergyConfig } from '../../src/utils/energy.js';

const CFG: EnergyConfig = {
  batteryCapacityKwh: 13.5,
  evBatteryKwh: 75,
  bufferPercent: 20,
  chargeEfficiency: 0.9,
};

/** ev 55, battery 70 → raw 63.1 (stored 55 sits well below the deadband). */
function input(overrides: Partial<ReTargetInput> = {}): ReTargetInput {
  return {
    chargingState: 'Charging',
    evSocPercent: 55,
    sessionTargetPercent: 55,
    sessionInitialTargetPercent: 55,
    sessionStopReason: null,
    homeBatterySocPercent: 70,
    energyConfig: CFG,
    ...overrides,
  };
}

describe('evaluateReTarget (pure) — change', () => {
  it('raises on surplus beyond the deadband: stop target + Tesla limit', () => {
    const verdict = evaluateReTarget(input());
    expect(verdict).toMatchObject({ change: 'raise', newStopTarget: 63, newChargeLimit: 63 });
    expect(verdict.resume).toBe(false);
    expect(verdict.detail).toBe('re-target 55% → 63% (solar surplus, battery 70%)');
  });

  it('the deadband suppresses sub-margin drift — no rounding-boundary flap', () => {
    // raw 63.1 vs stored 63: would round to the same integer anyway.
    expect(evaluateReTarget(input({ sessionTargetPercent: 63 }))).toMatchObject({
      change: 'none',
      newStopTarget: null,
      newChargeLimit: null,
    });
    // ev 50, battery 60 → raw 56.48 vs stored 56: rounds to 56, delta 0.48 < 1
    // — a raw oscillating around the .5 boundary never fires.
    const boundary = input({ evSocPercent: 50, homeBatterySocPercent: 60, sessionTargetPercent: 56 });
    expect(evaluateReTarget(boundary)).toMatchObject({ change: 'none' });
  });

  it('lowers symmetrically, session target only (never the car)', () => {
    const verdict = evaluateReTarget(
      input({
        homeBatterySocPercent: 45, // raw 59.05
        sessionTargetPercent: 65,
        sessionInitialTargetPercent: 45,
      })
    );
    expect(verdict).toMatchObject({ change: 'lower', newStopTarget: 59, newChargeLimit: null });
    expect(verdict.detail).toBe('re-target 45% → 59% (battery 45%)');
  });

  it('a raise below Tesla’s floor carries both numbers (raw 48.1)', () => {
    const verdict = evaluateReTarget(
      input({ evSocPercent: 40, sessionTargetPercent: 47, sessionInitialTargetPercent: 47 })
    );
    expect(verdict).toMatchObject({ change: 'raise', newStopTarget: 48, newChargeLimit: 50 });
  });

  it('a lower below the floor stops at the unclamped truth', () => {
    const verdict = evaluateReTarget(
      input({ evSocPercent: 40, homeBatterySocPercent: 32, sessionTargetPercent: 43 }) // raw 41.94
    );
    expect(verdict).toMatchObject({ change: 'lower', newStopTarget: 41, newChargeLimit: null });
  });

  it('a battery-limited lower stops where the math lands (at the EV)', () => {
    const verdict = evaluateReTarget(
      input({ evSocPercent: 50, homeBatterySocPercent: 21, sessionTargetPercent: 60 }) // raw 50.16
    );
    expect(verdict).toMatchObject({ change: 'lower', newStopTarget: 50, newChargeLimit: null });
  });

  it('reason phrases initial → new even after earlier re-targets', () => {
    const verdict = evaluateReTarget(
      input({ sessionTargetPercent: 55, sessionInitialTargetPercent: 45 })
    );
    expect(verdict.detail).toBe('re-target 45% → 63% (solar surplus, battery 70%)');
  });
});

describe('evaluateReTarget (pure) — guards', () => {
  it('unreadable inputs never act', () => {
    expect(evaluateReTarget(input({ energyConfig: null }))).toMatchObject({
      change: 'none',
      resume: false,
    });
    expect(evaluateReTarget(input({ homeBatterySocPercent: null }))).toMatchObject({
      change: 'none',
      resume: false,
    });
    expect(evaluateReTarget(input({ evSocPercent: null }))).toMatchObject({
      change: 'none',
      resume: false,
    });
  });

  it('battery at/below the buffer yields to the monitor entirely', () => {
    expect(
      evaluateReTarget(
        input({
          chargingState: 'Stopped',
          sessionStopReason: 'battery_buffer',
          evSocPercent: 40,
          sessionTargetPercent: 60,
          homeBatterySocPercent: 19,
        })
      )
    ).toMatchObject({ change: 'none', resume: false });
  });

  it('manual/car stops are never touched (no monitor reason → no act)', () => {
    const verdict = evaluateReTarget(
      input({
        chargingState: 'Stopped',
        sessionStopReason: null,
        evSocPercent: 40,
        sessionTargetPercent: 60, // huge surplus delta, but not ours to manage
      })
    );
    expect(verdict).toMatchObject({ change: 'none', resume: false });
  });

  it('no target armed → no change and no resume', () => {
    const verdict = evaluateReTarget(
      input({
        chargingState: 'Stopped',
        sessionStopReason: 'battery_buffer',
        evSocPercent: 40,
        sessionTargetPercent: null,
        sessionInitialTargetPercent: null,
        homeBatterySocPercent: 25,
      })
    );
    expect(verdict).toMatchObject({ change: 'none', resume: false });
  });
});

describe('evaluateReTarget (pure) — resume', () => {
  it('surplus raise while monitor-stopped carries resume with it', () => {
    const verdict = evaluateReTarget(
      input({
        chargingState: 'Stopped',
        sessionStopReason: 'target_reached',
        evSocPercent: 50,
        sessionTargetPercent: 50,
        sessionInitialTargetPercent: 50,
      })
    ); // raw 58.1
    expect(verdict).toMatchObject({
      change: 'raise',
      newStopTarget: 58,
      newChargeLimit: 58,
      resume: true,
    });
  });

  it('a recovered buffer stop resumes (lower + resume in one verdict)', () => {
    const verdict = evaluateReTarget(
      input({
        chargingState: 'Stopped',
        sessionStopReason: 'battery_buffer',
        evSocPercent: 40, // battery 35 → raw 42.43 (sub-50 → floor 42) vs stored 60
        sessionTargetPercent: 60,
        sessionInitialTargetPercent: 45,
        homeBatterySocPercent: 35,
      })
    );
    expect(verdict).toMatchObject({ change: 'lower', newStopTarget: 42, resume: true });
    expect(verdict.detail).toBe('re-target 45% → 42% (battery 35%)');
  });

  it('pure resume when the stored target already fits', () => {
    const verdict = evaluateReTarget(
      input({
        chargingState: 'Stopped',
        sessionStopReason: 'battery_buffer',
        evSocPercent: 40,
        sessionTargetPercent: 41,
        sessionInitialTargetPercent: 45,
        homeBatterySocPercent: 25,
      })
    );
    expect(verdict).toMatchObject({ change: 'none', resume: true });
  });

  it(`resume needs the recovery margin — buffer+${RESUME_MIN_RECOVERY_PERCENT} equality does not count`, () => {
    const verdict = evaluateReTarget(
      input({
        chargingState: 'Stopped',
        sessionStopReason: 'battery_buffer',
        evSocPercent: 40,
        sessionTargetPercent: 60,
        homeBatterySocPercent: 20 + RESUME_MIN_RECOVERY_PERCENT, // exactly at the margin
      })
    );
    expect(verdict.resume).toBe(false);
  });

  it('no resume without a monitor stop reason, even fully recovered', () => {
    const verdict = evaluateReTarget(
      input({
        chargingState: 'Stopped',
        sessionStopReason: null,
        evSocPercent: 40,
        sessionTargetPercent: 60,
        homeBatterySocPercent: 25,
      })
    );
    expect(verdict).toMatchObject({ change: 'none', resume: false });
  });

  it('no resume at/above the target (nothing left to charge)', () => {
    const verdict = evaluateReTarget(
      input({
        chargingState: 'Stopped',
        sessionStopReason: 'target_reached',
        evSocPercent: 60,
        sessionTargetPercent: 60,
        homeBatterySocPercent: 25,
      })
    ); // raw 60.81: delta 0.81 < deadband, and 60 < 60 is false
    expect(verdict).toMatchObject({ change: 'none', resume: false });
  });

  it('resume never fires while already charging', () => {
    const verdict = evaluateReTarget(
      input({
        chargingState: 'Charging',
        sessionStopReason: 'battery_buffer', // stale reason (cleared on start)
        evSocPercent: 40,
        sessionTargetPercent: 60,
        homeBatterySocPercent: 35,
      })
    );
    expect(verdict).toMatchObject({ change: 'lower', newStopTarget: 42, resume: false });
  });
});

describe('createReTargeter (edge)', () => {
  let dir: string;
  let db: DatabaseSync;
  let logs: string[];
  let calls: string[]; // ordered actuation: 'limit:N' then 'start'
  let events: NotificationEvent[];
  let sessionId: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-retarget-'));
    db = openStore(path.join(dir, 'data.sqlite'));
    logs = [];
    calls = [];
    events = [];
    sessionId = sessionStore.openSession(db, {
      vehicleId: 'VIN',
      homeBatteryId: 'GW',
      plugTsMs: 500,
    });
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 1, socPercent: 70 });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function retarget(overrides: Partial<ReTargeterDeps> = {}) {
    return createReTargeter({
      db,
      vehicleId: 'VIN',
      autoStart: { enabled: true, filters: [] },
      dryRun: false,
      setChargeLimit: async (percent) => {
        calls.push(`limit:${percent}`);
      },
      startCharging: async () => {
        calls.push('start');
      },
      getEnergyConfig: () => CFG,
      log: (message) => logs.push(message),
      notify: async (event) => {
        events.push(event);
      },
      ...overrides,
    });
  }

  const charging = (tsMs: number, soc: number | null = 55) => ({
    tsMs,
    evSocPercent: soc,
    chargingState: 'Charging',
  });
  const stopped = (tsMs: number, soc: number | null = 50) => ({
    tsMs,
    evSocPercent: soc,
    chargingState: 'Stopped',
  });

  it('live raise: limit first, then target + notification (initial → new)', async () => {
    sessionStore.setSessionTarget(db, sessionId, 55); // seeds initial 55
    await retarget()(charging(1_000));

    expect(calls).toEqual(['limit:63']);
    const session = sessionStore.openSessionFor(db, 'VIN')!;
    expect(session.targetPercent).toBe(63);
    expect(session.targetChangeReason).toBe('re-target 55% → 63% (solar surplus, battery 70%)');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'session-retargeted',
      direction: 'raise',
      detail: 're-target 55% → 63% (solar surplus, battery 70%)',
    });
    expect(logs.join('\n')).toContain('re-target 55% → 63%');
  });

  it('live lower: session target only — the car is never touched', async () => {
    sessionStore.setSessionTarget(db, sessionId, 45);
    sessionStore.setSessionTarget(db, sessionId, 65); // initial stays 45
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 2, socPercent: 45 }); // raw 59.05

    await retarget()(charging(1_000));

    expect(calls).toEqual([]);
    const session = sessionStore.openSessionFor(db, 'VIN')!;
    expect(session.targetPercent).toBe(59);
    expect(session.targetChangeReason).toBe('re-target 45% → 59% (battery 45%)');
    expect(events[0]).toMatchObject({ type: 'session-retargeted', direction: 'lower' });
  });

  it('raise + resume: limit → target → start, in that order', async () => {
    sessionStore.setSessionTarget(db, sessionId, 50); // initial 50, EV at 50, battery 70
    sessionStore.setSessionStopReason(db, sessionId, 'target_reached'); // raw 58.1

    await retarget()(stopped(1_000));

    expect(calls).toEqual(['limit:58', 'start']);
    expect(sessionStore.openSessionFor(db, 'VIN')!.targetPercent).toBe(58);
    expect(events[0]).toMatchObject({ type: 'session-retargeted', direction: 'raise' });
    expect(logs.join('\n')).toContain('resumed charging (battery 70%)');
  });

  it('pure resume: recovered buffer stop starts without touching the target', async () => {
    sessionStore.setSessionTarget(db, sessionId, 43); // raw 42.43 — inside the deadband
    sessionStore.setSessionStopReason(db, sessionId, 'battery_buffer');
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 2, socPercent: 35 });

    await retarget()(stopped(1_000, 40));

    expect(calls).toEqual(['start']);
    expect(sessionStore.openSessionFor(db, 'VIN')!.targetPercent).toBe(43);
    expect(events).toHaveLength(0); // a resume alone is not a target change
    expect(logs.join('\n')).toContain('resumed charging (battery 35%)');
  });

  it('shadow (autoStart disabled): logs would-act once per episode, never actuates', async () => {
    sessionStore.setSessionTarget(db, sessionId, 55);
    const run = retarget({ autoStart: { enabled: false, filters: [] } });
    await run(charging(1_000));
    await run(charging(2_000)); // condition persists — no duplicate line
    expect(calls).toEqual([]);
    expect(events).toHaveLength(0);
    expect(logs.filter((line) => line.includes('would raise'))).toHaveLength(1);

    await retarget({ dryRun: true })(charging(3_000)); // merge-dark: same verdict
    expect(calls).toEqual([]);
  });

  it('a failed limit logs every attempt but notifies once per episode', async () => {
    sessionStore.setSessionTarget(db, sessionId, 55);
    let failing = true;
    let attempts = 0;
    const run = retarget({
      setChargeLimit: async (percent) => {
        attempts += 1;
        if (failing) throw new Error('proxy down');
        calls.push(`limit:${percent}`);
      },
    });

    await run(charging(1_000));
    await run(charging(2_000));
    expect(attempts).toBe(2);
    expect(logs.filter((line) => line.includes('actuation failed'))).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'failure', component: 're-target' });
    expect(sessionStore.openSessionFor(db, 'VIN')!.targetPercent).toBe(55); // not written

    failing = false; // next tick retries and completes
    await run(charging(3_000));
    expect(sessionStore.openSessionFor(db, 'VIN')!.targetPercent).toBe(63);
    expect(events).toHaveLength(2); // the one failure + the applied change
  });

  it('a stale battery sample never acts (freshness guard, monitor parity)', async () => {
    sessionStore.setSessionTarget(db, sessionId, 55);
    await retarget()(charging(1_000_000)); // sample is 999 999 ms old > 600 000
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
    expect(events).toEqual([]);
  });

  it('folds the step-3 weather reserve into the effective buffer', async () => {
    sessionStore.setSessionTarget(db, sessionId, 50);
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 2, socPercent: 22 });
    const policy: WeatherPolicy = { ...DEFAULT_WEATHER_POLICY, bufferAdjPercent: 5 };
    // Low-solar vintage (24 window hours × 25 W/m² = 600 < 2000) fetched at t=1_000.
    weatherStore.insertForecast(
      db,
      Array.from({ length: 48 }, (_, i) => ({
        hourTsMs: 1_000 + i * 3_600_000,
        irradianceWm2: 25,
        temperatureC: 10,
      })),
      1_000
    );

    // With the reserve the effective buffer is 25 → battery 22 yields to it.
    await retarget({ weatherPolicy: policy })(charging(1_000));
    expect(calls).toEqual([]);

    // Default policy (off): the same tick computes (raw 55.32 vs stored 50) → raise.
    await retarget()(charging(2_000));
    expect(calls).toEqual(['limit:55']);
    expect(sessionStore.openSessionFor(db, 'VIN')!.targetPercent).toBe(55);
  });

  it('folds the step-2 observed efficiency into the recompute', async () => {
    // Five clean sessions at 0.95 (config says 0.90): raw 63.55 vs 63.1 —
    // the stored 62 sits inside the config-only deadband but beyond the
    // measured one, so only the measured path moves (to 64, not 63).
    for (let i = 0; i < 5; i++) {
      const id = sessionStore.openSession(db, {
        vehicleId: 'OTHER',
        homeBatteryId: 'GW',
        plugTsMs: 100 + i,
      });
      sessionStore.closeOpenSession(db, 'OTHER', 101 + i);
      sessionStore.finalizeSession(db, id, {
        energyKwh: 9.5,
        energyPercent: 10,
        elapsedMs: 60_000,
        houseEnergyKwh: 10,
        efficiency: 0.95,
      });
    }
    sessionStore.setSessionTarget(db, sessionId, 62);

    await retarget()(charging(1_000));

    expect(calls).toEqual(['limit:64']);
    expect(sessionStore.openSessionFor(db, 'VIN')!.targetPercent).toBe(64);
  });

  // --- battery-sample tick: the sleeping-car resume path -------------------
  // The poll path never runs while the car sleeps (no rich reads); these pin
  // the second trigger: evaluate from the LATEST STORED EV observation.

  /** The 2026-11-09 live shape: monitor-stopped, car asleep since the stop. */
  function seedSleepingStop(batterySoc = 38.1) {
    sessionStore.setSessionTarget(db, sessionId, 31);
    sessionStore.setSessionStopReason(db, sessionId, 'target_reached');
    evStore.insertSample(db, {
      vehicleId: 'VIN',
      tsMs: 900,
      state: 'online',
      chargingState: 'Stopped',
      socPercent: 34,
    });
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 990, socPercent: batterySoc });
  }

  it('battery tick raises + resumes from stored state (the car is asleep)', async () => {
    seedSleepingStop();

    // ev 34, battery 38.1, buffer 20 → raw 36.93: raise 31 → 36 (vehicle
    // limit clamps to the floor), then resume — the verdict a rich read
    // would have produced, evaluated without one.
    await retarget({ nowMs: () => 1_000 }).onBatteryTick();

    expect(calls).toEqual(['limit:50', 'start']);
    expect(sessionStore.openSessionFor(db, 'VIN')!.targetPercent).toBe(36);
    expect(logs.join('\n')).toContain('re-target 31% → 36% (solar surplus, battery 38.1%)');
    expect(logs.join('\n')).toContain('resumed charging (battery 38.1%) [battery-sample]');
    expect(events[0]).toMatchObject({ type: 'session-retargeted', direction: 'raise' });
  });

  it('one resume per EV observation — a fresh rich read re-enables it', async () => {
    seedSleepingStop();
    const run = retarget({ nowMs: () => 1_000 });

    await run.onBatteryTick();
    await run.onBatteryTick(); // same stored observation — no duplicate start
    expect(calls).toEqual(['limit:50', 'start']);

    // A fresh observation lands (still stopped): fresh state owns the truth.
    evStore.insertSample(db, {
      vehicleId: 'VIN',
      tsMs: 1_100,
      state: 'online',
      chargingState: 'Stopped',
      socPercent: 34,
    });
    await run.onBatteryTick();
    expect(calls).toEqual(['limit:50', 'start', 'start']);
  });

  it('no EV observation yet → the battery tick is a no-op', async () => {
    await retarget({ nowMs: () => 1_000 }).onBatteryTick();
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
    expect(events).toEqual([]);
  });

  it('battery tick never resumes a manual/car stop', async () => {
    seedSleepingStop();
    sessionStore.setSessionStopReason(db, sessionId, null);
    await retarget({ nowMs: () => 1_000 }).onBatteryTick();
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('battery at/below the buffer never acts on the tick (monitor owns it)', async () => {
    seedSleepingStop(19); // CFG buffer 20
    await retarget({ nowMs: () => 1_000 }).onBatteryTick();
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('battery tick shadow mode: would-act once per episode, never actuates', async () => {
    seedSleepingStop();
    const run = retarget({
      nowMs: () => 1_000,
      autoStart: { enabled: false, filters: [] },
    });
    await run.onBatteryTick();
    await run.onBatteryTick();
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    expect(logs.filter((line) => line.includes('would raise'))).toHaveLength(1);
  });

  it('a failed start on the battery tick logs honestly and retries next tick', async () => {
    seedSleepingStop();
    let failing = true;
    const run = retarget({
      nowMs: () => 1_000,
      startCharging: async () => {
        if (failing) throw new Error('proxy down');
        calls.push('start');
      },
    });

    await run.onBatteryTick(); // limit + target land, start fails
    expect(calls).toEqual(['limit:50']);
    expect(logs.filter((line) => line.includes('actuation failed'))).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'failure', component: 're-target' });

    failing = false; // no resume was issued → the next tick retries
    await run.onBatteryTick();
    expect(calls).toEqual(['limit:50', 'start']);
    expect(logs.join('\n')).toContain('resumed charging (battery 38.1%) [battery-sample]');
  });
});

describe('runDaemon composition (source pin)', () => {
  it('re-target evaluates before the stop check in the same tick', () => {
    const source = fs.readFileSync(
      new URL('../../src/daemon/runDaemon.ts', import.meta.url),
      'utf8'
    );
    const retargetAt = source.indexOf('await reTargetOnProgress(');
    const monitorAt = source.indexOf('await monitorChargingProgress(');
    expect(retargetAt).toBeGreaterThan(-1);
    expect(monitorAt).toBeGreaterThan(-1);
    expect(retargetAt).toBeLessThan(monitorAt);
  });

  it('the battery sampler hosts only the re-target resume trigger', () => {
    const source = fs.readFileSync(
      new URL('../../src/daemon/runDaemon.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain('reTargetStage?.onBatteryTick()');
    // The session monitor must never ride the battery path: its stop checks
    // need a fresh EV read, and a stored 'Charging' must not act from there.
    const afterSampleAt = source.indexOf('afterSample:');
    const monitorCallAt = source.indexOf('monitorChargingProgress(', afterSampleAt);
    const evPollerAt = source.indexOf('createEvPoller', afterSampleAt);
    expect(afterSampleAt).toBeGreaterThan(-1);
    expect(monitorCallAt).toBeGreaterThan(evPollerAt); // monitor lives only in the poll chain
  });
});