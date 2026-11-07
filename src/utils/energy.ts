/**
 * Energy math for `charge-from-battery`.
 *
 * Pure module: no I/O, no services, no store. Two state-of-charge readings --
 * each a percent of a different pack -- are converted into one vehicle
 * charge-limit percent via kWh, the only unit both packs share. Comparing raw
 * percentages is dimensionally invalid (percent of a ~13.5 kWh house battery
 * against percent of a ~75 kWh car), so there is deliberately no percent-based
 * path here.
 */

/** Tunables for the charge-limit computation. Capacities are usable kWh. */
export interface EnergyConfig {
  /** House pack size (FranklinWH aPower 2 usable). */
  batteryCapacityKwh: number;
  /** EV pack size (Model Y usable). */
  evBatteryKwh: number;
  /** Reserve kept in the house pack, percent of batteryCapacityKwh, 0-100. */
  bufferPercent: number;
  /** Fraction of house energy that reaches the car, in (0, 1]. */
  chargeEfficiency: number;
}

/**
 * The vehicle's settable charge-limit bounds. The DEFAULT is Tesla's policy
 * (rejects anything below 50%); a future EV adapter passes its own bounds --
 * the clamp and the floor verdict below key off this, never off a hardcoded
 * make. The CLI setter validates against the default until bounds flow from
 * the service (EV #2 seam, recorded in the workplan).
 */
export interface ChargeLimitBounds {
  /** Lowest limit the vehicle accepts, percent. */
  minPercent: number;
  /** Highest limit the vehicle accepts, percent. */
  maxPercent: number;
}

/** Tesla's bounds today — the only vehicle implemented so far. */
export const DEFAULT_CHARGE_LIMIT_BOUNDS: ChargeLimitBounds = {
  minPercent: 50,
  maxPercent: 100,
};

/**
 * Why the target is what it is: nothing constrained it (`none`), the available
 * house energy cannot raise the target above the EV's current charge
 * (`battery`), the EV pack would overfill (`ev-capacity`), or the kWh math
 * landed below the vehicle's minimum settable limit (`vehicle-minimum`).
 */
export type EnergyLimitedBy = 'none' | 'battery' | 'ev-capacity' | 'vehicle-minimum';

/** The computed charge-limit decision and the reasoning to show the user. */
export interface EnergyChargeLimit {
  /** House energy above the buffer, floored at 0, in kWh. */
  batteryAvailableKwh: number;
  /** Energy the EV holds now, in kWh. */
  evCurrentKwh: number;
  /** Energy the EV would hold at the target, in kWh. */
  evTargetKwh: number;
  /** Integer vehicle limit to request, clamped to the bounds. */
  targetPercent: number;
  /** What shaped the target; see EnergyLimitedBy. */
  limitedBy: EnergyLimitedBy;
  /** The unclamped percentage, for explaining a `vehicle-minimum` result. */
  rawPercent: number;
}

/**
 * Per-field validation shared by the config store (on load and on write) and
 * by computeChargeLimit (defense for direct callers). Keys are in schema
 * order -- the order the first-run flow prompts in.
 */
const FIELD_CHECKS: { [K in keyof EnergyConfig]: (value: number) => string | null } = {
  batteryCapacityKwh: (v) => (v > 0 ? null : `batteryCapacityKwh = ${v} (must be > 0)`),
  evBatteryKwh: (v) => (v > 0 ? null : `evBatteryKwh = ${v} (must be > 0)`),
  bufferPercent: (v) =>
    v >= 0 && v <= 100 ? null : `bufferPercent = ${v} (must be 0-100)`,
  chargeEfficiency: (v) =>
    v > 0 && v <= 1 ? null : `chargeEfficiency = ${v} (must be in (0, 1])`,
};

/** Schema-ordered field names. */
export const ENERGY_CONFIG_FIELDS = Object.keys(FIELD_CHECKS) as (keyof EnergyConfig)[];

/**
 * One problem message for one field's value (type and range), or null if it
 * is fine. Accepts `unknown` so hand-edited JSON of the wrong shape is caught
 * by the same path as out-of-range numbers.
 */
