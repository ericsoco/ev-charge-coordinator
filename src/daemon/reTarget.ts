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
 * actuates. One verdict per charging-progress tick, composed BEFORE the
 * stop check so a lowered target is enforced in the same tick.
 *
 * The edge has TWO triggers: the poller's rich-read tick (fresh EV state),
 * and `onBatteryTick` — after each battery sample, evaluated from the LATEST
 * STORED EV observation. The second one exists because the poll path stops
 * entirely while the car sleeps (no rich reads), which is exactly when a
 * monitor-stopped session waits for the home battery to recover: without it,
 * a recovered battery would never resume charging until the car happened to
 * wake on its own. The start command performs the one wake.
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
import type { DatabaseSync } from 'node:sqlite';
import type { SessionStopReason } from '../store/types.js';
import type { AutoStartConfig } from '../utils/daemonConfig.js';
import type { WeatherPolicy } from '../utils/weather.js';
import type { ChargingProgressContext } from './EvPoller.js';
import type { NotificationEvent } from '../notifiers/types.js';
import { resolveEnergyConfig } from '../utils/config.js';
import {
  EFFICIENCY_FETCH_LIMIT,
  applyEfficiency,
  estimateEfficiency,
} from '../utils/efficiency.js';
import { DEFAULT_WEATHER_POLICY, weatherAdjustment } from '../utils/weather.js';
import { computeChargeLimit, stopTargetFor, type EnergyConfig } from '../utils/energy.js';
import * as sessionStore from '../store/SessionStore.js';
import * as homeBattery from '../store/HomeBatteryStore.js';
import * as evStore from '../store/EvStore.js';
import * as weatherStore from '../store/WeatherForecastStore.js';
import { DEFAULT_BATTERY_SAMPLE_MAX_AGE_MS } from './sessionMonitor.js';

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
  /** Session-target move to apply; 'none' → newStopTarget/newChargeLimit null. */
  change: ReTargetChange;
  /** The new stop target (what the monitor enforces); set iff change ≠ none. */
  newStopTarget: number | null;
  /** Vehicle limit to send; set iff change === 'raise' (lower never touches the car). */
  newChargeLimit: number | null;
  /** Start charging this tick — monitor-stopped session with recovered battery. */
  resume: boolean;
  /** initial → new phrasing for target_change_reason + notification; '' otherwise. */
  detail: string;
}

