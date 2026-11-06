/**
 * Session monitor (design §3.4): while charging, stop at the computed target
 * (the sub-50% case Tesla's limit cannot express) and stop when the home
 * battery hits its buffer.
 *
 * Split like engine/decisionConsumer: `evaluateSessionStop` is pure policy —
 * mode-agnostic, what SHOULD happen; `createSessionMonitor` is the I/O edge —
 * store reads, mode gating (live = autoStart.enabled && !dry-run; shadow
 * evaluates and logs "would stop" once per episode), the signed stop, and
 * once-per-episode bookkeeping. Never throws: a failed stop must not take the
 * poll loop down (it retries next tick — the condition persists).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AutoStartConfig } from '../utils/daemonConfig.js';
import type { EnergyConfig } from '../utils/energy.js';
import type { SessionStopReason } from '../store/types.js';
import { resolveEnergyConfig } from '../utils/config.js';
import * as sessionStore from '../store/SessionStore.js';
import * as homeBattery from '../store/HomeBatteryStore.js';
import type { ChargingProgressContext } from './EvPoller.js';
import type { NotificationEvent } from '../notifiers/types.js';

export interface SessionStopInput {
  chargingState: string;
  evSocPercent: number | null;
  /** The session's CURRENT stop target — re-read every tick (mutable mid-session). */
  sessionTargetPercent: number | null;
  homeBatterySocPercent: number | null;
  bufferPercent: number | null;
}

export type SessionStopVerdict =
  | { stop: false }
  | { stop: true; reason: SessionStopReason; detail: string };

/**
 * Pure verdict. Buffer first — the safety interlock outranks the session's
 * target when both fire. A value that cannot be read skips its check:
 * missing data never stops charging (fail-open for stopping; the engine's
 * fail-loud applies to starting). Equality counts: at the buffer = below,
 * at the target = reached.
 */
export function evaluateSessionStop(input: SessionStopInput): SessionStopVerdict {
  if (input.chargingState !== 'Charging') return { stop: false };

  if (
    input.homeBatterySocPercent !== null &&
    input.bufferPercent !== null &&
    input.homeBatterySocPercent <= input.bufferPercent
  ) {
    return {
      stop: true,
      reason: 'battery_buffer',
      detail:
        `home battery ${input.homeBatterySocPercent}% is at or below the ` +
        `${input.bufferPercent}% buffer`,
    };
  }

  if (
    input.sessionTargetPercent !== null &&
    input.evSocPercent !== null &&
    input.evSocPercent >= input.sessionTargetPercent
  ) {
    return {
      stop: true,
      reason: 'target_reached',
      detail:
        `EV SoC ${input.evSocPercent}% reached the session target ` +
        `${input.sessionTargetPercent}%`,
    };
  }

  return { stop: false };
}

export interface SessionMonitorDeps {
  db: DatabaseSync;
  vehicleId: string;
  autoStart: AutoStartConfig;
  /** `daemon --dry-run`; live = enabled && !dryRun (the engine's mode mirror). */
  dryRun: boolean;
  /** Signed charge_stop: wake + command + post-condition verification. */
  stopCharging: () => Promise<void>;
  /** Injectable so tests avoid config files; default reads energy config.json. */
  getEnergyConfig?: () => EnergyConfig | null;
  /**
   * A battery sample older than this reads as missing — stale data must never
   * stop charging (after sleep the ev-poll tick can beat the battery sampler's
   * first tick). runDaemon passes 5 × `batterySampleSec`.
   */
  batterySampleMaxAgeMs?: number;
  log?: (message: string) => void;
  /** Typed-event sink for stop failures; failures are isolated here. */
  notify?: (event: NotificationEvent) => Promise<void>;
}

