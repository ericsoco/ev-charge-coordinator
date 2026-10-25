/**
 * The EvPoller chain's decision stage (design.md §3.3): on each VEHICLE
 * plug-in event the chain reads state, detects changes, applies filters,
 * and acts: a live accepted decision sets the charge limit, starts charging,
 * and records the outcome row. Pure policy lives in ./filters.ts and
 * ./engine.ts; this module is the I/O edge: decision-time location fetch
 * (Option B), home secret, battery SoC, energy config, vehicle commands,
 * store write. Never throws: a lost decision is logged, never able to take
 * the poll loop down.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { VehicleLocation } from '../types/ev.js';
import type { HomeLocation } from '../utils/credentials.js';
import type { AutoStartConfig } from '../utils/daemonConfig.js';
import type { EnergyConfig } from '../utils/energy.js';
import { resolveEnergyConfig } from '../utils/config.js';
import * as decisionStore from '../store/DecisionStore.js';
import * as homeBattery from '../store/HomeBatteryStore.js';
import { evaluateDecision } from './engine.js';
import type { VehiclePlugInContext } from './EvPoller.js';

export interface DecisionConsumerDeps {
  db: DatabaseSync;
  /** Decision-time fix (Option B): read-only, never wakes; failure declines. */
  getVehicleLocation: () => Promise<VehicleLocation>;
  getHomeLocation: () => Promise<HomeLocation | undefined>;
  vehicleId: string;
  homeBatteryId: string;
  autoStart: AutoStartConfig;
  /**
   * `daemon --dry-run`; the engine derives the mode (dry = !enabled || flag).
   * Dry records the verdict without actuating.
   */
  dryRun: boolean;
  /**
   * Signed commands in order: set the computed limit, then start. The
   * service resolves/respawns the tesla-http-proxy sidecar per command and
   * verifies the car actually began charging.
   */
  chargeCommands: {
    setChargeLimit: (percent: number) => Promise<void>;
    startCharging: () => Promise<void>;
  };
  /** Injectable so tests avoid config files; default reads energy config.json. */
  getEnergyConfig?: () => EnergyConfig | null;
  log?: (message: string) => void;
}

/**
 * The chain's vehicle plug-in hook: evaluate the decision and record it.
 * Owns every I/O step and swallows its own failures (log-only).
 */
export function createDecisionConsumer(
  deps: DecisionConsumerDeps
): (ctx: VehiclePlugInContext) => Promise<void> {
  return async (ctx: VehiclePlugInContext): Promise<void> => {
    try {
      const sessionAlreadyDecided =
        decisionStore.decisionForSession(deps.db, ctx.sessionId) !== null;

      let vehicleLocation: VehicleLocation | null = null;
      try {
        vehicleLocation = await deps.getVehicleLocation();
      } catch (error) {
        deps.log?.(
          `[decision] vehicle location read failed: ${
            error instanceof Error ? error.message : String(error)
          } — the geofence will decline`
        );
      }

      let home: HomeLocation | null = null;
      try {
        home = (await deps.getHomeLocation()) ?? null;
      } catch (error) {
        deps.log?.(
          `[decision] home location read failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      const getEnergyConfig = deps.getEnergyConfig ?? (() => resolveEnergyConfig().config);
      const outcome = evaluateDecision({
        sessionAlreadyDecided,
        event: ctx.event,
        plugged: true, // this hook fires on a vehicle plug-in event by definition
        chargingState: ctx.chargingState,
        evSocPercent: ctx.evSocPercent,
        homeBatterySocPercent: homeBattery.latestSample(deps.db)?.socPercent ?? null,
        energyConfig: getEnergyConfig(),
        autoStart: deps.autoStart,
        dryRun: deps.dryRun,
        home,
        vehicleLocation,
      });

      // Live and every gate passed: set the limit first, then start (the
      // service verifies the car is actually charging). A command failure
      // downgrades the outcome — the row must say what happened, with the
      // computed target kept as context.
      let recorded = outcome;
      if (outcome.accepted && outcome.targetPercent !== null) {
        try {
          await deps.chargeCommands.setChargeLimit(outcome.targetPercent);
          await deps.chargeCommands.startCharging();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recorded = {
            ...outcome,
            accepted: false,
            reasonCode: 'service_error',
            reasonDetail: `${outcome.reasonDetail ?? 'decision accepted'} — actuation failed: ${message}`,
          };
        }
      }

      decisionStore.insertDecision(deps.db, {
        vehicleId: deps.vehicleId,
        homeBatteryId: deps.homeBatteryId,
        tsMs: ctx.tsMs,
        sessionId: ctx.sessionId,
        accepted: recorded.accepted,
        dryRun: recorded.dryRun,
        reasonCode: recorded.reasonCode,
        reasonDetail: recorded.reasonDetail,
        filterResultsJson: JSON.stringify(recorded.filterResults),
        limitedBy: recorded.limitedBy,
      });
      deps.log?.(
        `[decision] session ${ctx.sessionId}: ${recorded.reasonCode}${
          recorded.reasonDetail ? ` — ${recorded.reasonDetail}` : ''
        }`
      );
    } catch (error) {
      deps.log?.(`[decision] failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
