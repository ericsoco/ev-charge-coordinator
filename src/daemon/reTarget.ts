/**
 * Solar-surplus re-targeting (design §3.6 item 4, P1c step 4): while a
 * session charges, recompute the charge limit from the latest home-battery
 * SoC + current EV SoC and move the session's target when the plan has moved
 * — symmetric raise/lower behind a hysteresis deadband, plus resume after a
 * monitor stop once the battery recovered.
 *
 * Split like engine/sessionMonitor: `evaluateReTarget` is pure policy (this
 * part); the I/O edge (createReTargeter) reads the store, folds the
 * observed-efficiency + weather-reserve overlays, gates live/shadow, and
 * actuates. One verdict per charging-progress tick; the edge composes it
 * BEFORE the stop check so a lowered target is enforced in the same tick.
 *
 * Decisions this encodes (workplan, user 2026-11-03):
 * - symmetric: raise = signed limit + session target; lower = session target
 *   only (the monitor enforces it on its next tick);
 * - hysteresis ≤ ~1 change per 20 min → RETARGET_MIN_DELTA_PERCENT, derived
 *   from real history (see constant);
 * - resume only after a MONITOR stop (stop_reason set — never fight a
 *   manual/car stop) once the battery is a recovery margin above the buffer;
 * - notify on every applied change; the reason string (initial → new) feeds
 *   target_change_reason, the log, and the notification alike.
 */
import type { SessionStopReason } from '../store/types.js';
import { computeChargeLimit, stopTargetFor, type EnergyConfig } from '../utils/energy.js';

/**
 * Minimum |new raw target − stored target| (EV charge-limit points) before a
 * re-target applies. Derived from real history (2026-11-05 analysis, 7,233
 * samples): battery→EV factor 13.5×0.9/75 = 0.162, daylight 20-min |ΔSoC| p90
 * = 6.21% battery → 1.01 EV points — so at typical daylight drift this is
 * exactly ≤1 change per 20 min (the decided cadence), while the 2-min noise
 * floor (0.74% battery → 0.12 EV points) sits 8× below and can never flap it.
 */
export const RETARGET_MIN_DELTA_PERCENT = 1;

/**
 * Battery % above the buffer required to resume after a monitor stop.
 * 2% clears the 2-min noise p99 (1.58% battery — a blip must not flip
 * stop↔resume) and, at solar recovery rates, bounds buffer stop→resume
 * cycles to ≳ ~15 min. The stop side stays at the buffer itself, so the
 * deadband is (buffer, buffer + 2].
 */
export const RESUME_MIN_RECOVERY_PERCENT = 2;

export type ReTargetChange = 'raise' | 'lower' | 'none';

export interface ReTargetInput {
  chargingState: string;
  evSocPercent: number | null;
  /** CURRENT stored stop target (mutable, last write wins); null = no target armed. */
  sessionTargetPercent: number | null;
  /** Write-once initial — the reason string phrases initial → new. */
  sessionInitialTargetPercent: number | null;
  /** Non-null only when the MONITOR stopped this session (cleared on start). */
  sessionStopReason: SessionStopReason | null;
  /** Freshness-gated by the edge: stale reads pass as null (skip, never act). */
  homeBatterySocPercent: number | null;
  /** Effective config: observed-efficiency overlay + weather-adjusted buffer. */
  energyConfig: EnergyConfig | null;
}

export interface ReTargetVerdict {
  /** Session-target move to apply; 'none' → newStopTarget/newTeslaLimit null. */
  change: ReTargetChange;
  /** The new stop target (what the monitor enforces); set iff change ≠ none. */
  newStopTarget: number | null;
  /** Tesla limit to send; set iff change === 'raise' (lower never touches the car). */
  newTeslaLimit: number | null;
  /** Start charging this tick — monitor-stopped session with recovered battery. */
  resume: boolean;
  /** initial → new phrasing for target_change_reason + notification; '' otherwise. */
  detail: string;
}

function idle(): ReTargetVerdict {
  return { change: 'none', newStopTarget: null, newTeslaLimit: null, resume: false, detail: '' };
}

/**
 * Pure verdict. Guards first (missing data never acts — same fail-open
 * stance as the monitor's stop checks), then the change, then resume.
 *
 * The deadband is evaluated against the RAW target so a rounding boundary
 * cannot flap (stored 51, raw oscillating 51.4/51.6 never fires); changes
 * are allowed while charging or while a monitor-stopped session sits idle
 * (the surplus raise that later resumes it), never on manual/car states.
 * Battery at/below the effective buffer yields nothing: the monitor's
 * interlock runs right after us and owns that tick.
 */
export function evaluateReTarget(input: ReTargetInput): ReTargetVerdict {
  const cfg = input.energyConfig;
  const batterySoc = input.homeBatterySocPercent;
  const evSoc = input.evSocPercent;
  if (cfg === null || batterySoc === null || evSoc === null) return idle();
  if (batterySoc <= cfg.bufferPercent) return idle();

  const stored = input.sessionTargetPercent;
  const monitorStopped = input.sessionStopReason !== null;
  const managesState = input.chargingState === 'Charging' || monitorStopped;

  let change: ReTargetChange = 'none';
  let newStopTarget: number | null = null;
  let newTeslaLimit: number | null = null;
  let detail = '';

  if (stored !== null && managesState) {
    const limit = computeChargeLimit(evSoc, batterySoc, cfg);
    const delta = limit.rawPercent - stored;
    if (delta >= RETARGET_MIN_DELTA_PERCENT || delta <= -RETARGET_MIN_DELTA_PERCENT) {
      change = delta > 0 ? 'raise' : 'lower';
      newStopTarget = stopTargetFor(limit);
      // Raise: the car must be allowed to reach the new target (sub-50 →
      // Tesla clamps to its floor; the stop target still carries the truth).
      // Lower: session-target only — the monitor stops at its next tick.
      newTeslaLimit = change === 'raise' ? limit.targetPercent : null;
      const initial = input.sessionInitialTargetPercent ?? stored;
      detail =
        change === 'raise'
          ? `re-target ${initial}% → ${newStopTarget}% (solar surplus, battery ${batterySoc}%)`
          : `re-target ${initial}% → ${newStopTarget}% (battery ${batterySoc}%)`;
    }
  }

  // Resume: a monitor-stopped session with its battery recovered and room
  // left below the (possibly just-raised) target. `evSoc < target` is
  // strict — at the target there is nothing to charge, and because stored
  // targets only move in deadbanded steps this is what keeps a
  // target-reached stop from micro-bursting until the next real raise.
  const effectiveTarget = newStopTarget ?? stored;
  const resume =
    input.chargingState !== 'Charging' &&
    monitorStopped &&
    effectiveTarget !== null &&
    evSoc < effectiveTarget &&
    batterySoc > cfg.bufferPercent + RESUME_MIN_RECOVERY_PERCENT;

  return { change, newStopTarget, newTeslaLimit, resume, detail };
}