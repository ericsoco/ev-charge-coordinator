# Workplan — Execute `prompts.md`

> Generated 2026-09-26 against branch `feature/ev-charge-coordinator-cli` @ `7d12f11`.
> Source of truth for requirements: [`./prompts.md`](./prompts.md). This document is the
> execution plan, not a specification — `prompts.md` wins on any conflict.

---

## 0. Current State (verified, not assumed)

This repo is **not** greenfield. The single commit `7d12f11` already implements most of
`prompts.md`. Verified during planning:

- `npx tsc --noEmit` → **zero errors**.
- `node dist/index.js --help` → all **9 spec'd commands** present (`start`, `exit`,
  `get-ev-bsoc`, `get-battery-soc`, `set-ev-charge-limit`, `start-ev-charging`,
  `stop-ev-charging`, `charge-from-battery`, `set-battery-buffer`) plus `config`.
- `.venv` has `franklinwh 2026.2.1`, `flask 3.1.3`, `flask-cors 6.0.2` installed.
- `npm run lint` → **fails** (ESLint 9.39.3 finds no flat config).
- No test files, no `test` script in `package.json`.

**Uncommitted working-tree changes** (from the previous session, all in `src/index.ts` +
`package.json` + `package-lock.json`): dropped the `readline` dep, switched to
`node:readline`, and added the `promptPassword` TODO comment.

**Consequence:** this is a **gap-closure + hardening plan**, not a build-from-scratch plan.
Several spec'd features exist but are non-functional against the real APIs.

---

## 1. Gap Audit Against `prompts.md`

| Requirement | Status | Evidence |
|---|---|---|
| TS/Node CLI, extensible to any EV / any battery | ✅ done | `src/types/ev.ts` (`EVService`), `src/types/battery.ts` (`BatteryService`), both implemented |
| Python `franklinwh` via localhost proxy (not `python-shell`) | ✅ done | `python/franklin_proxy.py` Flask server; spawned by `FranklinWHService.ts:78-139` |
| All 9 CLI commands exist | ✅ done | verified via `--help` |
| MIT license + README + CLI docs | ✅ done | `LICENSE`, `README.md`, `package.json` cleaned up |
| **Tesla: correct token endpoint** | 🔴 **broken** | `TeslaService.ts:14,130,157` POST to `auth.tesla.com/oauth2/v3/token`. Docs: *"calls to `/token` must use the `fleet-auth.prd.vn.cloud.tesla.com` domain"* |
| **Tesla: form-encoded body** | 🔴 **broken** | `TeslaService.ts:137,163` send `application/json`; docs require `application/x-www-form-urlencoded` |
| **Tesla: `audience` param** | 🔴 **broken** | `audience` (Fleet API base URL) is **required** on code exchange — omitted entirely (`TeslaService.ts:129-147`) |
| **Tesla: application Virtual Key** | 🔴 **missing** | Spec'd explicitly at `prompts.md:13`. No EC keygen, no public-key hosting, no `POST /api/1/partner_accounts`, no pairing step anywhere in `src/` |
| Tesla public-key domain / key-path config | 🔴 missing | `README.md:67` tells users to host a key; no code reads a domain or private key |
| Secure credential storage (both APIs) | 🟡 flawed | `credentials.ts` keytar + AES-256-GCM is sound. But `index.ts:183-190` re-saves Tesla creds with `undefined` tokens, **wiping real tokens**; `setTeslaCredentials` takes 6 positional params |
| Respond to user actions during auth | 🟡 partial | Browser callback server exists (`TeslaService.ts:185-244`); no auto-open browser, port `8089` hardcoded, OAuth `state` from `Math.random()` (`TeslaService.ts:273`) |
| `start` starts "the NodeJS server" | 🔴 not as spec'd | `index.ts:209-429` is a foreground REPL. There is no server/daemon |
| `exit` terminates proxy + server | 🔴 **cannot work** | `index.ts:431-445`: services are module-level vars, always `null` in a fresh `exit` process — a proxy spawned by an earlier `start` is never killed |
| Proxy security | 🔴 open local server | **No auth token** on any Flask route; any local process can `POST /mode` (battery write control). `/shutdown` (`franklin_proxy.py:251`) unauthenticated. `/auth` retains the user's **plaintext password** in a module global for process lifetime |
| Proxy interpreter resolution | 🟡 fragile | `FranklinWHService.ts:86` spawns bare `python3`. `franklinwh` lives only in `./.venv`; a clean shell fails. Only works in this session because the venv is on `PATH` |
| `requirements.txt` pin | 🟡 misleading | Declares `franklinwh>=0.2.0`; installed + written-against is `2026.2.1` |
| Hidden password input | 🔴 stub | User's own TODO at `index.ts:36-42` — password echoes to terminal. `inquirer` is a dependency and is used **nowhere** in `src/` |
| `charge-from-battery` correctness | 🟡 wrong units | `index.ts:551-567`: `evLimit = batterySoc − buffer` compares **% of a ~13.5 kWh house battery** to **% of a ~75 kWh car**. 100%−20% = "80%" EV ≈ 60 kWh requested from a battery holding ~10.8 kWh |
| Lint | 🔴 broken | ESLint 9 requires `eslint.config.js`; none exists |
| Tests | 🔴 none | No test files, no `test` script |
| `.venv/` absent from `.gitignore` | 🟢 cosmetic | Not polluting git today only because `venv` writes its own `.venv/.gitignore` containing `*` |
| REPL duplicates every command | 🟡 | `index.ts:240-405` re-implements all 9 commands as a `switch`, duplicating the Commander actions |



