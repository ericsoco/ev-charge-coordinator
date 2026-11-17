/**
 * Hand-over stage (2026-11-14 ownership work; + 2026-11-17 episode-conclusion
 * restore) — three jobs on every rich read:
 *
 * 1. Restore the user-set charge limit when EVCC's OWN episode concludes
 *    (car stopped charging; the claim predates the stop): the idle gap
 *    before the next charge — e.g. an overnight scheduled charge — must
 *    hold the USER's limit, not EVCC's budget target (2026-11-16: EVCC's
 *    54% left on the car made the departure schedule a no-op all night).
 *    Once per conclusion; a failed write retries next tick.
 * 2. Restore the user-set charge limit on a foreign (manual/scheduled)
 *    episode: EVCC's managed episode left its own limit on the car; when
 *    someone else owns the charge, the car must charge to the USER's limit.
 *    Once per episode — never clobbers a mid-episode user change.
 * 3. Prioritize scheduled charging (preference, default on): when a start-at
 *    schedule window activates (or the `handOverAt` fallback time passes)
 *    during a managed plug-in — charging or idle — release EVCC's control
 *    WITHOUT stopping the car: the scheduled session seamlessly continues to
 *    the user's limit. Departure windows never trigger this (they are an
 *    attribution heuristic only).
 *
 * Live gating mirrors the monitor/re-targeter (autoStart.enabled && !dry-run;
 * shadow logs would-restore / would-release once per episode). Never throws —
 * the poll loop must survive. Runs BEFORE re-target/monitor so a release
 * takes effect in the same tick.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ChargingScheduleSnapshot } from '../types/ev.js';
import {
  DEFAULT_SCHEDULED_LEAD_MINUTES,
  type AutoStartConfig,
  type ScheduledChargingConfig,
} from '../utils/daemonConfig.js';
import { findActivatedChargingWindow, handOverReached } from '../utils/schedule.js';
import * as sessionStore from '../store/SessionStore.js';
import { isManagedEpisode } from './ownership.js';
import type { ChargingProgressContext } from './EvPoller.js';
import type { NotificationEvent } from '../notifiers/types.js';

/** Schedule windows are quasi-static; one vehicle_data read per window suffices. */
const SCHEDULE_CACHE_MS = 15 * 60_000;

export interface HandoverDeps {
  db: DatabaseSync;
  vehicleId: string;
  autoStart: AutoStartConfig;
  /** `daemon --dry-run`; live = enabled && !dryRun (the engine's mode mirror). */
  dryRun: boolean;
  /** OEM schedule introspection (optional capability); absent = window checks off. */
  getChargingSchedule?: () => Promise<ChargingScheduleSnapshot | null>;
  /** Signed limit restore (live only). */
  setChargeLimit: (percent: number) => Promise<void>;
  /** Policy block; omitted = shipped defaults (prioritize on, 15-min lead, no handOverAt). */
  scheduledCharging?: ScheduledChargingConfig;
  nowMs?: () => number;
  log?: (message: string) => void;
  notify?: (event: NotificationEvent) => Promise<void>;
}

