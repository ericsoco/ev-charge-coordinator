/**
 * Re-target verdict matrix (pure): deadband raise/lower incl. sub-50,
 * guards, and the resume rules (monitor-stop-only, recovery margin,
 * strict room-below-target). The I/O edge lands with the wiring commit.
 */
import { describe, expect, it } from 'vitest';
import {
  RESUME_MIN_RECOVERY_PERCENT,
  evaluateReTarget,
  type ReTargetInput,
} from '../../src/daemon/reTarget.js';
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
    expect(verdict).toMatchObject({ change: 'raise', newStopTarget: 63, newTeslaLimit: 63 });
    expect(verdict.resume).toBe(false);
    expect(verdict.detail).toBe('re-target 55% → 63% (solar surplus, battery 70%)');
  });

  it('the deadband suppresses sub-margin drift — no rounding-boundary flap', () => {
    // raw 63.1 vs stored 63: would round to the same integer anyway.
    expect(evaluateReTarget(input({ sessionTargetPercent: 63 }))).toMatchObject({
      change: 'none',
      newStopTarget: null,
      newTeslaLimit: null,
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
    expect(verdict).toMatchObject({ change: 'lower', newStopTarget: 59, newTeslaLimit: null });
    expect(verdict.detail).toBe('re-target 45% → 59% (battery 45%)');
  });

  it('a raise below Tesla’s floor carries both numbers (raw 48.1)', () => {
    const verdict = evaluateReTarget(
      input({ evSocPercent: 40, sessionTargetPercent: 47, sessionInitialTargetPercent: 47 })
    );
    expect(verdict).toMatchObject({ change: 'raise', newStopTarget: 48, newTeslaLimit: 50 });
  });

  it('a lower below the floor stops at the unclamped truth', () => {
    const verdict = evaluateReTarget(
      input({ evSocPercent: 40, homeBatterySocPercent: 32, sessionTargetPercent: 43 }) // raw 41.94
    );
    expect(verdict).toMatchObject({ change: 'lower', newStopTarget: 41, newTeslaLimit: null });
  });

  it('a battery-limited lower stops where the math lands (at the EV)', () => {
    const verdict = evaluateReTarget(
      input({ evSocPercent: 50, homeBatterySocPercent: 21, sessionTargetPercent: 60 }) // raw 50.16
    );
    expect(verdict).toMatchObject({ change: 'lower', newStopTarget: 50, newTeslaLimit: null });
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
      newTeslaLimit: 58,
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