/**
 * Pure energy math: two percent-of-different-packs readings in, one Tesla
 * charge limit out. No I/O -- every case is a direct call to
 * computeChargeLimit with an explicit config.
 */
import { describe, expect, it } from 'vitest';
import {
  computeChargeLimit,
  DEFAULT_ENERGY_CONFIG,
  type EnergyConfig,
} from '../../src/utils/energy.js';

/** 13.5 kWh house pack, 75 kWh EV, 20% buffer, 90% efficiency, 1 kWh minimum. */
const CFG: EnergyConfig = { ...DEFAULT_ENERGY_CONFIG };

describe('computeChargeLimit - the case that motivated the rewrite', () => {
  it('turns a full 13.5 kWh house battery into a sane limit for a 75 kWh car', () => {
    // The deleted percent rule read 100% - 20% buffer as "80% available" and
    // asked Tesla for an 80% limit (~60 kWh on a Model Y) while the house
    // pack holds 10.8 kWh above the buffer -- a ~5.5x over-promise.
    const limit = computeChargeLimit(50, 100, CFG);

    expect(limit.batteryAvailableKwh).toBeCloseTo(10.8, 3);
    expect(limit.targetPercent).toBeGreaterThanOrEqual(60);
    expect(limit.targetPercent).toBeLessThanOrEqual(65);
    expect(limit.targetPercent).toBe(63); // not the old dimensionally-invalid 80
    expect(limit.limitedBy).toBe('none');
  });
});

describe('computeChargeLimit - buffer handling', () => {
  it('treats a zero buffer as the whole battery being available', () => {
    const limit = computeChargeLimit(50, 50, { ...CFG, bufferPercent: 0 });

    expect(limit.batteryAvailableKwh).toBeCloseTo(6.75, 3);
    expect(limit.limitedBy).toBe('none');
  });

  it('marks a full-size (100%) buffer as not enough charge', () => {
    const limit = computeChargeLimit(50, 100, { ...CFG, bufferPercent: 100 });

    expect(limit.batteryAvailableKwh).toBe(0);
    expect(limit.limitedBy).toBe('battery');
  });

  it('floors availability at zero when the buffer exceeds the current SoC', () => {
    const limit = computeChargeLimit(50, 30, { ...CFG, bufferPercent: 40 });

    expect(limit.batteryAvailableKwh).toBe(0);
    expect(limit.limitedBy).toBe('battery');
  });
});

describe('computeChargeLimit - charge efficiency', () => {
  it('delivers everything at efficiency 1.0', () => {
    const limit = computeChargeLimit(50, 100, { ...CFG, chargeEfficiency: 1.0 });

    // 37.5 kWh now + 10.8 kWh spare = 48.3 kWh -> 64.4%.
    expect(limit.evTargetKwh).toBeCloseTo(48.3, 3);
    expect(limit.targetPercent).toBe(64);
  });

  it('halves the delivered energy at efficiency 0.5', () => {
    const limit = computeChargeLimit(50, 100, { ...CFG, chargeEfficiency: 0.5 });

    // 37.5 kWh now + 5.4 kWh spare = 42.9 kWh -> 57.2%.
    expect(limit.evTargetKwh).toBeCloseTo(42.9, 3);
    expect(limit.targetPercent).toBe(57);
  });
});

describe('computeChargeLimit - Tesla 50% floor', () => {
  it('sets 50% and reports tesla-minimum when the math lands below it', () => {
    const limit = computeChargeLimit(20, 40, CFG);

    expect(limit.batteryAvailableKwh).toBeCloseTo(2.7, 3);
    expect(limit.rawPercent).toBeCloseTo(23.24, 2);
    expect(limit.targetPercent).toBe(50);
    expect(limit.limitedBy).toBe('tesla-minimum');
  });
});

describe('computeChargeLimit - EV capacity ceiling and already-charged EVs', () => {
  it('clamps to 100% and reports ev-capacity when the pack would overfill', () => {
    const limit = computeChargeLimit(100, 90, CFG);

    expect(limit.evTargetKwh).toBe(75);
    expect(limit.targetPercent).toBe(100);
    expect(limit.limitedBy).toBe('ev-capacity');
  });

  it('can round below the current SoC when the spare is tiny, which the handler reads as nothing to gain', () => {
    // minCharge 0 lets a 0.0675 kWh spare through; rounding puts the target
    // (54%) under the EV's current 54.4%. chargeFromBattery skips the write.
    const limit = computeChargeLimit(54.4, 20.5, { ...CFG, minChargeKwh: 0 });

    expect(limit.limitedBy).toBe('none');
    expect(limit.targetPercent).toBe(54);
    expect(limit.targetPercent).toBeLessThan(54.4);
  });
});

describe('computeChargeLimit - minimum-spare abort', () => {
  it('reports battery-limited just below the minimum spare', () => {
    const limit = computeChargeLimit(50, 21, CFG); // 0.135 kWh above buffer

    expect(limit.batteryAvailableKwh).toBeCloseTo(0.135, 3);
    expect(limit.limitedBy).toBe('battery');
  });

  it('proceeds just above the minimum spare', () => {
    const limit = computeChargeLimit(50, 28, CFG); // 1.08 kWh above buffer

    expect(limit.batteryAvailableKwh).toBeCloseTo(1.08, 3);
    expect(limit.limitedBy).toBe('none');
  });
});

describe('computeChargeLimit - config validation happens at the boundary', () => {
  it.each([
    ['zero battery capacity', { batteryCapacityKwh: 0 }],
    ['negative EV capacity', { evBatteryKwh: -1 }],
    ['zero efficiency', { chargeEfficiency: 0 }],
    ['efficiency above 1', { chargeEfficiency: 1.5 }],
    ['negative buffer', { bufferPercent: -1 }],
    ['buffer above 100', { bufferPercent: 101 }],
    ['negative minimum', { minChargeKwh: -1 }],
  ])('rejects %s', (_label, patch) => {
    expect(() => computeChargeLimit(50, 50, { ...CFG, ...patch })).toThrow(/Invalid energy config/);
  });

  it('names every bad field in one message', () => {
    expect(() =>
      computeChargeLimit(50, 50, { ...CFG, batteryCapacityKwh: -1, chargeEfficiency: 2 })
    ).toThrow(/batteryCapacityKwh.*chargeEfficiency/);
  });
});

describe('computeChargeLimit - unreadable SoC input', () => {
  it('rejects a non-finite solar battery SoC (the proxy can omit battery_soc)', () => {
    expect(() => computeChargeLimit(50, Number.NaN, CFG)).toThrow(/Solar battery SoC/);
    expect(() => computeChargeLimit(50, undefined as unknown as number, CFG)).toThrow(
      /Solar battery SoC/
    );
  });

  it('rejects a non-finite EV SoC', () => {
    expect(() => computeChargeLimit(undefined as unknown as number, 50, CFG)).toThrow(/EV SoC/);
    expect(() => computeChargeLimit(Number.NaN, 50, CFG)).toThrow(/EV SoC/);
  });

  it('rejects SoC values outside 0-100', () => {
    expect(() => computeChargeLimit(50, 120, CFG)).toThrow(/Solar battery SoC/);
    expect(() => computeChargeLimit(-5, 50, CFG)).toThrow(/EV SoC/);
  });
});
