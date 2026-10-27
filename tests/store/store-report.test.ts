/**
 * The store-report script itself: seed a tmp store, run the script with
 * --json, assert the machine-readable report — and prove the missing-store
 * path fails loudly. (The report's aggregate SQL lives in the script by
 * design; this pins that the script runs and reports true numbers.)
 */
import { execFileSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openStore } from '../../src/store/database.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';
import * as ev from '../../src/store/EvStore.js';
import * as sessions from '../../src/store/SessionStore.js';
import * as weather from '../../src/store/WeatherForecastStore.js';
import * as decisions from '../../src/store/DecisionStore.js';

const REPO = process.cwd();
const VIN = 'VIN-TEST';
const GW = 'GW-TEST';

let dir: string;
let dbPath: string;

function runStdout(...args: string[]): string {
  return execFileSync('node', ['scripts/store-report.mjs', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ECC_DISABLE_KEYCHAIN: '1' },
  });
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-report-'));
  dbPath = path.join(dir, 'data.sqlite');
  const db = openStore(dbPath);

  homeBattery.insertSample(db, { homeBatteryId: GW, tsMs: 1_000, socPercent: 55 });
  homeBattery.insertSample(db, { homeBatteryId: GW, tsMs: 2_000, socPercent: 65 });
  homeBattery.insertCounters(db, { homeBatteryId: GW, tsMs: 2_000, batteryDischargeKwh: 10 });
  ev.insertSample(db, { vehicleId: VIN, tsMs: 1_500, chargingState: 'Stopped', socPercent: 40 });
  sessions.insertEvent(db, { vehicleId: VIN, tsMs: 1_500, kind: 'plug_in', fromState: 'Disconnected', toState: 'Stopped' });

  const openId = sessions.openSession(db, { vehicleId: VIN, homeBatteryId: GW, plugTsMs: 1_000 });
  sessions.closeOpenSession(db, VIN, 61_000);
  sessions.finalizeSession(db, openId, {
    energyKwh: 5, energyPercent: 12, elapsedMs: 60_000, houseEnergyKwh: 6, efficiency: 5 / 6,
  });
  sessions.openSession(db, { vehicleId: VIN, homeBatteryId: GW, plugTsMs: 100_000 });

  weather.insertForecast(
    db,
    [
      { hourTsMs: 1_000, irradianceWm2: 100, temperatureC: 15, rawJson: '{}' },
      { hourTsMs: 2_000, irradianceWm2: 200, temperatureC: 16 },
    ],
    999
  );
  decisions.insertDecision(db, {
    vehicleId: VIN,
    tsMs: 3_000,
    sessionId: openId,
    accepted: false,
    dryRun: false,
    reasonCode: 'service_error',
    reasonDetail: 'actuation failed: complete',
    limitedBy: 'none',
    filterResultsJson: '[{"type":"always","pass":true,"reason":"always"}]',
  });
  decisions.insertDecision(db, {
    vehicleId: VIN,
    tsMs: 4_000,
    sessionId: openId,
    accepted: true,
    dryRun: false,
    reasonCode: 'started',
    reasonDetail: 'starting: charge limit 51% (none) — 8.5 kWh above 20% buffer',
  });
  db.close();
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('store-report', () => {
  it('reports true numbers as JSON', () => {
    const report = JSON.parse(runStdout('--json', '--db', dbPath));

    expect(report.store).toBe(dbPath);
    expect(report.home_battery_samples).toMatchObject({
      rows: 2,
      avgSocPercent: 60,
      window: { from: '1970-01-01T00:00:01.000Z', to: '1970-01-01T00:00:02.000Z' },
    });
    expect(report.home_battery_samples.latest.socPercent).toBe(65);
    expect(report.home_energy_counters.rows).toBe(1);
    expect(report.ev_samples).toMatchObject({ rows: 1 });
    expect(report.ev_samples.latest).toMatchObject({ vehicleId: VIN, chargingState: 'Stopped' });
    expect(report.events.byKind).toEqual({ plug_in: 1 });
    expect(report.events.latest5[0]).toMatchObject({ kind: 'plug_in' });
    expect(report.sessions).toMatchObject({
      total: 2,
      open: 1,
      closed: 1,
      avgEnergyKwh: 5,
      avgElapsedMs: 60_000,
    });
    expect(report.sessions.avgEfficiency).toBeCloseTo(5 / 6, 3);
    expect(report.weather_forecasts).toMatchObject({ rows: 2, hoursInLatestVintage: 2 });
    expect(report.decisions.rows).toBe(2);
    expect(report.decisions.recent5[0]).toMatchObject({
      ts: '1970-01-01T00:00:04.000Z',
      accepted: true,
      dryRun: false,
      reason: 'started',
    });
    expect(report.decisions.recent5[0].detail).toContain('kWh above 20% buffer');
    expect(report.decisions.recent5[1]).toMatchObject({ reason: 'service_error', accepted: false });
    expect(report.decisions.recent5[1].detail).toContain('actuation failed: complete');
    expect(report.decisions.recent5[1].filters).toContain('always');
  });

  it('human-readable mode prints every section', () => {
    const stdout = runStdout('--db', dbPath);
    for (const table of [
      'home_battery_samples',
      'home_energy_counters',
      'ev_samples',
      'events',
      'sessions',
      'weather_forecasts',
      'decisions',
    ]) {
      expect(stdout).toContain(table);
    }
    expect(stdout).toContain('2 total, 1 open, 1 closed');
    // Decision lines: local wall-clock shape + the why of the newest row.
    const decisionLine = stdout.split('\n').find((entry) => entry.includes('decision:'));
    expect(decisionLine).toMatch(/decision: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} session/);
    expect(stdout).toContain('service_error');
    expect(stdout).toContain('actuation failed: complete');
  });

  it('fails loudly on a missing store', () => {
    expect(() => runStdout('--json', '--db', path.join(dir, 'nope.sqlite'))).toThrow();
  });
});
