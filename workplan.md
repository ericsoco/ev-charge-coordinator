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

## P1a — collect-only daemon (active execution plan)

> Status: **planning complete 2026-10-19; Step 1 — Store layer not started.** Standing rules:
> one step at a time; each step green (`npm run check`) + its own commit on
> `feat/p1a-collect-daemon`; stop for review after each step; **the user performs the launchd
> install themselves** (guide below). Design rationale: [design.md](./design.md) §3/§5.
> After each step: update the status line here, append a short dated Log entry.

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

### Current step detail: 1 — Store layer (not started)

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

**Plist** → `~/Library/LaunchAgents/com.ericsoco.ev-charge-coordinator.daemon.plist`
(template ships as `scripts/evcc-daemon.plist` in step 6):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ericsoco.ev-charge-coordinator.daemon</string>
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

**Install** (step 6's `scripts/install-daemon.sh` automates 1–4):
1. `npm run build` (dist must be current)
2. `mkdir -p ~/.ev-charge-coordinator/logs`
3. Write the plist → `plutil -lint <plist>`
4. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ericsoco.ev-charge-coordinator.daemon.plist`
5. Verify: `launchctl print gui/$(id -u)/com.ericsoco.ev-charge-coordinator.daemon | grep -E
   'state|pid'` · `tail -f ~/.ev-charge-coordinator/logs/daemon.log` · (from step 5)
   `node dist/index.js status`
6. **First-run keychain prompt:** macOS may ask to allow `node` to access the
   `ev-charge-coordinator` keychain item — "Always Allow" once.

**Operate:** stop `launchctl bootout gui/$(id -u)/com.ericsoco.ev-charge-coordinator.daemon` ·
restart in place `launchctl kickstart -k gui/$(id -u)/com.ericsoco.ev-charge-coordinator.daemon`
· uninstall = bootout + `rm` the plist (`scripts/uninstall-daemon.sh`, step 6) · auto-loads at
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
  daemon health-checks and restarts it.

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


