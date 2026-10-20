/**
 * Row contracts for the store — hand-maintained mirrors of the DDL in
 * migrations/001-initial-schema.ts (snake_case columns ↔ camelCase fields).
 * No ORM/codegen: any schema change updates the migration, these interfaces,
 * and the tests/store round-trips in the same commit.
 *
 * Nullable columns are `| null` because node:sqlite surfaces SQL NULL as
 * `null`. Insert inputs use optional fields (`?`) that map to NULL when
 * absent — never undefined-in, NULL-out ambiguity.
 */

/**
 * The site enum. Storage enforces the same set via CHECK (site_id = 'home');
 * Phase 3 widens both together.
 */
export type SiteId = 'home';

/** The only site today; the default in every repository signature. */
export const HOME_SITE: SiteId = 'home';

/** Detected EV/session transitions; mirrored by the events.kind CHECK. */
export type EventKind =
  | 'plug_in'
  | 'unplug'
  | 'charging_start'
  | 'charging_stop'
  | 'daemon_start'
  | 'daemon_stop';

export interface HomeBatterySampleRow {
  id: number;
  siteId: SiteId;
  homeBatteryId: string;
  tsMs: number;
  socPercent: number | null;
  socKwh: number | null;
  powerW: number | null;
  homeLoadW: number | null;
  solarW: number | null;
  gridW: number | null;
}

export interface NewHomeBatterySample {
  homeBatteryId: string;
  tsMs: number;
  socPercent?: number | null;
  socKwh?: number | null;
  powerW?: number | null;
  homeLoadW?: number | null;
  solarW?: number | null;
  gridW?: number | null;
}

export interface HomeEnergyCountersRow {
  id: number;
  siteId: SiteId;
  homeBatteryId: string;
  tsMs: number;
  batteryChargeKwh: number | null;
  batteryDischargeKwh: number | null;
  gridImportKwh: number | null;
  gridExportKwh: number | null;
  solarKwh: number | null;
  homeUseKwh: number | null;
}

export interface NewHomeEnergyCounters {
  homeBatteryId: string;
  tsMs: number;
  batteryChargeKwh?: number | null;
  batteryDischargeKwh?: number | null;
  gridImportKwh?: number | null;
  gridExportKwh?: number | null;
  solarKwh?: number | null;
  homeUseKwh?: number | null;
}

export interface EvSampleRow {
  id: number;
  siteId: SiteId;
  vehicleId: string;
  tsMs: number;
  state: string | null;
  chargingState: string | null;
  socPercent: number | null;
  chargeLimitSoc: number | null;
  chargeRateKw: number | null;
  minutesToFull: number | null;
  chargeEnergyAddedKwh: number | null;
  /** 1/0/NULL; NULL until the P1b geofence evaluates it. Raw GPS is never stored. */
  atHome: number | null;
}

export interface NewEvSample {
  vehicleId: string;
  tsMs: number;
  state?: string | null;
  chargingState?: string | null;
  socPercent?: number | null;
  chargeLimitSoc?: number | null;
  chargeRateKw?: number | null;
  minutesToFull?: number | null;
  chargeEnergyAddedKwh?: number | null;
  atHome?: number | null;
}

export interface EventRow {
  id: number;
  siteId: SiteId;
  vehicleId: string;
  tsMs: number;
  kind: EventKind;
  fromState: string | null;
  toState: string | null;
}

export interface NewEvent {
  vehicleId: string;
  tsMs: number;
  kind: EventKind;
  fromState?: string | null;
  toState?: string | null;
}

export interface SessionRow {
  id: number;
  siteId: SiteId;
  vehicleId: string;
  homeBatteryId: string;
  plugTsMs: number;
  unplugTsMs: number | null;
  /** Closing aggregates — all NULL while the session is open (P1a). */
  energyKwh: number | null;
  energyPercent: number | null;
  elapsedMs: number | null;
  houseEnergyKwh: number | null;
  efficiency: number | null;
}

export interface NewOpenSession {
  vehicleId: string;
  homeBatteryId: string;
  plugTsMs: number;
}

export interface WeatherForecastRow {
  id: number;
  siteId: SiteId;
  /** The fetch this row belongs to (a vintage); consumers take the newest. */
  fetchedTsMs: number;
  hourTsMs: number;
  irradianceWm2: number | null;
  temperatureC: number | null;
  rawJson: string | null;
}

export interface NewWeatherForecast {
  hourTsMs: number;
  irradianceWm2?: number | null;
  temperatureC?: number | null;
  rawJson?: string | null;
}
