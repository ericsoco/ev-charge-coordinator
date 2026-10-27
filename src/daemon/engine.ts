/**
 * Plug-in decision engine (design.md §3.3) — pure, no I/O.
 *
 * The EvPoller chain (read state → detect changes → apply filters → act)
 * supplies every input and persists the outcome via DecisionStore; this
 * module only decides. Interlocks run in fixed order; the configured filter
 * chain then runs in full. `autoStart.enabled` and `--dry-run` are MODES,
 * not stops: a dark or dry run evaluates the identical verdicts and records
 * them (accepted 0, dryRun 1) — merge dark.
 */
import type { EventKind, DecisionReasonCode } from '../store/types.js';
import type { AutoStartConfig } from '../utils/daemonConfig.js';
import type { HomeLocation } from '../utils/credentials.js';
import type { VehicleLocation } from '../types/ev.js';
import {
  computeChargeLimit,
  type EnergyChargeLimit,
  type EnergyConfig,
  type EnergyLimitedBy,
} from '../utils/energy.js';
import { runFilters, type FilterResult } from './filters.js';

/** Everything the engine reads — assembled by the poller chain per plug-in. */
export interface DecisionInput {
  /** Idempotency: wiring looked up DecisionStore.decisionForSession. */
  sessionAlreadyDecided: boolean;
  event: EventKind;
  plugged: boolean;
  chargingState: string;
  evSocPercent: number | null;
  homeBatterySocPercent: number | null;
  /** Resolved energy config; null = missing/invalid (denies loudly). */
  energyConfig: EnergyConfig | null;
  autoStart: AutoStartConfig;
  /** Forced true until actuation lands (step 5); `daemon --dry-run` sets it. */
  dryRun: boolean;
  /** Home secret; null = not set (geofence declines). */
  home: HomeLocation | null;
  /** Decision-time fix (Option B); null = fetch failed or never attempted. */
  vehicleLocation: VehicleLocation | null;
}

export interface DecisionOutcome {
  /** True only when the mode was live and every gate passed. */
  accepted: boolean;
  /** Mode mirror: no actuation would happen this run (disabled or dry-run). */
  dryRun: boolean;
  reasonCode: DecisionReasonCode;
  reasonDetail: string | null;
  /** Full per-filter audit; the wiring serializes into filter_results_json. */
  filterResults: FilterResult[];
  /** From computeChargeLimit when the math ran; null when it did not. */
  limitedBy: EnergyLimitedBy | null;
  /** Tesla limit the math produced; null when it did not run. */
  targetPercent: number | null;
}

export function evaluateDecision(input: DecisionInput): DecisionOutcome {
  const dryRun = !input.autoStart.enabled || input.dryRun;

  const declined = (
    reasonCode: DecisionReasonCode,
    reasonDetail: string | null,
    filterResults: FilterResult[] = []
  ): DecisionOutcome => ({
    accepted: false,
    dryRun,
    reasonCode,
    reasonDetail,
    filterResults,
    limitedBy: null,
    targetPercent: null,
  });

  // Interlocks, in order (design §3.3): never re-fire, never act on a state
  // that does not need us, never act without verified safety inputs.
  if (input.sessionAlreadyDecided) {
    return declined('duplicate_session', 'this session already has a decision');
  }
  if (!input.plugged) {
    return declined('not_plugged_in', 'plug_in observed but the latest state says disconnected');
  }
  if (input.chargingState === 'Charging') {
    return declined('already_charging', 'vehicle is already charging');
  }

  const cfg = input.energyConfig;
  if (cfg === null) {
    return declined(
      'config_error',
      'energy config.json missing or invalid — cannot verify the battery buffer'
    );
  }
  if (input.homeBatterySocPercent === null) {
    return declined(
      'config_error',
      'home battery SoC unreadable — cannot verify the battery buffer'
    );
  }
  const batterySoc = input.homeBatterySocPercent;
  // Equality = below: at exactly the buffer, energy.ts computes 0 available kWh.
  if (batterySoc <= cfg.bufferPercent) {
    return declined(
      'below_buffer',
      `home battery ${batterySoc}% is at or below the ${cfg.bufferPercent}% buffer`
    );
  }

  const chain = runFilters(input.autoStart.filters, {
    event: input.event,
    plugged: input.plugged,
    chargingState: input.chargingState,
    home: input.home,
    vehicleLocation: input.vehicleLocation,
    homeBatterySocPercent: input.homeBatterySocPercent,
    energyConfig: input.energyConfig,
  });
  if (!chain.pass) {
    const failing = chain.results.find((result) => !result.pass);
    return declined(
      'filter_declined',
      failing?.detail ?? failing?.reason ?? 'filter declined',
      chain.results
    );
  }

  if (input.evSocPercent === null) {
    return declined(
      'compute_error',
      'EV SoC unreadable — cannot compute a charge limit',
      chain.results
    );
  }
  const evSoc = input.evSocPercent;

  let limit: EnergyChargeLimit;
  try {
    limit = computeChargeLimit(evSoc, batterySoc, cfg);
  } catch (error) {
    return declined(
      'compute_error',
      error instanceof Error ? error.message : String(error),
      chain.results
    );
  }

  // Integer SoC is where the car's own controller decides: a limit at or
  // below it raises nothing (the CLI refuses the same case with its kWh
  // breakdown) — decline without touching the vehicle.
  if (limit.targetPercent <= evSoc) {
    return declined(
      'insufficient_energy',
      `energy math cannot raise the limit above the EV's current ${evSoc}% ` +
        `(target ${limit.targetPercent}%, ` +
        `${limit.batteryAvailableKwh.toFixed(1)} kWh above ${cfg.bufferPercent}% buffer)`,
      chain.results
    );
  }

  const accepted = !dryRun;
  const why = input.autoStart.enabled ? 'dry-run mode' : 'autoStart disabled';
  const math =
    `charge limit ${limit.targetPercent}% (${limit.limitedBy}) — ` +
    `${limit.batteryAvailableKwh.toFixed(1)} kWh above ${cfg.bufferPercent}% buffer`;
  return {
    accepted,
    dryRun,
    reasonCode: accepted ? 'started' : 'dry_run',
    reasonDetail: accepted ? `starting: ${math}` : `would start (${why}): ${math}`,
    filterResults: chain.results,
    limitedBy: limit.limitedBy,
    targetPercent: limit.targetPercent,
  };
}
