/**
 * Response contracts for the read API — the single source of truth for the
 * shapes documented in docs/api.md. Deliberately pure (no imports) so both
 * toolchains consume the same file: the server under NodeNext (`./types.js`)
 * and the web app under bundler resolution (`../../../src/api/types`).
 * Server code defines nothing here — it implements against these and
 * re-exports what it returns (`reads.ts`, `series.ts`).
 */

/** Mirror of GET /api/now's vehicle block. */
export interface NowVehicle {
  vehicleId: string;
  socPercent: number | null;
  chargingState: string | null;
  chargeLimitSoc: number | null;
  sampleTsMs: number;
  ageMs: number;
}

/** Mirror of GET /api/now's battery block. */
export interface NowBattery {
  socPercent: number | null;
  powerW: number | null;
  homeLoadW: number | null;
  solarW: number | null;
  gridW: number | null;
  sampleTsMs: number;
  ageMs: number;
}

export interface NowSession {
  id: number;
  plugTsMs: number;
  targetPercent: number | null;
  stopReason: 'target_reached' | 'battery_buffer' | null;
}

/** Mirror of GET /api/now. */
export interface NowResponse {
  nowMs: number;
  vehicle: NowVehicle | null;
  battery: NowBattery | null;
  session: NowSession | null;
}

/**
 * Metrics accepted by GET /api/series — must stay key-identical to the
 * server's SERIES_METRICS registry (enforced by its `satisfies` clause).
 */
export type SeriesMetricName =
  | 'ev_soc'
  | 'battery_soc'
  | 'grid_import'
  | 'grid_export'
  | 'solar'
  | 'home_load';

export type SeriesUnit = 'percent' | 'kwh';
export type SeriesAggregation = 'avg' | 'integrate';

/** Mirror of GET /api/series. */
export interface SeriesResult {
  metric: SeriesMetricName;
  unit: SeriesUnit;
  aggregation: SeriesAggregation;
  from: number;
  to: number;
  bucketMs: number;
  /** [epochMs, value] pairs, oldest bucket first. */
  points: Array<[number, number]>;
}

/**
 * A GET /api/sessions row — selector label plus the tooltip data the charts
 * show for a charging session. The stop-reason union mirrors
 * store/types.ts's SessionStopReason (inlined to keep this file import-free).
 */
export interface SessionSummary {
  id: number;
  /** Selector label: start date+time, local `YYYY-MM-DD HH:MM`. */
  label: string;
  plugTsMs: number;
  unplugTsMs: number | null;
  open: boolean;
  targetPercent: number | null;
  initialTargetPercent: number | null;
  targetChangeReason: string | null;
  stopReason: 'target_reached' | 'battery_buffer' | null;
  energyKwh: number | null;
  energyPercent: number | null;
  efficiency: number | null;
  /** First EV sample SoC at/after plug; null when the car left no samples. */
  evSocStartPercent: number | null;
  /** Last EV sample SoC at/before unplug; null while open or unsampled. */
  evSocEndPercent: number | null;
  batterySocStartPercent: number | null;
  /** Null while open — an open session has no final value yet. */
  batterySocEndPercent: number | null;
}

/** Mirror of GET /api/sessions. */
export interface SessionsResponse {
  total: number;
  limit: number;
  offset: number;
  sessions: SessionSummary[];
}

/**
 * A future Messages-tab row (P2 step 7 lands the `notifications` table and
 * the notifier-fanout writes). Documented now so the app can bind to the
 * final shape; the list is empty until then.
 */
export interface ApiMessage {
  id: number;
  tsMs: number;
  /** NotificationEvent.type ('plug-in-detected', 'decision-made', …). */
  type: string;
  /** Human headline, e.g. "Charging started". */
  title: string;
  /** Rendered detail: reason, SoC, target — what ntfy/Slack would show. */
  body: string;
}

/** Mirror of GET /api/messages. */
export interface MessagesResponse {
  messages: ApiMessage[];
}
