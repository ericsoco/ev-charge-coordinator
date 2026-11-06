/**
 * Engine matrix: interlock order, merge-dark equivalence, filter-decline
 * recording, compute outcomes. Pure — inputs are plain objects.
 */
import { describe, expect, it } from 'vitest';
import { evaluateDecision, type DecisionInput } from '../../src/daemon/engine.js';
import type { EnergyConfig } from '../../src/utils/energy.js';

const HOME = { latitude: 37.7749, longitude: -122.4194 };
const CFG: EnergyConfig = {
  batteryCapacityKwh: 13.5,
  evBatteryKwh: 75,
  bufferPercent: 20,
  chargeEfficiency: 0.9,
};

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    sessionAlreadyDecided: false,
    event: 'plug_in',
    plugged: true,
    chargingState: 'Stopped',
    evSocPercent: 40,
    homeBatterySocPercent: 90,
    energyConfig: CFG,
    autoStart: { enabled: true, filters: [{ type: 'always' }] },
    dryRun: false,
    home: null,
    vehicleLocation: null,
    weather: null,
    ...overrides,
  };
}

describe('weather-adjusted reserve (P1c step 3)', () => {
  const WEATHER = { adjustmentPercent: 5, detail: 'low solar next 24h (600 < 2000 Wh/m²)' };

  it('raises the buffer in the math and audits it in reasonDetail', () => {
    const outcome = evaluateDecision(input({ weather: WEATHER }));
    expect(outcome.accepted).toBe(true);
    expect(outcome.reasonDetail).toContain('8.8 kWh above 25% buffer');
    expect(outcome.reasonDetail).toContain(
      ' — weather +5%: low solar next 24h (600 < 2000 Wh/m²)'
    );
  });

  it('the interlock uses the adjusted buffer, naming base and weather', () => {
    const outcome = evaluateDecision(input({ weather: WEATHER, homeBatterySocPercent: 22 }));
    expect(outcome).toMatchObject({ accepted: false, reasonCode: 'below_buffer' });
    expect(outcome.reasonDetail).toBe(
      'home battery 22% is at or below the 25% buffer (20% base + 5% weather)'
    );
    // Same SoC without weather clears the 20% base buffer and would start
    // (Tesla's 50% floor lifts the raw 40.3%) — the adjustment is what stops it.
    expect(evaluateDecision(input({ homeBatterySocPercent: 22 })).reasonCode).toBe('started');
  });

  it('null weather leaves the base plan untouched', () => {
    const outcome = evaluateDecision(input({ weather: null }));
    expect(outcome.reasonDetail).toContain('9.4 kWh above 20% buffer');
    expect(outcome.reasonDetail).not.toContain('weather +');
  });

  it('a non-positive adjustment is ignored (one-sided guarantee)', () => {
    const outcome = evaluateDecision(
      input({ weather: { adjustmentPercent: -5, detail: 'sunny' } })
    );
    expect(outcome.reasonDetail).toContain('9.4 kWh above 20% buffer');
    expect(outcome.reasonDetail).not.toContain('weather +');
  });
});

describe('interlocks', () => {
  it('duplicate_session short-circuits before any filter runs', () => {
    const outcome = evaluateDecision(
      input({
        sessionAlreadyDecided: true,
        autoStart: { enabled: true, filters: [{ type: 'geofence', radiusM: 100 }] },
      })
    );
    expect(outcome).toMatchObject({
      accepted: false,
      reasonCode: 'duplicate_session',
      filterResults: [],
      targetPercent: null,
    });
  });

  it('a stale plug_in with a disconnected state declines not_plugged_in', () => {
    expect(evaluateDecision(input({ plugged: false })).reasonCode).toBe('not_plugged_in');
  });

  it('an already-charging vehicle declines already_charging', () => {
    expect(evaluateDecision(input({ chargingState: 'Charging' })).reasonCode).toBe(
      'already_charging'
    );
  });

  it('missing energy config denies loudly with config_error', () => {
    const outcome = evaluateDecision(input({ energyConfig: null }));
    expect(outcome.reasonCode).toBe('config_error');
    expect(outcome.reasonDetail).toContain('config.json');
  });

  it('unreadable home battery SoC denies loudly with config_error', () => {
    const outcome = evaluateDecision(input({ homeBatterySocPercent: null }));
    expect(outcome.reasonCode).toBe('config_error');
    expect(outcome.reasonDetail).toContain('SoC unreadable');
  });

  it('SoC exactly at the buffer counts as below (energy.ts yields 0 available)', () => {
    const outcome = evaluateDecision(input({ homeBatterySocPercent: 20 }));
    expect(outcome.reasonCode).toBe('below_buffer');
    expect(outcome.reasonDetail).toContain('20%');
  });
});

