/**
 * Weather-adjusted reserve (design §3.6.2, P1c step 3): a binary low-solar
 * rule — when the next-24h daylight integral (shortwave radiation, Wh/m²)
 * falls below a threshold, the charge-limit math keeps more reserve in the
 * house pack. One-sided by design: a low outlook raises the buffer; a bright
 * outlook changes nothing (never spend more than the base plan).
 *
 * Pure: no I/O, no clock — the edges (decision consumer, charge-from-battery)
 * fetch the newest forecast vintage and pass `now`. The age guard lives here
 * so every edge forgets a stale vintage the same way.
 *
 * Open-Meteo reports site-level shortwave radiation — a proxy for what the
 * array will see (no panel tilt/efficiency model); the threshold is tuned
 * against that proxy, not against PV output.
 *
 * Future refinements (workplan: documented, not built): (B) a graded
 * adjustment scaled continuously by how far the integral falls below the
 * threshold, and (C) a percentile computed against stored past vintages'
 * same-window integrals (self-calibrating, no magic energy constant).
 */

/** One forecast hour; structurally satisfied by the store's row shape. */
export interface ForecastHourSample {
  hourTsMs: number;
  irradianceWm2: number | null;
}

/** A single vintage's rows; `latestVintage()` rows satisfy this. */
export interface ForecastVintageRow extends ForecastHourSample {
  /** The fetch time shared by every row of the vintage. */
  fetchedTsMs: number;
}

export interface WeatherPolicy {
  /** Extra reserve (percent of battery capacity) on a low outlook. 0 = off. */
  bufferAdjPercent: number;
  /** Below this next-24h daylight integral (Wh/m²) the outlook counts as low. */
  solarThresholdWhM2: number;
  /** Newest vintage older than this is stale — never adjust on it. */
  maxVintageAgeMs: number;
  /** Hourly rows required in the 24h window (of 24) to trust the integral. */
  minCoverageHours: number;
}

/**
 * The whole policy, as knobs with defaults. `bufferAdjPercent: 0` keeps the
 * adjustment off until the operator opts in via daemon-config.json — shipped
 * defaults never change existing behavior.
 */
export const DEFAULT_WEATHER_POLICY: WeatherPolicy = {
  bufferAdjPercent: 0,
  solarThresholdWhM2: 2000,
  maxVintageAgeMs: 36 * 60 * 60 * 1000, // one missed daily fetch, then give up
  minCoverageHours: 18,
};

export interface WeatherAdjustment {
  /** Percent to add to `bufferPercent` before the charge-limit math. */
  adjustmentPercent: number;
  /** Human phrasing for reason_detail / the CLI display. */
  detail: string;
}

/** Daylight integral over [now, now+24h): rows outside the window ignored. */
export function daylightIntegral24h(
  rows: readonly ForecastHourSample[],
  nowMs: number
): { integralWhM2: number; hours: number } {
  const endMs = nowMs + 24 * 60 * 60 * 1000;
  let integralWhM2 = 0;
  let hours = 0;
  for (const row of rows) {
    if (row.hourTsMs < nowMs || row.hourTsMs >= endMs) continue;
    hours += 1;
    // 1-hour buckets: W × 1h = Wh/m². Null/zero contributes nothing.
    if (row.irradianceWm2 !== null && row.irradianceWm2 > 0) {
      integralWhM2 += row.irradianceWm2;
    }
  }
  return { integralWhM2, hours };
}

/**
 * The adjustment for one vintage, or null when none applies: disabled (0),
 * no rows, stale fetch, thin window coverage, or an outlook that is not low.
 * Rows must be one vintage (`latestVintage()` guarantees it) — the fetch time
 * is read from the first row.
 */
export function weatherAdjustment(
  rows: readonly ForecastVintageRow[],
  nowMs: number,
  policy: WeatherPolicy = DEFAULT_WEATHER_POLICY
): WeatherAdjustment | null {
  if (rows.length === 0 || !(policy.bufferAdjPercent > 0)) return null;
  if (nowMs - rows[0].fetchedTsMs > policy.maxVintageAgeMs) return null;

  const window = daylightIntegral24h(rows, nowMs);
  if (window.hours < policy.minCoverageHours) return null;
  if (window.integralWhM2 >= policy.solarThresholdWhM2) return null;

  return {
    adjustmentPercent: policy.bufferAdjPercent,
    detail:
      `low solar next 24h (${Math.round(window.integralWhM2)} < ` +
      `${policy.solarThresholdWhM2} Wh/m²)`,
  };
}