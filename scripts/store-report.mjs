#!/usr/bin/env node
/**
 * Store report: latest row + aggregates per table. The diagnostic companion
 * to the daemon — `npm run store` after a collection run. Read-only, and it
 * never touches services or credentials.
 *
 *   node scripts/store-report.mjs            human-readable
 *   node scripts/store-report.mjs --json     machine-readable (jq-friendly)
 *   node scripts/store-report.mjs --db PATH  a specific store file
 *
 * Requires `npm run build` (imports dist/). Aggregate SQL lives here on
 * purpose: this is a diagnostic view, not production query surface.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dbFlag = args.indexOf('--db');
const dbPath = dbFlag !== -1 ? args[dbFlag + 1] : null;

let store;
try {
  const database = await import(pathToFileURL(path.join(repo, 'dist/store/database.js')).href);
  store = {
    path: dbPath ?? database.storePath(),
    openReadOnly: database.openStoreReadOnly,
    homeBattery: await import(pathToFileURL(path.join(repo, 'dist/store/HomeBatteryStore.js')).href),
    ev: await import(pathToFileURL(path.join(repo, 'dist/store/EvStore.js')).href),
    sessions: await import(pathToFileURL(path.join(repo, 'dist/store/SessionStore.js')).href),
    weather: await import(pathToFileURL(path.join(repo, 'dist/store/WeatherForecastStore.js')).href),
  };
} catch {
  console.error('Could not load dist/store — run `npm run build` first.');
  process.exit(1);
}

if (!fs.existsSync(store.path)) {
  console.error(`No store at ${store.path} — run \`node dist/index.js daemon\` first.`);
  process.exit(1);
}

const db = store.openReadOnly(store.path);
const one = (sql) => db.prepare(sql).get();
const all = (sql) => db.prepare(sql).all();
const iso = (ts) => (ts === null || ts === undefined ? null : new Date(Number(ts)).toISOString());
const round = (value, digits = 3) =>
  value === null || value === undefined ? null : Number(Number(value).toFixed(digits));

const batteryAgg = one(
  'SELECT COUNT(*) AS rows, MIN(ts_ms) AS firstTs, MAX(ts_ms) AS lastTs, AVG(soc_percent) AS avgSoc ' +
    'FROM home_battery_samples'
);
const countersAgg = one('SELECT COUNT(*) AS rows FROM home_energy_counters');
const evAgg = one('SELECT COUNT(*) AS rows FROM ev_samples');
// Latest EV row across all vehicles (a diagnostic view, not a repo method).
const evLatest =
  one(
    'SELECT id, vehicle_id AS vehicleId, ts_ms AS tsMs, state, charging_state AS chargingState, ' +
      'soc_percent AS socPercent, charge_energy_added_kwh AS chargeEnergyAddedKwh ' +
      'FROM ev_samples ORDER BY ts_ms DESC, id DESC LIMIT 1'
  ) ?? null;
const eventCounts = all('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY kind');
const latestEvents = all(
  'SELECT ts_ms, kind, from_state, to_state FROM events ORDER BY ts_ms DESC, id DESC LIMIT 5'
);
const sessionsAgg = one(
  'SELECT COUNT(*) AS total, ' +
    'SUM(CASE WHEN unplug_ts_ms IS NULL THEN 1 ELSE 0 END) AS open, ' +
    'AVG(energy_kwh) AS avgEnergyKwh, AVG(efficiency) AS avgEfficiency, AVG(elapsed_ms) AS avgElapsedMs ' +
    'FROM sessions'
);
const weatherAgg = one(
  'SELECT COUNT(*) AS rows, MAX(fetched_ts_ms) AS latestVintage FROM weather_forecasts'
);
const decisionsAgg = one('SELECT COUNT(*) AS rows FROM decisions');

const report = {
  store: store.path,
  home_battery_samples: {
    rows: Number(batteryAgg.rows),
    window: { from: iso(batteryAgg.firstTs), to: iso(batteryAgg.lastTs) },
    avgSocPercent: round(batteryAgg.avgSoc, 2),
    latest: store.homeBattery.latestSample(db),
  },
  home_energy_counters: { rows: Number(countersAgg.rows), latest: store.homeBattery.latestCounters(db) },
  ev_samples: { rows: Number(evAgg.rows), latest: evLatest },
  events: {
    byKind: Object.fromEntries(eventCounts.map((row) => [row.kind, Number(row.n)])),
    latest5: latestEvents.map((row) => ({ ...row, ts: iso(row.ts_ms) })),
  },
  sessions: {
    total: Number(sessionsAgg.total ?? 0),
    open: Number(sessionsAgg.open ?? 0),
    closed: Number(sessionsAgg.total ?? 0) - Number(sessionsAgg.open ?? 0),
    avgEnergyKwh: round(sessionsAgg.avgEnergyKwh),
    avgEfficiency: round(sessionsAgg.avgEfficiency),
    avgElapsedMs: round(sessionsAgg.avgElapsedMs, 0),
    latest: store.sessions.recentSessions(db, 1)[0] ?? null,
  },
  weather_forecasts: {
    rows: Number(weatherAgg.rows),
    latestVintage: iso(weatherAgg.latestVintage),
    hoursInLatestVintage:
      weatherAgg.latestVintage === null
        ? 0
        : Number(
            one(
              `SELECT COUNT(*) AS n FROM weather_forecasts WHERE fetched_ts_ms = ${Number(weatherAgg.latestVintage)}`
            ).n
          ),
  },
  decisions: { rows: Number(decisionsAgg.rows) },
};
db.close();

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const line = (label, value) => console.log(`  ${label}: ${value}`);
console.log(`store: ${report.store}`);
for (const [table, data] of Object.entries(report)) {
  if (table === 'store') continue;
  console.log(`\n${table}`);
  if (data.rows !== undefined) line('rows', data.rows);
  if (data.window) line('window', `${data.window.from ?? '—'} → ${data.window.to ?? '—'}`);
  if (data.avgSocPercent !== undefined) line('avg soc', data.avgSocPercent === null ? '—' : `${data.avgSocPercent}%`);
  if (data.byKind) line('by kind', Object.entries(data.byKind).map(([k, n]) => `${k}=${n}`).join(' ') || '(none)');
  if (data.latest5?.length) for (const event of data.latest5) line('event', `${event.ts} ${event.kind} ${event.from_state}→${event.to_state}`);
  if (data.total !== undefined) {
    line('sessions', `${data.total} total, ${data.open} open, ${data.closed} closed`);
    line('avg energy / efficiency / elapsed', `${data.avgEnergyKwh ?? '—'} kWh / ${data.avgEfficiency ?? '—'} / ${data.avgElapsedMs ?? '—'} ms`);
  }
  if (data.latestVintage !== undefined) line('latest vintage', `${data.latestVintage ?? '—'} (${data.hoursInLatestVintage} hours)`);
  if (data.latest) line('latest', JSON.stringify(data.latest));
}
