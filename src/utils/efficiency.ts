/**
 * Measured charge efficiency (design §3.6.1): a rolling estimate from closed
 * sessions' (EV kWh added ÷ house kWh discharged) that replaces the static
 * config `chargeEfficiency` once enough clean data exists — the config value
 * stays the fallback (and the first-run seed) below the gate. Pure: no db, no
 * config files; callers fetch rows and compose.
 *
 * Energy-weighted (ratio of sums): weighting each ratio by its house energy
 * makes the estimate ΣEV ÷ Σhouse over the window — a 0.6-kWh session cannot
 * skew a budget meant to spend kilowatt-hours, and the number reads as "of
 * everything the battery gave, this fraction arrived".
 *
 * The cleanliness filters exist because the raw ratio is untrustworthy at the
 * tails: > 1 means measurement skew (or solar assist — workplan limitation
 * note), ≤ 0 carries no transfer information and would poison config
 * validation, and tiny house denominators amplify meter quantization into
 * absurd ratios.
 */
import type { EnergyConfig } from './energy.js';

export interface EfficiencySample {
  /** House kWh discharged over the session (the denominator). */
  houseEnergyKwh: number;
  /** EV kWh added ÷ house kWh discharged — stored raw, may exceed 1. */
  efficiency: number;
}

export interface EfficiencyPolicy {
  /** Latest N clean sessions that count toward the estimate. */
  window: number;
  /** Clean sessions required before the estimate overrides config. */
  minSamples: number;
  /** Denominator floor (kWh) — below this the ratio is meter noise. */
  minHouseKwh: number;
  /** Inclusive plausibility cap; above it the sample is excluded. */
  maxEfficiency: number;
}

export const DEFAULT_EFFICIENCY_POLICY: EfficiencyPolicy = {
  window: 20,
  minSamples: 5,
  minHouseKwh: 0.5,
  maxEfficiency: 1.0,
};

/** Fetch buffer: enough raw rows that filtering down to `window` still has data. */
export const EFFICIENCY_FETCH_LIMIT = 100;

export interface MeasuredEfficiency {
  /** The estimate, or null when the gate is not met. */
  efficiency: number | null;
  /** Clean sessions inside the window (post-filter count; may be < gate). */
  samples: number;
}

/**
 * Filter → window → gate → energy-weighted mean. Rows arrive newest-first
 * (the store orders them), so `slice(0, window)` keeps the latest clean ones.
 * `efficiency: null` exactly when fewer than `minSamples` survive — the
 * denominator floor guarantees a positive sum otherwise.
 */
export function estimateEfficiency(
  rows: readonly EfficiencySample[],
  policy: EfficiencyPolicy = DEFAULT_EFFICIENCY_POLICY
): MeasuredEfficiency {
  const clean = rows.filter(
    (row) =>
      row.efficiency > 0 &&
      row.efficiency <= policy.maxEfficiency &&
      row.houseEnergyKwh >= policy.minHouseKwh
  );
  const window = clean.slice(0, policy.window);
  if (window.length < policy.minSamples) {
    return { efficiency: null, samples: window.length };
  }

  let house = 0;
  let ev = 0;
  for (const row of window) {
    house += row.houseEnergyKwh;
    ev += row.houseEnergyKwh * row.efficiency;
  }
  return { efficiency: ev / house, samples: window.length };
}

export interface EffectiveEfficiency {
  /** The config with `chargeEfficiency` overridden when the estimate exists. */
  config: EnergyConfig;
  source: 'measured' | 'config';
  measured: MeasuredEfficiency;
}

/** Overlay the estimate onto the config; below the gate the config stands. */
export function applyEfficiency(
  cfg: EnergyConfig,
  measured: MeasuredEfficiency
): EffectiveEfficiency {
  if (measured.efficiency === null) {
    return { config: cfg, source: 'config', measured };
  }
  // Defense: the estimate must satisfy the same (0, 1] rule as the config —
  // throw on a broken invariant rather than compute with it.
  if (!(measured.efficiency > 0 && measured.efficiency <= 1)) {
    throw new Error(`Measured efficiency out of (0, 1]: ${measured.efficiency}`);
  }
  return { config: { ...cfg, chargeEfficiency: measured.efficiency }, source: 'measured', measured };
}

/**
 * The one wording for "which efficiency shaped this math" — shared by the
 * decision audit (reasonDetail) and the charge-from-battery display so the
 * two can never drift (PR #62's DRY lesson).
 */
export function efficiencyClause(
  effective: EffectiveEfficiency,
  policy: EfficiencyPolicy = DEFAULT_EFFICIENCY_POLICY
): string {
  const { config, source, measured } = effective;
  if (source === 'measured' && measured.efficiency !== null) {
    return `efficiency ${measured.efficiency.toFixed(3)} (measured, ${measured.samples} sessions)`;
  }
  const fallback = config.chargeEfficiency.toFixed(3);
  return measured.samples === 0
    ? `efficiency ${fallback} (config, no clean sessions yet)`
    : `efficiency ${fallback} (config, ${measured.samples} clean < ${policy.minSamples})`;
}