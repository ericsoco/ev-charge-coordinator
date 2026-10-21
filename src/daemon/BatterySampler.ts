/**
 * Home-battery sampler: one Franklin stats read per tick → one transaction
 * containing the instantaneous sample AND the day-so-far counter snapshot
 * (split tables, same tick — the design's "different measurement classes"
 * rule).
 *
 * Mapping notes: `batteryUse` sign follows the types/battery.ts contract
 * (positive = charging). The `*_kwh` totals are day-so-far counters; their
 * exact midnight-reset semantics are non-critical downstream because
 * sessionAggregates.monotonicDelta skips resets (units: kWh — magnitude
 * verified at live `daemon --once`). `soc_kwh` stays NULL: getStats does not
 * carry available energy (the composite-info read does; revisit if needed).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { FranklinWHService } from '../services/FranklinWHService.js';
import { withTransaction } from '../store/database.js';
import * as homeBattery from '../store/HomeBatteryStore.js';
import type { ScheduledTask } from './scheduler.js';

export interface BatterySamplerDeps {
  db: DatabaseSync;
  /** Only getStats is used; tests pass fakes. */
  franklin: Pick<FranklinWHService, 'getStats'>;
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
      const stats = await deps.franklin.getStats();
      const tsMs = nowMs();
      withTransaction(deps.db, () => {
        homeBattery.insertSample(deps.db, {
          homeBatteryId: deps.homeBatteryId,
          tsMs,
          socPercent: stats.current.batterySoc,
          socKwh: null,
          powerW: stats.current.batteryUse,
          homeLoadW: stats.current.homeLoad,
          solarW: stats.current.solarProduction,
          gridW: stats.current.gridUse,
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
