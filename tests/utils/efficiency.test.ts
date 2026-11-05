/**
 * Measured-efficiency estimator (pure): clean-session filters, window, gate,
 * energy-weighted (ratio-of-sums) mean, config overlay, shared clause wording.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EFFICIENCY_POLICY,
  applyEfficiency,
  efficiencyClause,
  estimateEfficiency,
  type EfficiencySample,
} from '../../src/utils/efficiency.js';
import type { EnergyConfig } from '../../src/utils/energy.js';

const CFG: EnergyConfig = {
  batteryCapacityKwh: 13.5,
  evBatteryKwh: 75,
  bufferPercent: 20,
  chargeEfficiency: 0.9,
};

/** n clean samples, newest first: house 10 kWh @ efficiency 0.9. */
function clean(n: number): EfficiencySample[] {
  return Array.from({ length: n }, () => ({ houseEnergyKwh: 10, efficiency: 0.9 }));
}

describe('estimateEfficiency', () => {
  it('returns null below the gate, counting what survived', () => {
    expect(estimateEfficiency(clean(4))).toEqual({ efficiency: null, samples: 4 });
    expect(estimateEfficiency([])).toEqual({ efficiency: null, samples: 0 });
  });

  it('gates at exactly the minimum', () => {
    const result = estimateEfficiency(clean(5));
    expect(result.efficiency).toBeCloseTo(0.9, 10);
    expect(result.samples).toBe(5);
  });

  it('filters dirty samples BEFORE the window (dirty rows do not consume slots)', () => {
    const rows: EfficiencySample[] = [
      ...clean(3),
      { houseEnergyKwh: 10, efficiency: 1.4 }, // skew — excluded
      { houseEnergyKwh: 0.1, efficiency: 0.5 }, // meter noise — excluded
      { houseEnergyKwh: 10, efficiency: 0 }, // no transfer info — excluded
      ...clean(3),
    ];
    expect(estimateEfficiency(rows)).toEqual({ efficiency: expect.closeTo(0.9, 10), samples: 6 });
  });

  it('keeps boundary values: efficiency 1.0 and house exactly 0.5 are clean', () => {
    const rows = [
      { houseEnergyKwh: 0.5, efficiency: 1.0 },
      ...clean(4),
    ];
    expect(estimateEfficiency(rows).samples).toBe(5);
  });

  it('windows to the latest N clean rows (newest-first input)', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => ({ houseEnergyKwh: 10, efficiency: 0.9 })),
      { houseEnergyKwh: 10, efficiency: 0.7 }, // 21st clean, oldest — outside the window
    ];
    const result = estimateEfficiency(rows);
    expect(result.samples).toBe(DEFAULT_EFFICIENCY_POLICY.window);
    expect(result.efficiency).toBeCloseTo(0.9, 10); // the 0.7 row was sliced off
  });

  it('weights by house energy — ratio of sums, not the plain mean', () => {
    const rows: EfficiencySample[] = [
      { houseEnergyKwh: 0.6, efficiency: 0.5 }, // newest: tiny session, poor ratio
      ...clean(4),
    ];
    // Σev/Σhouse = (0.3 + 36) / (0.6 + 40) = 36.3 / 40.6 ≈ 0.894 — the tiny
    // session barely moves it. The plain mean (0.5 + 4×0.9)/5 = 0.82 would
    // let 0.6 kWh outweigh 40 kWh — weighting is the whole point.
    const result = estimateEfficiency(rows);
    expect(result.efficiency).toBeCloseTo(36.3 / 40.6, 10);
    expect(result.efficiency).not.toBeCloseTo(0.82, 2);
  });

  it('honors a custom policy', () => {
    const result = estimateEfficiency(clean(3), { ...DEFAULT_EFFICIENCY_POLICY, minSamples: 3 });
    expect(result.efficiency).toBeCloseTo(0.9, 10);
  });
});

describe('applyEfficiency', () => {
  it('below the gate the config stands untouched', () => {
    const effective = applyEfficiency(CFG, { efficiency: null, samples: 2 });
    expect(effective.source).toBe('config');
    expect(effective.config).toBe(CFG);
  });

  it('above the gate only chargeEfficiency changes', () => {
    const effective = applyEfficiency(CFG, { efficiency: 0.913, samples: 12 });
    expect(effective.source).toBe('measured');
    expect(effective.config).toEqual({ ...CFG, chargeEfficiency: 0.913 });
  });

  it('throws when an out-of-range estimate slips past the filters', () => {
    expect(() => applyEfficiency(CFG, { efficiency: 1.5, samples: 5 })).toThrow(
      /out of \(0, 1\]/
    );
  });
});

describe('efficiencyClause (shared wording)', () => {
  it('names the measured value and session count', () => {
    const effective = applyEfficiency(CFG, { efficiency: 0.913, samples: 12 });
    expect(efficiencyClause(effective)).toBe('efficiency 0.913 (measured, 12 sessions)');
  });

  it('config fallback explains why: no history, or under the gate', () => {
    expect(efficiencyClause(applyEfficiency(CFG, { efficiency: null, samples: 0 }))).toBe(
      'efficiency 0.900 (config, no clean sessions yet)'
    );
    expect(efficiencyClause(applyEfficiency(CFG, { efficiency: null, samples: 4 }))).toBe(
      'efficiency 0.900 (config, 4 clean < 5)'
    );
  });
});