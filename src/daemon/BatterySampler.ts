/**
 * Home-battery sampler: one Franklin stats read per tick → one transaction
 * containing the instantaneous sample AND the day-so-far counter snapshot
 * (split tables, same tick — the design's "different measurement classes"
 * rule).
 *
 * Mapping notes: live-verified 2026-10-21 — the franklinwh library reports
 * instantaneous power in kW (a "0.267" home load is 267 W), while the store's
 * *_w columns are watts, so the sampler converts (×1000). Totals are day-so-far
 * counters in kWh as named; their midnight-reset semantics are non-critical
 * downstream because sessionAggregates.monotonicDelta skips resets.
 * `batteryUse` sign follows the types/battery.ts contract (positive = charging).
 * `soc_kwh` stays NULL: getStats does not carry available energy.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BatteryFullStats } from '../types/battery.js';
import type { FranklinWHService } from '../services/FranklinWHService.js';
import { withTransaction } from '../store/database.js';
import * as homeBattery from '../store/HomeBatteryStore.js';
import type { ScheduledTask } from './scheduler.js';

export interface BatterySamplerDeps {
  db: DatabaseSync;
  /** Reads and the recovery path after a failed read; tests pass fakes. */
  franklin: Pick<FranklinWHService, 'getStats' | 'reconnect'>;
  /** Franklin gateway id — every row is attributed to it. */
  homeBatteryId: string;
  sampleSec: number;
  nowMs?: () => number;
}

export function createBatterySampler(deps: BatterySamplerDeps): ScheduledTask {
  const nowMs = deps.nowMs ?? Date.now;
  return {
    name: 'battery-sample',
    everyMs: deps.sampleSec * 1000,
    run: async () => {
      let stats: BatteryFullStats;
      try {
        stats = await deps.franklin.getStats();
      } catch {
        // The proxy can die under us (`exit` in another terminal) or arrive
        // with a stale Franklin session: reconnect respawns/attaches and
        // re-auths once, then the retry. A second failure propagates; the
        // scheduler isolates it.
        await deps.franklin.reconnect();
        stats = await deps.franklin.getStats();
      }
      const tsMs = nowMs();
      withTransaction(deps.db, () => {
        homeBattery.insertSample(deps.db, {
          homeBatteryId: deps.homeBatteryId,
          tsMs,
          socPercent: stats.current.batterySoc,
          socKwh: null,
          // The library's instantaneous power is kW; the store's columns are W.
          powerW: stats.current.batteryUse * 1000,
          homeLoadW: stats.current.homeLoad * 1000,
          solarW: stats.current.solarProduction * 1000,
          gridW: stats.current.gridUse * 1000,
        });
        homeBattery.insertCounters(deps.db, {
          homeBatteryId: deps.homeBatteryId,
          tsMs,
          batteryChargeKwh: stats.totals.batteryCharge,
          batteryDischargeKwh: stats.totals.batteryDischarge,
          gridImportKwh: stats.totals.gridImport,
          gridExportKwh: stats.totals.gridExport,
          solarKwh: stats.totals.solar,
          homeUseKwh: stats.totals.homeUse,
        });
      });
    },
  };
}
