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
