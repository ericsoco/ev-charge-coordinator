/**
 * /api/series internals: parameter validation, auto-bucketing, and the two
 * downsampling queries (bucketed averages, W→kWh trapezoid integration with
 * the gap cap). Offline against a temp store; fixed UTC epoch base.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';
import * as evStore from '../../src/store/EvStore.js';
import { ApiError } from '../../src/api/ApiError.js';
import {
  MAX_SPAN_MS,
  autoBucketMs,
  parseSeriesParams,
  querySeries,
} from '../../src/api/series.js';

const VIN = 'VIN-TEST';
const T0 = Date.UTC(2026, 10, 10, 0, 0, 0); // midnight UTC — 5-min aligned
const GAP0 = T0 + 10 * 3_600_000;

let db: DatabaseSync;
let dir: string;

function params(query: Record<string, unknown>) {
  return parseSeriesParams(query);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-series-'));
  db = openStore(path.join(dir, 'data.sqlite'));

  // EV SoC: 10 one-minute samples (50 → 59).
  for (let i = 0; i < 10; i += 1) {
    evStore.insertSample(db, { vehicleId: VIN, tsMs: T0 + i * 60_000, socPercent: 50 + i });
  }
  // Battery: 12 five-minute samples; grid imports 600 W then exports 400 W.
  for (let i = 0; i < 12; i += 1) {
    homeBattery.insertSample(db, {
      homeBatteryId: 'GW',
      tsMs: T0 + i * 300_000,
      socPercent: 70 + i,
      gridW: i < 6 ? 600 : -400,
      solarW: 1000,
      homeLoadW: 500,
      powerW: 100,
    });
  }
  // Gap probe: +10 min, then +20 min (second gap exceeds the 15-min cap),
  // and a null-power row an hour later.
  homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: GAP0, solarW: 1000 });
  homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: GAP0 + 600_000, solarW: 1000 });
  homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: GAP0 + 1_800_000, solarW: 1000 });
  homeBattery.insertSample(db, { homeBatteryId: 'GW', tsMs: GAP0 + 3_600_000, socPercent: 50 });
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('autoBucketMs', () => {
  it('picks the finest ladder bucket keeping the span ≤ 400 points', () => {
    expect(autoBucketMs(2 * 3_600_000)).toBe(60_000); // 120 pts
    expect(autoBucketMs(7 * 86_400_000)).toBe(1_800_000); // 336 pts (15 min would be 672)
    expect(autoBucketMs(365 * 86_400_000)).toBe(86_400_000); // 365 pts
    expect(autoBucketMs(3 * 366 * 86_400_000)).toBe(604_800_000); // ladder tail
  });
});

describe('parseSeriesParams', () => {
  it('requires a known metric and from/to', () => {
    expect(() => params({})).toThrow(ApiError);
    expect(() => params({})).toThrow(/metric is required and must be one of/);
    expect(() => params({ metric: 'nope', from: '1', to: '2' })).toThrow(/metric is required/);
    expect(() => params({ metric: 'ev_soc' })).toThrow(/from and to are required/);
  });

  it('rejects non-integer, negative, and inverted ranges', () => {
    const base = { metric: 'ev_soc' };
    expect(() => params({ ...base, from: 'abc', to: '2' })).toThrow(/from must be an integer/);
    expect(() => params({ ...base, from: ['1', '2'], to: '3' })).toThrow(/from must be an integer/);
    expect(() => params({ ...base, from: '-1', to: '2' })).toThrow(/from must be >= 0/);
    expect(() => params({ ...base, from: '100', to: '100' })).toThrow(/to must be greater/);
  });

  it('rejects spans beyond the cap and buckets that are too fine or too coarse', () => {
    expect(() => params({ metric: 'ev_soc', from: '0', to: String(MAX_SPAN_MS + 1) })).toThrow(
      /spans more than/
    );
    expect(() =>
      params({ metric: 'ev_soc', from: String(T0), to: String(T0 + 60_000), bucket: '500' })
    ).toThrow(/bucket must be >= 1000 ms/);
    expect(() =>
      params({ metric: 'ev_soc', from: String(T0), to: String(T0 + 10 * 86_400_000), bucket: '1000' })
    ).toThrow(/would exceed 4000 points/);
  });

  it('auto-buckets when omitted and echoes the resolved bucket', () => {
    const parsed = params({ metric: 'ev_soc', from: String(T0), to: String(T0 + 2 * 3_600_000) });
    expect(parsed.bucketMs).toBe(60_000);
    expect(parsed).toMatchObject({ metric: 'ev_soc', fromMs: T0, toMs: T0 + 2 * 3_600_000 });
  });
});

describe('querySeries', () => {
  it('averages SoC per epoch-aligned bucket', () => {
    const result = querySeries(
      db,
      params({ metric: 'ev_soc', from: String(T0), to: String(T0 + 9 * 60_000), bucket: '300000' })
    );
    expect(result).toMatchObject({ unit: 'percent', aggregation: 'avg', bucketMs: 300_000 });
    expect(result.points).toEqual([
      [T0, 52], // avg 50..54
      [T0 + 300_000, 57], // avg 55..59
    ]);
    const battery = querySeries(
      db,
      params({ metric: 'battery_soc', from: String(T0), to: String(T0 + 3_600_000), bucket: '3600000' })
    );
    expect(battery.points).toEqual([[T0, 75.5]]); // avg 70..81
  });

  it('integrates W columns into kWh per bucket (sign-split grid, clamped solar)', () => {
    const query = (metric: string) =>
      querySeries(
        db,
        params({ metric, from: String(T0), to: String(T0 + 3_600_000), bucket: '3600000' })
      );
    // Trapezoid over 11 five-minute pairs: import 0.275, export 0.1833,
    // solar 0.9166, load 0.4583 kWh.
    const imported = query('grid_import');
    expect(imported).toMatchObject({ unit: 'kwh', aggregation: 'integrate' });
    expect(imported.points).toHaveLength(1);
    expect(imported.points[0][0]).toBe(T0);
    expect(imported.points[0][1]).toBeCloseTo(0.275, 10);
    expect(query('grid_export').points[0][1]).toBeCloseTo(0.1833333333, 8);
    expect(query('solar').points[0][1]).toBeCloseTo(0.9166666667, 8);
    expect(query('home_load').points[0][1]).toBeCloseTo(0.4583333333, 8);
  });

  it('skips pairs beyond the 15-minute gap cap and null-power rows', () => {
    // The +10 min pair integrates (≤ cap); the +20 min follow-up is skipped.
    const gapped = querySeries(
      db,
      params({ metric: 'solar', from: String(GAP0), to: String(GAP0 + 1_800_000), bucket: '3600000' })
    );
    expect(gapped.points).toHaveLength(1);
    expect(gapped.points[0][0]).toBe(GAP0); // hour-aligned bucket
    expect(gapped.points[0][1]).toBeCloseTo((1000 * 600_000) / 3_600_000_000, 12);
    // The lone null-solar row contributes nothing.
    const nullOnly = querySeries(
      db,
      params({ metric: 'solar', from: String(GAP0 + 3_600_000), to: String(GAP0 + 3_660_000) })
    );
    expect(nullOnly.points).toEqual([]);
  });

  it('returns an empty point list for a range with no samples', () => {
    const empty = querySeries(
      db,
      params({ metric: 'ev_soc', from: String(T0 + 20 * 3_600_000), to: String(T0 + 21 * 3_600_000) })
    );
    expect(empty.points).toEqual([]);
  });
});

