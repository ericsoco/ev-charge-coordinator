/**
 * EvStore round-trips: fields (including NULL at_home), per-vehicle
 * latest, retention.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as ev from '../../src/store/EvStore.js';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-ev-'));
  db = openStore(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('insertSample / latestSample', () => {
  it('round-trips every field', () => {
    const id = ev.insertSample(db, {
      vehicleId: 'VIN-TEST',
      tsMs: 5_000,
      state: 'online',
      chargingState: 'Charging',
      socPercent: 42.5,
      chargeLimitSoc: 80,
      chargeRateKw: 7.2,
      minutesToFull: 95,
      chargeEnergyAddedKwh: 3.1,
      atHome: 1,
    });
    expect(id).toBeGreaterThan(0);

    const row = ev.latestSample(db, 'VIN-TEST');
    expect(row).toMatchObject({
      siteId: 'home',
      vehicleId: 'VIN-TEST',
      tsMs: 5_000,
      state: 'online',
      chargingState: 'Charging',
      socPercent: 42.5,
      chargeLimitSoc: 80,
      chargeRateKw: 7.2,
      minutesToFull: 95,
      chargeEnergyAddedKwh: 3.1,
      atHome: 1,
    });
    expect(row?.id).toBe(id);
  });

  it('maps absent fields to null (at_home stays null until P1b)', () => {
    ev.insertSample(db, { vehicleId: 'VIN-TEST', tsMs: 1 });
    const row = ev.latestSample(db, 'VIN-TEST');
    expect(row?.state).toBeNull();
    expect(row?.chargingState).toBeNull();
    expect(row?.chargeEnergyAddedKwh).toBeNull();
    expect(row?.atHome).toBeNull();
  });

  it('returns the newest row for the requested vehicle only', () => {
    ev.insertSample(db, { vehicleId: 'VIN-A', tsMs: 100, socPercent: 10 });
    ev.insertSample(db, { vehicleId: 'VIN-B', tsMs: 200, socPercent: 20 });
    ev.insertSample(db, { vehicleId: 'VIN-A', tsMs: 300, socPercent: 30 });

    expect(ev.latestSample(db, 'VIN-A')?.tsMs).toBe(300);
    expect(ev.latestSample(db, 'VIN-A')?.socPercent).toBe(30);
    expect(ev.latestSample(db, 'VIN-B')?.socPercent).toBe(20);
  });

  it('is null for an unknown vehicle', () => {
    expect(ev.latestSample(db, 'VIN-NEVER')).toBeNull();
  });
});

describe('prune', () => {
  it('deletes only rows past the cutoff', () => {
    const nowMs = 100 * 86_400_000;
    ev.insertSample(db, { vehicleId: 'VIN', tsMs: 1_000 });
    ev.insertSample(db, { vehicleId: 'VIN', tsMs: nowMs });

    expect(ev.prune(db, 90, nowMs)).toBe(1);
    expect(ev.latestSample(db, 'VIN')?.tsMs).toBe(nowMs);
  });

  it('rejects a negative retention window', () => {
    expect(() => ev.prune(db, -1, 0)).toThrow(/retentionDays/);
  });
});
