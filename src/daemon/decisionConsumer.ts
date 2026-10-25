/**
 * The EvPoller chain's decision stage (design.md §3.3): on each VEHICLE
 * plug-in event the chain reads state, detects changes, applies filters,
 * and acts — here "act" means recording the decisions row; step 5 adds the
 * actuator. Pure policy lives in ./filters.ts and ./engine.ts; this module
 * is the I/O edge: decision-time location fetch (Option B), home secret,
 * battery SoC, energy config, store write. Never throws: a lost decision
 * is logged, never able to take the poll loop down.
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

/**
 * Forced true until the step-5 actuator exists: every decision is recorded
 * in dry-run mode and nothing actuates — merge dark holds even if
 * autoStart.enabled is flipped early.
 */
const DRY_RUN_UNTIL_ACTUATION = true;

export interface DecisionConsumerDeps {
  db: DatabaseSync;
  /** Decision-time fix (Option B): read-only, never wakes; failure declines. */
  getVehicleLocation: () => Promise<VehicleLocation>;
  getHomeLocation: () => Promise<HomeLocation | undefined>;
  vehicleId: string;
  homeBatteryId: string;
  autoStart: AutoStartConfig;
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
        dryRun: DRY_RUN_UNTIL_ACTUATION,
        home,
        vehicleLocation,
      });

      decisionStore.insertDecision(deps.db, {
        vehicleId: deps.vehicleId,
        homeBatteryId: deps.homeBatteryId,
        tsMs: ctx.tsMs,
        sessionId: ctx.sessionId,
        accepted: outcome.accepted,
        dryRun: outcome.dryRun,
        reasonCode: outcome.reasonCode,
        reasonDetail: outcome.reasonDetail,
        filterResultsJson: JSON.stringify(outcome.filterResults),
        limitedBy: outcome.limitedBy,
      });
      deps.log?.(
        `[decision] session ${ctx.sessionId}: ${outcome.reasonCode}${
          outcome.reasonDetail ? ` — ${outcome.reasonDetail}` : ''
        }`
      );
    } catch (error) {
      deps.log?.(`[decision] failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
