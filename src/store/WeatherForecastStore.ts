/**
 * Weather forecast vintages — append-only.
 *
 * Each daily fetch inserts a new vintage (fetched_ts_ms) instead of replacing
 * old rows: history is kept for actual-vs-forecast error analysis. Consumers
 * read latestVintage() — the newest fetch's rows — not the whole table.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  HOME_SITE,
  type NewWeatherForecast,
  type SiteId,
  type WeatherForecastRow,
} from './types.js';

/**
 * Aliased to camelCase so the driver output *is* the WeatherForecastRow
 * shape — no Raw* mirror interface, no per-row mapper. The schema-pin test
 * pins this alias list to the DDL and the interface.
 */
const COLUMNS = [
  'id',
  'site_id AS siteId',
  'fetched_ts_ms AS fetchedTsMs',
  'hour_ts_ms AS hourTsMs',
  'irradiance_wm2 AS irradianceWm2',
  'temperature_c AS temperatureC',
  'raw_json AS rawJson',
].join(', ');

/**
 * Append one vintage of forecast rows atomically (own transaction — do not
 * call inside another). Empty input is a no-op. Returns rows inserted.
 */
export function insertForecast(
  db: DatabaseSync,
  rows: readonly NewWeatherForecast[],
  fetchedTsMs: number,
  siteId: SiteId = HOME_SITE
): number {
  if (rows.length === 0) return 0;
  const statement = db.prepare(
    `INSERT INTO weather_forecasts
       (site_id, fetched_ts_ms, hour_ts_ms, irradiance_wm2, temperature_c, raw_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      statement.run(
        siteId,
        fetchedTsMs,
        row.hourTsMs,
        row.irradianceWm2 ?? null,
        row.temperatureC ?? null,
        row.rawJson ?? null
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return rows.length;
}

/** Rows of the newest vintage, ordered by hour; [] when none stored. */
export function latestVintage(
  db: DatabaseSync,
  siteId: SiteId = HOME_SITE
): WeatherForecastRow[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM weather_forecasts
        WHERE site_id = ?
          AND fetched_ts_ms = (
            SELECT MAX(fetched_ts_ms) FROM weather_forecasts WHERE site_id = ?
          )
        ORDER BY hour_ts_ms`
    )
    .all(siteId, siteId) as unknown as WeatherForecastRow[];
  return rows;
}

/** Total stored rows (retention/diagnostics helper). */
export function countForecasts(
  db: DatabaseSync,
  siteId: SiteId = HOME_SITE
): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM weather_forecasts WHERE site_id = ?')
    .get(siteId) as { n: number | bigint };
  return Number(row.n);
}