function idle(): ReTargetVerdict {
  return { change: 'none', newStopTarget: null, newChargeLimit: null, resume: false, detail: '' };
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
  let newChargeLimit: number | null = null;
  let detail = '';

  if (stored !== null && managesState) {
    const limit = computeChargeLimit(evSoc, batterySoc, cfg);
    const delta = limit.rawPercent - stored;
    if (delta >= RETARGET_MIN_DELTA_PERCENT || delta <= -RETARGET_MIN_DELTA_PERCENT) {
      change = delta > 0 ? 'raise' : 'lower';
      newStopTarget = stopTargetFor(limit);
      // Raise: the car must be allowed to reach the new target (below the
      // vehicle's minimum the send clamps to its floor; the stop target still
      // carries the truth).
      // Lower: session-target only — the monitor stops at its next tick.
      newChargeLimit = change === 'raise' ? limit.targetPercent : null;
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

  return { change, newStopTarget, newChargeLimit, resume, detail };
}

export interface ReTargeterDeps {
  db: DatabaseSync;
  vehicleId: string;
  autoStart: AutoStartConfig;
  /** `daemon --dry-run`; live = enabled && !dryRun (the engine's mode mirror). */
  dryRun: boolean;
  /** Signed limit raise (live only); a sub-minimum send clamps to the vehicle floor. */
  setChargeLimit: (percent: number) => Promise<void>;
  /** Signed start for a resumed session (live only). */
  startCharging: () => Promise<void>;
  /** Injectable so tests avoid config files; default reads energy config.json. */
  getEnergyConfig?: () => EnergyConfig | null;
  /** Low-solar reserve knobs; omitted = adjustment off (step 3 parity). */
  weatherPolicy?: WeatherPolicy;
  /** A battery sample older than this reads as missing (monitor parity). */
  batterySampleMaxAgeMs?: number;
  /** Injectable clock for the battery-tick context; tests inject. */
  nowMs?: () => number;
  log?: (message: string) => void;
  notify?: (event: NotificationEvent) => Promise<void>;
}

/** Never lets a notification failure reach the caller (design §3.4). */
async function emitNotify(deps: ReTargeterDeps, event: NotificationEvent): Promise<void> {
  if (!deps.notify) return;
  try {
    await deps.notify(event);
  } catch (error) {
    deps.log?.(
      `[re-target] notify failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * The I/O edge, with two triggers (see the module header): call it with the
 * poller's rich-read context, or use `onBatteryTick` after a battery sample.
 * Composed BEFORE the session monitor so a lowered target is enforced in the
 * same tick (the workplan's seam). Store/config surprise → log-only, never
 * throws (the poll loop must survive); actuation failure logs every attempt
 * and notifies once per episode, retrying next tick while the condition
 * persists.
 */
export interface ReTargeter {
  (ctx: ChargingProgressContext): Promise<void>;
  /**
   * Second trigger, called after each successful battery sample: re-evaluates
   * from the latest STORED EV observation so a monitor-stopped session can
   * resume while the car sleeps (no rich reads → the call path above never
   * runs). A resume already issued for that observation is not repeated until
   * a fresh rich read supersedes it — the start command may still be waking
   * the car, and fresh state owns the truth.
   */
  onBatteryTick(): Promise<void>;
}

export function createReTargeter(deps: ReTargeterDeps): ReTargeter {
  const getEnergyConfig = deps.getEnergyConfig ?? (() => resolveEnergyConfig().config);
  const log = deps.log ?? (() => {});
  const nowMs = deps.nowMs ?? Date.now;
  let wouldActLogged = false;
  let failureNotified = false;
  // ts of the EV observation a successful resume acted on (either trigger);
  // null = no resume in flight. In-memory like the episode flags above — a
  // restart re-derives everything from the store.
  let resumeIssuedForSampleMs: number | null = null;

  const run = async (ctx: ChargingProgressContext): Promise<void> => {
    try {
      const session = sessionStore.openSessionFor(deps.db, deps.vehicleId);

      // Fresh reads every tick, freshness-gated like the monitor: a sample
      // from before a sleep is as unreadable as none.
      const sample = homeBattery.latestSample(deps.db);
      const maxAgeMs = deps.batterySampleMaxAgeMs ?? DEFAULT_BATTERY_SAMPLE_MAX_AGE_MS;
      const ageMs = sample === null ? null : ctx.tsMs - sample.tsMs;
      const stale = ageMs !== null && ageMs > maxAgeMs;
      const batterySoc = sample !== null && !stale ? sample.socPercent : null;

      // Effective config = step-2 observed efficiency + step-3 weather
      // reserve folded in — the recompute must see the same numbers the
      // decision engine saw (workplan pointers).
      const cfg = getEnergyConfig();
      let energyConfig: EnergyConfig | null = null;
      if (cfg !== null) {
        const observed = applyEfficiency(
          cfg,
          estimateEfficiency(sessionStore.recentEfficiencySamples(deps.db, EFFICIENCY_FETCH_LIMIT))
        ).config;
        const weather = weatherAdjustment(
          weatherStore.latestVintage(deps.db),
          ctx.tsMs,
          deps.weatherPolicy ?? DEFAULT_WEATHER_POLICY
        );
        energyConfig =
          weather !== null
            ? {
                ...observed,
                bufferPercent: Math.min(100, observed.bufferPercent + weather.adjustmentPercent),
              }
            : observed;
      }

      const verdict = evaluateReTarget({
        chargingState: ctx.chargingState,
        evSocPercent: ctx.evSocPercent,
        sessionTargetPercent: session?.targetPercent ?? null,
        sessionInitialTargetPercent: session?.initialTargetPercent ?? null,
        sessionStopReason: session?.stopReason ?? null,
        homeBatterySocPercent: batterySoc,
        energyConfig,
      });

      if (verdict.change === 'none' && !verdict.resume) {
        wouldActLogged = false;
        failureNotified = false;
        return;
      }
      if (session === null) return; // verdict implies a session; narrows for the writes

      const live = deps.autoStart.enabled && !deps.dryRun;
      if (!live) {
        // Shadow mode: identical verdicts, no actuation (merge-dark).
        if (!wouldActLogged) {
          wouldActLogged = true;
          const what = [
            verdict.change !== 'none' ? `${verdict.change} to ${verdict.newStopTarget}%` : null,
            verdict.resume ? 'resume' : null,
          ]
            .filter(Boolean)
            .join(' + ');
          log(
            `[re-target] would ${what}${verdict.detail ? ` (${verdict.detail})` : ''} — ` +
              'shadow mode (autoStart disabled or --dry-run), not actuating'
          );
        }
        return;
      }

      try {
        // Order mirrors the decision consumer: raise sends the limit first,
        // then records the target (a partial failure retries cleanly next
        // tick — the deadband still sees the old stored target), then start.
        if (verdict.change === 'raise' && verdict.newChargeLimit !== null) {
          await deps.setChargeLimit(verdict.newChargeLimit);
        }
        if (verdict.change !== 'none' && verdict.newStopTarget !== null) {
          sessionStore.setSessionTarget(deps.db, session.id, verdict.newStopTarget, verdict.detail);
        }
        if (verdict.resume) {
          await deps.startCharging();
          // The observation we acted on: the battery tick stays quiet until a
          // fresh rich read supersedes it (no duplicate start while the car
          // is still waking from our command).
          resumeIssuedForSampleMs = ctx.tsMs;
        }
        if (verdict.change !== 'none') {
          log(`[re-target] ${verdict.detail}`);
          await emitNotify(deps, {
            type: 'session-retargeted',
            tsMs: ctx.tsMs,
            sessionId: session.id,
            vehicleId: deps.vehicleId,
            direction: verdict.change,
            detail: verdict.detail,
          });
        }
        if (verdict.resume) {
          log(
            `[re-target] resumed charging (battery ${batterySoc}%) ` +
              `[${ctx.source ?? 'ev-poll'}]`
          );
        }
        failureNotified = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[re-target] actuation failed: ${message}`);
        // The condition persists → the next tick retries; notify once per episode.
        if (!failureNotified) {
          failureNotified = true;
          await emitNotify(deps, {
            type: 'failure',
            tsMs: ctx.tsMs,
            component: 're-target',
            message: `actuation failed: ${message}`,
          });
        }
      }
    } catch (error) {
      // Store/config surprise: sampling survives, next tick tries again.
      log(`[re-target] failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const onBatteryTick = async (): Promise<void> => {
    const sample = evStore.latestSample(deps.db, deps.vehicleId);
    // No (or incomplete) EV observation — nothing to judge state against.
    if (sample === null || sample.chargingState === null || sample.socPercent === null) return;
    if (resumeIssuedForSampleMs !== null && sample.tsMs <= resumeIssuedForSampleMs) {
      return; // already acted on this exact observation
    }
    await run({
      tsMs: nowMs(),
      evSocPercent: sample.socPercent,
      chargingState: sample.chargingState,
      source: 'battery-sample',
    });
  };

  return Object.assign(run, { onBatteryTick });
}