/** Never lets a notification failure reach the caller (design §3.4). */
async function emitNotify(deps: HandoverDeps, event: NotificationEvent): Promise<void> {
  if (!deps.notify) return;
  try {
    await deps.notify(event);
  } catch (error) {
    deps.log?.(
      `[hand-over] notify failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function createHandoverStage(
  deps: HandoverDeps
): (ctx: ChargingProgressContext) => Promise<void> {
  const log = deps.log ?? (() => {});
  const policy = deps.scheduledCharging ?? {
    prioritize: true,
    leadMinutes: DEFAULT_SCHEDULED_LEAD_MINUTES,
    handOverAt: null,
  };
  // TTL cache: window state does not change tick-to-tick, and vehicle_data
  // reads are billed — never fetch per tick.
  let snapshotCache: { atMs: number; snapshot: ChargingScheduleSnapshot | null } | null = null;
  // Once-per-episode flags (restart-safe: a restart may restore once more —
  // idempotent by the limit comparison).
  let restoreAttemptedFor: number | null = null;
  // Conclusion restore key: the stopping event's ts. A new stop re-arms it;
  // set only after a successful live write so a failed write retries.
  let conclusionRestoredFor: number | null = null;
  let shadowReleased = false;
  // Previous tick's clock for interval checks; null on the first tick, which
  // then looks back one cache window so a restart cannot miss an activation.
  let lastTickMs: number | null = null;

  const cachedSnapshot = async (nowMs: number): Promise<ChargingScheduleSnapshot | null> => {
    if (!deps.getChargingSchedule) return null;
    if (snapshotCache !== null && nowMs - snapshotCache.atMs < SCHEDULE_CACHE_MS) {
      return snapshotCache.snapshot;
    }
    try {
      const snapshot = (await deps.getChargingSchedule()) ?? null;
      snapshotCache = { atMs: nowMs, snapshot };
      return snapshot;
    } catch (error) {
      log(
        `[hand-over] schedule read failed (${
          error instanceof Error ? error.message : String(error)
        })`
      );
      return null;
    }
  };

  return async (ctx: ChargingProgressContext): Promise<void> => {
    try {
      const session = sessionStore.openSessionFor(deps.db, deps.vehicleId);
      if (session === null) return;
      const lastOwner = sessionStore.lastSessionOwner(deps.db, session.id);
      const managedSession = isManagedEpisode({ lastOwner, releasedTsMs: session.releasedTsMs });
      const live = deps.autoStart.enabled && !deps.dryRun;
      const nowMs = ctx.tsMs;
      const fromMs = lastTickMs ?? nowMs - SCHEDULE_CACHE_MS;

      const userLimit = session.userChargeLimitPercent;
      // A conclusion restore in this tick pre-empts job 3's redundant write
      // (ctx.chargeLimitPercent still reads the pre-write value this tick).
      let restoredThisTick = false;

      // 1. Restore the user limit when EVCC's own episode concludes — the car
      //    just stopped and is still awake, so the idle gap ahead (e.g. an
      //    overnight scheduled charge) finds the USER's limit on it. The claim
      //    predating the stop distinguishes "concluded" from the start/resume
      //    gap where EVCC's limit must stay put until charging begins.
      if (
        managedSession &&
        ctx.chargingState !== 'Charging' &&
        userLimit != null &&
        ctx.chargeLimitPercent != null &&
        ctx.chargeLimitPercent !== userLimit &&
        lastOwner !== null
      ) {
        const lastStopTsMs = sessionStore.latestEventTs(deps.db, deps.vehicleId, 'charging_stop');
        if (
          lastStopTsMs !== null &&
          lastOwner.fromTsMs <= lastStopTsMs &&
          conclusionRestoredFor !== lastStopTsMs
        ) {
          if (live) {
            await deps.setChargeLimit(userLimit);
            conclusionRestoredFor = lastStopTsMs;
            restoredThisTick = true;
            log(
              `[hand-over] episode concluded — restored the user charge limit to ${userLimit}% ` +
                `(EVCC had left ${ctx.chargeLimitPercent}%)`
            );
          } else {
            conclusionRestoredFor = lastStopTsMs;
            log(
              `[hand-over] would restore the user charge limit to ${userLimit}% — episode concluded; ` +
                'shadow mode (autoStart disabled or --dry-run), not actuating'
            );
          }
        }
      }

      // 2. Restore the user limit on a foreign episode (D4) — once per episode.
      if (
        ctx.chargingState === 'Charging' &&
        !managedSession &&
        lastOwner !== null &&
        userLimit != null &&
        ctx.chargeLimitPercent != null &&
        ctx.chargeLimitPercent !== userLimit &&
        restoreAttemptedFor !== lastOwner.fromTsMs
      ) {
        restoreAttemptedFor = lastOwner.fromTsMs;
        if (live) {
          await deps.setChargeLimit(userLimit);
          log(
            `[hand-over] restored the user charge limit to ${userLimit}% ` +
              `(${lastOwner.owner} episode; EVCC had left ${ctx.chargeLimitPercent}%)`
          );
        } else {
          log(
            `[hand-over] would restore the user charge limit to ${userLimit}% — ` +
              'shadow mode (autoStart disabled or --dry-run), not actuating'
          );
        }
      }

      // 3. Prioritize scheduled charging: hand over when a start-at window
      //    activates or the handOverAt fallback passes — charging OR idle (an
      //    idle managed session must yield too; its leftover limit would
      //    otherwise block the very schedule it is handing over to).
      if (policy.prioritize && managedSession && session.releasedTsMs === null) {
        const snapshot = await cachedSnapshot(nowMs);
        const activated =
          snapshot !== null ? findActivatedChargingWindow(snapshot, fromMs, nowMs) : null;
        const handOver =
          policy.handOverAt !== null && handOverReached(policy.handOverAt, fromMs, nowMs);
        if (activated !== null || handOver) {
          const why =
            activated !== null
              ? `scheduled window activated (${activated.startMinute} min)`
              : `handOverAt ${policy.handOverAt}`;
          if (live) {
            sessionStore.releaseSession(deps.db, session.id, nowMs);
            if (
              userLimit != null &&
              ctx.chargeLimitPercent != null &&
              ctx.chargeLimitPercent !== userLimit &&
              !restoredThisTick
            ) {
              await deps.setChargeLimit(userLimit);
            }
            log(`[hand-over] released EVCC control to the scheduled charge — ${why}`);
            await emitNotify(deps, {
              type: 'session-released',
              tsMs: nowMs,
              sessionId: session.id,
              vehicleId: deps.vehicleId,
              detail: `handed over to scheduled charging — ${why}`,
            });
          } else if (!shadowReleased) {
            shadowReleased = true;
            log(
              `[hand-over] would release EVCC control (${why}) — ` +
                'shadow mode (autoStart disabled or --dry-run), not actuating'
            );
          }
        }
      }

      lastTickMs = nowMs;
    } catch (error) {
      log(`[hand-over] failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}