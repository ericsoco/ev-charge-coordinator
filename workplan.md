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

### 2026-10-19 — P1a plan recorded (collect-only daemon; implementation deferred)

Branch `plan/p1a-workplan`. The Phase 1 design branch has already landed on `main`
([design.md](./design.md) is in place); approved in plan mode; per user
direction only this recording happens now: **implementation proceeds one step at a time from
step 1 below, never as a batch.** Design rationale lives in design.md §3/§5;
this entry is the execution checklist.

**Goal:** long-running `evcc daemon` on this Mac that only observes and records — battery
samples, poll-while-awake EV samples, plug-in/session events, daily weather forecasts — into a
new SQLite store. No decision engine, no actuation, no notifications.

**Scope in:** `daemon` command (foreground; `--once` = single cycle); SQLite store + versioned
migrations (all 7 design tables, `site_id`/`vehicle_id`, no raw-GPS columns); samplers (battery
120 s default; EV status probe 60 s + `vehicle_data` 60 s plugged / 300 s awake-idle / none
asleep; weather daily Open-Meteo, 48–72 h rolling); event/session recording; read-only `status`
+ `sessions` commands; `set-home-location` one-shot; launchd plist + install/uninstall scripts
+ README docs.
**Out:** decision engine, filters/geofence enforcement, notifications, auto-start, efficiency
computation (inputs stored only), telemetry, Modbus, any CLI writes to the store.

**Decisions:**
- Built-in `node:sqlite` driver (verified working on local Node v24.14.0; zero new deps;
  `ExperimentalWarning` tolerated or suppressed via launchd arg; CI Node 24/26 matrix is the
  compatibility gate; fallback `better-sqlite3` behind `src/store/` if CI breaks).
- `daemon.json` (ops tunables, documented defaults, validate-on-read fail-loud) separate from
  energy `config.json` (strict `EnergyConfig`, no defaults).
- Home location is a secret: `credentials.ts` gains `getHomeLocation`/`setHomeLocation`, set
  via one-shot `set-home-location` — never written to `config.json`.
- Event detection (poll state machine + pure transition reducer) built once here with a
  record-only consumer; P1b adds the decision consumer.
- Weather sampler included; degrades with a notice until the home-location secret exists.
- Single-writer: only the daemon writes the store; CLI opens read-only (WAL).
- **launchd: document plist + install/uninstall + `launchctl bootstrap` steps only — the user
  performs the install themselves.**

**Data model (migration v1, `<config-dir>/data.sqlite`, WAL, `user_version`):** `battery_samples`,
`ev_samples` (incl. `at_home`, NULL until P1b), `events`, `sessions`, `decisions`,
`efficiency_observations`, `weather_forecasts`; epoch-ms UTC timestamps; daily retention prune
(raw samples 90 d).

**New modules:** `src/daemon/{runDaemon,lockfile,scheduler,EvPoller,eventDetector,BatterySampler,WeatherSampler}.ts`,
`src/store/{database,migrations,SampleStore,SessionStore,WeatherStore}.ts`,
`src/utils/daemonConfig.ts`, `scripts/{evcc-daemon.plist,install-daemon.sh,uninstall-daemon.sh}`.
**Changed:** `index.ts` (+4 thin actions: `daemon`, `status`, `sessions`, `set-home-location`),
`repl.ts` (`status`/`sessions` registered; `daemon`/`set-home-location` in the one-shot
whitelist — the repl-commands drift guard drives the wiring), `TeslaService.ts` (non-waking
`getVehicleState()` probe + `chargeEnergyAdded` in `getStatus()`), `credentials.ts`, README.
**Reuse:** `initializeFranklin`/`initializeTesla` (index.ts:254/326), `keepResident` (:81),
`startTeslaProxy`, `writeRuntimeState`, Franklin `attachOrStartProxy`/`isProxyHealthy`, the
non-waking `getStatus()` read (`vehicle_data?endpoints=charge_state`).

**Steps — one at a time; each green (`npm run check`) + its own commit on
`feat/p1a-collect-daemon`:**
1. **Store layer** — database/migrations/repositories + tests (ECC_CONFIG_DIR tmp dirs;
   round-trip, migration idempotency, WAL single-writer).
2. **daemon config + lockfile + scheduler** + tests (defaults, validation failures, stale-lock
   recovery, per-tick error isolation).
3. **Tesla state probe + `chargeEnergyAdded` + event detector** + tests (transition matrix:
   `Disconnected→*` = plug_in, `*→Disconnected` = unplug, `Charging→Complete` = stop;
   408-as-asleep probe handling).
4. **Samplers + `runDaemon`** + tests with fake Franklin/Tesla services (rows land; totals
   deltas; weather skipped without the secret).
5. **CLI + REPL wiring** — `daemon`, `status`, `sessions`, `set-home-location` + tests (drift
   guard, output snapshots).
6. **launchd assets + README daemon section + workplan log** — plist template, install/uninstall
   scripts, documented `launchctl bootstrap` steps; **user performs the install**.
7. **Validation** (checklist below) — stop for review before landing to main.

**Validation checklist:** `npm run check` green (baseline 349 passed / 2 skipped + new);
`node dist/index.js --help` lists the new commands; `daemon --once` real cycle (asleep car →
probe path, no 408 error); sample counts grow via `sqlite3 <config-dir>/data.sqlite 'select
count(*) from battery_samples'`; `status` shows alive + last-sample ages; a second `daemon`
invocation refuses the lock; optional `RUN_LIVE_TESTS=1` live cycle test.

**Risks:** `node:sqlite` experimental vs Node 26 CI (fallback noted); Mac sleep misses events
(document `pmset`, not automated); `exit` stops the daemon-owned proxy → daemon health-check
restarts it; Tesla status-probe billing negligible after the $10/mo individual credit.
