/**
 * Poll-while-awake EV sampling: one adaptive scheduler tick implements both
 * data cadences. Every tick runs the cheap state probe; a rich
 * `vehicle_data` read happens only when the car is online AND the
 * plugged-or-idle cadence (pure: shouldSampleRich) has elapsed. Each rich
 * read lands a sample, runs the pure transition detector, and maintains
 * sessions — open on plug_in, close+finalize on unplug. On the first rich
 * read it also runs the program-init reconciliation: a plugged,
 * not-charging car with no session (or an undecided one) is treated as a
 * vehicle plug-in, covering daemon-off → plug-in → daemon-on.
 *
 * Known limitation: an unplug the car sleeps through is
 * observed only at the next wake; if the next visit's state matches the
 * stale one, the session boundary self-heals on the first observed
 * transition (plug_in with an already-open session closes it first, at the
 * observation time — approximate by necessity). Meter-reset boundary
 * detection is future hardening.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { EventKind } from '../store/types.js';
import type { EVService } from '../types/ev.js';
import * as evStore from '../store/EvStore.js';
import { formatLocalTimestamp } from '../utils/time.js';
import * as homeBatteryStore from '../store/HomeBatteryStore.js';
import * as sessionStore from '../store/SessionStore.js';
import * as decisionStore from '../store/DecisionStore.js';
import { detectTransitions } from './eventDetector.js';
import type { NotificationEvent } from '../notifiers/types.js';
import { computeSessionAggregates } from './sessionAggregates.js';
import type { ScheduledTask } from './scheduler.js';

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
 * True when a rich `vehicle_data` read should happen on this tick: the first
 * observation always samples (it seeds state), otherwise the plugged-or-idle
 * cadence has elapsed. Asleep handling is the caller's job — this never
 * runs when the probe said asleep.
 */
export function shouldSampleRich(input: EvCadenceInput): boolean {
  if (input.lastRichSampleMs === null) return true;
  const intervalMs = (input.plugged ? input.samplePluggedSec : input.sampleIdleSec) * 1000;
  return input.nowMs - input.lastRichSampleMs >= intervalMs;
}

/** What the decision consumer receives per vehicle plug-in event. */
export interface VehiclePlugInContext {
  tsMs: number;
  sessionId: number;
  event: EventKind;
  chargingState: string;
  evSocPercent: number | null;
}

/** What the session-monitor stage receives on every rich read. */
export interface ChargingProgressContext {
  tsMs: number;
  evSocPercent: number | null;
  chargingState: string;
  /**
   * Which stage produced the tick (diagnostics only): this poller's rich
   * read, or the re-targeter's battery-sample path — the latter exists so a
   * sleeping car (no rich reads) can still be resumed from stored state.
   */
  source?: 'ev-poll' | 'battery-sample';
}

/** First asleep observation, then hourly — silence stays explicable. */
const ASLEEP_HEARTBEAT_MS = 3_600_000;

export interface EvPollerDeps {
  db: DatabaseSync;
  /** Only these two reads are used; tests pass fakes. */
  ev: Pick<EVService, 'getVehicleState' | 'getStatus'>;
  vehicleId: string;
  homeBatteryId: string;
  /** Tick cadence (evStatusPollSec), seconds. */
  statusPollSec: number;
  /** Rich-read cadences, seconds (0 = every tick; tests). */
  samplePluggedSec: number;
  sampleIdleSec: number;
  nowMs?: () => number;
  /** Diagnostic lines (probe transitions, cadence gates); tests pass collectors. */
  log?: (message: string) => void;
  /**
   * Decision stage of the chain: called once per vehicle plug-in after
   * the new session opens. Absent = collect-only.
   */
  onVehiclePlugIn?: (ctx: VehiclePlugInContext) => Promise<void>;
  /**
   * Session-monitor stage (P1c step 1): called on every rich read so the
   * monitor re-reads the (mutable) session target and its own episode state
   * each tick; the charging gate lives inside the stage. Absent = no monitor.
   */
  onChargingProgress?: (ctx: ChargingProgressContext) => Promise<void>;
  /**
   * One-time init wake, gated by wakeAtInit: the init plug-in check needs
   * charge_state, which only an awake car answers. Attempted at most once
   * per process, only while the init check is still pending.
   */
  wakeUp?: () => Promise<void>;
  /** Live auto-start mode — collect-only and --dry-run never wake the car. */
  wakeAtInit?: boolean;
  /**
   * Typed-event sink (design §3.7): plug-in + charge start/stop transitions,
   * emitted where the events rows are written. Failures are isolated here.
   */
  notify?: (event: NotificationEvent) => Promise<void>;
}

