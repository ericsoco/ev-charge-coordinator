/**
 * WeatherForecastStore: append-only vintages — history is kept, consumers
 * read only the newest vintage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as weather from '../../src/store/WeatherForecastStore.js';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-wx-'));
  db = openStore(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const VINTAGE_1 = 1_000;
const VINTAGE_2 = 2_000;

describe('insertForecast / latestVintage', () => {
  it('round-trips a vintage, ordered by hour', () => {
    const inserted = weather.insertForecast(
      db,
      [
        { hourTsMs: 3_000, irradianceWm2: 120.5, temperatureC: 18.2, rawJson: '{}' },
        { hourTsMs: 1_000, irradianceWm2: 0, temperatureC: 12.1 },
        { hourTsMs: 2_000, irradianceWm2: 60.4, temperatureC: 15.7 },
      ],
      VINTAGE_1
    );
    expect(inserted).toBe(3);

    const rows = weather.latestVintage(db);
    expect(rows.map((row) => row.hourTsMs)).toEqual([1_000, 2_000, 3_000]);
    expect(rows[0]).toMatchObject({
      siteId: 'home',
      fetchedTsMs: VINTAGE_1,
      irradianceWm2: 0,
      temperatureC: 12.1,
      rawJson: null,
    });
    expect(rows[2].rawJson).toBe('{}');
  });

  it('appends a newer vintage without deleting history', () => {
    weather.insertForecast(
      db,
      [
        { hourTsMs: 1_000, irradianceWm2: 100 },
        { hourTsMs: 2_000, irradianceWm2: 200 },
      ],
      VINTAGE_1
    );
    weather.insertForecast(db, [{ hourTsMs: 1_000, irradianceWm2: 90 }], VINTAGE_2);

    // Latest consumers see only the newest vintage…
    const latest = weather.latestVintage(db);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ fetchedTsMs: VINTAGE_2, hourTsMs: 1_000, irradianceWm2: 90 });

    // …but the old vintage is still stored for forecast-error analysis.
    expect(weather.countForecasts(db)).toBe(3);
  });

  it('an empty batch is a no-op', () => {
    expect(weather.insertForecast(db, [], VINTAGE_1)).toBe(0);
    expect(weather.latestVintage(db)).toEqual([]);
    expect(weather.countForecasts(db)).toBe(0);
  });

  it('latestVintage is empty on a fresh store', () => {
    expect(weather.latestVintage(db)).toEqual([]);
  });
});
