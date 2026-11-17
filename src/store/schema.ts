/**
 * The store's expected schema — one manifest behind two guards:
 *
 * - the runtime guard (`database.ts`): after migrations run (or a version
 *   check passes), every table and column here must actually exist. `PRAGMA
 *   user_version` can lie — two branches shipping the same migration number
 *   leave a store stamped "current" with an older schema — so trust the
 *   schema, never the stamp.
 * - the three-way drift pin (`tests/store/schema-pin.test.ts`): DDL ↔ row
 *   interfaces (`types.ts`) ↔ aliased repository SELECTs.
 *
 * A schema change must touch, in one commit: the migration, the row
 * interface, the repository aliases, and this list.
 */
export interface ExpectedTable {
  table: string;
  /** Creation-order columns. */
  columns: readonly string[];
  /**
   * The explicitly declared NOT NULL set. Note on `id`: a rowid alias is
   * implicitly non-NULL, but SQLite reports its `notnull` flag as 0 unless
   * NOT NULL is written literally — `id`'s non-nullness is pinned by the pin
   * test's pk assertion instead.
   */
  notNull: readonly string[];
}

export const EXPECTED_SCHEMA: readonly ExpectedTable[] = [
  {
    table: 'home_battery_samples',
    columns: [
      'id', 'site_id', 'home_battery_id', 'ts_ms', 'soc_percent', 'soc_kwh',
      'power_w', 'home_load_w', 'solar_w', 'grid_w',
    ],
    notNull: ['site_id', 'home_battery_id', 'ts_ms'],
  },
  {
    table: 'home_energy_counters',
    columns: [
      'id', 'site_id', 'home_battery_id', 'ts_ms', 'battery_charge_kwh',
      'battery_discharge_kwh', 'grid_import_kwh', 'grid_export_kwh',
      'solar_kwh', 'home_use_kwh',
    ],
    notNull: ['site_id', 'home_battery_id', 'ts_ms'],
  },
  {
    table: 'ev_samples',
    columns: [
      'id', 'site_id', 'vehicle_id', 'ts_ms', 'state', 'charging_state',
      'soc_percent', 'charge_limit_soc', 'charge_rate_kw', 'minutes_to_full',
      'charge_energy_added_kwh', 'at_home',
    ],
    notNull: ['site_id', 'vehicle_id', 'ts_ms'],
  },
  {
    table: 'events',
    columns: ['id', 'site_id', 'vehicle_id', 'ts_ms', 'kind', 'from_state', 'to_state'],
    notNull: ['site_id', 'vehicle_id', 'ts_ms', 'kind'],
  },
  {
    table: 'sessions',
    columns: [
      'id', 'site_id', 'vehicle_id', 'home_battery_id', 'plug_ts_ms',
      'unplug_ts_ms', 'energy_kwh', 'energy_percent', 'elapsed_ms',
      'house_energy_kwh', 'efficiency', 'target_percent', 'stop_reason',
      'initial_target_percent', 'target_change_reason',
      'user_charge_limit_percent', 'released_ts_ms',
    ],
    notNull: ['site_id', 'vehicle_id', 'home_battery_id', 'plug_ts_ms'],
  },
  {
    table: 'session_owners',
    columns: ['id', 'site_id', 'session_id', 'owner', 'from_ts_ms'],
    notNull: ['site_id', 'session_id', 'owner', 'from_ts_ms'],
  },
  {
    table: 'weather_forecasts',
    columns: [
      'id', 'site_id', 'fetched_ts_ms', 'hour_ts_ms', 'irradiance_wm2',
      'temperature_c', 'raw_json',
    ],
    notNull: ['site_id', 'fetched_ts_ms', 'hour_ts_ms'],
  },
  {
    table: 'decisions',
    columns: [
      'id', 'site_id', 'vehicle_id', 'home_battery_id', 'ts_ms', 'session_id',
      'accepted', 'dry_run', 'reason_code', 'reason_detail',
      'filter_results_json', 'limited_by',
    ],
    notNull: [
      'site_id', 'vehicle_id', 'ts_ms', 'accepted', 'dry_run', 'reason_code',
    ],
  },
];