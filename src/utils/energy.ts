/**
 * Energy math for `charge-from-battery`.
 *
 * Pure module: no I/O, no services, no store. Two state-of-charge readings --
 * each a percent of a different pack -- are converted into one Tesla
 * charge-limit percent via kWh, the only unit both packs share. Comparing raw
 * percentages is dimensionally invalid (percent of a ~13.5 kWh house battery
 * against percent of a ~75 kWh car), so there is deliberately no percent-based
 * path here.
 */

import { MAX_EV_CHARGE_LIMIT, MIN_EV_CHARGE_LIMIT } from '../commands/context.js';

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
  /** Abort when the spare house energy is below this, in kWh. */
  minChargeKwh: number;
}

/**
 * Why the target is what it is: nothing constrained it (`none`), the house
 * spare ran out (`battery`), the EV pack would overfill (`ev-capacity`), or
 * the kWh math landed below Tesla's 50% floor (`tesla-minimum`).
 */
export type EnergyLimitedBy = 'none' | 'battery' | 'ev-capacity' | 'tesla-minimum';

/** The computed charge-limit decision and the reasoning to show the user. */
export interface EnergyChargeLimit {
  /** House energy above the buffer, floored at 0, in kWh. */
  batteryAvailableKwh: number;
  /** Energy the EV holds now, in kWh. */
  evCurrentKwh: number;
  /** Energy the EV would hold at the target, in kWh. */
  evTargetKwh: number;
  /** Integer Tesla limit to request, clamped to 50-100. */
  targetPercent: number;
  /** What shaped the target; see EnergyLimitedBy. */
  limitedBy: EnergyLimitedBy;
  /** The unclamped percentage, for explaining a `tesla-minimum` result. */
  rawPercent: number;
}

/**
 * Sensible defaults for this hardware. bufferPercent is always replaced at
 * call time by the stored `set-battery-buffer` setting; it exists here so the
 * config shape is complete.
 */
export const DEFAULT_ENERGY_CONFIG: EnergyConfig = {
  batteryCapacityKwh: 13.5, // FranklinWH aPower 2 usable
  evBatteryKwh: 75, // Tesla Model Y usable
  bufferPercent: 20,
  chargeEfficiency: 0.9, // onboard charger + conversion losses
  minChargeKwh: 1.0,
};

/** Throw on a misconfigured pack rather than clamping it into a wrong answer. */
function validateConfig(cfg: EnergyConfig): void {
  const problems: string[] = [];
  if (!(cfg.batteryCapacityKwh > 0)) {
    problems.push(`batteryCapacityKwh = ${cfg.batteryCapacityKwh} (must be > 0)`);
  }
  if (!(cfg.evBatteryKwh > 0)) {
    problems.push(`evBatteryKwh = ${cfg.evBatteryKwh} (must be > 0)`);
  }
  if (!(cfg.bufferPercent >= 0) || cfg.bufferPercent > 100) {
    problems.push(`bufferPercent = ${cfg.bufferPercent} (must be 0-100)`);
  }
  if (!(cfg.chargeEfficiency > 0) || cfg.chargeEfficiency > 1) {
    problems.push(`chargeEfficiency = ${cfg.chargeEfficiency} (must be in (0, 1])`);
  }
  if (!(cfg.minChargeKwh >= 0)) {
    problems.push(`minChargeKwh = ${cfg.minChargeKwh} (must be >= 0)`);
  }
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
 * Compute the Tesla charge limit that delivers the spare house energy to the EV.
 *
 * batteryAvailableKwh = capacity x max(0, batterySoc - bufferPercent) / 100
 * evTargetKwh         = min(evCapacity, evCurrent + available x efficiency)
 * targetPercent       = clamp(round(evTargetKwh / evCapacity x 100), 50, 100)
 */
export function computeChargeLimit(
  evSocPercent: number,
  batterySocPercent: number,
  cfg: EnergyConfig
): EnergyChargeLimit {
  validateConfig(cfg);
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

  let limitedBy: EnergyLimitedBy = 'none';
  if (batteryAvailableKwh < cfg.minChargeKwh) {
    limitedBy = 'battery';
  } else if (rawPercent >= MAX_EV_CHARGE_LIMIT) {
    limitedBy = 'ev-capacity';
  } else if (rawPercent < MIN_EV_CHARGE_LIMIT) {
    limitedBy = 'tesla-minimum';
  }

  const targetPercent = Math.min(
    MAX_EV_CHARGE_LIMIT,
    Math.max(MIN_EV_CHARGE_LIMIT, Math.round(rawPercent))
  );

  return { batteryAvailableKwh, evCurrentKwh, evTargetKwh, targetPercent, limitedBy, rawPercent };
}
