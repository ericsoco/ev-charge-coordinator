/**
 * Poll-while-awake EV sampling.
 *
 * One adaptive scheduler tick implements both data cadences: the caller runs
 * the cheap state probe every `evStatusPollSec`, and this predicate decides
 * whether the tick also earns an expensive `vehicle_data` read.
 *
 * Pure by design — the poller task (samplers step) wires it to real time and
 * services; tests drive it with hand-picked timestamps.
 */

export interface EvCadenceInput {
  nowMs: number;
  /** Last successful rich read; null = none this run (boot seed counts). */
  lastRichSampleMs: number | null;
  /** Plugged = last observed charging_state !== 'Disconnected'. */
  plugged: boolean;
  /** Cadence while plugged (evSamplePluggedSec), seconds. */
  samplePluggedSec: number;
  /** Cadence while awake and not plugged (evSampleIdleSec), seconds. */
  sampleIdleSec: number;
}

/**
 * True when a rich `vehicle_data` read should happen on this tick:
 * the first observation always samples (it seeds state), otherwise the
 * plugged-or-idle cadence has elapsed. Asleep handling is the caller's job —
 * this never runs when the probe said asleep.
 */
export function shouldSampleRich(input: EvCadenceInput): boolean {
  if (input.lastRichSampleMs === null) return true;
  const intervalMs = (input.plugged ? input.samplePluggedSec : input.sampleIdleSec) * 1000;
  return input.nowMs - input.lastRichSampleMs >= intervalMs;
}
