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
    time: await import(pathToFileURL(path.join(repo, 'dist/utils/time.js')).href),
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

/**
 * Timestamp-shaped keys (*tsMs / *TsMs) → ISO strings under a key without the
 * `Ms` suffix, so `npm run store` reads as time not epoch. Duration-shaped
 * fields (elapsedMs, avgElapsedMs) do not match the pattern and stay numbers.
 */
const humanize = (row) => {
  if (row === null || row === undefined || typeof row !== 'object') return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) =>
      /[tT]sMs$/.test(key) && typeof value === 'number'
        ? [key.replace(/Ms$/, ''), iso(value)]
        : [key, value]
    )
  );
};

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
// Latest decisions with their outcomes — the "why didn't it charge?" view.
const decisionsRecent = all(
  'SELECT session_id AS sessionId, ts_ms AS tsMs, accepted, dry_run AS dryRun, ' +
    'reason_code AS reasonCode, reason_detail AS reasonDetail, ' +
    'filter_results_json AS filterResultsJson, limited_by AS limitedBy ' +
    'FROM decisions ORDER BY ts_ms DESC, id DESC LIMIT 5'
);

const report = {
  store: store.path,
  home_battery_samples: {
    rows: Number(batteryAgg.rows),
    window: { from: iso(batteryAgg.firstTs), to: iso(batteryAgg.lastTs) },
    avgSocPercent: round(batteryAgg.avgSoc, 2),
    latest: humanize(store.homeBattery.latestSample(db)),
  },
  home_energy_counters: {
    rows: Number(countersAgg.rows),
    latest: humanize(store.homeBattery.latestCounters(db)),
  },
  ev_samples: { rows: Number(evAgg.rows), latest: humanize(evLatest) },
  events: {
    byKind: Object.fromEntries(eventCounts.map((row) => [row.kind, Number(row.n)])),
    latest5: latestEvents.map((row) => ({
      ts: iso(row.ts_ms),
      kind: row.kind,
      from: row.from_state,
      to: row.to_state,
    })),
  },
  sessions: {
    total: Number(sessionsAgg.total ?? 0),
    open: Number(sessionsAgg.open ?? 0),
    closed: Number(sessionsAgg.total ?? 0) - Number(sessionsAgg.open ?? 0),
    avgEnergyKwh: round(sessionsAgg.avgEnergyKwh),
    avgEfficiency: round(sessionsAgg.avgEfficiency),
    avgElapsedMs: round(sessionsAgg.avgElapsedMs, 0),
    latest: humanize(store.sessions.recentSessions(db, 1)[0] ?? null),
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
  decisions: {
    rows: Number(decisionsAgg.rows),
    recent5: decisionsRecent.map((row) => ({
      ts: iso(row.tsMs),
      sessionId: row.sessionId,
      accepted: row.accepted === 1,
      dryRun: row.dryRun === 1,
      reason: row.reasonCode,
      detail: row.reasonDetail,
      limitedBy: row.limitedBy,
      filters: row.filterResultsJson,
    })),
  },
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
  if (data.latest5?.length) for (const event of data.latest5) line('event', `${event.ts} ${event.kind} ${event.from}→${event.to}`);
  if (data.recent5?.length) {
    // Decision lines are local wall-clock (machine mode keeps ISO); each row
    // shows why, and the per-filter audit rides along.
    for (const decision of data.recent5) {
      line(
        'decision',
        `${store.time.formatLocalTimestamp(Date.parse(decision.ts))} session ${decision.sessionId} ` +
          `accepted=${decision.accepted ? 1 : 0} dry=${decision.dryRun ? 1 : 0} ${decision.reason}`
      );
      if (decision.detail) console.log(`      ${decision.detail}`);
      if (decision.filters) console.log(`      filters: ${decision.filters}`);
    }
  }
  if (data.total !== undefined) {
    line('sessions', `${data.total} total, ${data.open} open, ${data.closed} closed`);
    line('avg energy / efficiency / elapsed', `${data.avgEnergyKwh ?? '—'} kWh / ${data.avgEfficiency ?? '—'} / ${data.avgElapsedMs ?? '—'} ms`);
  }
  if (data.latestVintage !== undefined) line('latest vintage', `${data.latestVintage ?? '—'} (${data.hoursInLatestVintage} hours)`);
  if (data.latest) line('latest', JSON.stringify(data.latest));
}