### 1.1 Verified Tesla Fleet API contract

Fetched live from `developer.tesla.com` during planning (so implementers don't re-derive it):

- **Authorize:** `https://auth.tesla.com/oauth2/v3/authorize` — params `response_type=code`,
  `client_id`, `redirect_uri`, `scope`, `state`; optional `nonce`, `prompt_missing_scopes`,
  `require_requested_scopes`, `show_keypair_step`.
- **Token exchange + refresh:** `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token`
  — **not** `auth.tesla.com`. Body must be `application/x-www-form-urlencoded`.
- **Code exchange requires `audience`** = a Fleet API base URL (e.g.
  `https://fleet-api.prd.na.vn.cloud.tesla.com`).
- **Refresh** needs only `grant_type`, `client_id`, `refresh_token` (no `client_secret`).
  Refresh tokens are **single-use** and expire after 3 months; the newest one stays valid
  up to 24 h to survive a failed save. Losing one forces full re-auth.
- **Scopes needed by this app:** `openid offline_access vehicle_device_data vehicle_cmds
  vehicle_charging_cmds`. (`user_data`, `vehicle_location` not required.)
- **Virtual key** = secp256r1 / prime256v1 keypair. Public key must be hosted, PEM-encoded,
  at `https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`, then enrolled
  via `POST /api/1/partner_accounts` using a **partner token** (`grant_type=client_credentials`
  + `client_id` + `client_secret` + `audience`). Verify with
  `GET /api/1/partner_accounts/public_key?domain=<domain>`.
- **Pairing a non-B2B vehicle is user-driven**, via the Tesla app deep link
  `https://tesla.com/_ak/<developer-domain>?vin=<VIN>`. This is precisely the
  "prompt and respond to necessary user actions" requirement at `prompts.md:13`.
- **Consent management** (revoke / scope change):
  `https://auth.tesla.com/user/revoke/consent?revoke_client_id=<client_id>&back_url=<url>`.
- OIDC metadata for cross-checking:
  `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/thirdparty/.well-known/openid-configuration`.

**Unconfirmed — do not build against without verifying:** a client-assertion-based
`POST /api/1/vehicles/<vin>/objects/virtual_key` endpoint is widely referenced in the wild,
but I could **not** confirm it in the docs pages fetched. Phase 1 uses only the
docs-confirmed path above.

---

## Phase 0 — Baseline & safety net (~0.5 d)

Lock in what works before touching it.

**✅ COMPLETE** (branch `chore/phase-0-baseline`). Exit criteria met: build, lint, typecheck and
36/36 tests green; no behavior change (CLI `--help`/`--version` unchanged, tests never write to
the real `~/.ev-charge-coordinator`).

1. ✅ Done manually by user | Commit the current uncommitted WIP (`package.json`,
   `package-lock.json`, `src/index.ts`) as a `chore:` commit so Phase 1's diff is reviewable on
   its own. (Landed as `455c6a6`, merged via PR #2.)
2. ✅ `.gitignore` gained `.venv/` and `venv/`. Note: `.venv` was *already* invisible to git
   because `python -m venv` writes a self-ignoring `.venv/.gitignore`; the root entry is for
   contributors whose venv is created some other way.
3. ✅ `vitest@5` + `typescript-eslint@9` flat config (`eslint.config.js`), plus
   `vitest.config.ts` and `tsconfig.test.json`. `npm run lint` went from broken (no config
   file existed) to 0 errors.
4. ✅ Characterization suites under `tests/` (36 tests, ~160 ms, no network, no Python):
   - `tests/utils/credentials.test.ts` (12) - encrypted round-trip, ciphertext-at-rest proof,
     key-file permissions, tamper handling, buffer default, Tesla token rotation.
   - `tests/services/franklin-wh.service.test.ts` (16) - full `snake_case` -> camelCase DTO
     map, `/health`-gated `initialize()`, snake_case `/auth` body, guard errors, shutdown.
   - `tests/characterization/legacy-charge-limit.test.ts` (8) - pins the Phase 4b percent rule
     **and deletes itself as the signal that the rule is gone.**
   Each suite was mutation-tested: perturbing the formula, the buffer default, or the DTO map
   makes the suite fail, so it cannot pass vacuously.
5. ✅ Scripts: `test`, `test:watch`, plus `typecheck` and a `check` gate
   (`build && lint && typecheck && test`).

### Notes Phase 1+ must inherit

- **Two test seams were added to `src/utils/credentials.ts`** (the only source change in this
  phase, and behavior-neutral for real users): `ECC_CONFIG_DIR` redirects the config dir, and
  `ECC_DISABLE_KEYCHAIN` forces the encrypted-file path. Without them the suite would write to
  the developer's real keychain/credential file. This shifts `credentials.ts` line numbers by
  +9, so the references at lines 289 and 361 above are now ~35-37 and ~48-58.
- **New lint debt, deliberately not fixed:** `isRunning` (`index.ts:17`) is assigned at `:230`
  and `:417` and **never read** - there is no run loop. `eslint.config.js` downgrades
  `no-unused-vars` to `warn` for `src/index.ts` only, with a comment ordering Phase 2 to remove
  the override. This is the mechanical proof that `exit` cannot stop the REPL (Phase 2 item).
- `getStats()`/`getStateOfCharge()` return `undefined` when the proxy omits `battery_soc`,
  which flows into `Math.max(0, batterySoc - buffer)` as `NaN`. Pinned; Phase 4 must handle it.
- `credentialStore` is a module singleton with a sticky `initialized` flag; tests must
  instantiate `new CredentialStore()` to get a clean load.


---

## Phase 1 — Tesla auth correctness (the blockers) (~1.5 d)

Nothing Tesla-facing is testable until this lands — every other Tesla task is blocked here.

**Status: COMPLETE, landed on `main` (`953cd75` and the commits before it). 122 tests green,
`npm run check` passing. All four exit criteria below were verified against a live vehicle
and a live developer app during development.** The notes in this section record where
reality differed from the plan; the "late findings" list after item 5 records five defects
that only surfaced in live use, all now fixed.

1. **`src/services/TeslaService.ts` — fix the token exchange:**
   - Add `TESLA_AUTH_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token'`;
     keep `auth.tesla.com` for `/authorize` **only** (delete its use at `:130,:157`).
   - Switch both POSTs to `application/x-www-form-urlencoded` (`URLSearchParams` body).
   - Add `audience: TESLA_API_URL` to the code exchange.
   - Refresh sends only `grant_type` / `client_id` / `refresh_token`.
   - Replace `Math.random()` state (`:273`) with `crypto.randomBytes(32).toString('hex')`;
     add PKCE (`code_verifier` + `code_challenge_method=S256`).
   - Persist the **rotated** refresh token on every refresh (single-use tokens).
2. **Region / base-URL config** — `fleet-api.prd.na.…` is hardcoded (`TeslaService.ts:15`);
   make `baseUrl` configurable (`na` / `eu` / `apac`) and persist the choice.
   - **Correction:** there is no `apac` deployment. Tesla maps Asia-Pacific (ex-China) to
     the **same** `na` host, so the regions are `na` / `eu` / `cn` only, with `cn` on a
     separate developer portal. Implemented as `resolveRegion` in `src/services/tesla/endpoints.ts`.
3. **Virtual key support** — new `src/services/tesla/VirtualKeyService.ts` + CLI:
   - Generate or load the prime256v1 pair (`private-key.pem` is already gitignored);
     generate on first run if absent.
   - Instruct the user to host the public key at the `/.well-known/appspecific/...` path,
     then `POST /api/1/partner_accounts` with a partner token; verify via
     `GET /api/1/partner_accounts/public_key?domain=…`.
   - Print the pairing deep link `https://tesla.com/_ak/<domain>?vin=<vin>` and **wait for
     the user to confirm** pairing in the Tesla app before proceeding.
   - **Shipped as one command, `pair-tesla-key`** (not `register-key` / `pair-vehicle`),
     with `--check-only` and `--skip-registration` flags. The steps are sequential and
     share a key pair, so splitting them meant re-deriving state in each. `config` gained
     `--tesla-domain` and `--show-public-key` for the setup half.
   - **Added a pre-flight check that the plan did not call for:** the command now fetches
     the well-known URL and compares it to the local key *before* registering the domain.
     A 200 serving an HTML error page, a stale key, or a redirect otherwise surfaces only
     after the one-shot pairing tap in front of the car. Verified against a real local
     TLS server in all three states.
   - **Correction to the exit criteria:** "reports the key present on the VIN" is **not
     achievable**. Tesla documents no endpoint that reports per-vehicle key pairing; the
     only documented signal is `key_paired` in a fleet-telemetry response, which needs a
     signed request and a configured telemetry server. Checked the Fleet API endpoint
     index, the Partner/Vehicle endpoint pages, and Tesla's own `vehicle-command` repo.
     The command therefore verifies what *is* checkable (key hosted, key matches, Tesla
     holds it) and tells the user how to confirm the rest by running a command.
4. **`config` command additions** — `--set-domain`, `--set-region`, `--show-public-key`,
   `--register-key`, `--pair`.
   - Shipped as `--tesla-domain` / `--tesla-region` / `--show-public-key`, with registration
     and pairing living in `pair-tesla-key` (see item 3).
5. **`src/utils/credentials.ts`** — replace the 6-positional-arg `setTeslaCredentials`
   (`:193-211`) with an options object; add `domain`, `baseUrl`, key paths; stop
   `index.ts:183-190` from blanking real tokens.
   - `baseUrl`/key paths were dropped: the region implies the base URL, and the key paths
     are derived from the config dir rather than stored per-credential.

**Exit criteria:** `get-ev-bsoc` returns a real SoC against a live vehicle; tokens survive a
restart; refresh works with no user interaction; ~~`pair-vehicle` reports the key present on
the VIN~~ — replaced by: `pair-tesla-key` verifies the published key matches the local pair
and that Tesla holds the same key, and prints the deep link for the manual tap.

### Late findings (live-use defects, all fixed)

Each of these passed the test suite and failed against the real API. They are recorded
because the pattern matters more than the individual bugs: **every one was a case where the
code encoded an assumption that the unit tests then pinned**, so a green suite actively
protected the defect.

1. **Registration deadlock.** `initializeTesla` saved the client ID/secret only *after*
   `authenticate()`, and `authenticate()` ends by resolving a VIN, which 412s until the app
   is registered — and registration needs those credentials. A user who had not registered
   could therefore never register. Fixed by saving credentials before the OAuth round trip
   and treating a 412 from `resolveVin()` as a partial success rather than a failed login.
2. **Partner tokens rejected.** `parseTokenResponse` hard-required a `refresh_token`, because
   it was written for the third-party grant. The `client_credentials` grant issues none, and
   Tesla documents no `offline_access` for it, so registration always failed. Now
   `requireRefreshToken` is opt-out, and only `client_credentials` passes false.
   **`fetchPartnerToken` had no test at all** — the only reason this shipped.
3. **Consent gate invisible.** Pairing via `tesla.com/_ak/` requires the user to have
   already authorized the app; until then Tesla answers *"you have not granted `<domain>`
   access to your account"*. `pair-tesla-key` printed the link unconditionally, so the only
   way to find out was to tap into an error in the Tesla app. Now checked before the link
   is printed, and reported by `--check-only`.
4. **Split-brain credential storage.** `initialize()` and `save()` each independently chose
   between the keychain and the encrypted file, silently falling back. A load could come
   from one while a write went to the other; since the keychain wins on read, correctly
   saved credentials became invisible and every run looked "not signed in". The backend is
   now resolved once and pinned for the life of the store.
5. **Test pollution of the real keychain.** `tests/services/tesla-error-reporting.test.ts`
   called `authenticate()`, which saves credentials, without setting `ECC_DISABLE_KEYCHAIN`
   or `ECC_CONFIG_DIR`. It wrote test values into the developer's real keychain *and*
   encrypted file. `ECC_DISABLE_KEYCHAIN`/`ECC_CONFIG_DIR` now live in `vitest.config.ts`,
   where a suite cannot forget them.

### One lesson worth carrying forward

Three separate advice strings told users to run a command that did not exist, and when that
was fixed the replacement ("run `get-ev-bsoc`") was *also* wrong — it is a data command, not
a login. The real fix was to write the missing `authenticate` command. **Advice text is a
user-facing surface and needs the same rigour as code**; there is now a test that reads the
registered command names out of `index.ts` and asserts every command mentioned in any error
message actually exists.



---

## Phase 1.5 — Extract shared command handlers (~0.5 d)

**Status: COMPLETE on `feature/phase-1-5-command-handlers`. 144 tests green, `npm run check`
clean (the `isRunning` warning is gone along with the flag). `--help` output is byte-identical
to the pre-refactor baseline.**

**Promoted above Phase 2/4 on purpose:** the same command logic exists twice today
(Commander actions + the REPL `switch`), so any Phase 4 math change would be made twice and
the two paths would drift. Do this first.

1. ✅ New `src/commands/` dir: `context.ts` holds `CommandContext` (Franklin/EV services +
   credential store + an injected `ask`), `vehicle.ts` holds the handlers. Each exports a
   function returning `Promise<CommandResult>`. Services are injected, not imported, so the
   handlers are unit-testable without a keychain, a proxy, or the network.
2. ✅ Commander actions in `src/index.ts` are thin wrappers. Failures funnel through one
   `runCommand()` that sets `process.exitCode = 1`; the REPL calls handlers directly so a
   failed command there does not kill the session.
3. ✅ The `start` REPL dispatches to the same handlers; its private copies are deleted.
   `index.ts` went 1180 → 1054 lines.
4. ✅ Shared error rendering (`describeError`) and the `MIN_EV_CHARGE_LIMIT` /
   `MAX_EV_CHARGE_LIMIT` constants are defined once.
5. ✅ `isRunning` deleted and the `src/index.ts` ESLint `no-unused-vars` override retired —
   the file now lints under the normal rule.

### The drift was already real, not hypothetical

The premise was worth checking rather than assuming. The two copies had already diverged
before this phase:

| | REPL | Commander |
|---|---|---|
| printed `Setting EV limit to: N%` | yes | **no** |
| prompted "Start charging now?" | yes | **no** |
| not-enough-charge handling | `break` | `process.exit(0)` |

So the same command already printed different output depending on how you invoked it. That
difference is now an explicit `offerToStart` argument rather than an accident of which copy
you happen to read.

### Guardrails added

- `tests/commands/vehicle.test.ts` (21 tests) covers the handlers directly, including that
  `offerToStart: false` never prompts and never starts charging.
- `legacy-charge-limit.test.ts`'s source guard now points at `src/commands/vehicle.ts` and
  expects **1** occurrence instead of 2, plus a new assertion that `index.ts` contains **0**.
  Verified by injecting a duplicate back into `index.ts`, which makes the test fail. So
  "defined in exactly one place" is enforced rather than merely intended.

**Exit criteria:** ✅ every command's behavior is defined in exactly one place; ✅ `--help`
unchanged; ✅ Phase 0 characterization tests still pass (repointed, not deleted — Phase 4b
still deletes them).

---

## Phase 2 — Real `start` / `exit` lifecycle (~1 d)

`prompts.md:17-18` specifies `start`/`exit` as process control; today `exit` structurally
**cannot** work (services are `null` in a fresh process).

1. **`src/services/ProcessManager.ts`** — write
   `~/.ev-charge-coordinator/runtime.json` = `{ pid, port, startedAt, tokenHash }` with mode
   `0600`; on startup, if the state file exists, health-probe it and **reuse** the live proxy
   rather than spawning a second one.
2. **`start`** — launch the Python proxy, wait on `/health`, keep the Node side resident
   (today's foreground REPL; optionally `--daemon`), print resolved PIDs and ports.
3. **`exit`** — read the state file, call the authenticated `/shutdown`, then `kill(pid)`
   with `SIGTERM` → `SIGKILL` escalation, then clear the state file. Must work from a **fresh
   process** and sweep orphans (port probe / PID match).
4. **Fix the teardown bug** — `index.ts:478-480` (`finally { disconnect() }`) tears down a
   proxy the one-shot command didn't start, so a second `get-battery-soc` pays full cold
   start. Only stop what you started.
5. Handle `EADDRINUSE` on 8089 (OAuth callback) and 3001 (proxy) with actionable messages
   instead of today's generic 10 s "Proxy startup timed out" (`FranklinWHService.ts:132-137`).
6. **Interpreter resolution** — prefer `./.venv/bin/python`, then `$ECC_PYTHON`, then
   `python3`; on `franklinwh` ImportError print the exact fix:
   `python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt`.
7. Make the OAuth callback port configurable (replace hardcoded `8089`, `TeslaService.ts:16`
   and `:229`) and document it must match the registered redirect URI.

**Exit criteria:** `start`, new terminal, `exit` reliably leaves no stray `python3`; running
`get-battery-soc` twice reuses a single proxy; killing the terminal leaves a state file that
the next `exit` still cleans up.

---

## Phase 3 — Python proxy security + packaging (~0.5 d)

1. **Shared secret:** Node generates a random token, passes it via env, Flask requires
   `X-Proxy-Token` on every route except `/health`. Today any process on the host can
   `POST /mode` and rewrite battery operating mode.
2. **`/health` must stop leaking `gateway_id`** (`franklin_proxy.py:79-86`).
3. **`/auth` must not retain the plaintext password** — drop it once `Client` is built;
   right now it lives in `_token_fetcher` for the process lifetime (`franklin_proxy.py:115-117`).
4. **Fix `/shutdown`** (`franklin_proxy.py:251-259`): `werkzeug.server.shutdown` was removed
   in Flask ≥ 2.1, so that branch is dead code and the `os._exit(0)` fallback hard-kills
   mid-request without cleanup. Use a signal-based shutdown on the main thread.
5. Keep the `127.0.0.1` bind (correct today) but **fail fast** if an override requests
   `0.0.0.0`, since these routes are battery-write capable.
6. Pin `python/requirements.txt` to what's actually installed and API-compatible:
   `franklinwh>=2026.2.1` (the current `>=0.2.0` does not match the code's API surface).
7. Add a smoke test: proxy boots in a temp venv and `GET /health` → 200. Gate live Franklin
   calls behind `RUN_LIVE_TESTS=1`.

**Verified API surface** (`franklinwh 2026.2.1`, confirmed by introspection — the proxy's
calls are correct): `TokenFetcher(username, password)`, `Client(fetcher, gateway, url_base)`,
`refresh_token`, `get_stats`, `get_mode`, `set_mode`, `get_composite_info`,
`get_home_gateway_list`, `Mode.{time_of_use,self_consumption,emergency_backup}`, and
exceptions `InvalidCredentials` / `AccountLocked` / `DeviceTimeout` / `GatewayOffline`.

**Exit criteria:** requests without the token get 401; no plaintext password persists;
`exit` shuts the proxy down cleanly with no `os._exit`.

---

## Phase 4 — Credential UX + spec'd charging behavior (~1.5 d)

**Depends on Phase 1.5** (shared handlers) so the percent math is deleted once, not twice.

### 4a. Replace the password-prompt stub

1. Delete `prompt` / `promptPassword` and the TODO at `index.ts:19-52`; use the
   **already-installed** `inquirer` (`password` for secrets, `number` for percentages,
   `confirm` for save-credentials, `search`/`select` for vehicle choice). `inquirer` is
   currently in `dependencies` and referenced nowhere in `src/` except that TODO comment.
2. Never echo secrets; check whether the FranklinWH `gateway_id` prompt should be masked too.

### 4b. `charge-from-battery` → energy math, percent rule **deleted**

> **Decision (locked):** kWh/energy math only. The raw "battery % − buffer %" comparison is
> **removed entirely** — no `--mode percent` fallback, no compat flag. Rationale: comparing a
> % of a ~13.5 kWh house battery against a % of a ~75 kWh vehicle is dimensionally invalid and
> can request ~6x more energy than the battery holds.

1. **New pure module `src/utils/energy.ts`** (no I/O — this is the "business logic in
   JavaScript" that `prompts.md:6` asks to keep editable):

   ```ts
   export interface EnergyConfig {
     batteryCapacityKwh: number;   // FranklinWH aPower 2
     evBatteryKwh: number;         // Model Y usable
     bufferPercent: number;        // existing setting, 0-100
     chargeEfficiency: number;     // onboard-charger / converter losses
     minChargeKwh: number;         // don't start below this
   }
   export interface EnergyEstimate {
     batteryAvailableKwh: number;
     evCurrentKwh: number;
     evTargetKwh: number;
     targetPercent: number;        // already clamped to Tesla's 50-100 window
     limitedBy: 'battery' | 'ev-capacity' | 'tesla-minimum';
   }
   export function computeChargeLimit(
     evSoc: number, batterySoc: number, cfg: EnergyConfig
   ): EnergyEstimate
   ```

2. **Math:**
   `batteryAvailableKwh = batteryCapacityKwh x max(0, batterySoc - bufferPercent) / 100`
   then `evTargetKwh = min(evBatteryKwh, evCurrentKwh + batteryAvailableKwh x chargeEfficiency)`
   then `targetPercent = clamp(round(evTargetKwh / evBatteryKwh x 100), 50, 100)`.
3. **Delete both percent call sites:** `index.ts:554-555`
   (`availableCharge = batterySoc - buffer` and `Math.max(50, Math.min(100, availableCharge))`)
   **and** its REPL twin at `index.ts:352-355`. Replace with one `computeChargeLimit` call
   reporting the kWh breakdown
   (`Battery available: 8.2 kWh - EV now: 30.0 kWh -> target 55%`). Abort with `limitedBy`
   when `batteryAvailableKwh < minChargeKwh`.

4. **Capacities are now required** (no percent fallback to lean on): first run of
   `charge-from-battery` prompts for them via `inquirer` rather than silently defaulting, so a
   wrong pack size can't silently under/over-charge. `config` displays derived values.
   `StoredCredentials.settings` (`credentials.ts:32-34`) grows the new fields.
5. **Config surface:** `config --set-battery-kwh <n>`, `--set-ev-kwh <n>`,
   `--set-efficiency <0-1>`, `--set-min-kwh <n>`.
6. **Unify the start-charging behavior:** non-interactive `charge-from-battery` never starts
   charging, but the REPL version prompts to (`index.ts:370-374`). Make it explicit via
   `--start` / `--dry-run`, identical in both modes.
7. `set-battery-buffer` — add `--get`.
8. **Tests** (`src/utils/energy.test.ts`): empty / over-cap buffer, `bufferPercent` 0 and 100,
   EV already above target, efficiency `1.0` and `0.5`, the 50 % floor, and the
   13.5 kWh-battery -> 75 kWh-car case that motivated this change (assert a sane ~60-65 %
   target, i.e. **not** the old nonsensical 80 %).

**Exit criteria:** passwords never echo; `charge-from-battery` produces a unit-correct,
defensible limit and explains itself in kWh.

---

## Phase 5 — Open-source packaging (~0.5 d)

1. `LICENSE` -> `Copyright (c) 2026 <holder>` (currently `2024`, no holder). `package.json`:
   fill `author` (currently `""`), add `repository`, `bugs`, `homepage`, and
   `bin: { "ev-charge-coordinator": "./dist/index.js" }` (shebang already present at
   `index.ts:1`).
2. `README.md`: replace `your-username` (`:34`) with the real repo; document that the Fleet
   **token** host differs from the **authorize** host; the public-key hosting + pairing deep
   link flow; the `charge-from-battery` kWh formula; the venv / `python3` resolution failure in
   Troubleshooting; refresh the CLI Reference + Architecture diagrams to match Phases 1-4.
3. `.github/workflows/ci.yml`: `npm ci` -> build -> lint -> unit tests ->
   `python -m py_compile python/franklin_proxy.py`.
4. `CONTRIBUTING.md`, issue/PR templates, `CHANGELOG.md`.
5. Update `AGENTS.md` with the new `npm test` / lint commands and the `src/commands/`,
   `src/utils/energy.ts` layout.

**Exit criteria:** a first-time clone can follow the README top-to-bottom and reach a
successful `get-battery-soc`.

---

## Phase 6 — Explicitly deferred (out of scope)

Web GUI (`prompts.md:3` says "later") - multi-EV / multi-gateway fan-out - scheduled charging
windows and solar-aware rate timing - Fleet Telemetry WebSocket instead of polling - publishing
as `npx ev-charge-coordinator` - `keytar` replacement.

---

## 7. Decisions

| Decision | Choice |
|---|---|
| `charge-from-battery` semantics | **Energy math (kWh) only - percent comparison deleted** (user decision, this session) |
| `start` / `exit` model | State-file-backed supervisor so `exit` works from a fresh process (today it structurally cannot) |
| Hidden password input | `inquirer` - already a dependency, currently unused |
| Virtual key path | Docs-confirmed only: EC keygen -> host public key -> `POST /api/1/partner_accounts` -> mobile pairing deep link. The client-assertion `objects/virtual_key` API is **unconfirmed** and off the table without verification |
| Command-handler duplication | Extract `src/commands/` **before** Phase 4 (added as Phase 1.5) |
| Test framework | `vitest`; live Tesla/Franklin calls gated behind `RUN_LIVE_TESTS=1` |
| `LICENSE` holder / `author` | Not yet supplied by user - Phase 5 needs a name before it can close |

---

## 8. Risks & Caveats

- **Tesla is untestable offline.** Phases 1 and 5 can be written to spec and unit-tested with
  mocks, but **cannot be verified in this environment** (no real vehicle, no public domain to
  host the key). Budget one debug round-trip on the user's side.
- **Fleet API is billed**, and `set_charge_limit` (`TeslaService.ts:384`) may be deprecated on
  newer firmware in favor of scheduled-charging endpoints. Verify against the vehicle during
  Phase 1.
- **FranklinWH is write-capable** - `set_mode` is exposed by the proxy. `charge-from-battery`
  must stay **read-only** against the battery; never mutate operating mode without an explicit
  user command.
- **`keytar@7.9.0` is deprecated** with no prebuilt binaries for newer Node/OS targets. It is
  correctly optional today (`credentials.ts:39-49`), so the AES-256-GCM file fallback will carry
  most users - but it deserves a `package.json` / README note.
- **Public-key hosting is a hard external prerequisite** for Tesla commands and cannot be
  automated away by this CLI.
- The `.venv` currently resolves only because this session has it on `PATH`; Phase 2 item 6 is
  what makes the proxy startup reproducible for other developers.
- Deleting the percent rule (Phase 4) is a **behavior change** for anyone already relying on
  `charge-from-battery`; call it out in `CHANGELOG.md` as breaking.

---

## 9. Sequencing & Effort

**Critical path:** Phase 0 -> 1 -> 1.5 -> 2 -> 3 -> 4 -> 5. Phases 3 and 5 parallelize with 2/4.
**Total approximately 5 focused days.**

Suggested commit sequence:

```
test: characterization suite + eslint flat config + vitest
fix(tesla): correct token host, form encoding, audience param
fix(tesla): PKCE + crypto-random OAuth state + refresh-token rotation
feat(tesla): virtual key registration and mobile pairing flow
refactor(cli): extract shared command handlers used by Commander + REPL
fix(cli): real start/exit lifecycle via runtime state file
fix(cli): do not tear down proxy processes we did not start
fix(proxy): shared-secret auth; stop retaining plaintext password
fix(proxy): resolve venv interpreter; pin franklinwh to installed API
feat(cli): inquirer prompts replacing the password echo stub
refactor(cli): energy-based charge-from-battery; remove percent comparison
docs: license year/holder, repo URLs, README rewrite, CI workflow
```

---

## 10. Acceptance Checklist

Traced back to `prompts.md`:

- [ ] `start` starts the Python proxy **and** a resident Node process; PIDs printed
- [ ] `exit` from a **separate shell** terminates both, leaving no stray `python3`
- [ ] `get-ev-bsoc` / `get-battery-soc` return live values
- [ ] `set-ev-charge-limit` / `start-ev-charging` / `stop-ev-charging` succeed against a real
      Model Y (requires the Phase 1 virtual-key pairing)
- [ ] `charge-from-battery` sets a kWh-derived limit and prints the kWh reasoning
- [ ] `set-battery-buffer` persists across restarts
- [ ] Tesla OAuth completes in a browser, honors user actions, tokens survive restart + refresh
- [ ] FranklinWH credentials prompted once, stored securely, never echoed
- [ ] No proxy route writable without the shared token
- [ ] `npm run build`, `npm run lint`, `npm test` and CI all green
- [ ] MIT `LICENSE` + README CLI docs accurate for the shipped commands

