/**
 * Schema pin — the three-way drift guard for the store.
 *
 * The expected schema lives in src/store/schema.ts (shared with the runtime
 * schema guard in store/database.ts) ↔ row interfaces (types.ts) ↔
 * aliased repository SELECTs. A schema change must touch all three in one
 * commit: the migration, the interface, and the pinned manifest. No codegen —
 * introspection plus compile-time-checked fixtures do the pinning:
 *
 * 1. table_info pins column order + NOT NULL + the id primary key;
 * 2. toCamel(column) must equal an interface key for every column (the
 *    aliasing rule the stores rely on);
 * 3. repository reads must return exactly the interface's key set (catches a
 *    missing/misspelled/extra alias in any SELECT);
 * 4. fixtures are typed as the interfaces, so tsc rejects fixture drift the
 *    moment an interface changes.
 *
 * PRAGMA table names cannot be bound; the interpolated names come from the
 * pinned EXPECTED_SCHEMA manifest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import { EXPECTED_SCHEMA } from '../../src/store/schema.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';
import * as ev from '../../src/store/EvStore.js';
import * as sessions from '../../src/store/SessionStore.js';
import * as weather from '../../src/store/WeatherForecastStore.js';
import * as decisions from '../../src/store/DecisionStore.js';
import type {
  DecisionRow,
  EventRow,
  EvSampleRow,
  HomeBatterySampleRow,
  HomeEnergyCountersRow,
  SessionOwnerRow,
  SessionRow,
  WeatherForecastRow,
} from '../../src/store/types.js';

/** DDL truth: the pinned EXPECTED_SCHEMA manifest (src/store/schema.ts). */

/** The aliasing rule every store SELECT follows: snake_case → camelCase. */
function toCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

// Typed fixtures: tsc rejects any drift from the interface — missing or
// excess keys — so these key sets cannot silently lag the interfaces.
const homeSample: HomeBatterySampleRow = {
  id: 0, siteId: 'home', homeBatteryId: '', tsMs: 0, socPercent: null,
  socKwh: null, powerW: null, homeLoadW: null, solarW: null, gridW: null,
};
const homeCounters: HomeEnergyCountersRow = {
  id: 0, siteId: 'home', homeBatteryId: '', tsMs: 0, batteryChargeKwh: null,
  batteryDischargeKwh: null, gridImportKwh: null, gridExportKwh: null,
  solarKwh: null, homeUseKwh: null,
};
const evSample: EvSampleRow = {
  id: 0, siteId: 'home', vehicleId: '', tsMs: 0, state: null,
  chargingState: null, socPercent: null, chargeLimitSoc: null,
  chargeRateKw: null, minutesToFull: null, chargeEnergyAddedKwh: null,
  atHome: null,
};
const eventFixture: EventRow = {
  id: 0, siteId: 'home', vehicleId: '', tsMs: 0, kind: 'plug_in',
  fromState: null, toState: null,
};
const sessionFixture: SessionRow = {
  id: 0, siteId: 'home', vehicleId: '', homeBatteryId: '', plugTsMs: 0,
  unplugTsMs: null, energyKwh: null, energyPercent: null, elapsedMs: null,
  houseEnergyKwh: null, efficiency: null, targetPercent: null,
  initialTargetPercent: null, targetChangeReason: null, stopReason: null,
  userChargeLimitPercent: null, releasedTsMs: null,
};
const sessionOwnerFixture: SessionOwnerRow = {
  id: 0, siteId: 'home', sessionId: 0, owner: 'evcc', fromTsMs: 0,
};
const forecastFixture: WeatherForecastRow = {
  id: 0, siteId: 'home', fetchedTsMs: 0, hourTsMs: 0, irradianceWm2: null,
  temperatureC: null, rawJson: null,
};
const decisionFixture: DecisionRow = {
  id: 0, siteId: 'home', vehicleId: '', homeBatteryId: null, tsMs: 0,
  sessionId: null, accepted: 0, dryRun: 0, reasonCode: 'dry_run',
  reasonDetail: null, filterResultsJson: null, limitedBy: null,
};

