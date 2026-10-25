/**
 * Pure decision filters for auto-start (design.md §3.3/§4).
 *
 * Placement rationale: filters exist only inside the EvPoller chain — the
 * poller reads vehicle state, detects state changes (eventDetector.ts),
 * applies this chain, and acts on the outcome (sessions now; decisions +
 * actuation in the next P1b steps). Purity is a testing choice, not a bid
 * for other consumers: each filter is a total function over injected data —
 * no I/O, no store, no services; the poller supplies the home secret, the
 * decision-time vehicle location (geofence = Option B: fetched at plug-in,
 * never here), and config. Failure semantics (§4): a configured filter
 * that cannot decide fails with an actionable reason — never a silent
 * allow.
 */
import type { HomeLocation } from '../utils/credentials.js';
import type { VehicleLocation } from '../types/ev.js';
import type { EventKind } from '../store/types.js';
import type { DecisionFilterConfig } from '../utils/daemonConfig.js';

/** Coordinates as the credential store and Tesla reads hand them out. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * The decision context (design: `(event, decisionContext) → {pass, reason}`).
 * Filters read the location fields today; the battery fields are engine
 * context the step-3 interlocks read off the same object.
 */
export interface FilterInput {
  event: EventKind;
  plugged: boolean;
  chargingState: string;
  /** Home secret; null = not set (geofence cannot pass). */
  home: HomeLocation | null;
  /** Decision-time fix; null = fetch failed or never attempted. */
  vehicleLocation: VehicleLocation | null;
  /** Home battery SoC, percent — engine interlock context. */
  homeBatterySocPercent?: number | null;
  /** Resolved energy config — engine interlock context (`bufferPercent`). */
  energyConfig?: { bufferPercent: number } | null;
}

/**
 * Why one filter passed or failed. `always`/`geofence` are pass reasons;
 * the rest are loud-failure reasons (each carries a `detail` sentence the
 * decision row should keep).
 */
export type FilterReason =
  | 'always'
  | 'geofence'
  | 'not_at_home'
  | 'home_unset'
  | 'location_unavailable'
  | 'config_error';

export interface FilterResult {
  /** Producing filter; 'unknown' = a type nothing recognizes (loud fail). */
  type: DecisionFilterConfig['type'] | 'unknown';
  pass: boolean;
  reason: FilterReason;
  /** Human sentence for `filter_results_json` / `reason_detail`. */
  detail?: string;
  /** geofence outcome only: whole meters, recorded on pass AND `not_at_home`. */
  distanceM?: number;
}

export interface FilterChainResult {
  /** Overall verdict: every filter passed (empty chain passes). */
  pass: boolean;
  /** Every filter's result — no short-circuit, so the audit is complete. */
  results: FilterResult[];
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters (haversine). */
export function distanceM(a: GeoPoint, b: GeoPoint): number {
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLng = (b.longitude - a.longitude) * toRad;
  const lat1 = a.latitude * toRad;
  const lat2 = b.latitude * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Evaluate the configured chain with AND semantics. Every filter runs even
 * after one fails (pure and cheap), so the decision row's `filter_results_
 * json` shows the full picture; an empty chain passes (design: "empty
 * filters array = all plug-in events").
 */
export function runFilters(
  filters: readonly DecisionFilterConfig[],
  input: FilterInput
): FilterChainResult {
  const results = filters.map((filter) => evaluate(filter, input));
  return { pass: results.every((result) => result.pass), results };
}

function evaluate(filter: DecisionFilterConfig, input: FilterInput): FilterResult {
  switch (filter.type) {
    case 'always':
      return { type: 'always', pass: true, reason: 'always' };
    case 'geofence':
      return evaluateGeofence(filter.radiusM, input);
    default: {
      // Config read rejects unknown types; a direct caller slipping one past
      // both gets a loud fail, not a pass.
      const unknown = filter as { type?: unknown };
      return {
        type: 'unknown',
        pass: false,
        reason: 'config_error',
        detail: `unknown filter type ${JSON.stringify(unknown.type)}`,
      };
    }
  }
}

function evaluateGeofence(radiusM: number | undefined, input: FilterInput): FilterResult {
  const type = 'geofence' as const;
  if (input.home === null) {
    return {
      type,
      pass: false,
      reason: 'home_unset',
      detail: 'geofence needs the home location — run set-home-location <latitude> <longitude>',
    };
  }
  if (radiusM === undefined || !Number.isFinite(radiusM) || radiusM <= 0) {
    return {
      type,
      pass: false,
      reason: 'config_error',
      detail: `geofence radius must be a positive number of meters (got ${String(radiusM)})`,
    };
  }
  if (input.vehicleLocation === null) {
    return {
      type,
      pass: false,
      reason: 'location_unavailable',
      detail:
        'vehicle location unavailable — the decision-time read needs the ' +
        'vehicle_location ACCOUNT scope and an awake car',
    };
  }
  const distance = Math.round(distanceM(input.home, input.vehicleLocation));
  const pass = distance <= radiusM;
  return {
    type,
    pass,
    reason: pass ? 'geofence' : 'not_at_home',
    detail: pass
      ? `at home: ${distance} m of ${radiusM} m radius`
      : `${distance} m from home — outside the ${radiusM} m radius`,
    distanceM: distance,
  };
}
