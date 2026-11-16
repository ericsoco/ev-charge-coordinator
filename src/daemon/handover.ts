/**
 * Hand-over stage (2026-11-14 ownership work) — two jobs on every rich read:
 *
 * 1. Restore the user-set charge limit on a foreign (manual/scheduled)
 *    episode: EVCC's managed episode left its own limit on the car; when
 *    someone else owns the charge, the car must charge to the USER's limit.
 *    Once per episode — never clobbers a mid-episode user change.
 * 2. Prioritize scheduled charging (preference, default on): when a start-at
 *    schedule window activates mid-managed-episode (or the `handOverAt`
 *    fallback time passes), release EVCC's control WITHOUT stopping the car
 *    — the scheduled session seamlessly continues to the user's limit.
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

      // 1. Restore the user limit on a foreign episode (D4) — once per episode.
      const userLimit = session.userChargeLimitPercent;
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

      // 2. Prioritize scheduled charging: hand over when a start-at window
      //    activates mid-managed-episode or the handOverAt fallback passes.
      if (
        policy.prioritize &&
        managedSession &&
        ctx.chargingState === 'Charging' &&
        session.releasedTsMs === null
      ) {
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
              ctx.chargeLimitPercent !== userLimit
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