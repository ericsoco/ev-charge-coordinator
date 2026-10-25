# EV Charge Coordinator — Workplan (living)

> **Current context and forward decisions.** Created 2026-10-18 after Phases 0–5 landed on
> `main` (`6891126`). The full Phase 0–5 execution record was archived to
> [workplan-history.md](./workplan-history.md) — **historical, backup context only**; read
> this file first and consult history only when deeper context is needed. Product
> requirements live in [requirements.md](./requirements.md); the user's backlog lives in
> [TODO.md](./TODO.md) (keep it there — do not mirror backlog items into this file).
> The Phase 1 design (long-running daemon, auto-start event filters, storage, hosting)
> lives in [design.md](./design.md) (approved 2026-10-18).

## Current state (verified 2026-10-18)

- **Phases 0–5 complete and landed on `main`;** GitHub Actions CI green on Node 24 + 26.
  Gate for every change: `npm run check` (build + lint + typecheck + unit tests; 349 passed /
  2 skipped at last run).
- **Shipped surface:** `start` / `exit` lifecycle, `get-battery-soc`, `get-ev-bsoc`,
  `set-ev-charge-limit`, `start-ev-charging`, `stop-ev-charging`, `charge-from-battery`,
  `get-charging-state`, `config --set-buffer`, `--daemon`, interactive REPL with masked
  credential prompts. Start-charging consent is explicit flags only (`--start` / `--dry-run`
  / `--stop`); `charge-from-battery` prints its consent prompt for approval.
- **Architecture:** FranklinWH via per-session/one-shot token-guarded Flask proxy
  (`python/franklin_proxy.py`); Tesla signed commands via managed `tesla-http-proxy` sidecar
  (TLS :4443, per-spawn token in `~/.ev-charge-coordinator/runtime.json`); OAuth tokens in
  keychain with AES-256-GCM encrypted-file fallback.
- **Live-verified:** both SoC reads; signed limit/start/stop against a real Model Y;
  `charge-from-battery` consent flow and kWh-derived limit (math in `src/utils/energy.ts`);
  asleep-car `get-charging-state` returns a useful 408 wake-gap message; unplugged
  `start-ev-charging` fails loudly.

## Decisions on future work

- **Deferred by explicit decision (2026-10-17):** `CONTRIBUTING.md`, issue/PR templates,
  `CHANGELOG.md` — revisit before any outreach to external contributors.
- **Out of scope by decision (Phase 6 list):** Web GUI, multi-EV / multi-gateway fan-out,
  scheduled charging windows + solar-aware rate timing, Fleet Telemetry WebSocket instead of
  polling, `npx` publishing. (The keytar replacement formerly listed here was done 2026-10-18:
  `@napi-rs/keyring`, see Log.)
- **Battery-buffer product evolution** (`requirements.md` Oct 10 / Oct 14 entries:
  trigger on charger-plug-in event, sub-50% target handling with polling stop) is open
  product work — record design decisions here when it is picked up.
- **P1b Tesla resilience pointer (noted 2026-10-21, from P1a step 6):** the Franklin
  self-heal (`FranklinWHService.reconnect()`, wired into the battery tick) has **no Tesla
  analog in P1a** — EV polling is direct Fleet API HTTPS over OAuth (access-token refresh
  is automatic; un-refreshable auth is a degrade-and-surface case for the human to
  `authenticate`, not a retry loop). When the daemon starts issuing signed commands in
  P1b, the `tesla-http-proxy` sidecar enters its path: give the command executor an
  alive-check/respawn before each command (`ProcessManager`), which is simpler than
  Franklin's reconnect — the sidecar is a stateless signer (app key on disk), so there is
  no re-auth session to restore.

## P1b — auto-start decision engine (active execution plan)

> Status: **Step 1 — decision config complete (2026-10-24); next: Step 2 — pure filters.**
> Standing rules: one step at a time; **branch per step** (`p1b/stepN-<name>`), gate green
> (`npm run check`) + its own commit; stop for review after each step; the user lands each
> step to `main`. Design rationale: [design.md](./design.md) §3.9 + the decisions below.
> After each step: update the status line here, append a dated Log entry.

**Goal:** plug-in decisions the daemon records and — once enabled — acts on: evaluate the
configured filter chain, compute the charge limit, write a `decisions` audit row, then,
gated by `autoStart.enabled`, set the limit and start charging. Notifiers + docs last.

**Confirmed decisions (2026-10-24, user):**
- **Geofence = decision-time fetch (Option B):** on plug-in, after the cheap local filters
  pass, one read-only `getVehicleLocation()` (`endpoints=location_data`, never wakes) →
  haversine vs the `vehicle_location` secret → outside radius / secret missing / location
  read fails ⇒ **decline loudly** (deny-by-default; recorded in the decision row's
  `filter_results_json`). Sampling never depends on location — a scope lapse degrades only
  decisions, never the collect path. `ev_samples.at_home` stays NULL; the audit history is
  the `decisions` rows themselves.
- **Merge dark:** `autoStart.enabled` defaults **false** — the engine runs and records
  decisions from real plug-ins but actuates nothing until the operator flips the flag in
  `daemon-config.json`. `--dry-run` (step 5) forces non-actuation even when enabled.
- **Actuation** sets the computed charge limit first, then starts charging — same semantics
  as `charge-from-battery` (shared pure math, extracted not duplicated).

### Steps

1. **Decision config** — `autoStart` block in `daemon-config.json`: `enabled` (default
   `false`), `filters[]` (`always`, `geofence` + `radiusM`), fail-loud validation (unknown
   type, missing/non-positive radius, non-boolean `enabled`); defaults and template stay in
   lockstep. *(branch `p1b/step1-decision-config` — complete)*
2. **Pure filters** — `src/decision/filters.ts`: `(input) => {pass, reason}`; `always` +
   `geofence` (location injected by the caller — this step stays fetch-free); unit matrix.
   *(branch `p1b/step2-decision-filters`)*
3. **Decision engine + store** — pure engine (interlock order: enabled → plugged →
   not-already-charging → battery-above-buffer → filters → compute limit → outcome);
   `DecisionStore` writer (migration adds the `decisions` row mapper/reason codes;
   `filter_results_json`, `dry_run`, session-id idempotency); the intentionally-unpinned
   `decisions` schema-pin arrives. *(branch `p1b/step3-decision-engine`)*
4. **Wiring** — decision consumer hooked at `plug_in` in `EvPoller` (narrow injectable
   seam): decision-time location fetch (Option B), engine run, decision row; tests with
   fakes (plug-in → row; location failure → decline reason).
   *(branch `p1b/step4-decision-wiring`)*
5. **Actuation** — shared charge-limit math extracted from `charge-from-battery`;
   `tesla-http-proxy` alive-check/respawn before commands (Decisions pointer above);
   `setChargeLimit` → `startCharging` gated on `enabled`; `daemon --dry-run`; dry/disabled
   ⇒ zero command calls; interlock-matrix tests. *(branch `p1b/step5-actuation`)*
6. **Notifiers** — `Notifier` interface + `log-only`/`ntfy`/Slack; typed events (decision,
   start/stop, interlock decline, service failures); secrets in credential store;
   failure-isolation tests. *(branch `p1b/step6-notifiers`)*
7. **Surfaces + docs** — store-report decisions section, `status` shows auto-start mode,
   README auto-start section, workplan. *(branch `p1b/step7-docs-surfaces`)*
8. **Live validation** (user + car) — disabled-run decision rows → flip `enabled` → real
   auto-start; buffer interlock; park-away geofence decline; optional ntfy.

### Scope

**In:** `autoStart` config; decision engine + `decisions` audit rows; filters (`always`,
`geofence`); battery-buffer interlock; charge-limit computation + gated start; notifiers;
status/report surfaces.
**Out:** weather-adaptive charging, scheduled windows, multi-EV, telemetry, Modbus, GUI —
Phase 6+.

## P1a — collect-only daemon (complete)

> Status: **Complete — steps 1–7 landed; daemon installed on launchd and in validated
> long-run operation (Log 2026-10-24 entries).** Historical detail below; the active plan
> is P1b above. Design rationale: [design.md](./design.md) §3/§5.

**Goal:** long-running `evcc daemon` on this Mac that only observes and records — home-battery
samples, poll-while-awake EV samples, plug-in/session events, daily weather forecasts — into a
new SQLite store. No decision engine, no actuation, no notifications.

### Steps

1. **Store layer** — migrations + database open/migrate + repositories + tests (detail below).
2. **daemon config + lockfile + scheduler** + tests (defaults, validation failures, stale-lock
   recovery, per-tick error isolation).
3. **Tesla state probe + `chargeEnergyAdded` + event detector** + tests (transition matrix:
   `Disconnected→*` = plug_in, `*→Disconnected` = unplug, `Charging→Complete` = stop;
   408-as-asleep probe handling).
4. **Samplers + `runDaemon`** + tests with fake Franklin/Tesla services (rows land; counter
   deltas; weather skip without the secret). Includes the Open-Meteo response-shape spike
   (finalizes the provisional weather columns) and live confirmation of the Franklin day-total
   counter reset semantics.
5. **CLI + REPL wiring** — `daemon`, `status`, `sessions`, `set-home-location` + tests (drift
   guard, output snapshots).
6. **launchd assets + README daemon section + workplan log** — plist template,
   install/uninstall scripts; **user performs the install** (guide below).
7. **Validation** (checklist below) — stop for review before landing to main.

### Scope

