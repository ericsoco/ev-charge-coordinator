/**
 * HomeBatteryStore round-trips: samples, counters, ordering, retention.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-hb-'));
  db = openStore(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('samples', () => {
  it('round-trips every field', () => {
    const id = homeBattery.insertSample(db, {
      homeBatteryId: 'GW-TEST',
      tsMs: 1_000,
      socPercent: 55.5,
      socKwh: 7.4,
      powerW: -320,
      homeLoadW: 900,
      solarW: 4_200,
      gridW: 0,
    });
    expect(id).toBeGreaterThan(0);

    const row = homeBattery.latestSample(db);
    expect(row).toMatchObject({
      siteId: 'home',
      homeBatteryId: 'GW-TEST',
      tsMs: 1_000,
      socPercent: 55.5,
      socKwh: 7.4,
      powerW: -320,
      homeLoadW: 900,
      solarW: 4_200,
      gridW: 0,
    });
    expect(row?.id).toBe(id);
  });

  it('maps absent optional fields to null', () => {
    homeBattery.insertSample(db, { homeBatteryId: 'GW-TEST', tsMs: 1_000 });
    const row = homeBattery.latestSample(db);
    expect(row?.socPercent).toBeNull();
    expect(row?.socKwh).toBeNull();
    expect(row?.powerW).toBeNull();
    expect(row?.gridW).toBeNull();
  });

  it('latestSample orders by ts, then id', () => {
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 100 });
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 200 });
    expect(homeBattery.latestSample(db)?.tsMs).toBe(200);

    // An older row arriving later must not become "latest".
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 150 });
    expect(homeBattery.latestSample(db)?.tsMs).toBe(200);

    // Same-ts tie: the later insert wins.
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: 200 });
    expect(homeBattery.latestSample(db)?.tsMs).toBe(200);
  });

  it('latestSample is null on an empty store', () => {
    expect(homeBattery.latestSample(db)).toBeNull();
  });
});

describe('counters', () => {
  it('round-trips every field', () => {
    const id = homeBattery.insertCounters(db, {
      homeBatteryId: 'GW-TEST',
      tsMs: 2_000,
      batteryChargeKwh: 12.3,
      batteryDischargeKwh: 45.6,
      gridImportKwh: 1.2,
      gridExportKwh: 8.8,
      solarKwh: 30.1,
      homeUseKwh: 55.5,
    });
    const row = homeBattery.latestCounters(db);
    expect(row).toMatchObject({
      id,
      siteId: 'home',
      homeBatteryId: 'GW-TEST',
      tsMs: 2_000,
      batteryChargeKwh: 12.3,
      batteryDischargeKwh: 45.6,
      gridImportKwh: 1.2,
      gridExportKwh: 8.8,
      solarKwh: 30.1,
      homeUseKwh: 55.5,
    });
  });

  it('latestCounters is null on an empty store', () => {
    expect(homeBattery.latestCounters(db)).toBeNull();
  });
});

describe('prune', () => {
  it('deletes only rows past the cutoff, across both tables', () => {
    const nowMs = 100 * 86_400_000; // day 100
    const oldTs = 1_000; // day 0
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: oldTs });
    homeBattery.insertCounters(db, { homeBatteryId: 'GW', tsMs: oldTs });
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: nowMs });
    homeBattery.insertCounters(db, { homeBatteryId: 'GW', tsMs: nowMs });

    const deleted = homeBattery.prune(db, 90, nowMs);
    expect(deleted).toBe(2);
    expect(homeBattery.latestSample(db)?.tsMs).toBe(nowMs);
    expect(homeBattery.latestCounters(db)?.tsMs).toBe(nowMs);
  });

  it('prunes nothing when the store is inside the window', () => {
    const nowMs = 10 * 86_400_000;
    homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: nowMs });
    expect(homeBattery.prune(db, 90, nowMs)).toBe(0);
  });

  it('rejects a negative retention window', () => {
    expect(() => homeBattery.prune(db, -1, 0)).toThrow(/retentionDays/);
  });
});
