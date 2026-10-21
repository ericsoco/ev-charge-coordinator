/**
 * Pure closing-aggregate math for sessions.
 *
 * The load-bearing idea is monotonicDelta: every counter summed across a
 * session (Franklin's day-so-far battery discharge, Tesla's
 * charge_energy_added) can legitimately *decrease* — at the gateway's local
 * midnight reset, or when Tesla resets the session meter. Summing only
 * positive steps drops those discontinuities instead of poisoning the sum,
 * which makes the exact reset semantics non-critical.
 *
 * All inputs are store rows already filtered to [plug, unplug] (via the
 * range queries), oldest first. Everything here is pure: no db, no clock —
 * the caller supplies timestamps.
 */
import type { FinalizeSessionInput } from '../store/SessionStore.js';
import type { EvSampleRow, HomeEnergyCountersRow } from '../store/types.js';

/**
 * Sum of positive steps over the sequence. Empty input → null (nothing
 * observed); a single value → 0 (observed, no change); a decreasing value is
 * a meter reset, not negative energy.
 */
export function monotonicDelta(values: readonly number[]): number | null {
  let total = 0;
  let prev: number | null = null;
  for (const value of values) {
    if (prev !== null && value > prev) total += value - prev;
    prev = value;
  }
  return prev === null ? null : total;
}

/**
 * Compute the closing aggregates for one session. Everything uncomputable
 * comes back null — never a guess (raw values throughout; P1c interprets
 * anomalies like efficiency > 1).
 */
export function computeSessionAggregates(input: {
  /** ev_samples in [plug, unplug], oldest first. */
  evSamples: readonly EvSampleRow[];
  /** home_energy_counters in [plug, unplug], oldest first. */
  counters: readonly HomeEnergyCountersRow[];
  plugTsMs: number;
  unplugTsMs: number;
}): FinalizeSessionInput {
  const numbers = (values: readonly (number | null)[]): number[] =>
    values.filter((value): value is number => value !== null);

  const energyKwh = monotonicDelta(numbers(input.evSamples.map((s) => s.chargeEnergyAddedKwh)));
  const houseEnergyKwh = monotonicDelta(
    numbers(input.counters.map((c) => c.batteryDischargeKwh))
  );

  // soc needs two observations to state a change; one point says nothing.
  const socs = numbers(input.evSamples.map((s) => s.socPercent));
  const energyPercent = socs.length >= 2 ? socs[socs.length - 1] - socs[0] : null;

  const elapsedMs = input.unplugTsMs - input.plugTsMs;
  const efficiency =
    energyKwh !== null && houseEnergyKwh !== null && houseEnergyKwh > 0
      ? energyKwh / houseEnergyKwh
      : null;

  return { energyKwh, energyPercent, elapsedMs, houseEnergyKwh, efficiency };
}