export function createEvPoller(deps: EvPollerDeps): ScheduledTask {
  const nowMs = deps.nowMs ?? Date.now;
  const log = deps.log ?? (() => {});
  // Typed-event sink: never fatal to sampling (design §3.4 isolation).
  const notify = async (event: NotificationEvent): Promise<void> => {
    if (!deps.notify) return;
    try {
      await deps.notify(event);
    } catch (error) {
      log(`[ev-poll] notify failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // Restart-safe state reconstruction: the store, not memory, owns history.
  const seed = evStore.latestSample(deps.db, deps.vehicleId);
  let lastChargingState: string | null = seed?.chargingState ?? null;
  let lastRichSampleMs: number | null = null;
  // Probe baseline is established by the first probe (silently): a boot-time
  // transition against a stale seed would be noise, not information.
  let lastProbeState: string | null = null;
  let lastDueLoggedAt: number | null = null;
  let lastAsleepHeartbeatMs: number | null = null;
  // Program-init bookkeeping: the wake fires at most once, the reconciliation
  // runs once — after the first successful rich read.
  let initWakeAttempted = false;
  let initCheckDone = false;

  function finalize(sessionId: number, plugTsMs: number, unplugTsMs: number): void {
    sessionStore.finalizeSession(
      deps.db,
      sessionId,
      computeSessionAggregates({
        evSamples: evStore.samplesInRange(deps.db, deps.vehicleId, plugTsMs, unplugTsMs),
        counters: homeBatteryStore.countersInRange(deps.db, plugTsMs, unplugTsMs),
        plugTsMs,
        unplugTsMs,
      })
    );
  }

  /** One decision-consumer call, isolated so a failure never stops sampling. */
  const runVehiclePlugIn = async (ctx: VehiclePlugInContext): Promise<void> => {
    if (!deps.onVehiclePlugIn) return;
    try {
      await deps.onVehiclePlugIn(ctx);
    } catch (error) {
      log(
        `[ev-poll] decision consumer failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  /** One session-monitor call, isolated so a failure never stops sampling. */
  const runChargingProgress = async (ctx: ChargingProgressContext): Promise<void> => {
    if (!deps.onChargingProgress) return;
    try {
      await deps.onChargingProgress(ctx);
    } catch (error) {
      log(
        `[ev-poll] charging-progress stage failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  /**
   * Init reconciliation (first rich read only): a plugged, not-charging car
   * with no session is the plug-in missed while the daemon was not running —
   * record and evaluate it; an open session without a decision gets that
   * decision completed; a decided session is left alone, so restarts never
   * re-fire. Charging/disconnected cars are the transition path's job.
   */
  const reconcileInitPlugIn = async (
    tsMs: number,
    battery: { chargingState: string; soc: number }
  ): Promise<void> => {
    if (battery.chargingState === 'Disconnected' || battery.chargingState === 'Charging') {
      return;
    }
    const open = sessionStore.openSessionFor(deps.db, deps.vehicleId);
    if (open === null) {
      sessionStore.insertEvent(deps.db, {
        vehicleId: deps.vehicleId,
        tsMs,
        kind: 'plug_in',
        fromState: null, // no baseline to transition from
        toState: battery.chargingState,
      });
      const sessionId = sessionStore.openSession(deps.db, {
        vehicleId: deps.vehicleId,
        homeBatteryId: deps.homeBatteryId,
        plugTsMs: tsMs,
      });
      log(
        `[ev-poll] init: vehicle plugged (${battery.chargingState}) with no session — ` +
          'treating as vehicle plug-in'
      );
      await notify({
        type: 'plug-in-detected',
        tsMs,
        sessionId,
        vehicleId: deps.vehicleId,
        evSocPercent: battery.soc,
      });
      await runVehiclePlugIn({
        tsMs,
        sessionId,
        event: 'plug_in',
        chargingState: battery.chargingState,
        evSocPercent: battery.soc,
      });
      return;
    }
    if (!deps.onVehiclePlugIn) return;
    if (decisionStore.decisionForSession(deps.db, open.id) === null) {
      log(`[ev-poll] init: session ${open.id} has no decision yet — evaluating`);
      await runVehiclePlugIn({
        tsMs,
        sessionId: open.id,
        event: 'plug_in',
        chargingState: battery.chargingState,
        evSocPercent: battery.soc,
      });
    } else {
      log(`[ev-poll] init: session ${open.id} already decided — skipping`);
    }
  };

  return {
    name: 'ev-poll',
    everyMs: deps.statusPollSec * 1000,
    run: async () => {
      const vehicle = await deps.ev.getVehicleState();
      if (lastProbeState !== null && vehicle.state !== lastProbeState) {
        log(`[ev-poll] vehicle ${lastProbeState} → ${vehicle.state}`);
      }
      lastProbeState = vehicle.state;
      // The one wake the daemon triggers: the init plug-in check needs
      // charge_state, which only an awake car answers. Once per process and
      // only while the init check is pending — never a wake loop.
      if (
        vehicle.state === 'asleep' &&
        !initWakeAttempted &&
        !initCheckDone &&
        deps.wakeAtInit &&
        deps.wakeUp
      ) {
        initWakeAttempted = true;
        log('[ev-poll] vehicle asleep at init — waking once to check plug-in state');
        try {
          await deps.wakeUp();
          lastProbeState = 'online'; // wakeUp resolves only once online
        } catch (error) {
          log(
            `[ev-poll] init wake failed: ${
              error instanceof Error ? error.message : String(error)
            } — waiting for the vehicle to wake on its own`
          );
        }
      }
      if (lastProbeState !== 'online') {
        // Liveness while silent: first observation, then hourly, so an empty
        // log is explicable — poll-while-awake observes wakes; the init check
        // above is the only one it triggers.
        const probeNow = nowMs();
        if (
          lastAsleepHeartbeatMs === null ||
          probeNow - lastAsleepHeartbeatMs >= ASLEEP_HEARTBEAT_MS
        ) {
          lastAsleepHeartbeatMs = probeNow;
          log(
            `[ev-poll] vehicle ${vehicle.state} — waiting (poll-while-awake; ` +
              'wakes are observed, not triggered)'
          );
        }
        return; // probe-only tick: no rich read, no wake
      }
      lastAsleepHeartbeatMs = null;

      const plugged = lastChargingState !== null && lastChargingState !== 'Disconnected';
      const now = nowMs();
      if (
        !shouldSampleRich({
          nowMs: now,
          lastRichSampleMs,
          plugged,
          samplePluggedSec: deps.samplePluggedSec,
          sampleIdleSec: deps.sampleIdleSec,
        })
      ) {
        // One due-line per cadence window: the standing answer to "why is
        // there no row yet".
        const intervalSec = plugged ? deps.samplePluggedSec : deps.sampleIdleSec;
        const dueAt = (lastRichSampleMs ?? now) + intervalSec * 1000;
        if (lastDueLoggedAt !== dueAt) {
          lastDueLoggedAt = dueAt;
          log(
            `[ev-poll] rich read due ${formatLocalTimestamp(dueAt)} ` +
              `(cadence ${intervalSec}s, ${plugged ? 'plugged' : 'idle'})`
          );
        }
        return;
      }
      lastDueLoggedAt = null;

      const status = await deps.ev.getStatus();
      const tsMs = nowMs();
      const battery = status.battery;

      evStore.insertSample(deps.db, {
        vehicleId: deps.vehicleId,
        tsMs,
        state: status.state,
        chargingState: battery.chargingState,
        socPercent: battery.soc,
        chargeLimitSoc: battery.chargeLimit,
        chargeRateKw: battery.chargeRate,
        minutesToFull: battery.minutesToFull,
        chargeEnergyAddedKwh: battery.chargeEnergyAdded,
        atHome: null, // geofence evaluation writes this; raw coordinates never land here
      });
      lastRichSampleMs = tsMs;

      // Session progress on every rich read while charging — the line people
      // watch. Session-independent on purpose: a daemon restart mid-session
      // (no open session row) still reports.
      if (battery.chargingState === 'Charging') {
        const parts = [`${battery.soc}% / limit ${battery.chargeLimit}%`];
        if (battery.chargeRate !== undefined) parts.push(`${battery.chargeRate} kW`);
        if (battery.chargeEnergyAdded !== undefined) parts.push(`+${battery.chargeEnergyAdded} kWh`);
        log(`[ev-poll] charging ${parts.join(' · ')}`);
      }

      let sawPlugIn = false;
      for (const event of detectTransitions(lastChargingState, battery.chargingState)) {
        sessionStore.insertEvent(deps.db, {
          vehicleId: deps.vehicleId,
          tsMs,
          kind: event.kind,
          fromState: event.fromState,
          toState: event.toState,
        });

        if (event.kind === 'plug_in') {
          sawPlugIn = true;
          const alreadyOpen = sessionStore.openSessionFor(deps.db, deps.vehicleId);
          if (alreadyOpen) {
            // Stale session from a missed unplug: close it at this
            // observation (approximate boundary) before opening the new one.
            const staleId = sessionStore.closeOpenSession(deps.db, deps.vehicleId, tsMs);
            if (staleId !== null) finalize(staleId, alreadyOpen.plugTsMs, tsMs);
          }
          const sessionId = sessionStore.openSession(deps.db, {
            vehicleId: deps.vehicleId,
            homeBatteryId: deps.homeBatteryId,
            plugTsMs: tsMs,
          });
          await notify({
            type: 'plug-in-detected',
            tsMs,
            sessionId,
            vehicleId: deps.vehicleId,
            evSocPercent: battery.soc,
          });
          await runVehiclePlugIn({
            tsMs,
            sessionId,
            event: event.kind,
            chargingState: battery.chargingState,
            evSocPercent: battery.soc,
          });
        } else if (event.kind === 'charging_start' || event.kind === 'charging_stop') {
          const open = sessionStore.openSessionFor(deps.db, deps.vehicleId);
          if (event.kind === 'charging_start') {
            // A resumed session must not carry the previous stop's reason.
            if (open !== null && open.stopReason !== null) {
              sessionStore.setSessionStopReason(deps.db, open.id, null);
            }
            await notify({
              type: 'charging-started',
              tsMs,
              sessionId: open?.id ?? null,
              vehicleId: deps.vehicleId,
              evSocPercent: battery.soc,
            });
          } else {
            await notify({
              type: 'charging-stopped',
              tsMs,
              sessionId: open?.id ?? null,
              vehicleId: deps.vehicleId,
              evSocPercent: battery.soc,
              // The monitor wrote it one tick earlier; null = manual/car stop.
              reason: open?.stopReason ?? null,
            });
          }
        } else if (event.kind === 'unplug') {
          const open = sessionStore.openSessionFor(deps.db, deps.vehicleId);
          const closedId = sessionStore.closeOpenSession(deps.db, deps.vehicleId, tsMs);
          if (closedId !== null && open) finalize(closedId, open.plugTsMs, tsMs);
        }
      }

      // Session monitor (P1c step 1): every rich read, after the transition
      // loop so a same-tick plug-in's decision has already armed the session
      // target. The stage itself gates on charging and re-reads the mutable
      // target each tick.
      await runChargingProgress({
        tsMs,
        evSocPercent: battery.soc,
        chargingState: battery.chargingState,
        source: 'ev-poll',
      });

      // Program-init reconciliation: the first rich read of this process is
      // where daemon-off → plug-in → daemon-on lands when the transition
      // above could not see it (no store baseline). Once per process, and
      // never after a plug_in this tick — that path already decided.
      if (!initCheckDone) {
        initCheckDone = true;
        if (!sawPlugIn) await reconcileInitPlugIn(tsMs, battery);
      }

      lastChargingState = battery.chargingState;
    },
  };
}