export function energyConfigFieldProblem(field: keyof EnergyConfig, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const shown = typeof value === 'number' ? String(value) : (JSON.stringify(value) ?? 'undefined');
    return `${field} = ${shown} (must be a number)`;
  }
  return FIELD_CHECKS[field](value);
}

/** Every problem in a complete config: one message per bad field. */
export function energyConfigProblems(cfg: EnergyConfig): string[] {
  const problems: string[] = [];
  for (const field of ENERGY_CONFIG_FIELDS) {
    const problem = energyConfigFieldProblem(field, cfg[field]);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

/** Throw on a misconfigured pack rather than clamping it into a wrong answer. */
export function validateEnergyConfig(cfg: EnergyConfig): void {
  const problems = energyConfigProblems(cfg);
  if (problems.length > 0) {
    throw new Error(`Invalid energy config: ${problems.join('; ')}`);
  }
}

/** A SoC outside 0-100 (including undefined/NaN) means unreadable input, not a value to math on. */
function validateSoC(soc: number, label: string): void {
  if (!Number.isFinite(soc) || soc < 0 || soc > 100) {
    throw new Error(`${label} SoC must be a number between 0 and 100 (got ${soc})`);
  }
}

/**
 * Compute the vehicle charge limit that delivers the spare house energy to
 * the EV, bounded by the vehicle's settable limits.
 *
 * batteryAvailableKwh = capacity x max(0, batterySoc - bufferPercent) / 100
 * evTargetKwh         = min(evCapacity, evCurrent + available x efficiency)
 * targetPercent       = clamp(round(evTargetKwh / evCapacity x 100), bounds)
 */
export function computeChargeLimit(
  evSocPercent: number,
  batterySocPercent: number,
  cfg: EnergyConfig,
  bounds: ChargeLimitBounds = DEFAULT_CHARGE_LIMIT_BOUNDS
): EnergyChargeLimit {
  validateEnergyConfig(cfg);
  validateSoC(evSocPercent, 'EV');
  validateSoC(batterySocPercent, 'Solar battery');

  const batteryAvailableKwh =
    (cfg.batteryCapacityKwh * Math.max(0, batterySocPercent - cfg.bufferPercent)) / 100;
  const evCurrentKwh = (cfg.evBatteryKwh * evSocPercent) / 100;
  const evTargetKwh = Math.min(
    cfg.evBatteryKwh,
    evCurrentKwh + batteryAvailableKwh * cfg.chargeEfficiency
  );
  const rawPercent = (evTargetKwh / cfg.evBatteryKwh) * 100;
  const targetPercent = Math.min(
    bounds.maxPercent,
    Math.max(bounds.minPercent, Math.round(rawPercent))
  );

  // `battery` is the insufficient-energy case: the limit the math produces
  // does not exceed where the EV already is. rawPercent <= evSoc also catches
  // zero-gain rounding-up (e.g. EV at 99.6% with no spare).
  let limitedBy: EnergyLimitedBy = 'none';
  if (targetPercent <= evSocPercent || rawPercent <= evSocPercent) {
    limitedBy = 'battery';
  } else if (rawPercent >= bounds.maxPercent) {
    limitedBy = 'ev-capacity';
  } else if (rawPercent < bounds.minPercent) {
    limitedBy = 'vehicle-minimum';
  }

  return { batteryAvailableKwh, evCurrentKwh, evTargetKwh, targetPercent, limitedBy, rawPercent };
}

/**
 * The SoC at which the session monitor must stop for this limit: the
 * unclamped `rawPercent` floored when the vehicle's minimum settable limit
 * masked a lower computed target, else the limit itself (the car enforces
 * it; our stop is the backstop). Shared by the plug-in engine and the
 * mid-session re-targeter (P1c step 4) so both derive it identically.
 */
export function stopTargetFor(limit: EnergyChargeLimit): number {
  return limit.limitedBy === 'vehicle-minimum' ? Math.floor(limit.rawPercent) : limit.targetPercent;
}
