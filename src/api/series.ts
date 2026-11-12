/**
 * Time-series reads for GET /api/series: metric registry, parameter
 * validation, and server-side downsampling so the charts never pull raw rows.
 *
 * Buckets are epoch-aligned multiples of bucketMs. `avg` metrics take a
 * per-bucket AVG; `integrate` metrics trapezoid-integrate the instantaneous
 * W columns into kWh server-side (P2 step 6: kWh buckets from the sampled W
 * columns), attributing each sample pair to the LATER sample's bucket. Pairs
 * further apart than MAX_GAP_MS are skipped — a daemon outage is an
 * unobserved window, not energy.
 */
import type { DatabaseSync } from 'node:sqlite';
import { HOME_SITE, type SiteId } from '../store/types.js';
import { ApiError } from './ApiError.js';
import { intParam } from './params.js';
import type {
  SeriesAggregation,
  SeriesMetricName,
  SeriesResult,
  SeriesUnit,
} from './types.js';

export type { SeriesAggregation, SeriesMetricName, SeriesResult, SeriesUnit } from './types.js';

export interface MetricDef {
  table: 'ev_samples' | 'home_battery_samples';
  /** Column aggregated (`avg`) or NULL-filtered (`integrate`). */
  column: string;
  unit: SeriesUnit;
  aggregation: SeriesAggregation;
  /**
   * `integrate` only: per-sample power expression in W, non-negative.
   * Whitelisted constants built from `column` — never request input.
   * Sign convention: grid_w > 0 = import, < 0 = export (gateway balance:
   * solar + grid import + battery discharge = home load).
   */
  powerExpr?: string;
}

export const SERIES_METRICS = {
  ev_soc: { table: 'ev_samples', column: 'soc_percent', unit: 'percent', aggregation: 'avg' },
  battery_soc: {
    table: 'home_battery_samples',
    column: 'soc_percent',
    unit: 'percent',
    aggregation: 'avg',
  },
  grid_import: {
    table: 'home_battery_samples',
    column: 'grid_w',
    unit: 'kwh',
    aggregation: 'integrate',
    powerExpr: 'MAX(grid_w, 0)',
  },
  grid_export: {
    table: 'home_battery_samples',
    column: 'grid_w',
    unit: 'kwh',
    aggregation: 'integrate',
    powerExpr: 'MAX(-grid_w, 0)',
  },
  solar: {
    table: 'home_battery_samples',
    column: 'solar_w',
    unit: 'kwh',
    aggregation: 'integrate',
    // Clamp: night-time sensor noise reads slightly negative (seen: -6 W).
    powerExpr: 'MAX(solar_w, 0)',
  },
  home_load: {
    table: 'home_battery_samples',
    column: 'home_load_w',
    unit: 'kwh',
    aggregation: 'integrate',
    powerExpr: 'MAX(home_load_w, 0)',
  },
} as const satisfies Record<SeriesMetricName, MetricDef>;

/** Auto-bucket ladder (ms): 1m, 2m, 5m, 10m, 15m, 30m, 1h, 2h, 3h, 6h, 12h, 1d, 2d, 7d, 14d, 30d, 90d. */
const BUCKET_LADDER_MS = [
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
  10_800_000, 21_600_000, 43_200_000, 86_400_000, 172_800_000, 604_800_000,
  1_209_600_000, 2_592_000_000, 7_776_000_000,
];

/** Auto-bucket target: at most this many points when `bucket` is omitted. */
export const AUTO_MAX_POINTS = 400;
/** Hard cap with an explicit bucket — bounds response size. */
export const MAX_POINTS = 4_000;
/** Explicit buckets below this are rejected (finer than the 1-minute sample cadence). */
export const MIN_BUCKET_MS = 1_000;
/** Range cap: ~3 years, well past the chart's 1-year max zoom; guards from/to typos. */
export const MAX_SPAN_MS = 3 * 366 * 86_400_000;
/** Integration skips pairs further apart than this (daemon downtime = unobserved). */
export const MAX_GAP_MS = 15 * 60_000;

/** Smallest ladder bucket keeping the span within AUTO_MAX_POINTS. */
export function autoBucketMs(spanMs: number): number {
  for (const bucket of BUCKET_LADDER_MS) {
    if (spanMs / bucket <= AUTO_MAX_POINTS) return bucket;
  }
  return BUCKET_LADDER_MS[BUCKET_LADDER_MS.length - 1];
}