/** Never lets a notification failure reach the caller (design §3.4 isolation). */
async function emitNotify(deps: SessionMonitorDeps, event: NotificationEvent): Promise<void> {
  if (!deps.notify) return;
  try {
    await deps.notify(event);
  } catch (error) {
    deps.log?.(
      `[session-monitor] notify failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Default freshness window: 5 × the shipped batterySampleSec (10 min). */
export const DEFAULT_BATTERY_SAMPLE_MAX_AGE_MS = 600_000;

/**
 * The charging-progress stage of the EvPoller chain. Called on every rich
 * read (the chargingState gate lives in the pure fn); a non-charging tick
 * ends the episode and clears the once-per-episode flags.
 */
export function createSessionMonitor(
  deps: SessionMonitorDeps
): (ctx: ChargingProgressContext) => Promise<void> {
  const log = deps.log ?? (() => {});
  const getEnergyConfig = deps.getEnergyConfig ?? (() => resolveEnergyConfig().config);
  // Once-per-episode flags: cleared when charging ends (a non-charging tick)
  // or, for the stop condition itself, whenever the verdict clears.
  let wouldStopLogged = false;
  let failureNotified = false;
  let configWarned = false;
  let batteryWarned = false;

  return async (ctx: ChargingProgressContext): Promise<void> => {
    try {
      if (ctx.chargingState !== 'Charging') {
        wouldStopLogged = false;
        failureNotified = false;
        configWarned = false;
        batteryWarned = false;
        return;
      }

      // Fresh reads every tick: the session target is mutable mid-session
      // (a later re-targeting step rewrites it) — never cache it here.
      const session = sessionStore.openSessionFor(deps.db, deps.vehicleId);
      const energyConfig = getEnergyConfig();
      // Freshness qualification (sleep self-heal): a sample from before a
      // sleep is as unreadable as none — stale-low would spuriously stop a
      // healthy charge, stale-high hides a real breach that the sampler's
      // first fresh tick (≤ one battery cadence) will catch anyway.
      const sample = homeBattery.latestSample(deps.db);
      const maxAgeMs = deps.batterySampleMaxAgeMs ?? DEFAULT_BATTERY_SAMPLE_MAX_AGE_MS;
      const ageMs = sample === null ? null : ctx.tsMs - sample.tsMs;
      const stale = ageMs !== null && ageMs > maxAgeMs;
      const batterySoc = sample !== null && !stale ? sample.socPercent : null;

      if (energyConfig === null && !configWarned) {
        configWarned = true;
        log('[session-monitor] energy config unavailable — buffer stop disabled this tick');
      }
      if (batterySoc === null && !batteryWarned) {
        batteryWarned = true;
        log(
          stale
            ? `[session-monitor] home-battery sample is ${Math.round((ageMs ?? 0) / 60_000)} min old — ` +
              'buffer stop skipped until a fresh one lands'
            : '[session-monitor] no home-battery sample — buffer stop skipped until one lands'
        );
      }

      const verdict = evaluateSessionStop({
        chargingState: ctx.chargingState,
        evSocPercent: ctx.evSocPercent,
        sessionTargetPercent: session?.targetPercent ?? null,
        homeBatterySocPercent: batterySoc,
        bufferPercent: energyConfig?.bufferPercent ?? null,
      });

      if (!verdict.stop) {
        wouldStopLogged = false;
        failureNotified = false;
        return;
      }

      const live = deps.autoStart.enabled && !deps.dryRun;
      if (!live) {
        // Shadow mode: identical verdicts, no actuation (merge-dark).
        if (!wouldStopLogged) {
          wouldStopLogged = true;
          log(
            `[session-monitor] would stop (${verdict.reason}): ${verdict.detail} — ` +
              'shadow mode (autoStart disabled or --dry-run), not actuating'
          );
        }
        return;
      }

      try {
        await deps.stopCharging();
        if (session !== null) {
          sessionStore.setSessionStopReason(deps.db, session.id, verdict.reason);
        }
        log(`[session-monitor] stopped charging (${verdict.reason}): ${verdict.detail}`);
        failureNotified = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[session-monitor] stop failed (${verdict.reason}): ${message}`);
        // The condition persists → the next tick retries; notify once per episode.
        if (!failureNotified) {
          failureNotified = true;
          await emitNotify(deps, {
            type: 'failure',
            tsMs: ctx.tsMs,
            component: 'session-monitor',
            message: `stop (${verdict.reason}) failed: ${message}`,
          });
        }
      }
    } catch (error) {
      // Store/config surprise: sampling survives, next tick tries again.
      log(`[session-monitor] failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}