describe('filters → compute', () => {
  it('a failing filter declines with its detail and the full audit recorded', () => {
    const outcome = evaluateDecision(
      input({
        autoStart: { enabled: true, filters: [{ type: 'geofence', radiusM: 100 }] },
      })
    );
    expect(outcome).toMatchObject({
      accepted: false,
      dryRun: false,
      reasonCode: 'filter_declined',
    });
    expect(outcome.reasonDetail).toContain('set-home-location');
    expect(outcome.filterResults).toHaveLength(1);
    expect(outcome.filterResults[0].reason).toBe('home_unset');
  });

  it('passing filters record their results alongside a started outcome', () => {
    const outcome = evaluateDecision(
      input({
        autoStart: { enabled: true, filters: [{ type: 'geofence', radiusM: 100 }] },
        home: { ...HOME },
        vehicleLocation: { ...HOME },
      })
    );
    expect(outcome.reasonCode).toBe('started');
    expect(outcome.filterResults).toHaveLength(1);
    expect(outcome.filterResults[0]).toMatchObject({ type: 'geofence', pass: true });
  });

  it('an empty chain passes (all plug-in events)', () => {
    const outcome = evaluateDecision(input({ autoStart: { enabled: true, filters: [] } }));
    expect(outcome.reasonCode).toBe('started');
    expect(outcome.filterResults).toEqual([]);
  });

  it('missing EV SoC fails compute_error after filters still ran', () => {
    const outcome = evaluateDecision(input({ evSocPercent: null }));
    expect(outcome.reasonCode).toBe('compute_error');
    expect(outcome.reasonDetail).toContain('EV SoC');
    expect(outcome.filterResults).toHaveLength(1);
  });

  it('a live pass starts with the computed limit (battery 90%, EV 40% → 51%, none)', () => {
    const outcome = evaluateDecision(input());
    expect(outcome).toMatchObject({
      accepted: true,
      dryRun: false,
      reasonCode: 'started',
      targetPercent: 51,
      limitedBy: 'none',
    });
    expect(outcome.reasonDetail).toContain('51%');
    // The row must explain the math (why 51?) without a second query.
    expect(outcome.reasonDetail).toContain('kWh above 20% buffer');
  });

  it('a no-gain tie declines insufficient_energy without touching the vehicle', () => {
    // Battery 21% → 0.1 kWh above the 20% buffer cannot move integer 67.
    const outcome = evaluateDecision(
      input({ evSocPercent: 67, homeBatterySocPercent: 21 })
    );
    expect(outcome).toMatchObject({
      accepted: false,
      reasonCode: 'insufficient_energy',
      targetPercent: null,
    });
    expect(outcome.reasonDetail).toContain("current 67%");
    expect(outcome.reasonDetail).toContain('kWh above 20% buffer');
    // Filters still ran and stay in the audit.
    expect(outcome.filterResults).toHaveLength(1);
  });

  it('a full pack declines insufficient_energy (nothing left to raise)', () => {
    const outcome = evaluateDecision(input({ evSocPercent: 100 }));
    expect(outcome.reasonCode).toBe('insufficient_energy');
    expect(outcome.reasonDetail).toContain('current 100%');
  });

  it('merge dark: the no-gain decline still records the mode', () => {
    const outcome = evaluateDecision(
      input({
        evSocPercent: 67,
        homeBatterySocPercent: 21,
        autoStart: { enabled: false, filters: [] },
      })
    );
    expect(outcome).toMatchObject({
      accepted: false,
      dryRun: true,
      reasonCode: 'insufficient_energy',
    });
  });
});

