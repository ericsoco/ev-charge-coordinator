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
    ...overrides,
  };
}

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