const FIXTURES: Record<string, readonly string[]> = {
  home_battery_samples: sortedKeys(homeSample),
  home_energy_counters: sortedKeys(homeCounters),
  ev_samples: sortedKeys(evSample),
  events: sortedKeys(eventFixture),
  sessions: sortedKeys(sessionFixture),
  session_owners: sortedKeys(sessionOwnerFixture),
  weather_forecasts: sortedKeys(forecastFixture),
  decisions: sortedKeys(decisionFixture),
};

let db: DatabaseSync;
let dbDir: string;

beforeAll(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-pin-'));
  db = openStore(path.join(dbDir, 'data.sqlite'));
});

afterAll(() => {
  db.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('DDL pin (introspected vs the pinned manifest)', () => {
  it('column order, NOT NULL set, and id primary key match', () => {
    for (const { table, columns, notNull } of EXPECTED_SCHEMA) {
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
        name: string;
        notnull: number;
        pk: number;
      }[];
      expect(info.map((c) => c.name), table).toEqual([...columns]);
      expect(
        info.filter((c) => c.notnull === 1).map((c) => c.name),
        table
      ).toEqual([...notNull]);
      expect(info.find((c) => c.name === 'id')?.pk, table).toBe(1);
    }
  });

  it('sessions.stop_reason rejects a value outside the CHECK enum', () => {
    sessions.openSession(db, { vehicleId: 'VIN-PIN', homeBatteryId: 'GW', plugTsMs: 1 });
    const id = sessions.recentSessions(db, 1)[0].id;
    expect(() =>
      db
        .prepare('UPDATE sessions SET stop_reason = ? WHERE id = ?')
        .run('manual_stop', id)
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('interface pin (DDL columns ↔ row-interface keys)', () => {
  it('every column camel-converts to an interface key, per table', () => {
    for (const { table, columns } of EXPECTED_SCHEMA) {
      const keys = FIXTURES[table];
      expect(columns.map(toCamel).sort(), table).toEqual([...keys]);
    }
  });

  it('every table has a pinned row interface', () => {
    const unpinned = EXPECTED_SCHEMA.map((t) => t.table).filter((name) => !(name in FIXTURES));
    expect(unpinned).toEqual([]);
  });
});

describe('read pin (repository SELECTs ↔ interface keys)', () => {
  it('reads return exactly the interface key set — no missing or extra alias', () => {
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 1 });
    homeBattery.insertCounters(db, { homeBatteryId: 'GW', tsMs: 1 });
    ev.insertSample(db, { vehicleId: 'VIN', tsMs: 1 });
    const pinSessionId = sessions.openSession(db, {
      vehicleId: 'VIN', homeBatteryId: 'GW', plugTsMs: 1,
    });
    sessions.appendSessionOwner(db, pinSessionId, 'evcc', 1);
    weather.insertForecast(db, [{ hourTsMs: 1 }], 1);
    decisions.insertDecision(db, {
      vehicleId: 'VIN', tsMs: 1, sessionId: 1, accepted: false, dryRun: true,
      reasonCode: 'dry_run',
    });

    const reads: [string, object | null][] = [
      ['home_battery_samples', homeBattery.latestSample(db)],
      ['home_energy_counters', homeBattery.latestCounters(db)],
      ['ev_samples', ev.latestSample(db, 'VIN')],
      ['sessions', sessions.openSessionFor(db, 'VIN')],
      ['session_owners', sessions.lastSessionOwner(db, pinSessionId)],
      ['weather_forecasts', weather.latestVintage(db)[0] ?? null],
      ['decisions', decisions.decisionForSession(db, 1)],
    ];
    for (const [table, row] of reads) {
      expect(row, table).not.toBeNull();
      expect(sortedKeys(row!), table).toEqual([...FIXTURES[table]]);
    }
    // events has no repository reader yet — covered by the pins above.
  });
});

