/**
 * Pure aggregate math: monotonicDelta's reset-skipping and the session
 * close computation.
 */
import { describe, expect, it } from 'vitest';
import {
  computeSessionAggregates,
  monotonicDelta,
} from '../../src/daemon/sessionAggregates.js';
import type { EvSampleRow, HomeEnergyCountersRow } from '../../src/store/types.js';

function evSample(overrides: Partial<EvSampleRow>): EvSampleRow {
  return {
    id: 0,
    siteId: 'home',
    vehicleId: 'VIN',
    tsMs: 0,
    state: null,
    chargingState: null,
    socPercent: null,
    chargeLimitSoc: null,
    chargeRateKw: null,
    minutesToFull: null,
    chargeEnergyAddedKwh: null,
    atHome: null,
    ...overrides,
  };
}

function counter(overrides: Partial<HomeEnergyCountersRow>): HomeEnergyCountersRow {
  return {
    id: 0,
    siteId: 'home',
    homeBatteryId: 'GW',
    tsMs: 0,
    batteryChargeKwh: null,
    batteryDischargeKwh: null,
    gridImportKwh: null,
    gridExportKwh: null,
    solarKwh: null,
    homeUseKwh: null,
    ...overrides,
  };
}

describe('monotonicDelta', () => {
  it('sums increases in a monotonic sequence', () => {
    expect(monotonicDelta([1, 2, 3])).toBe(2);
    expect(monotonicDelta([10.5, 12])).toBeCloseTo(1.5, 10);
  });

  it('drops resets instead of counting negative energy', () => {
    expect(monotonicDelta([1, 5, 2, 6])).toBe(8); // +4, drop, +4
    expect(monotonicDelta([5, 3, 1])).toBe(0); // only decreases
  });

  it('handles the empty and single-value edges', () => {
    expect(monotonicDelta([])).toBeNull();
    expect(monotonicDelta([7])).toBe(0);
  });

  it('survives a day-so-far counter resetting at midnight mid-session', () => {
    // 10 → 12 kWh, midnight reset, 0.5 → 1: real discharge = 2 + 0.5.
    expect(monotonicDelta([10, 12, 0.5, 1])).toBeCloseTo(2.5, 10);
  });
});

describe('computeSessionAggregates', () => {
  it('computes every field from samples and counters', () => {
    const result = computeSessionAggregates({
      evSamples: [
        evSample({ tsMs: 1_000, socPercent: 40, chargeEnergyAddedKwh: 0 }),
        evSample({ tsMs: 60_000, socPercent: 49, chargeEnergyAddedKwh: 3 }),
        // Tesla resets the session meter mid-session; then resumes.
        evSample({ tsMs: 120_000, socPercent: 54, chargeEnergyAddedKwh: 12 }),
        evSample({ tsMs: 180_000, socPercent: 58, chargeEnergyAddedKwh: 1 }),
        evSample({ tsMs: 240_000, socPercent: 58, chargeEnergyAddedKwh: 5 }),
      ],
      counters: [
        counter({ tsMs: 1_000, batteryDischargeKwh: 100 }),
        counter({ tsMs: 120_000, batteryDischargeKwh: 107 }),
        counter({ tsMs: 240_000, batteryDischargeKwh: 114.2 }),
      ],
      plugTsMs: 0,
      unplugTsMs: 300_000,
    });

    // energy: 0→3 (+3), 3→12 (+9), 12→1 reset dropped, 1→5 (+4) = 16
    expect(result.energyKwh).toBeCloseTo(16, 10);
    expect(result.houseEnergyKwh).toBeCloseTo(14.2, 10);
    expect(result.energyPercent).toBe(18); // 40 → 58
    expect(result.elapsedMs).toBe(300_000);
    expect(result.efficiency).toBeCloseTo(16 / 14.2, 10);
  });

  it('returns nulls when there is nothing to observe', () => {
    const result = computeSessionAggregates({
      evSamples: [],
      counters: [],
      plugTsMs: 0,
      unplugTsMs: 1_000,
    });
    expect(result).toEqual({
      energyKwh: null,
      energyPercent: null,
      elapsedMs: 1_000,
      houseEnergyKwh: null,
      efficiency: null,
    });
  });

  it('needs two samples for a soc change; one says nothing', () => {
    const oneSample = computeSessionAggregates({
      evSamples: [evSample({ socPercent: 50, chargeEnergyAddedKwh: 4 })],
      counters: [],
      plugTsMs: 0,
      unplugTsMs: 1_000,
    });
    expect(oneSample.energyPercent).toBeNull();
    expect(oneSample.energyKwh).toBe(0); // observed, no observed change
    expect(oneSample.efficiency).toBeNull(); // no house energy observed
  });

  it('nulls efficiency when the house delivered no energy', () => {
    const result = computeSessionAggregates({
      evSamples: [
        evSample({ socPercent: 40, chargeEnergyAddedKwh: 0 }),
        evSample({ socPercent: 50, chargeEnergyAddedKwh: 7 }),
      ],
      counters: [counter({ batteryDischargeKwh: 50 })],
      plugTsMs: 0,
      unplugTsMs: 1_000,
    });
    expect(result.houseEnergyKwh).toBe(0); // one point, no observed change
    expect(result.efficiency).toBeNull();
  });
});
