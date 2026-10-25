/**
 * Pure filter chain: distance math, always/geofence matrices, chain AND
 * semantics. Inputs are plain objects — no I/O by construction.
 */
import { describe, expect, it } from 'vitest';
import { distanceM, runFilters, type FilterInput } from '../../src/decision/filters.js';
import type { DecisionFilterConfig } from '../../src/utils/daemonConfig.js';

const HOME = { latitude: 37.7749, longitude: -122.4194 };
/** ~11 m north of HOME (0.0001° latitude). */
const NEAR = { latitude: 37.775, longitude: -122.4194 };

function input(overrides: Partial<FilterInput> = {}): FilterInput {
  return {
    event: 'plug_in',
    plugged: true,
    chargingState: 'Stopped',
    home: { ...HOME },
    vehicleLocation: { ...HOME },
    homeBatterySocPercent: 55,
    energyConfig: { bufferPercent: 20 },
    ...overrides,
  };
}

describe('distanceM', () => {
  it('is zero for identical points', () => {
    expect(distanceM(HOME, { ...HOME })).toBe(0);
  });

  it('is ~111.19 km per degree of latitude', () => {
    expect(distanceM({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(
      111_195,
      0
    );
  });

  it('is symmetric', () => {
    expect(distanceM(HOME, NEAR)).toBe(distanceM(NEAR, HOME));
  });
});

describe('always', () => {
  it('passes even when nothing else is known (no-location auto-start mode)', () => {
    const chain = runFilters([{ type: 'always' }], input({ home: null, vehicleLocation: null }));
    expect(chain).toEqual({
      pass: true,
      results: [{ type: 'always', pass: true, reason: 'always' }],
    });
  });
});

describe('geofence', () => {
  it('passes at home with the distance recorded', () => {
    const { pass, results } = runFilters([{ type: 'geofence', radiusM: 100 }], input());
    expect(pass).toBe(true);
    expect(results[0]).toMatchObject({ type: 'geofence', pass: true, reason: 'geofence', distanceM: 0 });
    expect(results[0].detail).toContain('0 m of 100 m');
  });

  it('boundary distance == radius passes', () => {
    const radiusM = Math.round(distanceM(HOME, NEAR));
    const { pass, results } = runFilters([{ type: 'geofence', radiusM }], input({
      vehicleLocation: { ...NEAR },
    }));
    expect(pass).toBe(true);
    expect(results[0].reason).toBe('geofence');
  });

  it('outside the radius fails not_at_home with the distance in the detail', () => {
    const { pass, results } = runFilters([{ type: 'geofence', radiusM: 5 }], input({
      vehicleLocation: { ...NEAR },
    }));
    expect(pass).toBe(false);
    expect(results[0]).toMatchObject({ pass: false, reason: 'not_at_home', distanceM: 11 });
    expect(results[0].detail).toContain('outside the 5 m radius');
  });

  it('missing home secret fails home_unset even with a location in hand', () => {
    const { pass, results } = runFilters([{ type: 'geofence', radiusM: 100 }], input({
      home: null,
    }));
    expect(pass).toBe(false);
    expect(results[0]).toMatchObject({ reason: 'home_unset' });
    expect(results[0].distanceM).toBeUndefined();
    expect(results[0].detail).toContain('set-home-location');
  });

  it('home_unset wins over an unavailable location (config checked first)', () => {
    const { results } = runFilters([{ type: 'geofence', radiusM: 100 }], input({
      home: null,
      vehicleLocation: null,
    }));
    expect(results[0].reason).toBe('home_unset');
  });

  it('location fetch failure fails location_unavailable (deny-by-default)', () => {
    const { pass, results } = runFilters([{ type: 'geofence', radiusM: 100 }], input({
      vehicleLocation: null,
    }));
    expect(pass).toBe(false);
    expect(results[0]).toMatchObject({ reason: 'location_unavailable' });
    expect(results[0].distanceM).toBeUndefined();
    expect(results[0].detail).toContain('vehicle_location');
  });

  for (const radiusM of [0, -5, undefined, Number.NaN]) {
    it(`radius ${String(radiusM)} fails config_error (defense behind config validation)`, () => {
      const { pass, results } = runFilters([{ type: 'geofence', radiusM }], input());
      expect(pass).toBe(false);
      expect(results[0]).toMatchObject({ reason: 'config_error' });
      expect(results[0].distanceM).toBeUndefined();
    });
  }
});

describe('runFilters chain', () => {
  it('an empty chain passes with no results (all plug-in events)', () => {
    expect(runFilters([], input())).toEqual({ pass: true, results: [] });
  });

  it('AND semantics: records every result even after a failure', () => {
    const chain = runFilters(
      [
        { type: 'always' },
        { type: 'geofence', radiusM: 5 },
      ],
      input({ vehicleLocation: { ...NEAR } })
    );
    expect(chain.pass).toBe(false);
    expect(chain.results).toHaveLength(2);
    expect(chain.results[0].pass).toBe(true);
    expect(chain.results[1].pass).toBe(false);
  });

  it('passes when every filter passes', () => {
    const chain = runFilters([{ type: 'always' }, { type: 'geofence', radiusM: 100 }], input());
    expect(chain.pass).toBe(true);
    expect(chain.results.map((r) => r.type)).toEqual(['always', 'geofence']);
  });

  it('an unknown type reaching the evaluator fails loudly', () => {
    const bogus = { type: 'moon_phase' } as unknown as DecisionFilterConfig;
    const chain = runFilters([bogus], input());
    expect(chain.pass).toBe(false);
    expect(chain.results[0]).toMatchObject({ reason: 'config_error' });
    expect(chain.results[0].detail).toContain('moon_phase');
  });
});
