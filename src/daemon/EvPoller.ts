/**
 * Poll-while-awake EV sampling: one adaptive scheduler tick implements both
 * data cadences. Every tick runs the cheap state probe; a rich
 * `vehicle_data` read happens only when the car is online AND the
 * plugged-or-idle cadence (pure: shouldSampleRich) has elapsed. Each rich
 * read lands a sample, runs the pure transition detector, and maintains
 * sessions — open on plug_in, close+finalize on unplug.
 *
 * Known limitation (collect-only P1a): an unplug the car sleeps through is
 * observed only at the next wake; if the next visit's state matches the
 * stale one, the session boundary self-heals on the first observed
 * transition (plug_in with an already-open session closes it first, at the
 * observation time — approximate by necessity). Meter-reset boundary
 * detection is future hardening.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { TeslaService } from '../services/TeslaService.js';
import * as evStore from '../store/EvStore.js';
import * as homeBatteryStore from '../store/HomeBatteryStore.js';
import * as sessionStore from '../store/SessionStore.js';
import { detectTransitions } from './eventDetector.js';
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

export interface EvPollerDeps {
  db: DatabaseSync;
  /** Only these two reads are used; tests pass fakes. */
  ev: Pick<TeslaService, 'getVehicleState' | 'getStatus'>;
  vehicleId: string;
  homeBatteryId: string;
  /** Tick cadence (evStatusPollSec), seconds. */
  statusPollSec: number;
  /** Rich-read cadences, seconds (0 = every tick; tests). */
  samplePluggedSec: number;
  sampleIdleSec: number;
  nowMs?: () => number;
}

export function createEvPoller(deps: EvPollerDeps): ScheduledTask {
  const nowMs = deps.nowMs ?? Date.now;
  // Restart-safe state reconstruction: the store, not memory, owns history.
  const seed = evStore.latestSample(deps.db, deps.vehicleId);
  let lastChargingState: string | null = seed?.chargingState ?? null;
  let lastRichSampleMs: number | null = null;

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

  return {
    name: 'ev-poll',
    everyMs: deps.statusPollSec * 1000,
    run: async () => {
      const vehicle = await deps.ev.getVehicleState();
      if (vehicle.state !== 'online') return; // probe-only tick: no rich read, no wake

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
        return;
      }

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
        atHome: null, // P1b's geofence writes this; raw coordinates never land here
      });
      lastRichSampleMs = tsMs;

      for (const event of detectTransitions(lastChargingState, battery.chargingState)) {
        sessionStore.insertEvent(deps.db, {
          vehicleId: deps.vehicleId,
          tsMs,
          kind: event.kind,
          fromState: event.fromState,
          toState: event.toState,
        });

        if (event.kind === 'plug_in') {
          const alreadyOpen = sessionStore.openSessionFor(deps.db, deps.vehicleId);
          if (alreadyOpen) {
            // Stale session from a missed unplug: close it at this
            // observation (approximate boundary) before opening the new one.
            const staleId = sessionStore.closeOpenSession(deps.db, deps.vehicleId, tsMs);
            if (staleId !== null) finalize(staleId, alreadyOpen.plugTsMs, tsMs);
          }
          sessionStore.openSession(deps.db, {
            vehicleId: deps.vehicleId,
            homeBatteryId: deps.homeBatteryId,
            plugTsMs: tsMs,
          });
        } else if (event.kind === 'unplug') {
          const open = sessionStore.openSessionFor(deps.db, deps.vehicleId);
          const closedId = sessionStore.closeOpenSession(deps.db, deps.vehicleId, tsMs);
          if (closedId !== null && open) finalize(closedId, open.plugTsMs, tsMs);
        }
      }

      lastChargingState = battery.chargingState;
    },
  };
}