**In:** `daemon` command (foreground; `--once` = single cycle); SQLite store + versioned
migrations; samplers (battery 120 s default; EV status probe 60 s + `vehicle_data` 60 s plugged
/ 300 s awake-idle / none asleep; weather daily, 48–72 h rolling); event/session recording;
read-only `status` + `sessions` commands; `set-home-location` one-shot; launchd assets + docs.
**Out:** decision engine, filters/geofence enforcement, notifications, auto-start, efficiency
computation (inputs stored only), telemetry, Modbus, any CLI writes to the store.

**Decisions:**
- Built-in `node:sqlite` driver (verified on Node v24.14.0: WAL persists, `{readOnly:true}`
  blocks writes; zero new deps; `ExperimentalWarning` tolerated or suppressed via launchd arg;
  CI Node 24/26 matrix is the compatibility gate; fallback `better-sqlite3` behind `src/store/`
  if CI breaks).
- `daemon.json` (ops tunables, documented defaults, validate-on-read fail-loud) separate from
  energy `config.json` (strict `EnergyConfig`, no defaults).
- Home location is a secret: `credentials.ts` gains `getHomeLocation`/`setHomeLocation`, set via
  one-shot `set-home-location` — never written to `config.json`.
- Event detection (poll state machine + pure transition reducer) built once here with a
  record-only consumer; P1b adds the decision consumer.
- Weather sampler included; degrades with a notice until the home-location secret exists.
- Single-writer: only the daemon writes the store; CLI opens read-only (WAL).
- launchd: document only — the user installs + bootstraps (guide at the end of this section).

### Storage design (schema v1)

One file `<config-dir>/data.sqlite` (SQLite, WAL). The daemon is the only writer; CLI opens
read-only. Conventions, every table:
- `id INTEGER PRIMARY KEY` (rowid surrogate key) and `site_id TEXT NOT NULL CHECK (site_id='home')`
  on every table — the CHECK is the storage-level `SiteId` enum (`'home'`); Phase 3 widens it via
  a migration together with the shared TS type.
- Timestamps: `INTEGER` epoch-ms UTC (64-bit — no practical limit; displayed in local time only).
- Booleans: `INTEGER` 1/0. Unit suffixes everywhere: `_percent`, `_kwh`, `_w`, `_kw`, `_ms`,
  `_wm2`, `_c`.
- Cross-table references (`session_id`) are logical, not FOREIGN KEY-enforced — application-level
  integrity (a session row is always written before its decisions/aggregates). Explicit
  trade-off, not an oversight.

The data tells one story in three layers: **raw time series** (`home_battery_samples`,
`home_energy_counters`, `ev_samples` — what things *were*, sampled on timers) → **structured
history** (`events`, `sessions` — what *happened*) → **analysis inputs** (`weather_forecasts`,
`decisions` — what we learned / decided). Example flow: the sampler writes a battery row every
~2 min; when the EV poller sees `charging_state` change Disconnected→Stopped, it writes an
`events` row (`kind='plug_in'`) and opens a `sessions` row; on unplug the session closes and the
closing aggregates (Δ kWh, elapsed, house energy, efficiency) are computed onto the session row.

**1. `home_battery_samples`** — Franklin instantaneous readings (~2-min tick).
`home_battery_id TEXT NOT NULL` (Franklin Gateway ID/SN from stored credentials) · `ts_ms` ·
`soc_percent REAL` · `soc_kwh REAL` (gateway-reported available energy; NULL when absent) ·
`power_w REAL` (+charge/−discharge) · `home_load_w REAL` · `solar_w REAL` · `grid_w REAL`.
Index `(site_id, ts_ms)`.

**2. `home_energy_counters`** — gateway **day-so-far** cumulative counters (reset at local
midnight — confirm live in step 4), same tick and transaction as table 1; split out because
they are a different measurement class (cumulative vs instantaneous). Used for session energy =
last − first counter row.
`home_battery_id TEXT NOT NULL` · `ts_ms` · `battery_charge_kwh` · `battery_discharge_kwh` ·
`grid_import_kwh` · `grid_export_kwh` · `solar_kwh` · `home_use_kwh` (all REAL). Index `(site_id, ts_ms)`.

**3. `ev_samples`** — Tesla readings while awake.
`vehicle_id TEXT NOT NULL` (VIN) · `ts_ms` · `state TEXT` (online/…) · `charging_state TEXT`
(Disconnected/Stopped/Charging/Complete/NoPower) · `soc_percent REAL` · `charge_limit_soc INTEGER` ·
`charge_rate_kw REAL` · `minutes_to_full INTEGER` · `charge_energy_added_kwh REAL` ·
`at_home INTEGER` (NULL in P1a; P1b geofence writes 1/0 — raw coordinates never stored).
Index `(site_id, ts_ms)`. No EV `soc_kwh`: Tesla does not report absolute pack energy; a stored
derived value would go stale if the config pack size is later corrected — computed at analysis
time instead.

**4. `events`** — detected transitions, append-only.
`vehicle_id TEXT NOT NULL` · `ts_ms` · `kind TEXT NOT NULL CHECK IN ('plug_in','unplug',
'charging_start','charging_stop','daemon_start','daemon_stop')` · `from_state TEXT` ·
`to_state TEXT` (NULL for daemon_*). Index `(site_id, ts_ms)`.

**5. `sessions`** — one EV plug-in visit + closing aggregates (all aggregate columns NULL while
open, computed at close).
`vehicle_id TEXT NOT NULL` · `home_battery_id TEXT NOT NULL` · `plug_ts_ms INTEGER NOT NULL` ·
`unplug_ts_ms INTEGER` (NULL = open) · `energy_kwh REAL` (Δ charge_energy_added) ·
`energy_percent REAL` (Δ soc_percent) · `elapsed_ms INTEGER` (stored for query convenience
despite being derivable) · `house_energy_kwh REAL` (Δ battery_discharge_kwh) ·
`efficiency REAL` (energy_kwh / house_energy_kwh, in (0,1]). Index `(site_id, plug_ts_ms)`.
At most one open session per vehicle is enforced by daemon logic, not schema.
(Distinct `efficiency_observations` table **dropped** — strictly 1:1 with sessions, same writer,
same moment; per user decision 2026-10-19.)

**6. `weather_forecasts`** — append-only forecast vintages (never delete-on-refresh; historical
vintages give actual-vs-forecast error data later).
`fetched_ts_ms INTEGER NOT NULL` (vintage) · `hour_ts_ms INTEGER NOT NULL` · `irradiance_wm2
REAL` · `temperature_c REAL` · `raw_json TEXT` (full API payload per hour — nothing lost if the
API shape shifts). Index `(site_id, hour_ts_ms, fetched_ts_ms)`. Consumers take the newest
vintage per hour. Retention: prune vintages >90 d.
**Provisional columns** — finalized in step 4 against the live Open-Meteo response.

**7. `decisions`** — auto-start audit; created now, first written by P1b.
`vehicle_id TEXT NOT NULL` · `home_battery_id TEXT` (nullable so a metadata gap never blocks
recording; in practice always set — the above-buffer interlock requires a readable battery) ·
`ts_ms` · `session_id INTEGER` (logical ref) · `accepted INTEGER NOT NULL` (1 acted) ·
`dry_run INTEGER NOT NULL` · `reason_code TEXT NOT NULL CHECK IN ('started','dry_run',
'below_buffer','already_charging','not_plugged_in','duplicate_session','compute_error',
'service_error')` (top-level outcome; per-filter results live in `filter_results_json`; the
CHECK list grows by migration when P1b needs outcomes) · `reason_detail TEXT` (nullable
free-text sentence) · `filter_results_json TEXT` · `limited_by TEXT` (from `EnergyLimitedBy`).

### Migration encoding