export interface SeriesParams {
  metric: SeriesMetricName;
  fromMs: number;
  toMs: number;
  bucketMs: number;
}
/** Validate ?metric&from&to&bucket; throws ApiError(400) with a fix-it message. */
export function parseSeriesParams(query: Record<string, unknown>): SeriesParams {
  const metric = query.metric;
  if (typeof metric !== 'string' || !(metric in SERIES_METRICS)) {
    throw new ApiError(
      400,
      `metric is required and must be one of: ${Object.keys(SERIES_METRICS).join(', ')}`
    );
  }
  const fromMs = intParam(query, 'from');
  const toMs = intParam(query, 'to');
  if (fromMs === undefined || toMs === undefined) {
    throw new ApiError(400, 'from and to are required (epoch milliseconds)');
  }
  if (fromMs < 0) throw new ApiError(400, 'from must be >= 0 (epoch milliseconds)');
  if (toMs <= fromMs) throw new ApiError(400, 'to must be greater than from');
  const spanMs = toMs - fromMs;
  if (spanMs > MAX_SPAN_MS) {
    throw new ApiError(400, `range spans more than ${Math.round(MAX_SPAN_MS / 86_400_000)} days`);
  }
  const explicit = intParam(query, 'bucket');
  let bucketMs: number;
  if (explicit === undefined) {
    bucketMs = autoBucketMs(spanMs);
  } else {
    if (explicit < MIN_BUCKET_MS) {
      throw new ApiError(400, `bucket must be >= ${MIN_BUCKET_MS} ms`);
    }
    bucketMs = explicit;
  }
  if (spanMs / bucketMs > MAX_POINTS) {
    throw new ApiError(
      400,
      `bucket ${bucketMs} ms over ${spanMs} ms would exceed ${MAX_POINTS} points — ` +
        'raise bucket or narrow the range'
    );
  }
  return { metric: metric as SeriesMetricName, fromMs, toMs, bucketMs };
}

interface BucketRow {
  bucket: number | bigint;
  v?: number | bigint | null;
  kwh?: number | bigint | null;
}

/**
 * Run the validated query with server-side downsampling. Both statements are
 * fully parameterized; table/column/expression fragments come only from
 * SERIES_METRICS (never request input). W·ms ÷ 3.6e9 = kWh.
 */
export function querySeries(
  db: DatabaseSync,
  params: SeriesParams,
  siteId: SiteId = HOME_SITE
): SeriesResult {
  const def = SERIES_METRICS[params.metric];
  const { fromMs, toMs, bucketMs } = params;
  const rows: BucketRow[] =
    def.aggregation === 'avg'
      ? (db
          .prepare(
            `SELECT CAST(ts_ms / ? AS INTEGER) * ? AS bucket, AVG(${def.column}) AS v
               FROM ${def.table}
              WHERE site_id = ? AND ts_ms >= ? AND ts_ms <= ? AND ${def.column} IS NOT NULL
              GROUP BY bucket
              ORDER BY bucket`
          )
          .all(bucketMs, bucketMs, siteId, fromMs, toMs) as unknown as BucketRow[])
      : (db
          .prepare(
            `WITH s AS (
               SELECT ts_ms,
                      ${def.powerExpr} AS w,
                      LAG(ts_ms) OVER (ORDER BY ts_ms, id) AS prev_ts,
                      LAG(${def.powerExpr}) OVER (ORDER BY ts_ms, id) AS prev_w
                 FROM ${def.table}
                WHERE site_id = ? AND ts_ms >= ? AND ts_ms <= ? AND ${def.column} IS NOT NULL
             )
             SELECT CAST(ts_ms / ? AS INTEGER) * ? AS bucket,
                    SUM((prev_w + w) / 2.0 * (ts_ms - prev_ts)) / 3600000000.0 AS kwh
               FROM s
              WHERE prev_ts IS NOT NULL AND ts_ms - prev_ts <= ?
              GROUP BY bucket
              ORDER BY bucket`
          )
          .all(siteId, fromMs, toMs, bucketMs, bucketMs, MAX_GAP_MS) as unknown as BucketRow[]);

  const valueKey = def.aggregation === 'avg' ? 'v' : 'kwh';
  const points: Array<[number, number]> = rows.map((row) => [
    Number(row.bucket),
    Number(row[valueKey]),
  ]);
  return {
    metric: params.metric,
    unit: def.unit,
    aggregation: def.aggregation,
    from: fromMs,
    to: toMs,
    bucketMs,
    points,
  };
}