describe('modes (enabled / dry-run) evaluate identically', () => {
  it('disabled still records the full verdict: dry_run with the would-be limit', () => {
    const outcome = evaluateDecision(input({ autoStart: { enabled: false, filters: [] } }));
    expect(outcome).toMatchObject({
      accepted: false,
      dryRun: true,
      reasonCode: 'dry_run',
      targetPercent: 51,
      limitedBy: 'none',
    });
    expect(outcome.reasonDetail).toContain('autoStart disabled');
  });

  it('the --dry-run flag records dry_run without disabling anything', () => {
    const outcome = evaluateDecision(
      input({ dryRun: true, autoStart: { enabled: true, filters: [] } })
    );
    expect(outcome).toMatchObject({ accepted: false, dryRun: true, reasonCode: 'dry_run' });
    expect(outcome.reasonDetail).toContain('dry-run mode');
  });

  it('merge dark: disabled + geofence decline records filter_declined, not dry_run', () => {
    const outcome = evaluateDecision(
      input({
        autoStart: { enabled: false, filters: [{ type: 'geofence', radiusM: 100 }] },
      })
    );
    expect(outcome).toMatchObject({
      accepted: false,
      dryRun: true,
      reasonCode: 'filter_declined',
    });
    expect(outcome.filterResults[0].reason).toBe('home_unset');
  });

  it('a live decline stays dry_run=0: the mode was live and it said no', () => {
    const outcome = evaluateDecision(
      input({
        autoStart: { enabled: true, filters: [{ type: 'geofence', radiusM: 100 }] },
      })
    );
    expect(outcome).toMatchObject({
      accepted: false,
      dryRun: false,
      reasonCode: 'filter_declined',
    });
  });
});

describe('stopTargetPercent (the monitor\u2019s stop threshold)', () => {
  it('normal case: the stop target is the Tesla limit the math produced', () => {
    // battery 90%, EV 40% → limitedBy none, limit 51 — car enforces it, our stop is the backstop.
    const outcome = evaluateDecision(input());
    expect(outcome).toMatchObject({ targetPercent: 51, stopTargetPercent: 51 });
  });

  it('sub-50 case: floor of the unclamped raw target, never Tesla\u2019s 50% floor', () => {
    // battery 100%, EV 30% → raw 42.96% → limit clamped to 50, stop target floor(42.96) = 42.
    const outcome = evaluateDecision(
      input({ evSocPercent: 30, homeBatterySocPercent: 100 })
    );
    expect(outcome).toMatchObject({
      accepted: true,
      limitedBy: 'tesla-minimum',
      targetPercent: 50,
      stopTargetPercent: 42,
    });
  });

  it('declines carry no stop target', () => {
    const below = evaluateDecision(input({ homeBatterySocPercent: 20 }));
    expect(below.stopTargetPercent).toBeNull();
    const noGain = evaluateDecision(input({ evSocPercent: 67, homeBatterySocPercent: 21 }));
    expect(noGain.stopTargetPercent).toBeNull();
  });

  it('merge dark: a dry-run verdict carries the same stop target', () => {
    const outcome = evaluateDecision(
      input({ evSocPercent: 30, homeBatterySocPercent: 100, autoStart: { enabled: false, filters: [] } })
    );
    expect(outcome).toMatchObject({
      reasonCode: 'dry_run',
      targetPercent: 50,
      stopTargetPercent: 42,
    });
  });
});