- **Schema = SQL DDL owned by versioned migrations**, one file per version, integer versions
  (a linear chain — semver's patch/minor/major meanings do not apply to DDL):

  ```
  src/store/migrations/001-initial-schema.ts   → exports { version: 1, up(db) { … } }
  src/store/migrations/002-…future….ts
  src/store/migrations/index.ts                → explicit ordered import list → MIGRATIONS[]
  ```

- `up(db)` bodies are plain SQL strings run via `db.exec()` inside `BEGIN IMMEDIATE`/`COMMIT`;
  `migrate(db)` applies missing versions in order against `PRAGMA user_version` and **fails
  loudly** if the file's version is newer than the binary's.
- **Application representation** (no ORM, no codegen): TS row interfaces per table
  (hand-maintained mirrors of the DDL, nullable columns typed `| null`) + repository functions
  with inline parameterized SQL. Drift risk is carried by round-trip tests that must change in
  the same commit as any migration.

### Module layout

```
src/store/migrations/001-initial-schema.ts   src/store/migrations/index.ts
src/store/database.ts          openStore / openStoreReadOnly / migrate; storePath()
src/store/types.ts             SiteId + row interfaces
src/store/HomeBatteryStore.ts  EvStore.ts  SessionStore.ts  WeatherForecastStore.ts
tests/store/*.test.ts
```

Changed in later steps (not step 1): `index.ts` (+4 thin actions: `daemon`, `status`,
`sessions`, `set-home-location`), `repl.ts` (`status`/`sessions` registered;
`daemon`/`set-home-location` in the one-shot whitelist — the repl-commands drift guard drives
the wiring), `TeslaService.ts` (non-waking `getVehicleState()` probe + `chargeEnergyAdded` in
`getStatus()`), `credentials.ts` (home location), README.
**Reuse:** `initializeFranklin`/`initializeTesla` (index.ts:254/326), `keepResident` (:81),
`startTeslaProxy`, `writeRuntimeState`, Franklin `attachOrStartProxy`/`isProxyHealthy`, the
non-waking `getStatus()` read (`vehicle_data?endpoints=charge_state`).

### Current step detail: 1 — Store layer (complete 2026-10-19, commit `e0bf1e9`)

Branch `feat/p1a-collect-daemon`; one commit; gate `npm run check`.

1. `src/store/migrations/001-initial-schema.ts` — the v1 DDL above (7 tables + `(site_id, …)`
   indexes); `migrations/index.ts` with the explicit import list; `migrate()` with the
   newer-store guard in `database.ts`.
2. `src/store/database.ts` — `storePath()` → `<config-dir>/data.sqlite` via `getConfigDir()`
   (honors `ECC_CONFIG_DIR`); `openStore()`: mkdir 0700 → open → `PRAGMA journal_mode=WAL`,
   `synchronous=NORMAL`, `busy_timeout=5000` → `migrate()`; `openStoreReadOnly()`
   (`{readOnly:true}`, no migration).
3. `src/store/types.ts` — `type SiteId = 'home'` + row interfaces (nullable columns `| null`).
4. Repositories — plain functions taking `db` first, typed rows in/out, inline parameterized
   SQL:
   - `HomeBatteryStore`: `insertSample`, `insertCounters` (caller wraps both in one
     transaction), `latestSample`, `latestCounters`, `prune(retentionDays, nowMs)` (both tables)
   - `EvStore`: `insertSample`, `latestSample(vehicleId)`
   - `SessionStore`: `insertEvent`, `openSession`, `closeOpenSession(vehicleId, unplugTsMs)`
     (returns closed id or null), `openSessionFor(vehicleId)`, `recentSessions(limit)`
   - `WeatherForecastStore`: `insertForecast(rows)` (append-only), `latestVintage(siteId)`
5. Tests (`tests/store/`, `ECC_CONFIG_DIR` tmp dirs per the `tests/utils/config.test.ts`
   pattern): `database.test.ts` (file created; WAL active; user_version=1; re-open idempotent +
   data persists; hand-set user_version=999 → open throws); `home-battery-store.test.ts`
   (sample/counter round-trip, ts ordering, prune cutoff boundary); `ev-store.test.ts`;
   `session-store.test.ts` (open/close lifecycle; close with none open → null; bad `kind`
   rejected by CHECK; recent ordering); `weather-forecast-store.test.ts` (append keeps old
   vintages; `latestVintage` returns newest); read-only test (second connection reads while a
   writer is open; `readOnly` write attempt throws).
6. Contingency: if `@types/node` 22.19 lacks the `node:sqlite` module declaration, run
   `npm i -D @types/node@^22` (lockfile-only bump within the existing range). Do an early
   typecheck after a stub import.

**Out of step 1:** anything reachable from CLI/daemon; retention scheduling (step 4); decisions
repository (P1b); session aggregate computation (steps 3–4 write/extend session rows).

### launchd install (user performs; guide for steps 6/7)

**Why a LaunchAgent, not a LaunchDaemon:** agents run inside the login session — **required for
login-keychain access** (`@napi-rs/keyring`); a LaunchDaemon runs as root at boot with no
keychain session and would fall back to encrypted-file credentials.
**Paths on this Mac:** node `/Users/ericsoco/.nvm/versions/node/v24.14.0/bin/node` · repo
`/Users/ericsoco/Documents/lab/code/ev-charge-coordinator` · config `~/.ev-charge-coordinator`
· uid 501.

**Plist** → `~/Library/LaunchAgents/com.transmote.ev-charge-coordinator.daemon.plist`
(rendered from the `scripts/evcc-daemon.plist` template by `scripts/install-daemon.sh`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.transmote.ev-charge-coordinator.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/ericsoco/.nvm/versions/node/v24.14.0/bin/node</string>
    <string>/Users/ericsoco/Documents/lab/code/ev-charge-coordinator/dist/index.js</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/ericsoco/Documents/lab/code/ev-charge-coordinator</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/Users/ericsoco/.ev-charge-coordinator/logs/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/ericsoco/.ev-charge-coordinator/logs/daemon.err.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key>
    <string>/Users/ericsoco/.nvm/versions/node/v24.14.0/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

**Install** (`scripts/install-daemon.sh` automates 1–4; `--dry-run` renders and prints without
touching anything):
1. `npm run build` (dist must be current)
2. `mkdir -p ~/.ev-charge-coordinator/logs`
3. Write the plist → `plutil -lint <plist>`
4. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.transmote.ev-charge-coordinator.daemon.plist`
5. Verify:
  `launchctl print gui/$(id -u)/com.transmote.ev-charge-coordinator.daemon | grep -E'state|pid'`
  `tail -f ~/.ev-charge-coordinator/logs/daemon.log`
  `node dist/index.js status`
6. **First-run keychain prompt:** macOS may ask to allow `node` to access the
   `ev-charge-coordinator` keychain item — "Always Allow" once.

**Operate:** stop `launchctl bootout gui/$(id -u)/com.transmote.ev-charge-coordinator.daemon` ·
restart in place `launchctl kickstart -k gui/$(id -u)/com.transmote.ev-charge-coordinator.daemon`
· uninstall = bootout + `rm` the plist (`scripts/uninstall-daemon.sh`) · auto-loads at
login via `RunAtLoad` (`launchctl enable` if ever disabled).

**Caveats (documented, nothing automated):**
- **nvm pinning — the one real gotcha:** the plist embeds the version-specific node path.
  `nvm install <new>` doesn't move it, but a later `nvm use` changes your shell's node while the
  daemon keeps the pinned one. After a node upgrade, re-run the install script (re-resolves
  `command -v node`) or point the plist at a stable shim symlink. Goes in the README too.
- **Sleep:** launchd suspends the agent while the Mac sleeps; a plug-in during sleep is caught
  by the first poll after wake (the car is awake then). `pmset -g` to inspect; a repeat wake
  schedule on charging nights is the user's call — not automated.
- **Logs:** launchd doesn't rotate; the daemon logs sparsely — truncate with `: > <logfile>`.
- **`exit` interplay:** `node dist/index.js exit` stops the Franklin proxy the daemon owns; the
  next battery tick re-attaches (respawning it if needed) and re-authenticates via
  `FranklinWHService.reconnect()` — implemented in step 6 as this guide promised.

### Validation checklist (step 7)

`npm run check` green (baseline 349 passed / 2 skipped + new) · `node dist/index.js --help`
lists the new commands · `daemon --once` real cycle (asleep car → probe path, no 408 error) ·
sample counts grow via `sqlite3 <config-dir>/data.sqlite 'select count(*) from
home_battery_samples'` · `status` shows alive + last-sample ages · a second `daemon` invocation
refuses the lock · optional `RUN_LIVE_TESTS=1` live cycle test · user installs launchd per the
guide above.

### Risks

`node:sqlite` experimental vs Node 26 CI (fallback noted) · Mac sleep misses events (documented,
not automated) · `exit` stops the daemon-owned proxy → health-check restarts it · Tesla
status-probe billing negligible after the $10/mo individual credit.





## Log

<!-- Append dated entries below after each Act response, per AGENTS.md. -->

### 2026-10-18 — keytar replaced with `@napi-rs/keyring`

Branch `deps/keytar-to-napi-keyring-v2` (resolves TODO.md item 26; re-run of
`deps/keytar-to-napi-keyring`, which predates the workplan archive and is superseded
by this branch):

- `credentials.ts`: `getKeytar()` → `getKeyChain()`, a small adapter over
  `@napi-rs/keyring`'s `Entry` (`get`/`set`/`delete`), leaving `save()`/`load()`/
  `clearAll()` and all stored formats untouched. Linux pinned to
  `{ linux: { store: 'secret-service' } }` so an unavailable Secret Service throws
  → file fallback, instead of the binding's silent fallback to the kernel keyring,
  which does not persist across reboots. `ECC_DISABLE_KEYCHAIN` semantics unchanged
  (tests still force the file path).
- CI: dropped the `libsecret-1-dev` install step — it existed only because keytar
  compiled from source on Node 24/26 ABIs; the prebuilt platform binaries need no
  headers, and tests never touch the keychain.
- Docs: README Security section + structure tree, AGENTS.md utils line, TODO.md item
  26 ticked, Phase 6 out-of-scope bullet above refreshed.
- Gate: `npm run check` green — **340 passed / 2 skipped** (baseline unchanged).
  Live macOS smoke test against the real keychain: seeded entry → store resolved
  `storageBackend === 'keychain'`, wrote without creating `credentials.enc`,
  round-tripped through a fresh store, `clearAll()` deleted the entry, and the
  real pre-existing keychain value was backed up and restored afterwards.
- Migration: same `ev-charge-coordinator`/`credentials` service+account as keytar
  used on macOS, so existing login-keychain entries read transparently; on other
  platforms a miss falls through to the encrypted file (or a one-time re-auth if
  neither store has data).

### 2026-10-18 — `config --clear-all` renamed to `--clear-credentials`

Branch `rename/clear-all-to-clear-credentials` (TODO.md item 25, user-maintained
file left untouched):

- `index.ts`: Commander option, `ConfigOptions` field, and handler condition
  renamed (`clearAll` → `clearCredentials`); the success message still reads
  "✓ All credentials cleared".
- `repl.ts`: `BOOLEAN_FLAGS.config` updated, so the REPL parses the new flag
  (camelCasing is generic) and Commander's `--help` shows it. The retired
  `--clear-all` now errors with `unknown option` — deliberate hard rename, no
  back-compat alias (personal CLI, per TODO wording "Rename").
- `repl-commands.test.ts`: parse case added for `--clear-credentials`, plus a
  pin rejecting `--clear-all` so the rename cannot silently regress.
- README: usage example + CLI reference table row.
- Gate: `npm run check` green. `node dist/index.js config --help` verified to
  show the new flag. The flag itself was not executed live (it would delete
  real stored credentials).

### 2026-10-18 — REPL tab completion for command flags

Branch `feat/repl-flag-completion` (TODO.md item 26, user-maintained file left
untouched):

- `repl.ts`: `completeCommand` now tokenizes the line up to the cursor and
  completes in three modes — command names (old behavior preserved), a typed
  command's flags (`config --se` → `--set-`; after a trailing space, all of
  them), and value slots (`--tesla-region` offers `na eu cn` sourced from
  `TESLA_REGIONS`; other value flags offer nothing). `help` completes topic
  names. Commander's shell-completion feature was rejected: it targets
  bash/zsh via `COMP_LINE`, not an in-process readline.
- **Contract verified, not assumed:** readline calls the completer with the
  line up to the cursor and treats the tuple's second element as the suffix
  ending at the cursor (Node 24 `kTabComplete`/`kTabCompleter` source read via
  `--expose-internals`). Hits are full tokens; common-prefix insertion and the
  double-Tab listing were confirmed live with a scripted readline smoke
  (`config --se` + TAB → `config --set-`, TAB again lists the four `--set-*`).
- **Bug fixed en route:** `VALUE_FLAGS.config` was missing `set-buffer`, so
  the REPL rejected `config --set-buffer 20` while the one-shot CLI accepted
  it. Tables are now exported for tests.
- `repl-commands.test.ts`: 8 new completer cases, a `--set-buffer` parse case,
  and a drift guard that extracts every Commander `.option('--flag')` from
  `index.ts` and asserts set equality with the flag tables — closing the sync
  gap that let `set-buffer` drift. `start` and `authenticate` are whitelisted
  as one-shot-only-flagged (not parsed by the REPL dispatch); the guard fails
  if that whitelist rots or either gains REPL flag tables.
- README: tab-completion note under Interactive Mode Commands.
- Gate: `npm run check` green — **349 passed / 2 skipped**.

### 2026-10-18 — Phase 1 design recorded (daemon, auto-start, storage, hosting)

Branch `docs/phase1-design`: design discussed and approved in plan mode; full
write-up in [design.md](./design.md) — the forward reference for Phase 1 work:

- **Scope:** keep the CLI UX; add (1) plug-in event detection → auto-start
  charging and (2) stored history (battery depletion, charging efficiency,
  weather forecasts) feeding smarter charge-limit math. Phase 2 = mobile UX,
  single user; Phase 3 = multi-user cloud. Phase-2/3 seams are listed in
  design.md §7 (HTTP wrapper over the engine, repos → Postgres, env/KMS
  secrets, telemetry event source, per-home Modbus collector).
- **Decisions:** poll-while-awake Fleet API polling (plugging in wakes the car,
  so detection is near-instant with zero wake cost from us; Fleet Telemetry
  deferred behind a `VehicleEventSource` seam — it forces cloud hosting:
  public domain + publicly-trusted TLS terminating directly on Tesla's
  server); home-hosted on this Mac (launchd; OrangePi/systemd later);
  SQLite behind repository interfaces with `site_id`/`vehicle_id` on every
  table; auto-start via a general event-filter framework (`always`, optional
  `geofence`; empty filter list = all plug-ins; every filter result audited);
  home coordinates stored as a credential-store secret with only `at_home`
  persisted (privacy); pluggable `Notifier` with ntfy + Slack clients;
  `--dry-run` + decision audit table replace a notify-only stage.
- **Research:** Tesla offers no webhooks (telemetry is the only push);
  `franklinwh` lib is realtime-only, but the Franklin cloud API has history
  endpoints (`get_electric_data`, `get_power_by_day`, …) — backfill spike
  planned; `franklinwh-local-api` (Modbus TCP :502) kept as the long-term
  per-home collector option for the cloud phase.
- **Build order:** P1a collect-only daemon + storage → P1b filters + decision
  engine + notifiers + dry-run/live auto-start → P1c measured efficiency +
  weather-aware limits + sub-50% stop-at-target monitor; three small spikes
  alongside (design.md §5). No code changed yet — docs only on this branch.

### 2026-10-19 — P1a plan recorded, then lifted to the active section

Branch `plan/p1a-workplan`. Plan approved in plan mode and recorded here; same day, per user
direction, it was **lifted to the "P1a — collect-only daemon (active execution plan)" section
above** — the work spans multiple days, so the checklist lives above the dated log. The storage
schema + migration design were then clarified with user feedback (per-version migration files;
`home_battery_samples` + `home_energy_counters` split; session-closing aggregates with
efficiency folded in; enumerated `decisions.reason_code`; append-only weather vintages).
Implementation: not started — step 1 (Store layer) awaits the user's go.

### 2026-10-19 — P1a step 1 complete: store layer

Branch `feat/p1a-collect-daemon`, commit `e0bf1e9` (14 files, +1636): migration
`001-initial-schema.ts` (all 7 tables + indexes + CHECK enums), `migrations/index.ts`
(explicit chain), `database.ts` (`openStore` WAL/busy-timeout/migrate with newer-store guard
and close-on-failure; `openStoreReadOnly` never migrates), `types.ts` (`SiteId` + row
interfaces), repositories `HomeBatteryStore` / `EvStore` / `SessionStore` /
`WeatherForecastStore`, and 6 test files in `tests/store/` (37 tests: round-trips, ordering,
retention cutoff, migration idempotency, version-999 refusal, CHECK probes, WAL
cross-connection read, readOnly write-block, no-migration guarantee).

- **No dependency changes:** `@types/node` 22.19 ships `node:sqlite` types incl. `readOnly`
  — the workplan contingency (types bump) was not needed.
- **Small deviations, disclosed:** (1) `EvStore.prune` added — retention covers both raw
  tables, the checklist had pruned only the battery side; (2) no events *reader* yet
  (`mapEvent` dropped) — no read API was in the step-1 contract, P1a consumers read events
  when they exist; (3) `.all()` rows cast through `unknown` (node:sqlite returns
  `Record<string, SQLOutputValue>[]`, insufficient overlap for direct casts).
- **Gate:** `npm run check` green — **386 passed / 2 skipped** (baseline 349 + 37 new).
  `ExperimentalWarning: SQLite` observed at test startup, exactly as recorded in Risks.
- Step 1 touches no CLI surface: `node dist/index.js --help` unchanged (step 5 adds commands).

### 2026-10-19 — P1a step-1 addendum: row-mapper refactor + schema-pin test

Branch `feat/p1a-collect-daemon`, two commits after review of the DDL↔interface duplication:

- `67312b7` — **aliased SELECTs** (`site_id AS siteId`, …): driver output now *is* the
  `types.ts` row shape, so the per-store `Raw*` snake_case mirror interfaces and every
  per-row `map*` function are gone (4 files, +92/−163). One interface per table remains,
  plus the DDL — the duplication the user flagged (interfaces differing only by key case)
  is removed. `Number()` coercions dropped (epoch-ms and ids are inside the JS safe range,
  verified).
- `99a66d8` — **`tests/store/schema-pin.test.ts`** (4 tests): three-way drift guard —
  (1) `PRAGMA table_info` pinned to literal column order + explicit NOT NULL sets + `id`
  pk; (2) every DDL column camel-converts to a row-interface key (fixtures are *typed* as
  the interfaces, so tsc rejects fixture drift); (3) repository reads return exactly the
  interface key set (catches missing/misspelled/extra aliases); (4) `decisions` is the only
  intentionally unpinned table (row interface arrives with P1b — the test fails when that
  stops being true).
- **SQLite quirk, learned and pinned:** `INTEGER PRIMARY KEY` (rowid alias) is implicitly
  non-NULL, yet `table_info` reports `notnull = 0` unless `NOT NULL` is written literally —
  the pin's first run caught exactly this; `id` is pinned via the pk assertion instead,
  documented at the `TABLES` literal. No DDL change (`id INTEGER PRIMARY KEY` is the
  idiomatic form).
- Gate: `npm run check` green — **390 passed / 2 skipped** (baseline 386 + 4 pin tests).

### 2026-10-20 — P1a step 2 complete: daemon config, lockfile, scheduler

Branch `feat/p1a-daemon-runtime` (cut from `main` after the user landed step 1), three commits:

- `2cddd03` **deps: toad-scheduler@4.2.0** (transitive croner@10). Verification *before*
  coding, per the user's halt-condition instruction: licenses MIT/MIT ✓; Node 24 runtime
  smoke PASS (cadence, `runImmediately`, `AsyncTask` error callback, `executeAsync`,
  `stop`, overlap on an 80 ms task / 50 ms interval) ✓; **runtime-dependency check MISSED
  the zero-dep expectation** (toad 4.x depends on croner — and 3.x does too) → halted and
  prompted with options; **user chose to keep toad + croner** (2-package closure, both MIT,
  croner being the already-vetted runner-up and useful later for local-time cron).
- `c06edbd` **feat:** `src/utils/daemonConfig.ts` — `daemon.json` with documented defaults
  (field renamed to **`evSamplePluggedSec`** at the user's request after review: fast
  `vehicle_data` cadence while `charging_state !== 'Disconnected'`, which is broader than
  "while charging" — the plug-in event usually arrives as Disconnected→Stopped);
  validate-on-read, any invalid field ⇒ `config: null` + per-field problems (file optional,
  absent ⇒ defaults). `src/daemon/lockfile.ts` — O_EXCL acquire, liveness via `kill(pid,0)`
  (EPERM = alive), automatic stale-pid recovery (launchd KeepAlive self-heals), corrupt
  lock ⇒ loud refusal (never stolen), release deletes only our own pid. `src/daemon/scheduler.ts`
  — thin toad adapter: immediate-first cadence, `preventOverrun`, per-tick `onError`
  isolation (sync throw and rejection), drain-on-stop (toad's `stop()` doesn't drain — the
  adapter tracks in-flight ticks), `runOnce()` for `daemon --once`. 27 tests (12 config /
  8 lock / 7 scheduler).
- **Test-writing findings, disclosed:** (1) a missing `config[field] = value` assignment —
  caught immediately by the override test; (2) `preventOverrun` belongs in toad's
  JobOptions third arg — typecheck caught it (runtime had worked only because toad
  *defaults* it to true); (3) the fake-timer overlap test hung on `stop()` — diagnosed in
  toad's source (plain `setInterval` + `isExecuting` guard, nothing fake-timer-hostile):
  a test artifact, fixed by stop-then-advance-then-await; **verification #4 (fake timers)
  passes** — all 27 green.
- `0679e32` **docs:** README `### Data Storage & Schema` (versioned SQL migrations, current-
  schema-only runtime, three-way schema pin — closes the step-1 documentation gap the user
  flagged), project-structure tree += `daemon/`, `store/`, `daemonConfig.ts`, Checks pointer
  to the pin; AGENTS.md Key Files += `src/store/` bullet (user-approved).
- Gate: `npm run check` green — **417 passed / 2 skipped** (baseline 390 + 27 new).
- Next: Step 3 — Tesla state probe + `chargeEnergyAdded` + event detector.

### 2026-10-20 — P1a step 3 complete: vehicle probe, chargeEnergyAdded, event detector

Branch `feat/p1a-tesla-probe-events` (precondition verified: step 2 landed on `main` as
`9eded09`…`2bf2c0e`), commit `843266f` (6 files, +341):

- **`getVehicleState()`** — non-waking probe via `GET /api/1/vehicles/{vin}` on
  `TeslaService` **and the `EVService` interface** (new `EVVehicleState` type); resolves the
  VIN through the list endpoint first when unset. By design it cannot 408 (it never waits
  on the car); the remaining probe-vs-sleep race on `vehicle_data` is covered by
  pre-existing 408 mapping tests (verified: three cases in
  `tests/services/tesla-error-reporting.test.ts` — no new test needed).
- **`chargeEnergyAdded`** — `TeslaChargeState.charge_energy_added` → optional
  `EVBatteryStats.chargeEnergyAdded` in `getStatus()`. The store columns/types/aliases have
  been waiting since step 1, so the value is storage-ready for step 4's sampler. No CLI
  output change (`get-charging-state` untouched).
- **`src/daemon/eventDetector.ts`** — pure, total transition reducer. Plugged ≡
  `state !== 'Disconnected'` (state-agnostic: future firmware values classify correctly
  for free); documented ordering rules `plug_in → charging_start` (entry first) and
  `charging_stop → unplug` (exit last — charging cannot outlive the cable); unreadable
  input yields `[]` rather than throwing — deliberately unlike energy.ts, because a
  mid-tick daemon crash is worse than an unobserved transition and the caller keeps the
  raw samples.
- **18 tests:** 14 transition-matrix (ordering pairs, unknown states both directions,
  no-baseline, same-state, plugged reshuffles, a never-throws sweep) + 4 probe tests on the
  axios-adapter seam (singular endpoint only — recorded URLs prove no `wake_up`/`vehicle_data`;
  VIN-unset list-then-singular fallback; `charge_energy_added` passthrough + absent case).
- Gate: `npm run check` green — **435 passed / 2 skipped** (baseline 417 + 18). One fixture
  type caught by typecheck (`InternalAxiosRequestConfig` for the adapter seam) and fixed.
- The user's in-progress `TODO.md` edit rode along uncommitted on the working tree —
  deliberately not staged (human-maintained file).
- Next: Step 4 — samplers + `runDaemon` (incl. the Open-Meteo response-shape spike and
  live confirmation of the Franklin day-total counter reset).

### 2026-10-21 — P1a step 4 complete: samplers, runDaemon, `daemon` CLI, store report

Branch `feat/p1a-samplers-daemon` (precondition verified: step 3 landed on `main`), six
commits:

- `4cdd090` foundation: `withTransaction`, `finalizeSession`, `samplesInRange` /
  `countersInRange`, `get/setHomeLocation` (secret, validated) + 11 tests. (Typecheck caught
  the range queries still using the pre-refactor `Raw*`/`map*` pattern — fixed to the aliased
  cast form.)
- `c7dd738` pure layer: `sessionAggregates.monotonicDelta` (positive-step sum — midnight
  counter resets and Tesla meter resets drop out as discontinuities, which is what makes
  Franklin's reset semantics non-critical) + `computeSessionAggregates` + the
  `shouldSampleRich` cadence predicate. (One test-side boundary bug — inclusive `>=` — fixed
  and the commit amended; also disclosed: an earlier `npm run check | grep` pipe masked a
  failure and let a red commit through before the amend. Gate discipline since: full exit
  codes, no pipes.)
- `c3a042f` samplers: `BatterySampler` (sample + counters in one transaction),
  `EvPoller` (adaptive single task: cheap probe → cadence-gated rich read → store →
  detector → events + session open/close **with closing aggregates**; restart-safe state
  reconstruction from the store; stale-open-session self-heal on the next plug_in —
  documented limitation: unplug-through-sleep is bounded-approximate), `WeatherSampler`
  (injectable fetcher, one-time skip notice without the home-location secret). 12 tests.
- `eca528c` `runDaemon` (lock → store → tasks → scheduler; owns and disconnects the handed-in
  services; `daemon_start`/`daemon_stop` lifecycle events; disabled-task warnings) +
  `runDaemonOnce` (per-task results, ok = no errors) + `startDaemon().stop()` handle (CLI
  wires SIGINT/SIGTERM — lifecycle testable without process signals) + the thin **`daemon`
  CLI command with `--once`** (moved forward from step 5 — without it the step could not be
  verified live) + one-shot REPL whitelist entry (drift-guard forced) + 6 tests.
- `8362db9` **`scripts/store-report.mjs`** (`npm run store`; `--json`, `--db`): latest row +
  aggregates per table, exit-1 on a missing store; aggregate SQL deliberately lives in the
  script (diagnostic view, not production surface); 3 tests including a spawned-script run
  against a seeded store. (One test-helper bug — unconditional JSON.parse — fixed.)
- `e6cc62d` **live-spike finding: the franklinwh wire format is kW, not W** (a 0.267 "home
  load" is 236× too small in watts) — `BatterySampler` now converts ×1000 into the `_w`
  columns; totals confirmed kWh as named; `types/battery.ts` notes the wire format. Spike
  deferred earlier (terminal/keychain incidents) completed via the live `--once` runs instead.

- **Spikes resolved:** Open-Meteo live shape confirmed (`hourly.{time, shortwave_radiation,
  temperature_2m}`, `timezone=UTC`) — the step-1 weather columns fit as provisioned, **no
  migration needed**. Franklin counter-reset semantics rendered non-critical by
  `monotonicDelta`; units answered live (above).
- **Live verification (both runs exit 0, all tasks ✓):** `node dist/index.js daemon --once`
  twice against real services (proxy spawn, Tesla token refresh); `npm run store` shows real
  data: 2 battery samples (gateway `10060005A03X25160189`, soc ~21.6%, post-fix
  `powerW -771 / homeLoadW 271 / solarW 1041`), 2 counter snapshots, `daemon_start/stop`
  events; `ev_samples: 0` = car asleep (probe-only — correct poll-while-awake behavior);
  `weather: 0` = home-location secret not set until step 5's `set-home-location`.
- Gate: `npm run check` green at every commit — **479 passed / 2 skipped** (baseline 458 + 21
  across the step's commits). Terminal incidents (omz update prompt eating commands; one
  garbled heredoc) were worked around; one hidden-process keychain hang from the early spike
  never recurred in the CLI path.
- Step scope calls (approved in the plan): `daemon` command pulled from step 5; session-close
  aggregates computed at unplug (collect-only inputs for P1c); README CLI-reference row for
  `daemon` deferred to step 5/6 with the other CLI docs.
- Next: Step 5 — `status`, `sessions`, `set-home-location` CLI (+ REPL wiring) — and
  `set-home-location` is what finally turns the weather sampler on.

### 2026-10-21 — P1a step-4 addendum: Open-Meteo fetch retries

Branch `feat/p1a-samplers-daemon` (still unlanded; addendum appended), two commits:

- **User-driven scope:** `monotonicDelta` stays as-is (per-step accumulation accepted after
  the precision review: error bounded by n×ulp ≪ the 0.001 kWh input quantization, and
  empirically exact at 1e6 steps); only the Open-Meteo resiliency request proceeds.
- `c31ab68` **deps: axios-retry@4.5.0** (+ `is-retry-allowed@2.2.0`, MIT, zero transitive).
  Pre-commit verification deviated from expectations — **disclosed and user-approved before
  coding**: Apache-2.0 (expected MIT) and one tiny runtime dep (expected zero); closure is 2
  permissive-license packages, axios 1.x peer-compatible.
- **`WeatherSampler`:** `createOpenMeteoClient()` factory — retries: 3 (daily task, not
  aggressive), `exponentialDelay` backoff (≈1s/2s/4s + jitter), network/timeout/5xx-only
  condition (never 4xx — bad requests fail fast), **10 s per-attempt timeout**
  (`shouldResetTimeout`) — closing a real gap: axios's default is *no* timeout, so a hung
  connection would never fail and would hold `stop()`'s drain open. `fetchOpenMeteo` takes an
  injectable client (house DI pattern).
- **4 tests** (adapter seam, real timers, zero-delay backoff): 5xx×2 then success (3 calls),
  network errors retried, persistent 5xx rejects after configured attempts, 400 → exactly 1
  call. Skipped timesteps remain safe by design: append-only forecast vintages + null-tolerant
  hour rows + a failed day simply yields to tomorrow's fetch.
- Gate: `npm run check` green — **483 passed / 2 skipped** (baseline 479 + 4).
- Next: Step 5 — `status`, `sessions`, `set-home-location` CLI (unchanged).

### 2026-10-21 — P1a step 5 complete: status/sessions/set-home-location CLI + REPL

Branch `feat/p1a-store-cli` (precondition verified: step 4 + addendum on `main`), three
commits:

- `49f16a1` **feat** (14 files, +1192):
  - **Scope change (prerequisite, disclosed):** `vehicle_location` added to `TESLA_SCOPES` —
    existing installs must re-run `authenticate` (scopes are minted at authorization).
    The oauth scope-exactness test updated; a pin now guards the new scope. This retires
    design.md's P1b spike #3 early.
  - **`EVService.getVehicleLocation()`** — `vehicle_data?endpoints=drive_state`; missing
    location fields throw with re-auth guidance; read never wakes (the command decides).
  - **`showStatus` moved `vehicle.ts` → `commands/system.ts`** (never vehicle-specific) and
    extended: daemon lock state (running/stale/stopped/unreadable), store path/schema/size/
    counts/last-sample ages, Franklin proxy health probe (runtime.json pid + localhost
    /health, 1s), Tesla command proxy TCP probe (:4443), effective daemon config, home
    location set/not-set (coordinates never printed), `--json` output. Hard no-side-effects
    rule: no service init, no spawns, no writes. One-shot service lines now probe-based
    instead of the misleading "(not connected)".
  - **`sessions [--limit <n>] [--open]`** — newest-first lines with energy/house/efficiency
    + aggregates footer (new `SessionStore.sessionStats` / `openSessions`).
  - **`set-home-location [<lat> <lng>]`** — flag-free two-mode API (user's Option 1): no
    args = vehicle flow (wake → read → confirm `Vehicle reports … Current … Set?`), args =
    manual; **every write confirms with current → new**; REPL command too (`authenticate`
    precedent), positional args flow raw past `parseCommandArgs`; drift-guard satisfied with
    no tables/whitelist (no options).
  - REPL wiring: `status --json`, `sessions` (+flag tables, completer follows), 20 new tests.
    Fixes en route: `nowMs` invoked-not-assigned bug (typecheck), 5 test-expectation updates
    (requireService pin 8→9, completer now offers status flags, config-in-vitest-env null
    buffer, formatAge day form, closeOpenSession newest-plug ordering), one label fix
    (`daemon defaults:` when no daemon.json exists — live-checked).
- `46a3155` **docs:** README CLI Reference rows (daemon, status, sessions, set-home-location),
  Interactive Mode entries, and the scope step + re-auth note.
- **Live verification (read-only):** `node dist/index.js status` renders all five sections
  against the real store (schema v1, 60 KB, 2 battery rows, 4 events, effective config);
  `sessions` shows the friendly empty message; `status --json` parses. **Deliberately not run
  live:** `set-home-location` (writes the real secret + needs the re-auth first — user
  performs both).
- Gate: `npm run check` green — **503 passed / 2 skipped** (baseline 483 + 20).
- Next: Step 6 — launchd assets (`scripts/evcc-daemon.plist`, install/uninstall scripts) +
  README daemon section; **user installs and bootstraps** (guide above this log).

### 2026-10-21 — P1a step 6 complete: launchd assets, README daemon section, franklin self-heal

Branch `feat/p1a-launchd` (precondition verified: step 5 + review fix had landed on `main` as
`35f4c13`/`2592a41`). Four commits:
- `b1e7a66` **carry-over:** the staged `.agents/skills/github-pr-reply/SKILL.md` one-liner
  (step 1 runs gh as shell commands), committed first as its own commit per user request.
- `eed0176` **feat — launchd assets + self-heal:**
  - `scripts/evcc-daemon.plist` — template: **`com.transmote.ev-charge-coordinator.daemon`**
    Label first, `ProgramArguments` = pinned node → `dist/index.js` → `daemon`,
    `RunAtLoad` + `KeepAlive`, logs under the config dir, PATH seeded with the node bin dir;
    four placeholders (`__NODE_BIN__`, `__NODE_BIN_DIR__`, `__REPO_DIR__`, `__CONFIG_DIR__`).
  - `scripts/install-daemon.sh` / `scripts/uninstall-daemon.sh` — `set -euo pipefail`,
    `--dry-run` renders + prints every action without writing or calling launchctl; the label
    is derived from the template (single source of truth, drift-proofed by test); install
    idempotency via bootout-then-bootstrap. Exec bits set.
  - **Franklin proxy self-heal (disclosed scope addition):** the guide's `exit`-interplay
    caveat was design intent, not code — `FranklinWHService` now retains credentials **in
    memory only** (keychain stays the sole at-rest store) and exposes `reconnect()`
    (attach/respawn — `startProxy()` mints the fresh X-Proxy-Token — then re-auth via the
    extracted `authenticateWithProxy`). `BatterySampler` catches a failed read → `reconnect()`
    → one retry; a second failure propagates to the scheduler's isolation. `disconnect()`
    clears the in-memory credentials.
  - Tests: 3 battery (retry-succeeds / retry-still-fails / reconnect-fails), 3 franklin
    `reconnect` (never-initialized refusal, double `/auth` with remembered creds, cleared on
    disconnect), 7 launchd (template contract, dry-run renders with zero placeholder residue
    and no writes under a throwaway `HOME`, plutil lint darwin-gated, `bash -n` both scripts).
  - Decisions: namespace `com.transmote.*` for future reverse-DNS identifiers (transmote.com);
    keychain service name, config dir, package `author` deliberately unchanged.
    **LaunchAgent (gui domain), not LaunchDaemon** — login-keychain access + user-visible
    control while developing; on a server the question dissolves (systemd/containers,
    env-injected secrets per design.md Phase 3).
- **docs — README:** new `## Collect Daemon` section (what it collects, foreground + `--once`,
  install/uninstall, verify/operate commands, first-run keychain + `vehicle_location` re-auth
  notes, caveats incl. self-heal) + project-tree `scripts/` line.
- **docs — workplan (this entry):** status flip + the install guide above retargeted to
  `com.transmote` and truthful `exit`-interplay wording.
- Gate: `npm run check` green — **515 passed / 2 skipped** (baseline 503 + 12); both scripts
  `bash -n` clean; both `--dry-run` invocations exit 0 on this Mac.
- **User performs (step 7):** `scripts/install-daemon.sh` (or `--dry-run` first) → verify →
  re-auth for `vehicle_location` + `set-home-location` if not yet done → optional live
  self-heal check (`exit` in one terminal; battery rows resume within ~2 min).
- Next: Step 7 — validation checklist (below) + landing review.

### 2026-10-21 — REPL flag parity: `authenticate --force` fix + full flag audit

User report: `authenticate -force` in the REPL hit the "Already signed in" path and
printed the one-shot hint — the REPL dispatched `authenticate` with NO option parsing
(an old drift-guard whitelist exempted it), so the flag was silently dropped and the
command ran unforced; the one-shot CLI also rejects a single-dash `-force`, so neither
path worked as typed. Branch `fix/repl-authenticate-flags`:
- `src/commands/repl.ts`: `VALUE_FLAGS.authenticate = ['client-id', 'client-secret']`,
  `BOOLEAN_FLAGS.authenticate = ['force', 'help']` — all three one-shot flags were
  missing, not just `--force`; `parseCommandArgs` classifies single-dash tokens as
  `unknown option` (was `unknown argument`) to match Commander's rejection of `-force`.
- `src/index.ts`: the `authenticate` dispatch case parses flags, routes `--help`
  through `printCommandHelp`, and forwards `{clientId, clientSecret, force}` to the
  same `runAuthenticate` the one-shot uses.
- Tests (+3): drift-guard whitelist shrunk to `['start', 'daemon']` (neither has a
  REPL dispatch case, by design; anti-rot assertion updated); parse-parity test incl.
  `-force` rejection; two wiring pins — EVERY tabled command must be routed through
  `parseCommandArgs` + `printCommandHelp` in the dispatch (closes the "table exists
  but the dispatch never consults it" hole that caused this bug), and authenticate
  flags must reach `runAuthenticate`.
- Audit: everything else already at parity — config (10/10), pair-tesla-key (4/4),
  charge-from-battery (2), status (--json), sessions (--limit/--open); positional
  flows wired (`set-home-location` raw, `set-ev-charge-limit <percent>`); one-shot-only
  `start`/`daemon` flags are correct exemptions. Residual benign difference: single-dash
  unknown-flag error wording differs in phrasing between Commander and the REPL; both
  reject.
- Gate: `npm run check` green — **518 passed / 2 skipped** (baseline 515 + 3).
- Committed alongside (user request): their README setup-guide edit tightening the
  `vehicle_location` scope note.
- Session note: the mode was switched to plan mid-task; the fix had been applied via
  shell writers after the `editor` tool disappeared, and the guard blocked only the
  commit. Nothing landed until act mode was re-confirmed.
- Next: Step 7 — validation checklist + landing review.

### 2026-10-23 — authenticate: dead-app auto-detection + credential-selection rules

Follow-up to the parity fix: `authenticate --force` re-ran OAuth with the STORED
(old) client ID — deliberate ("reuse so a re-auth need not re-paste the secret"),
but a recreated Tesla application makes that pair dead, and the failure only
surfaced in the browser. Branch `feat/tesla-auth-probe`, gate green **533 passed /
2 skipped** (baseline 518 + 15):
- `8f7d166` **probe wire format** (`services/tesla/oauth.ts`): the token endpoint
  distinguishes `invalid_client` (app credentials not accepted) from
  `invalid_grant` (credentials fine, grant bad) — so a refresh_token grant with a
  deliberately dummy token probes client-ID liveness WITHOUT touching the real,
  single-use refresh token (test-pinned). `probeClientCredentials` (injected post,
  `ECC_TESLA_TOKEN_URL`-honoring; network trouble = `unknown`, never blocks) +
  `classifyTokenEndpointError` for thrown errors. 5 tests.
- `c271283` **selection rules** (`commands/authenticate.ts`, wired into
  `runAuthenticate`): flags win and are never paired with a stored counterpart
  (closes `--client-id X` silently reusing the OLD stored secret); stored
  credentials are reused only after an explicit `Re-use the stored app credentials
  (client ID …)? (y/n)` — `n` prompts for new ones; a probe-confirmed dead stored
  pair skips the reuse question, says why, prompts for new, and re-probes (dead
  twice → clear failure before any browser round trip); probe `unknown` never
  blocks. 10 tests incl. wiring pins.
- `TeslaService.refreshTokens` classifies its token-endpoint failure:
  invalid_client → "no longer recognizes this application … run `authenticate
  --force` and enter the new client credentials"; invalid_grant → "refresh token
  rejected … re-run `authenticate`". The daemon cannot self-heal this (human +
  new secret required) but now fails loudly with the right cause.
- Live validation for the user: run `authenticate --force` — with the old, dead
  stored ID it should print "Tesla does not recognize the stored client ID/secret"
  and prompt for the new pair; then `pair-tesla-key` for the recreated app's
  virtual key. Environment note for future sessions: this terminal garbles
  heredocs and stalls on double-quoted `!` (interactive bang history) — shell
  edits must avoid both; the `editor` tool works in act mode.
- **Ground truth (user-run live curls, both sides):** dead client → HTTP 400
  `{"error":"client_not_found","error_description":"The specified client was not
  found."}`; live client + dummy refresh → HTTP 401
  `{"error":"login_required","error_description":"The refresh_token is invalid"}`.
  Tesla deviates from RFC 6749's `invalid_client`/`invalid_grant` naming, which is
  why v1 of the probe classified `unknown` — the reuse question appeared and `y`
  reused the dead ID (the observed bug). `classifyTokenErrorCode` now keys on the
  observed codes with the RFC values as belts; both payloads are pinned verbatim
  in tests (`cbcea84`). Lesson recorded: curl the endpoint before coding its
  error contract.
- **Rename (user): `--force` → `--reauth`** — Commander option, REPL flag table
  (drift-guard mirror), `runAuthenticate` internals, the "Re-authorize anyway"
  hint, the consent-status and `refreshTokens` advice strings, and the parse/wiring
  tests. No alias kept; single-dash `-reauth` rejects like the one-shot.
- Next: Step 7 — validation checklist + landing review.

### 2026-10-24 — pairing UX: 422 transparency, changed-credentials guidance, --rotate-key

User hit it live after recreating the app: `pair-tesla-key --domain transmote.com`
verified the hosted key (steps 1-2 — key pair correctly reused) then failed at
registration with a bare "Request failed with status code 422" (Tesla's body
dropped) plus a confusing "not registered in this region" cascade. Branch
`feat/tesla-auth-probe`, gate green **541 passed / 2 skipped** (baseline 533 + 8):
- `14c3d33` **error fidelity + flow:** `describeAxiosHttpError` extracted into
  `services/tesla/oauth.ts` (TeslaService's private copy aliased over to it —
  same funnel, no duplication); `describeTeslaError` gains a 422 branch with
  Allowed-Origin advice (the live cause class after an app recreation);
  `registerDomainWithTesla` names the failing phase (partner-token mint vs
  partner_accounts POST vs confirm); `runPairTeslaKey` now honors the failure
  instead of cascading into the pairing section.
- `f84a3bf` **changed-credentials guidance:** `selectAppCredentials` returns
  `source: stored | entered | flags`; a successful sign-in with entered
  credentials prints that the key pair is unchanged/reusable (not tied to the
  client ID) plus the exact `pair-tesla-key --domain <stored>` next step.
- `d29e0b3` **`--rotate-key`:** `VirtualKeyStore.discard()` +
  `VirtualKeyService.rotateKeyPair()`; the CLI warns every paired vehicle must
  re-approve; REPL table + completer + drift guard updated (the completer's
  exact-list pin caught the new flag — the guard working as designed). Process
  note: the first commit attempt went out red and was immediately amended green —
  future gate chains must refuse to commit on non-zero, not just echo it.
- README: "Recreated your Tesla application?" checklist (reauth → Allowed
  Origins → pair-tesla-key → approve → check-only), HTTP 422 troubleshooting
  row, updated CLI/interactive rows for both commands.
- Live validation for the user: set Allowed Origins on the new app, re-run
  `pair-tesla-key --domain transmote.com` — any remaining 422 now prints
  Tesla's own error body plus the advice.
- Next: Step 7 — validation checklist + landing review.

**Resolved live (user, same evening):** with the fidelity fix in place the 422
read `Validation failed: Public key hash has already been taken` — Tesla enforces
global uniqueness of the public-key hash, and the old app's registration already
claimed it (registrations are per-application, so the recreated app inherits
nothing but also cannot re-claim the same hash). `pair-tesla-key --rotate-key`
then ran end-to-end: new key published → `✓ Registered transmote.com` → consent
confirmed → pairing link with VIN → **`get-ev-bsoc` answered 16%** (signed
command path verified against the re-paired vehicle). This corrected the earlier
guidance: after an app recreation, rotation is the COMMON case, not the
exception. Follow-up commit `a838def` (gate 541/2): hash-taken advice added to
`describeTeslaError`'s known map with a **case-insensitive** match (Tesla's
sentence starts with a capital `P` — the first attempt missed it, caught by the
new test before commit), an explicit "re-run WITHOUT --rotate-key" hint after
rotation (double-rotation footgun), corrected `runAuthenticate` key-pair wording
("usually reusable … if hash-taken, rotate"), and the README checklist updated
to match. The guarded gate chain refused to commit the red first attempt —
commit discipline holding.

### 2026-10-24 — wakeUp: honor 429 retry delays, stop hammering, poll light

User hit it live: `set-home-location` returned `HTTP 429: Retry in 12 seconds`.
Quantified cause: `wakeUp()` looped up to 10 × (`wake_up` POST + FULL
`vehicle_data` poll) at a flat 2 s cadence, swallowed every error, and only
surfaced the 429 on the last attempt — one command ≈ 10 rejected POSTs in ~20 s,
ignoring Tesla's stated delay. (Daemon ruled out: not running; no lock.) Branch
`fix/wake-backoff` (off main after feat/tesla-auth-probe landed), gate green
**550 passed / 3 skipped** (baseline 544 + 6):
- `5b19317` **test isolation:** the real-proxy boot test now dynamic-skips when
  loopback:4443 is held (the user's live session sidecar, PID-traced) instead of
  failing — a live session and a full gate are simultaneously runnable; CI
  unaffected (nothing listens there).
- `2fb8492` **retry-delay parsing** (`services/tesla/oauth.ts`):
  `rateLimitedRetrySeconds` — retry-after header first (clamped 1–60 s), then the
  "Retry in N seconds" body Tesla actually sends, 15 s fallback (never hammer);
  `describeTeslaError` gains a 429 branch ("wait the stated time — wake loops
  honor it").
- `1c91a1c` **wakeUp rework:** confirmation now polls the LIGHT state probe
  (`getVehicleState`, `GET /vehicles/{vin}` — the loop only reads `state`; the
  full vehicle_data it used to pull is the heaviest call Tesla offers); a 429
  sleeps the stated delay WITHOUT consuming a wake cycle and logs "Rate limited
  by Tesla; waiting Ns…"; 3-minute wall budget matches the charge path; a car
  that never comes online now FAILS (the old loop resolved silently). Parser is
  cause-chain aware — the Fleet error interceptor re-wraps axios errors, so the
  response lives on `.cause` (caught by the new tests, not by review).
  Routing pins updated ([wake_up, state probe]); 6 new fake-timer tests
  (stated-delay sleeps, header preference, budget error, non-429 bounded to 10
  cycles, never-online loud failure, no vehicle_data ever).
- README: HTTP 429 troubleshooting row.
- Live check for the user: re-run `set-home-location` — a rate-limited wake now
  WAITS (with a visible "waiting Ns" line) instead of failing after a burst.
- Next: Step 7 — validation checklist + landing review.

### 2026-10-24 — set-home-location: location lives behind the location_data selector

Follow-up: the429 fix worked ("waiting 42s" observed), but the flow then failed
with "Location is not in the vehicle response — the vehicle_location scope is
probably missing". User's app config DID list the scope; a fresh consent with
Location selected still failed. Read-only probes with the stored token settled
it live:
- `endpoints=drive_state` (narrow AND full read): `drive_state` =
  `power/shift_state/speed/timestamp` only — no lat/lng, token fresh, car online.
- `endpoints=location_data`: `drive_state` gains `gps_as_of, heading, latitude,
  longitude, native_*` — **`LATLNG OK: 37.76289, -122.504895`** (user's parked
  car) with the SAME token.
⇒ Not the scope, not the grant, not Tesla caching: Tesla relocated GPS fields
behind the separate `location_data` endpoint selector (community-documented:
timdorr/tesla-api#786 Aug 2025 with the identical response shape;
fleet-telemetry#460 May 2026 — "hidden … when location_data endpoint parameter
is not passed"). Wrong turns this cost the user two rounds: blaming
developer.tesla.com config, then a fabricated API-host revoke URL (DNS dead in
browsers; the human page is accounts.tesla.com/…/security?tab=tpty-apps — user-
discovered). Branch `fix/wake-backoff`, gate green **550 passed / 3 skipped**:
- `48c4a63` **fix:** `getVehicleLocation` requests `endpoints: 'location_data'`
  (fields still land under `drive_state`; shape unchanged); error message now
  explains BOTH failure modes (selector vs ACCOUNT-grant) and points at the
  real revoke page; `buildRevokeConsentUrl` returns the accounts.tesla.com
  Third-party-apps URL (was the API-host consent URL a browser cannot reach);
  probe/oauth tests updated (param pin `location_data`, error regexes, URL pin).
- README: troubleshooting section for the exact error with the evidence and the
  revoke→re-auth remedy.
- Method lesson (standing): before blaming configuration, probe the raw API
  response with the user's own token — the selector difference was visible in
  one request and invisible through config checking.
- Morning validation: `npm run build` then `set-home-location` should print
  "Vehicle reports 37.76289, -122.504895 …".
- Next: Step 7 — validation checklist + landing review.

### 2026-10-24 — daemon observability round (store report, ev-poll visibility, daemon-config.json, status probes, runtime ownership)

Inputs: (a) user's first manual plug-in test missed the event (car asleep at
the one due rich read; probes invisible — diagnosed from `ev_samples` = 1 row
and the 300 s idle cadence math); (b) promise of a longer run, which then
**performed exactly as expected** — plug_in detected, session written with
manual charge start/stop from the Tesla app, unplug finalized (verified live:
session 1, 1.86 kWh, efficiency 2.925); the log's `/auth 200`s were the battery
self-heal and its `/auth 401`s the stale-runtime attach gap (fixed below); the
single 408 was correct honest isolation. (c) `daemon.json` had no creation path
— `DAEMON_CONFIG_TEMPLATE` was exported but never surfaced. Branch
`feat/daemon-observability`, gates per commit (baseline 550/2 → **560/2**):
- `313ba72` **store-report humanize:** `*tsMs/*TsMs` keys → ISO strings under
  `Ms`-stripped keys (`ts`, `plugTs`); duration fields (`elapsedMs`) exempt by
  pattern; events latest5 reshaped to `{ts, kind, from, to}`. Live-verified.
- `41454e8` **ev-poll visibility:** `[ev-poll] vehicle asleep → online`
  transitions (first probe establishes baseline silently) + ONE
  `rich read due <ISO> (cadence Ns, plugged|idle)` line per cadence window —
  the standing answer to "why is there no row"; runDaemon passes its log.
- `a60a223` **daemon-config.json (user's design):** rename `daemon.json` →
  `daemon-config.json`; `ensureDaemonConfigFile()` runs on DAEMON START ONLY
  (status never creates — pinned): creates with `DAEMON_CONFIG_TEMPLATE`
  (defaults remain the code reference), migrates a legacy `daemon.json`
  preserving hand-edits, never overwrites the existing file — the file is the
  single source of truth for effective config. 5 new tests.
- `bd00923` **status probes:** `Vehicle:` line from a live non-waking state
  probe (stored creds, 5 s budget, injectable; states: online/asleep/no-
  creds/probe-failed) + Franklin proxy now probes the PORT regardless of
  record, adding the honest `running but unrecorded — likely the daemon or
  another session; one-shot commands cannot attach` state (the exact lie the
  user hit: "not running" while the daemon's proxy served /health 200).
- `26bb5af` **runtime.json ownership:** `runDaemon` records the franklin proxy
  IT spawned (`pid/port/startedAt/token` — single-slot file, spawner-writes
  rule; attached proxies leave others' records alone) and clears only a record
  whose pid is still its own. One-shot attach (`charge-from-battery --dry-run`,
  `exit`) now works beside a running daemon; stale-record 401s die on the next
  daemon start. Seam-injected in tests (real config dir untouched); the
  `undefined !== null` ownership bug was caught by the attached-case test
  before commit.
- Deferred (explicit): store-backed `--dry-run` (offline battery read).
- User validation: next daemon run prints the creation line + ev-poll lines;
  `status` shows `Vehicle: … (live probe)` and honest proxy state; a daemon run
  rewrites the stale runtime.json (your current one is from an old session).
- Next: Step 7 — validation checklist + landing review.

### 2026-10-24 — PR #36 review (self): dead revoke chain + comment hygiene

Two inline comments on PR #36, addressed in `0d150e5` (gate **550 passed /
2 skipped** — the real-proxy boot test ran (not skipped) once the user's live
session released :4443):
- "useless test pinning a static string" (`buildRevokeConsentUrl` test) →
  deeper fix: the whole chain was dead code (`getRevokeConsentUrl` had zero
  consumers in src or tests); removed function + getter + test + import — the
  revoke URL now lives only in the user-facing error message and README.
- README historical notes → section trimmed to current state exactly as the
  comment specified ("…endpoint selector." ends the sentence); the same
  AGENTS.md comment rule applied proactively to the docstrings and test
  comments this branch added (wakeUp "pre-rework" history, getVehicleLocation
  community links/dates, "old flat 2s hammer" phrasing) — all removed history
  lives in these workplan entries instead.
- Note for the human: PR body says "419 rate limit" — it is 429; GitHub writes
  stay with the user (skill rule).
- Next: Step 7 — validation checklist + landing review.

### 2026-10-24 — daemon install round: launcher shim (Login Items title + nvm resilience) + launchctl one-liner

Branch `fix/daemon-launcher-naming` off landed `main` (ed07d26). Two items
from the user's first real `install-daemon.sh` run:

- **Login Items title was "Node.js Foundation"** — macOS Background Task
  Management names a login item after `ProgramArguments[0]`; the plist pointed
  straight at the nvm node binary, whose code-signer identity is "Node.js
  Foundation" (same class of bug as traycerai/traycer#776, which showed "sh").
  Fix: new template `scripts/evcc-daemon-launcher.sh` rendered to
  `~/.ev-charge-coordinator/EV Charge Coordinator` (file name = visible
  title); plist's sole ProgramArguments entry is now `__LAUNCHER__`. The
  launcher also sources nvm and resolves `node` at each launch, removing the
  plist's baked nvm version path (the documented "re-install after node
  upgrade" caveat is gone; plist PATH env made static).
  Uninstall removes the launcher too; `--dry-run` on both scripts prints the
  rendered launcher.
- **`launchctl print` grep matched `state =` three times** — job state
  (one tab) plus the job's `resource coalition` and `jetsam coalition`
  bookkeeping entries (two tabs, `state = active` each). Not duplicate
  processes; pid appears once. README + install output now use the
  tab-anchored `grep -E $'^\t(state|pid) ='` with a one-line explanation.
- Tests: `tests/launchd/launchd-assets.test.ts` re-pinned (launcher-shaped
  ProgramArguments, placeholder sets {__LAUNCHER__,__REPO_DIR__,__CONFIG_DIR__}
  for the plist and {__REPO_DIR__} for the launcher, launcher dry-run/uninstall
  paths, bash -n over all three scripts).
- Pending (user): re-run `scripts/install-daemon.sh`, then confirm the System
  Settings / `sfltool dumpbtm` title reads "EV Charge Coordinator" (the old
  entry may linger until logout). P1b planning paused per user; launcher plan
  from the 2026-10-24 planning entry stands.

  **First re-install attempt failed (EIO):** log forensics showed launchd's
  async teardown of the old node-based job took ~1.2s (`service inactive →
  removing service` at +1.23s) while the script's next line had already fired
  `launchctl bootstrap`, which launchd rejected with `37: Operation already
  in progress` (client-visible as `Bootstrap failed: 5: Input/output error`).
  First install never hit it (bootout on a never-loaded label is a no-op).
  BTM re-registration itself succeeded (`name=EV Charge Coordinator,
  [enabled, allowed], result=no error` — Login Items title fixed ✓).
  Fix: install now retries bootstrap up to 5× (1s apart, first attempt
  immediate) and exits 1 with the last error if all fail; dry-run says so;
  source pin added in launchd-assets test.



### 2026-10-24 — P1b step 1 complete: autoStart decision config

Branch `p1b/step1-decision-config`, gate green (`npm run check` exit 0; 580 passed / 2
skipped; `daemon-config.test.ts` 35/35). P1b lifted to the active workplan section with
the user's confirmed decisions (geofence = decision-time fetch / Option B, merge dark,
limit-before-start, branch per step); P1a marked complete.

- `daemonConfig.ts`: nested `autoStart` block — `AutoStartConfig` (`enabled` default
  `false`; `filters[]` of `always` / `geofence` + `radiusM`) validated field-by-field by
  `resolveAutoStart`: absent fields keep defaults; any problem nulls the whole config
  with one message per problem naming the file (refuse, never clamp/patch). The numeric
  loop now walks `NumericDaemonField` (`Exclude<keyof DaemonConfig, 'autoStart'>`);
  `show()` renders objects/arrays as JSON.
- Resolved configs deep-copy the block — no shared references with
  `DEFAULT_DAEMON_CONFIG` (pinned by test).
- Template lockstep: first start writes `autoStart: {enabled: false, filters: [{type:
  'always'}]}` (dark on any machine); existing files without the block resolve to the
  same dark default — no migration needed.
- Tests: +18 in `daemon-config.test.ts` (defaults, template pin, partial/full override,
  empty chain valid, reference isolation, 11-case invalid matrix, mixed numeric+block
  problems); `run-daemon.test.ts` config literal gains `autoStart`.
- Recorded decisions: empty filter chain is valid (interlocks still apply); unknown keys
  inside `autoStart` tolerated like top-level; `always` entries normalize to `{type}`
  (extra keys dropped); a non-`geofence` entry never requires `radiusM`.
- Next: Step 2 — `src/decision/filters.ts` (branch `p1b/step2-decision-filters`).

