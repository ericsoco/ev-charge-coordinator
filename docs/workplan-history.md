# ⚠️ HISTORICAL — EV Charge Coordinator Workplan (2026-09-26 → 2026-11-03)

> **Superseded by [workplan.md](../workplan.md), which holds current context and forward
> decisions — read that file first.** This file holds two archived execution records:
> **Part 1** is the completed Phase 0–5 execution log (2026-09-26 → 2026-10-18), and
> **Part 2** is the Phase 1 execution record — P1a collect-only daemon + P1b auto-start
> decision engine (2026-10-18 → 2026-11-03, archived when P1c planning started). It is
> retained for backup context when investigating *why* something is the way it is. Its open
> items are closed or moved, and its file references reflect the repo as it existed then
> (e.g. the `prompts.md` named in Part 1's header is now [requirements.md](./requirements.md)).
> Do not treat anything below as current state.

---


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
     key-file permissions, tamper handling, buffer default (since removed with
     `StoredCredentials.settings`), Tesla token rotation.
   - `tests/services/franklin-wh.service.test.ts` (16) - full `snake_case` -> camelCase DTO
     map, `/health`-gated `initialize()`, snake_case `/auth` body, guard errors, shutdown.
   - `tests/characterization/legacy-charge-limit.test.ts` (8) - pinned the Phase 4b percent rule
     **and deleted itself as the signal that the rule is gone.** (Done: deleted in the
     Phase 4 pass.)
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
  which flows into `Math.max(0, batterySoc - buffer)` as `NaN`. Pinned; handled in the
  Phase 4 pass (`chargeFromBattery` rejects non-finite SoC input before computing).
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
still deletes them; done in the Phase 4 pass).

---

## Phase 2 — Real `start` / `exit` lifecycle (~1 d)

**Status: ✅ complete.** Items 1-6 landed on `feature/phase-2-process-lifecycle` (merged to
main), item 7 was already done in Phase 1. The human run against real credentials plus the
post-run investigation recorded below closed the last exit criteria: the `start` → new
terminal → `exit` round trip and `get-battery-soc` twice against one proxy are both
verified live. 196 tests green, lint clean.

`prompts.md:17-18` specifies `start`/`exit` as process control; today `exit` structurally
**cannot** work (services are `null` in a fresh process).

1. ✅ **`src/services/ProcessManager.ts`** — `runtime.json` = `{ pid, port, startedAt }`, mode
   `0600`, written atomically (temp file + rename). `readRuntimeState` reports a corrupt
   file as absent rather than throwing, and `terminateProcess` escalates SIGTERM → SIGKILL
   while confirming the process is actually gone.
   - **Deviation:** no `tokenHash`. There is no secret to verify until Phase 3 adds the
     shared proxy token, and a hash nobody can authenticate against is a field with no
     reader. Phase 3 adds it alongside the secret it checks.
2. ✅ **`start`** — ensures the proxy is up, records `runtime.json`, prints the resolved
   PID/port, then enters the REPL. `--daemon` stays resident without the REPL so it can be
   backgrounded.
3. ✅ **`exit`** — works from a fresh process: reads the state file, health-checks the PID,
   calls `/shutdown`, escalates the signal, clears the state. A missing or stale file
   reports honestly instead of the old "✓ Services stopped" that claimed success it had
   not achieved. Orphaned proxies are *reported*, not killed — without a recorded PID there
   is no way to know a process is ours.
4. ✅ **Teardown bug fixed** — `FranklinWHService` now distinguishes a proxy it spawned
   from one it attached to. `disconnect()` only kills what it owns, so a one-shot
   `get-battery-soc` no longer tears down the proxy a resident `start` owns.
5. ✅ **`EADDRINUSE` and dependency errors** — `describeProxyExit` reads the traceback Flask
   wrote to stderr and names the cause with the fixing command, replacing
   `Proxy exited with code 1`. The 10s timeout reports the interpreter and port.
6. ✅ **Interpreter resolution** — `.venv` → `$ECC_PYTHON` → `python3`, with the exact venv
   fix printed on a missing dependency.
7. ✅ **Already done in Phase 1** — `DEFAULT_CALLBACK_PORT` + `callbackPort` option, persisted
   as `callbackPort`. Marked rather than redone.

### Verified end to end, from a fresh process

`exit` was run as its own process against a planted live PID: it stopped the process,
confirmed it gone, and cleared the state file. The stale-PID path was exercised too.

### Bug found by using it: a wrong password leaked a proxy

The first real `start --daemon` run failed FranklinWH auth (wrong password) and left a
Python proxy listening on port 3001 that `exit` could not reach. Root cause:

1. `initialize()` spawns the proxy **before** authenticating, so the child already
   existed when `/auth` was rejected.
2. The CLI's catch block set `franklinService = null`, discarding the only handle to
   that child. That line predates Phase 2, but adding `spawnedProxyPid` made it
   consequential: before, a leaked process was untidy; now it defeats `exit`.
3. `start` then found no PID to record, so no `runtime.json` was written — and `exit`
   was **correct** to report nothing to stop.

Fixed by rolling back the proxy `initialize()` itself spawned when auth fails (leaving a
proxy it merely *attached* to alone), and by no longer discarding the service on the
error path. `start` now also warns when something holds port 3001 with no state file
recording it, so an orphan is visible rather than silent. The regression test was verified
to fail when the rollback is removed.

### `start` reporting was wrong, found by running it

`start` printed an unconditional `✓ Services started successfully` and then, one line
later, the accurate `Solar battery proxy: not running` — the banner contradicted the
detail beside it. It also printed `Stop with: node dist/index.js exit` on a run where
`exit` had already been shown to find nothing. The gate was `&&`, so "either service
down" only exited when *both* were.

Now one line per service, and `exit` is only advertised when a PID was recorded.
`--debug` (or `ECC_DEBUG=1`) adds the stack trace and raw body.

Verified against the live outage that prompted it — FranklinWH's backend returning
500 for three consecutive requests while their site root returned 200:

```
Stored credentials did not work: HTTP 500 — FranklinWH's service returned an internal error (not a credentials problem)
```

with `ECC_DEBUG=1` adding the 11-line trace underneath.

**A lesson about the tests here.** The first version of the reporting test mirrored
the rendering logic and passed — while the bug was still live, because the mirror had
drifted from the code. The tests now assert against `src/index.ts` directly. Both were
verified by reintroducing each bug and confirming a failure.

### One test had to be simulated rather than real

The SIGKILL-escalation test originally spawned a process that ignores SIGTERM. That fixture
was **unreliable under vitest** — a Node child with a `process.on('SIGTERM')` listener and a
`trap '' TERM` subshell both exited, even though the trap works in a plain shell. Rather
than keep a test whose outcome depends on runner signal scheduling, the escalation is
driven through an injectable seam (`terminateProcessWith`) and asserts the signal sequence
directly. Real-process behaviour is still covered by the "stops a live process" case.

### The human run, and what it exposed

The run against real credentials confirmed the phase's core machinery — proxy spawned and
recorded, per-service banner honest, in-shell `exit` clearing `runtime.json` — and produced
`Error: Request failed with status code 500` from `get-battery-soc` with no diagnostic
trail anywhere. That kicked off the investigation recorded as the late findings below.

**Exit criteria:** ✅ `exit` reliably stops the proxy from a fresh process (verified);
✅ one-shot commands no longer kill a resident proxy; ✅ killing the terminal leaves a state
file the next `exit` cleans up (stale path verified); ✅ `get-battery-soc` twice reusing a
single proxy — verified live after the fixes below (one attempt visibly retried a transient
upstream null and returned the SoC).

### Late findings from the human run (all fixed)

**1. The 500 left no trail — by construction.** Three links broke:

- the proxy's `handle_franklin_errors` catch-all returned `{"error", "details"}` but
  swallowed the traceback before Flask could log anything;
- Node's `describeError` printed only axios's message ("Request failed with status code
  500"), discarding the body that carried `details`;
- proxy stderr after startup accumulated in an in-memory string nothing ever read —
  invisible, unbounded, gone when the session ended. `--debug` would not have helped: it
  only enriches *startup* failures.

Fixed: (a) command-time Franklin errors now surface `HTTP 500 — <error>: <details>`
(`describeProxyHttpError`, original kept as `cause`); (b) the proxy prints the traceback
to stderr before returning the JSON; (c) stderr is forwarded live as `[proxy] ...`
(startup banner filtered, ANSI stripped, REPL prompt redrawn after each line), with the
retained tail bounded at 4 KB for `describeProxyExit`.

**2. Root causes of the 500s — two, plus two latent bugs found while proving them.**

- *Proxy defect:* `run_async` created and closed a fresh event loop per request, while
  `franklinwh`'s httpx client keeps pooled connections bound to the loop that created
  them — second request: `RuntimeError: Event loop is closed`. Now one process-lifetime
  loop behind a lock (process state like the existing `_client` singleton; Flask's
  threaded dev server needs the serialization).
- *Upstream:* Franklin's cloud answers HTTP **200 with `result: null`** when the gateway
  has no data ready, and `franklinwh` then raises `TypeError: 'NoneType' object is not
  subscriptable`. Reproduced with a bare franklinwh client against
  `energy.franklinwh.com` (no proxy involved), alternating 200/500 on consecutive calls.
  Reads are idempotent, so the proxy retries them (`run_read`: 3 attempts, 0.5s/1.5s);
  the four mapped exceptions are deterministic and never retried. A live 5-call probe
  went from 2/5 to 5/5, with retries logged as `[proxy]` lines.
- *EADDRINUSE detection was unreachable:* readiness was detected from the script's
  **pre-bind** "Starting FranklinWH API Proxy" print, so the child was declared started
  before the bind failed — `describeProxyExit`'s port message never ran and the CLI
  prompted for credentials instead (reproduced by occupying port 3001). Detection now
  waits for Werkzeug's post-bind `Running on`, spawn failures throw `ProxyStartupError`,
  and the credential prompt is skipped for them.
- *Dead one-shot guards:* `if (!(await initializeTesla()))` never fired — `ServiceStart`
  is an object, always truthy — so the `process.exit(1)` beneath was dead code and
  failures fell through (once into `franklinService!.disconnect()` on a null). Replaced
  by `requireService`, pinned by `tests/commands/init-failure-guards.test.ts`.

**3. REPL ergonomics.** Arrow-key history turned out to be built into `node:readline`
(verified over a PTY: ↑ replays the previous command) — nothing was missing there. Tab
completion was: `createReadline({ completer: completeCommand })`, with the command list
extracted to `src/commands/repl.ts` as the single source for `help` and completion — zero
new packages (`vorpal`-style shell frameworks are unmaintained). Verified live:
`stat` + TAB → `status`.

**4. Commands could be submitted while one was in flight.** Readline keeps emitting
`line` events while an async handler runs, so a second `get-battery-soc` overlapped the
first: interleaved output, two concurrent reads against an already-flaky upstream (more
ReadTimeouts), and a stale `ev-charge> ` rendered over in-progress output when typing
mid-command. The REPL now gates: non-local commands are skipped with an explicit line
(`LOCAL_WHILE_BUSY` keeps `help`/`status`/`exit` available — `exit` matters most during a
hang), sub-prompt answers like `80` are dropped silently, and the prompt is blanked while
busy. No queue: a queue would hide the delay and still fire every accidental duplicate at
Franklin, and the proxy needs none of its own — the shared loop lock already serializes
its network calls. Verified live: rapid double-submit runs once and prints the skip line;
`help` mid-flight does not re-prompt early. Supporting fixes: httpx timeouts carry no
message, so `details` falls back to the exception type (`HTTP 500 — Internal error:
ReadTimeout` instead of a bare `Internal error`), and the Franklin axios timeout went
30s → 60s so a queued or retrying proxy response is never cut off mid-flight.

---

## Phase 3 — Python proxy security + packaging (~0.5 d)

**Status: ✅ complete.** All seven items landed on `phase-3-proxy-security`. 216 tests
green (7 of them the new proxy smoke suite), lint clean. Verified live: curl without a
token → 401 naming `X-Proxy-Token`; the daemon session recorded its token in
`runtime.json`; a one-shot command attached using it (`/health → /auth → /soc` all 200);
`exit` from a fresh process got `/shutdown 200` and stopped the proxy cleanly;
occupying port 3001 still produces the honest EADDRINUSE guidance.

1. ✅ **Shared secret:** Node mints 32 random bytes per spawn, passes them via
   `FRANKLIN_PROXY_TOKEN`, Flask requires `X-Proxy-Token` on every route except
   `/health` (`hmac.compare_digest`, checked *before* `require_client`). The proxy
   refuses to boot without the env var, so a manual launch can never come up open.
   The token is stored **raw** in `runtime.json` (owner-only 0600) — see the
   deviation note below; a state file without one (pre-Phase 3) degrades honestly:
   `exit` falls back to SIGTERM, attach lets the proxy's 401 speak, which
   `upgradeTokenRejection` turns into `lsof` guidance rather than a credentials error.
2. ✅ **`/health` no longer leaks `gateway_id`** — Node only ever read `status`.
3. ✅ **The proxy keeps no password copy of its own** — `_token_fetcher` is gone
   (local to `/auth`). **Evidence-based deviation:** one copy unavoidably remains
   inside franklinwh's `TokenFetcher`, because `Client.refresh_token()` re-runs the
   full login (posts an MD5 of the password) and the library has no refresh-token
   path. The login response was introspected live: **no refresh token exists** —
   keys are `token` plus account/MFA metadata — so no client-side workaround can
   drop it. Exit criterion adjusted below to what is true.
4. ✅ **`/shutdown` is signal-based:** replies, then SIGTERMs itself from a short-lived
   thread; the main-thread handler raises `SystemExit`, so `serve_forever` unwinds and
   the interpreter exits normally. Live: `/shutdown 200` → **exit code 0**, no
   traceback, no `os._exit`. `stopProxy`/`exit`/`terminateProcess` comments updated —
   the response can still lose the 0.2s race, so the signal escalation remains the
   guarantee.
5. ✅ **Loopback fail-fast:** optional `FRANKLIN_PROXY_HOST` (the CLI never sets it)
   refuses anything outside `127.0.0.1`/`localhost`/`::1` with a message naming the
   battery-write routes.
6. ✅ **`requirements.txt` pins `franklinwh>=2026.2.1`.** The smoke venv installs
   2026.3.0 under that pin and boots the proxy, so the pin is verified against a
   newer release too, not just what is installed.
7. ✅ **Smoke test** (`tests/proxy-smoke.test.ts`): temp venv built from
   `requirements.txt` (cached in the OS tmpdir; one pip retry because the first run
   downloads everything), then asserts health-without-gateway_id, 401s for missing and
   wrong tokens, decorator order (right token, no `/auth` → "Not authenticated"),
   refusal without `FRANKLIN_PROXY_TOKEN`, refusal of `0.0.0.0`, and the clean exit-0
   shutdown. Skips when `python3` is absent. Live Franklin calls live in
   `tests/live/franklin-live.test.ts`, gated behind `RUN_LIVE_TESTS=1` with
   env-var credentials (the suite force-disables the keychain).

**Verified API surface** (`franklinwh 2026.2.1`, confirmed by introspection — the proxy's
calls are correct): `TokenFetcher(username, password)`, `Client(fetcher, gateway, url_base)`,
`refresh_token`, `get_stats`, `get_mode`, `set_mode`, `get_composite_info`,
`get_home_gateway_list`, `Mode.{time_of_use,self_consumption,emergency_backup}`, and
exceptions `InvalidCredentials` / `AccountLocked` / `DeviceTimeout` / `GatewayOffline`.

**Deviation — `token` (not `tokenHash`) in `runtime.json`:** the Phase 2 note imagined a
hash, but both readers — `exit` authenticating `/shutdown` and the attach flow
authenticating everything else — must *present* the secret; a hash has no reader that
can authenticate. The file is owner-only, and a same-user process could read the token
from the proxy's environment anyway, so storing it raw adds no exposure.

**Exit criteria:** ✅ requests without the token get 401 (smoke suite + live curl);
✅ no plaintext password persists *beyond what franklinwh itself requires for token
refresh* — the proxy's own copy is gone and the constraint is documented above;
✅ `exit` shuts the proxy down cleanly with no `os._exit` (live: exit code 0).

---

## Inter-phase — REPL sub-prompt bugs (all four fixed)

The human reported four defects in the `set-battery-buffer` / `set-ev-charge-limit`
prompts: every keystroke echoed twice, alphabetic input accepted by numeric questions,
no cancel key, and a prompt that "echoes input but does nothing" after an answer.

**Root cause (bug 4 almost certainly included):** `prompt()` opened a *second* readline
Interface on the same stdin while the REPL's interface was still live. Two terminal-mode
interfaces echo every keystroke; `rl.question` has no key filtering and no cancellation
path; closing the nested interface tears down stdin state the main prompt still needs.
Fix: `src/commands/prompt.ts` — one interface, ever. A sub-prompt borrows the REPL's
readline via one-shot listeners (`line`, input `keypress`, interface `SIGINT`, `close`),
removes them on every exit path, and swaps the tab completer out for the duration.
One-shot flows still create a private interface and close it.

**Mechanics verified empirically against Node 24** (none of this is in the docs):
- a lone ESC does not fire immediately — `emitKeypressEvents` waits 500 ms
  (`ESCAPE_CODE_TIMEOUT`) so it never eats a real escape sequence; cancel lands ~0.5 s
  after the keypress;
- keystroke processing runs through the instance method `_ttyWrite`, and an
  instance-level patch intercepts every key *before* echo — that is how `promptNumeric`
  swallows non-digits deterministically;
- `rl.completer` is an instance property (swapping it to `undefined` disables tab safely);
- an `rl.on('SIGINT')` listener converts Ctrl+C from process-kill into cancel.

**Behavioural choices:**
- `promptNumeric` returns `string | null`: `null` → `Cancelled.` on its own line; `''`
  (bare Enter) keeps the old invalid-input warning.
- `prompt()` folds a cancel into `''`, so free-text/y-n call sites and `CommandContext.ask`
  are untouched — ESC at a y/n prompt behaves exactly like answering "no". (Plan had
  proposed widening `ask` to `string | null`; folding needed fewer changes and is
  behaviourally identical at every call site.)
- answers are stripped from the shared history so `25` cannot resurface via ↑;
- command names typed at a *free-text* prompt go to the main handler (`help` mid-question
  prints help and the `finally` redraws the question); at a *numeric* prompt the letters
  are keystroke-blocked by design (bug 2's fix), so reaching that redraw live requires a
  free-text prompt.

**Live verification (PTY, three sessions):** single `7` echo (never `77`); `a` never
echoed and never buffered (backspace + `25` → `✓ Battery buffer set to 25%`); ESC →
`Cancelled.` on its own line; every subsequent command dispatched normally (bug 4 fixed);
clean shutdown each time. Buffer restored to 20% afterwards.

**Resolved (2026-10-16, `feature/phase-4-vcp-commands`):** the 403 that blocked the
redraw branch — and `charge-from-battery`'s success path — was Tesla's Vehicle Command
Protocol requirement; commands now route through a managed `tesla-http-proxy` sidecar
(see **"Landed: Tesla Vehicle Command Protocol (signed commands)"** below), and a
signed `set_charge_limit` was accepted by the physical vehicle. The redraw branch
remains pinned by its source guard; it can now be exercised live with a successful
command.

**Tests:** `tests/commands/prompt.test.ts` — 15 cases driving a real terminal-mode
readline over PassThrough streams (digit filtering, backspace, ESC, close-during-question,
completer swap, history strip, main-handler split) plus source guards on the index.ts
wiring.

---

## Phase 4 — Credential UX + spec'd charging behavior (~1.5 d)

**Depends on Phase 1.5** (shared handlers) so the percent math is deleted once, not twice.

**Status: ✅ complete (2026-10-17).** 4a ✅ complete (before this phase). 4b's energy
math ✅ complete on `feature/phase-4-energy-math`; items 4-5 (JSON config surface +
first-run prompts) ✅ complete on `feature/phase-4b-config-surface`; the Tesla
VCP/403 blocker ✅ resolved on `feature/phase-4-vcp-commands` (live-verified against
the physical vehicle); items 6-7 ✅ closed on `complete/phase-4` — explicit
`--start`/`--dry-run` flags replace the `offerToStart` prompt, and
`set-battery-buffer` was removed in favor of `config --set-buffer` (user decision).
No changelog: explicitly waived — the project is unreleased with no users.

### 4a. Replace the password-prompt stub

**✅ complete before this pass — deviation:** secrets are masked by the hand-rolled
`promptSecret` in `src/commands/prompt.ts` (single readline, `*` per keystroke, falls
back to a loudly-warned unmasked prompt when masking is unavailable), and `inquirer` was
dropped from `dependencies` instead of being used. The old stub/TODO at `index.ts:19-52`
is gone. The FranklinWH `gateway_id` prompt stays visible on purpose — it is an
identifier, not a secret.

### 4b. `charge-from-battery` → energy math, percent rule **deleted**

> **Decision (locked):** kWh/energy math only. The raw "battery % − buffer %" comparison is
> **removed entirely** — no `--mode percent` fallback, no compat flag. Rationale: comparing a
> % of a ~13.5 kWh house battery against a % of a ~75 kWh vehicle is dimensionally invalid and
> can request ~6x more energy than the battery holds.

1. ✅ **New pure module `src/utils/energy.ts`** (no I/O — this is the "business logic in
   JavaScript" that `prompts.md:6` asks to keep editable):

   ```ts
   export interface EnergyConfig {
     batteryCapacityKwh: number;   // FranklinWH aPower 2
     evBatteryKwh: number;         // Model Y usable
     bufferPercent: number;        // existing setting, 0-100
     chargeEfficiency: number;     // onboard-charger / converter losses
   }
   export interface EnergyChargeLimit {
     batteryAvailableKwh: number;
     evCurrentKwh: number;
     evTargetKwh: number;
     targetPercent: number;        // already clamped to Tesla's 50-100 window
     limitedBy: 'none' | 'battery' | 'ev-capacity' | 'tesla-minimum';
     rawPercent: number;           // unclamped, to explain a tesla-minimum result
   }
   export function computeChargeLimit(
     evSoc: number, batterySoc: number, cfg: EnergyConfig
   ): EnergyChargeLimit
   ```

   **Deviation from the sketch above:** the result type is `EnergyChargeLimit`
   (renamed), `limitedBy` gained `'none'` (the spec's three values leave no answer
   for "nothing clamped it"), and `rawPercent` was added so the log line can show
   what the math said before Tesla's floor applied. Config and SoC validation both
   happen inside the module, throwing with a message that names every bad field.
   **`minChargeKwh` (in the original sketch) was later removed entirely** — see
   item 3.

2. ✅ **Math:**
   `batteryAvailableKwh = batteryCapacityKwh x max(0, batterySoc - bufferPercent) / 100`
   then `evTargetKwh = min(evBatteryKwh, evCurrentKwh + batteryAvailableKwh x chargeEfficiency)`
   then `targetPercent = clamp(round(evTargetKwh / evBatteryKwh x 100), 50, 100)`.
3. ✅ **Delete both percent call sites.** By this phase Phase 1.5 had already unified
   them into the shared handler, so the deletion was one site: the inline rule in
   `src/commands/vehicle.ts` (`chargeFromBattery`). Replaced with one
   `computeChargeLimit` call reporting the kWh breakdown
   (`Battery available: 9.4 kWh - EV now: 41.3 kWh -> target 66%`). Unreadable SoC
   input (the proxy can omit `battery_soc`) fails cleanly instead of flowing `NaN`
   into the limit.
   **Insufficient energy fails with the reason (user decision, superseding the
   original `minChargeKwh` threshold):** the threshold was removed from the config
   and the math; `limitedBy: 'battery'` now means "the limit the math produces does
   not exceed the EV's current SoC" (checked before `ev-capacity`, so a full EV is
   also `battery`). `chargeFromBattery` fails with the numbers behind it —
   `Not enough energy to charge: the solar battery has no energy above its 20% buffer`
   / `... 0.3 kWh above its 20% buffer cannot raise the EV charge limit above its
   current 55%` / `Cannot charge: the EV is already fully charged` — instead of the
   old `not enough charge available` string or the former `ok: true` skip. A
   tiny-but-actionable spare (e.g. 0.27 kWh moving the target 50.4% -> 51%) now
   proceeds; there is no minimum.

4. ✅ **Capacities are now required** (no percent fallback to lean on): first run of
   `charge-from-battery` prompts for missing values via the existing prompt helpers
   (decimal-capable `promptNumeric`) when a TTY is attached, then writes `config.json`;
   without a TTY it fails listing the missing fields and how to set them. `config`
   displays the values plus the file path. **Deviation:** the planned
   `StoredCredentials.settings` home was replaced by a hand-editable `config.json`
   (single source of truth, validated on every read and on every write), and
   `settings` itself was removed from `StoredCredentials` along with the old
   battery-buffer accessors — no users existed to migrate.
5. ✅ **Config surface:** `config --set-battery-kwh <n>`, `--set-ev-kwh <n>`,
   `--set-buffer <percent>`, `--set-efficiency <0-1>` all write `config.json`
   (the standalone `set-battery-buffer` command was later removed — see item 7).
   `DEFAULT_ENERGY_CONFIG` is gone: `energy.ts` carries
   validation only, never values. Hand-edit mistakes are echoed with the file path.
   (`--set-min-kwh` was removed with `minChargeKwh`; existing files carrying the
   key still load and the key is dropped on the next write.)
6. ✅ **Unify the start-charging behavior** (`complete/phase-4`, amended
   `fix/phase-4-followups`): the `offerToStart`
   argument and the REPL's y/n prompt are gone — flags are the consent model,
   identical in both modes. Default sets the limit and never starts charging;
   `--start` also starts charging (inheriting wake, response-envelope and
   state-confirmation checks); `--dry-run` computes and prints the target without
   sending anything. `--start` with `--dry-run` is rejected before any I/O. The
   REPL parses the flags via `parseCommandArgs` and routes `--help` through
   `printCommandHelp`. **Amended 2026-10-17 (user):** the y/n prompt is back as
   the no-flag default when a terminal is attached — flags stay the
   non-interactive consent model; see the "post-Phase-4 fixes" entry below.
7. ✅ **Superseded, not built** (`complete/phase-4`, user decision): instead of
   `set-battery-buffer --get`, the standalone `set-battery-buffer` command was
   **removed entirely** — `config.json` is the single source of truth, so the
   buffer is read via `config`/`status` (or by editing the file) and written via
   `config --set-buffer <percent>` or a hand edit. A source guard pins both
   absences (no Commander definition, no REPL case).
8. ✅ **Tests** (`tests/utils/energy.test.ts`, 23 cases): empty / over-cap buffer,
   `bufferPercent` 0 and 100, insufficient energy (zero spare, rounding-eaten spare,
   zero-gain rounding-up, full EV), efficiency `1.0` and `0.5`, the
   50 % floor, config + SoC validation, the no-minimum-threshold behavior flip,
   and the 13.5 kWh-battery -> 75 kWh-car case that motivated this change (asserts 63 %,
   i.e. **not** the old nonsensical 80 %). `tests/commands/vehicle.test.ts` covers the
   handler wiring: kWh breakdown log, both unreadable-SoC failures, the 50 % fallback
   message, and the skip-write-when-full path.

**Exit criteria:** ✅ passwords never echo; ✅ `charge-from-battery` produces a
unit-correct, defensible limit and explains itself in kWh.

### Deferred from this pass — nothing left; Phase 4 is complete

Every deferred item is closed: config surface + first-run prompts
(`feature/phase-4b-config-surface`), the VCP/403 blocker
(`feature/phase-4-vcp-commands`, live-verified), flag unification and the
`set-battery-buffer` removal (`complete/phase-4`). The breaking-change callout
(item 3 of the old list) is **waived by decision**: the project is unreleased
with no users, so no changelog is maintained yet — re-evaluate when that
changes. Further ideas live in `TODO.md` (post-phase work: command renames,
wake/phantom-drain research, event-driven charging, solar-history math).

### Landed: Tesla Vehicle Command Protocol (signed commands)

The 403 blocker is fixed on `feature/phase-4-vcp-commands`: Tesla's official
`tesla-http-proxy` (teslamotors/vehicle-command) now runs as a managed sidecar and
every vehicle command is signed with the enrolled virtual key.

- **`src/services/TeslaCommandProxy.ts`** — finds the binary (`ECC_TESLA_PROXY_BIN`
  or PATH + ~/go/bin), generates TLS material once into `tesla-proxy/` (openssl, SAN
  localhost; LibreSSL lacks `-addext` so a config file is used), requires the
  `pair-tesla-key` private key, spawns `-host localhost -port 4443`, waits for a TLS
  handshake signed by its own cert, records `tesla-proxy.json`, and stops via the
  same `terminateProcess` escalation as the Franklin proxy. Prerequisite order:
  attach -> binary -> command key -> TLS, so each failure names one fix.
- **`TeslaService`** — `commandProxy` resolver in the config; `setChargeLimit` /
  `startCharging` / `stopCharging` route through a per-port cached client at
  `https://127.0.0.1:4443` with the proxy cert as the trust anchor; `wake_up`,
  `vehicle_data`, tokens stay on the direct Fleet client. `createClient` is shared,
  so auth/refresh/error-wrapping behave identically on both; 401 retries stay on
  the client that issued them. A refused proxy connection maps to run-start
  guidance; no resolver configured (tests) keeps the legacy direct path.
- **Lifecycle** — `start` reports `✓ Tesla command proxy: pid …, port 4443`
  (non-fatal), `exit` stops it cross-process, REPL close stops only what that
  session spawned; one-shot commands lazy-spawn it through the resolver.
- **Tests** — `tests/services/tesla-command-proxy.test.ts` (binary discovery, real
  openssl TLS pair + a live handshake proving the cert works as its own CA, real
  boot/attach/stop of the installed binary with a throwaway key, both guidance
  paths) and `tests/services/tesla-command-routing.test.ts` (command vs direct
  routing, CA pinning, resolver-null and legacy fallbacks, ECONNREFUSED mapping).
- **Live status (2026-10-16):** ✅ **verified end-to-end against the physical
  vehicle.** `start`/`exit` cycle works against the real machine; before key
  enrollment an idempotent `set_charge_limit(current)` reached the vehicle
  through the proxy and was rejected with `412: your public key has not been
  paired with the vehicle` (surfaced by the existing 412 mapper with that
  exact remedy). Diagnosis via `pair-tesla-key --check-only` showed the whole
  app-side chain green (local = hosted = Tesla-registered key), isolating the
  gap to the vehicle keychain; after the user tapped the `_ak` link in the
  Tesla app, the same idempotent command printed
  `OK: signed command accepted by the vehicle`. Note: re-running
  `pair-tesla-key` only re-prints the link — the tap is the enrollment — and
  if the app claims the key already exists, remove it from the vehicle's key
  list first, then re-tap.

### Fix landed off-plan: REPL help drift (`config` / `pair-tesla-key`)

Reported after the config-surface pass: both existed as Commander commands but were
absent from the REPL's `help` **and** its dispatch switch, so typing them interactively
printed "Unknown command" -- and the sync-guard only checked cases -> advertised, so the
drift was invisible. Fixed on `fix/repl-config-pairing`:

- Both actions extracted into shared runners (`runConfig`, `runPairTeslaKey`, modeled on
  `runAuthenticate`); only the Commander wrappers turn failure into a process exit code,
  so a REPL session cannot inherit one.
- `parseCommandArgs` in `src/commands/repl.ts` gives the REPL flag parity with the
  one-shot commands (Commander-style errors for unknown options / missing values), and
  `REPL_COMMANDS` advertises both commands for `help` and completion.
- The REPL line is now split into command token + inline flags; the busy-gate therefore
  recognizes `config --set-x` instead of silently dropping it.
- The sync-guard runs **both** directions: every case is advertised and every advertised
  command has a case.
- `start` reports the energy-config state between the service lines (valid / missing /
  invalid, echoing every problem), non-fatal -- only `charge-from-battery` and
  `set-battery-buffer` need the file.
- `--help` / `-h` work on the flag-taking REPL commands (`config`, `pair-tesla-key`),
  rendered from the Commander definitions via `helpInformation()` so the descriptions
  cannot drift; `help <command>` routes to the same renderer, matching the CLI.

---

## Phase 5 — Open-source packaging (~0.5 d) — ✅ Complete (2026-10-17; merged to `main`, GitHub CI green 2026-10-18)

1. ✅ Stale-plan correction: `LICENSE` (Eric Socolofsky) and `author: "ericsoco"` were already
   filled before this phase ran (see the decision-table row below). Added `repository`, `bugs`,
   `homepage`, and `bin: { "ev-charge-coordinator": "./dist/index.js" }` (shebang at
   `index.ts:1`, preserved by tsc). Added a `files` whitelist (`dist`, `python`, `scripts`,
   with `__pycache__` negated) — without it `npm pack` shipped 143 files including `src/`,
   `tests/`, and this workplan; it now ships 92. `engines` bumped `>=18` -> `>=24` (18/20 are
   EOL; user chose CI on Node 24 + 26); README prerequisites and first-time install (`npm ci`)
   aligned.
2. ✅ Stale-plan corrections: the `your-username` placeholder was already gone (README uses
   `ericsoco`), the CLI Reference was already current after the Phase 4 passes, and the
   public-key hosting + pairing deep-link flow was already documented under "Tesla Virtual Key
   pairing". Added: authorize-host vs token-host subsection (incl. the OIDC-metadata
   contradiction and the `ECC_TESLA_TOKEN_URL` override); the `charge-from-battery` kWh formula
   from `src/utils/energy.ts` with the `limitedBy` reasons; the venv / `ECC_PYTHON` / `python3`
   resolution entry in Troubleshooting (quotes the real failure text from
   `run-python-check.mjs`); refreshed architecture diagram (commands layer, `tesla-http-proxy`
   signing sidecar, teardown semantics) and project-structure tree; a Checks section
   (`npm run check`, `RUN_LIVE_TESTS=1` gating, CI pointer); keytar maintenance note under
   Security; CI badge.
3. ✅ `.github/workflows/ci.yml`: push-to-main + PRs, Node 24/26 matrix; installs
   `libsecret-1-dev` before `npm ci` because keytar compiles from source on these ABIs; then
   `npm ci` -> build -> lint -> typecheck -> unit tests -> `python -m py_compile
   python/franklin_proxy.py`. YAML parsed locally with `js-yaml`; the first real run on
   GitHub (2026-10-18) was green on both matrix legs.
4. ⏸️ **Deferred by user decision (2026-10-17):** `CONTRIBUTING.md`, issue/PR templates,
   `CHANGELOG.md` — not ready to welcome external contributions. Revisit before any outreach;
   the Phase 4 breaking-change callout (see §8 Risks) stays pending on `CHANGELOG.md`.
5. ✅ `AGENTS.md`: `npm ci` / `check` / `lint` / `typecheck` commands, `src/commands/` +
   `TeslaCommandProxy` / `ProcessManager` sidecar + `src/utils/{config,energy,color}.ts`
   layout, CI and `RUN_LIVE_TESTS` notes.

**Exit criteria:** ✅ satisfied 2026-10-17. Fresh clone of this branch into `/tmp`, followed
README top-to-bottom: `npm ci` (lockfile in sync, keytar installed), `.venv` + `pip install -r
python/requirements.txt`, `npm run check` -> 340 passed / 2 skipped, then live `node
dist/index.js get-battery-soc` -> `Solar Battery SoC: 16.316%` with one-shot proxy spawn and
clean `/shutdown`. Bin packaging proven separately: `npm pack` -> installed the tarball in a
scratch dir -> `./node_modules/.bin/ev-charge-coordinator --help` prints the real usage.

**Close-out (2026-10-18):** Phase 5 landed on `main` (user-merged, `main` @ `6891126`);
GitHub Actions green on Node 24 + 26 — the first real run of the workflow (user-confirmed).
The last open non-destructive check, `get-charging-state` against an asleep car, returns the
408 wake-gap message with useful guidance (user-verified 2026-10-18). §10 acceptance
checklist updated to match what the live sessions already verified.

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
| Energy config home | Hand-editable `config.json` in the config dir - single source of truth for all energy settings; validated on read and on write; `config --set-*` and `set-battery-buffer` write it; `StoredCredentials.settings` and `DEFAULT_ENERGY_CONFIG` removed (user decision) |
| `start` / `exit` model | State-file-backed supervisor so `exit` works from a fresh process (today it structurally cannot) |
| Hidden password input | Hand-rolled masked readline prompt (`src/commands/prompt.ts`); `inquirer` dropped from deps |
| Virtual key path | Docs-confirmed only: EC keygen -> host public key -> `POST /api/1/partner_accounts` -> mobile pairing deep link. The client-assertion `objects/virtual_key` API is **unconfirmed** and off the table without verification |
| Command-handler duplication | Extract `src/commands/` **before** Phase 4 (added as Phase 1.5) |
| Test framework | `vitest`; live Tesla/Franklin calls gated behind `RUN_LIVE_TESTS=1` |
| Proxy event loop | One process-lifetime loop behind a lock; per-request loops broke httpx's pooled connections (`Event loop is closed`) |
| Franklin read failures | Retry idempotent reads ×3 (`run_read`, 0.5s/1.5s); the four mapped exceptions are deterministic and never retried |
| REPL ergonomics | `node:readline` built-ins only — `completer` for tab completion, shared `REPL_COMMANDS` in `src/commands/repl.ts`; no shell-framework package |
| REPL in-flight commands | Reject non-local commands while one is running (busy-gate); whitelist `help`/`status`/`exit`; no queue — the proxy's loop lock already serializes its network calls |
| REPL sub-prompts | One shared readline with one-shot listeners (a second interface on the same stdin caused the double echo and the broken prompt); digits-only keystroke filter via an instance `_ttyWrite` patch; ESC/Ctrl+C cancel; cancel folds to `''` at free-text prompts so `CommandContext.ask` keeps its `Promise<string>` type |
| Output theming | User-chosen 24-bit RGB palette in `src/utils/color.ts`, zero dependencies; gated at call time on `isTTY && !NO_COLOR`, so tests, redirects, and NO_COLOR users receive byte-identical plain output |
| Proxy shared secret | Raw token minted per spawn, stored in owner-only `runtime.json` (a hash cannot authenticate); `hmac.compare_digest` on every route except `/health`, which the attach flow needs before it knows the token |
| `LICENSE` holder / `author` | Supplied before Phase 5 ran: "Eric Socolofsky" in `LICENSE`, `ericsoco` as npm `author` |

---

## 8. Risks & Caveats

- **Fleet API is billed**, and `set_charge_limit` (`TeslaService.ts:384`) may be deprecated on
  newer firmware in favor of scheduled-charging endpoints. Verify against the vehicle during
  Phase 1. **⚠️ Confirmed materialized (inter-phase REPL session): Tesla now answers HTTP 403
  "Vehicle Command Protocol required" for the REST vehicle-commands endpoint
  (docs: `announcements#2023-10-09-rest-api-vehicle-commands-endpoint-deprecation-warning`),
  so `setChargeLimit` — and with it `charge-from-battery`'s success path — was dead until the
  Vehicle Command Protocol (signed commands) is implemented. **✅ Resolved on
  `feature/phase-4-vcp-commands`: commands route through a managed `tesla-http-proxy`
  sidecar (see Phase 4 "Landed: Tesla Vehicle Command Protocol"), and the signed
  `set_charge_limit` was accepted by the physical vehicle on 2026-10-16 after the
  user enrolled the key with the `_ak` pairing tap.**
- **FranklinWH is write-capable** - `set_mode` is exposed by the proxy. `charge-from-battery`
  must stay **read-only** against the battery; never mutate operating mode without an explicit
  user command.
- **`keytar@7.9.0` is deprecated** with no prebuilt binaries for newer Node/OS targets. It is
  correctly optional today (`credentials.ts:39-49`), so the AES-256-GCM file fallback will carry
  most users. README note added in Phase 5 (Security section).
- **Public-key hosting is a hard external prerequisite** for Tesla commands and cannot be
  automated away by this CLI.

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

## 2026-10-17 — charging results are verified; `get-charging-state`; wake inventory

### Fix landed: charging commands verify their results (false-success bug)

- **Root cause:** `TeslaService.postVehicleCommand` ignored the response *body*.
  `tesla-http-proxy` reports a refused action as **HTTP 200** with
  `{response:null, error:"car could not execute command: …", error_description:"", txid:"…"}`
  (its nominal-error path); the Fleet REST fallback uses
  `{response:{result:false, reason:"disconnected"}}`. Axios treated both as
  success, so `start-ev-charging` on an unplugged car printed `✓ EV charging started`.
- **Layer 1 — envelope check:** `postVehicleCommand` now calls
  `assertVehicleCommandAccepted(response.data)`: fails on `result:false` (with a
  per-reason hint: disconnected → not connected to a charger; no_power; complete;
  already_stopped) and on any non-empty `error` field; benign "already in that
  state" reasons (`requested`, `is_charging`, `not_charging`) are accepted; a
  body with no failure evidence is accepted (forward-compatible). The literal
  200-with-error-body envelope is pinned as a regression test.
- **Layer 2 — post-condition confirmation:** `startCharging`/`stopCharging` now
  poll `charge_state` after the command (the car is awake from `wakeUp()`) every
  3 s for up to 12 s (`chargingConfirm` config; shrunk to 250 ms/10 ms in tests)
  until `Charging` (start) / not-charging (stop). Otherwise they fail naming the
  observed state: `Disconnected` → "plug in the vehicle", `NoPower` → charger
  provides no power, `Stopped`/`Idle` → check charge limit vs current level,
  `Complete` → charging already completed; a mid-poll read failure surfaces the
  read error. This distinguishes "accepted" from "actually charging" for firmware
  that answers start-while-unplugged with plain success.
- Earlier Q&A recorded: the ~90 s latency was always the honest `wakeUp()`
  (deep sleep + poll + 429 backoff) — the bug was only body-ignored acceptance;
  instant false success after a restart was the car still awake from the prior
  wake (nothing caches results — the proxy caches only its crypto session); and
  `--debug` only adds tracebacks to service-startup failures, while command
  errors print `✗ Error:` regardless — the 200 sailed through with no error
  detected at all.
- Handler UX: `start-ev-charging`, `stop-ev-charging`, and `charge-from-battery`
  log "(waking the vehicle if needed; asleep cars take up to a minute)…" before
  the command, so the pause reads as intent rather than a hang.

### Command record: `get-charging-state` (one-shot + REPL)

- Handler `getChargingState` in `src/commands/vehicle.ts`, reusing `getStatus()`
  (already the narrow `vehicle_data?endpoints=charge_state` read). Prints
  `Charging state: …`, `Battery: X% (charge limit Y%)`, and charge rate +
  minutes-to-full when charging.
- **No wake** (documented in the handler docstring and README): an asleep car
  returns the standard HTTP 408 via `describeError`. The read-side wake gap
  stays open pending the phantom-drain decision (see inventory below).
- Wired through `REPL_COMMANDS` + dispatch case + Commander
  (`requireService('Tesla', …)` + `runCommand`) + README (CLI table and
  interactive list). Tab-completion expectation updated; the one-shot
  `requireService` call-site count guard is now 8.

### Where wake happens (inventory, verified against this commit)

| Call site | Wakes? | Asleep-car behavior |
|---|---|---|
| `TeslaService.wakeUp()` (definition) | — | the only wake implementation: wake_up POST + poll + 429 backoff |
| `setChargeLimit` (→ `set-ev-charge-limit`, `charge-from-battery`) | yes | waits (up to ~3 min), then honest failure |
| `startCharging` (→ `start-ev-charging`, offer path) | yes | same |
| `stopCharging` (→ `stop-ev-charging`) | yes | same |
| `getStatus` (→ `get-charging-state`, post-command confirmation polls, status/offer paths) | **no** | HTTP 408 `vehicle unavailable` |
| `getStateOfCharge` (→ `get-ev-bsoc`, `charge-from-battery` EV read) | **no** | HTTP 408 |
| `getChargeLimit` | **no** | HTTP 408 |

- `charge-from-battery` therefore dies at its EV-read step (408) before ever
  reaching `setChargeLimit` on an asleep car. No wake changes in this pass, per
  instruction; this table is input for the phantom-drain TODO decision.

### Test/debt notes

- New coverage: 4 envelope tests, 8 state-confirmation tests, 4
  `getChargingState` handler tests; routing-test adapter now answers the narrow
  `charge_state` read with a scripted `charging_state` sequence. Gate:
  `npm run check` green — 333 passed / 2 skipped.
- The real-process `startTeslaProxy` test was failing for an environmental
  reason: an orphaned `tesla-http-proxy` from the 2026-10-16 live session still
  held port 4443 while its state file had been cleaned, so the test's spawn died
  on the occupied port (silent exit). Killed the orphan; if it recurs run
  `lsof -ti tcp:4443 | xargs kill` before the proxy test.
- Live-verification follow-ups (both since closed): unplugged `start-ev-charging`
  now fails loudly (verified in the post-Phase-4 run below); `get-charging-state`
  against an asleep car returns the 408 wake-gap message (user-verified 2026-10-18).

---

## 2026-10-17 (Phase 4 close-out) — explicit charging flags; `set-battery-buffer` removed

Branch `complete/phase-4`. Phase 4 is **complete**; this entry records the last two items.

- **Item 6 — `--start` / `--dry-run` unify the start-charging behavior.** The
  `offerToStart` argument and the REPL's y/n prompt are gone; flags are the
  consent model, identical in both modes. Default sets the limit and never
  starts charging; `--start` also starts charging (inheriting `startCharging`'s
  wake, response-envelope, and state-confirmation checks); `--dry-run` prints
  `✓ Dry run: would set the EV charge limit to N%` and sends nothing.
  `--start --dry-run` is rejected before any I/O. REPL parses the flags via
  `parseCommandArgs` (`BOOLEAN_FLAGS` entry) and routes `--help` through
  `printCommandHelp`; source guards pin the wiring. **Amended the same day**
  (`fix/phase-4-followups`, user request): the no-flag path prompts
  `Start charging now? (y/n)` in a TTY again — see the dated entry below.
- **Item 7 — superseded by removal (user decision).** `set-battery-buffer` is
  gone: handler, Commander command, REPL case + digit prompt, help entry,
  tests, README references. `config.json` is the single source of truth, so the
  buffer is read via `config`/`status` (or by editing the file) and written via
  `config --set-buffer <percent>` (new value flag on `config`, same validator
  and error style as the other setters) or a hand edit. Source guards pin both
  absences; the `prompt.test.ts` numeric-sub-prompt guard now pins that the
  buffer prompt is gone (remaining prompts: charge limit, vehicle selection).
- **Changelog: waived** (user decision — unreleased project, no users, nothing
  to maintain yet).
- Gate: `npm run check` green — 333 passed / 2 skipped. Live-verified:
  `charge-from-battery --help`/`config --help` show the new flags; a
  `config --set-buffer` round-trip writes `config.json`.

---

## 2026-10-17 (post-Phase-4 fixes) — consent prompt gates limit+start; vehicle-408 advice

Branch `fix/phase-4-followups`.

- **`charge-from-battery` consent now gates the whole action (user flow).**
  With no flags the handler reads both SoCs, runs the math, shows the plan
  (`... -> target N%`), and only then asks
  `Set the EV charge limit to N% and start charging? (y/n)`: `y`/`yes` sets the
  limit and starts charging through the same path as `--start` (wake,
  response-envelope, state-confirmation); declining prints `No changes made.`
  and sends nothing — the earlier set-limit-then-`Start charging now?` ordering
  from this branch is gone. A no-flag run without a TTY (scripted) is an early
  no-op before any read: `Non-interactive run: pass --start to set the limit
  and start charging, or --dry-run to preview.` — set-limit-only is retired.
  `--start` sets and starts without prompting; `--dry-run` unchanged. Per user
  direction a start **notifies without confirming**: it echoes
  `Starting EV charging...` and prints no `✓ EV charging started` afterwards
  (`start-ev-charging` keeps its own confirmation — untouched). `--start` help
  now reads "Set the charge limit and start charging, without prompting";
  README usage examples, command table, REPL list, and smart-charging flow
  updated. Tests: the four consent cases rewritten (prompt names the target;
  decline = nothing sent; non-TTY = hint, no reads), and math/refusal/config
  cases pass `{ start: true }` since a flagless non-TTY run no longer acts.
- **Investigated `HTTP 408: {"error": "timeout"}` on `get-charging-state` /
  `get-ev-bsoc`.** Root cause: reads deliberately never wake the vehicle (wake
  lives on the three command paths), so every read against a sleeping car 408s;
  Tesla varies the body between `vehicle unavailable: vehicle is offline or
  asleep` and a terse `{"error": "timeout"}` (confirmed earlier in-session:
  both reads succeed while the car is awake). `describeTeslaError` had no 408
  branch, so the raw body reached the terminal verbatim. Fixes:
  a 408 branch appends asleep/offline advice ("Reads do not wake vehicle;
  issue a command (e.g. `charge-from-battery --start`)."); JSON-looking raw bodies
  are unwrapped so the terse shape renders `HTTP 408: timeout - <advice>`; and
  `describeAxiosError` passes non-JSON-content-type string bodies through
  instead of falling back to axios's generic status line. Wake behavior itself
  is unchanged — wake research stays open in `TODO.md`. Three new cases in
  `tesla-error-reporting.test.ts` drive all body shapes through the real
  interceptor chain; four new/updated cases in `vehicle.test.ts` pin the
  prompt (y starts, n declines, non-TTY never prompts, `--start` skips it and
  no path prints the confirmation line).
- Gate: `npm run check` green — **338 passed / 2 skipped**. Live-verified after
  the consent rework: `charge-from-battery --help` shows the new `--start`
  text; a flagless non-TTY run prints the hint and exits 0 with no `/soc` read
  (proxy log shows only `/auth`/`/shutdown`); and the PTY decline demo ran the
  full flow (Franklin's gateway recovered — `GET /soc` 200): plan shown
  (`-> target 72%`), prompt answered `n`, `No changes made.` with no command
  routes hit. **Restart any REPL session opened before these fixes to pick
  them up.**

---

## 2026-10-17 (post-Phase-4 fixes, continued) — one-shot teardown; `already_set` no-op

- **Live bug: one-shot hang after a vehicle command.** Any one-shot command that
  sends a vehicle action lazy-spawns `tesla-http-proxy` (the `commandProxy`
  resolver) — but nothing on the one-shot path ever stopped it: `stopTeslaProxy()`
  was wired only to REPL close and `exit`. The child kept the event loop alive,
  so the CLI hung after its last output (user had to Ctrl+C; the run's Franklin
  `/shutdown` line made teardown look like it ran — it did, on the other
  service). `runCommand` now stops a sidecar it spawned in a `finally`, guarded
  by `spawnedTeslaProxyPid()` so an attached REPL/daemon proxy is left alone.
  Source pin in `start-reporting.test.ts`.
- **Live bug: `already_set` treated as a failure.** `set_charge_limit` on a limit
  already at the target returns `car could not execute command: already_set`.
  The proxy surfaces the car's own reason in two shapes (`{response:null,
  error:"…"}` and `{response:{result:false, reason:"…"}}` — the second is the
  Fleet envelope forwarded through the proxy); the benign set was only checked
  on the bare Fleet reason, so `charge-from-battery`'s `y` aborted right before
  the start step. `assertVehicleCommandAccepted` now extracts the wrapped reason
  in both shapes and accepts the benign set (`requested`/`is_charging`/
  `not_charging`/`already_set`), and applies the per-reason hint to the
  extracted car reason — a wrapped `disconnected` now reads `… disconnected (the
  vehicle is not connected to a charger)`, same as the bare reason.
- **Not a bug — the non-TTY hint.** `npm start charge-from-battery` in a terminal
  is an interactive run (`ctx.interactive = process.stdin.isTTY === true`), so
  the plan+prompt is correct; "Non-interactive run" is for piped/redirected
  stdin (`< /dev/null`) — live-verified.
- **Drive-by from `29dcd98`:** its 408-advice rewrite dropped the space between
  the two sentences (`offline.Reads`) and left its three pinned tests red; the
  space is restored and the tests pin the cleaned wording — and the space.
- Harness note: input piped into `script`'s pty reaches the readline interface
  before the prompt is shown and folds into an empty answer (= no), so the
  earlier PTY decline demo was a false positive for the same reason. Drive
  consent-flow demos with `expect` (send the answer on prompt match).
- Gate: `npm run check` green — **340 passed / 2 skipped**. Live-verified:
  `set-ev-charge-limit 59` → `✓ EV charge limit set to 59%` (the `already_set`
  case) exit 0; decline demo → plan (`-> target 59%`) + prompt + `No changes
  made.` exit 0; `y` flow → limit accepted (now `already_set` → no-op success),
  `Starting EV charging...`, then an honest `disconnected (the vehicle is not
  connected to a charger)` because the car is unplugged, exit 1. Every run exits
  on its own with no leftover `tesla-http-proxy`/`franklin_proxy` and no state
  file. Car left at limit 58% (target drifted 59→58 as the battery discharged);
  charging did not start because the vehicle is unplugged — plug it in and rerun.

---

## 10. Acceptance Checklist

Traced back to `prompts.md`:

- [x] `start` starts the Python proxy **and** a resident Node process; PIDs printed
- [x] `exit` from a **separate shell** terminates both, leaving no stray `python3`
- [x] `get-ev-bsoc` / `get-battery-soc` return live values
- [x] `set-ev-charge-limit` / `start-ev-charging` / `stop-ev-charging` succeed against a real
      Model Y (signed via `tesla-http-proxy`; live-verified 2026-10-16, refinements 2026-10-17)
- [x] `charge-from-battery` sets a kWh-derived limit and prints the kWh reasoning (live-verified
      2026-10-17 — see the post-Phase-4 entry above)
- [x] Battery buffer persists across restarts (in `config.json`, set via `config --set-buffer`)
- [x] Tesla OAuth completes in a browser, honors user actions, tokens survive restart + refresh
      (Phase 1 exit criteria, live-verified; rotated refresh token persisted on every refresh)
- [x] FranklinWH credentials prompted once, stored securely, never echoed (Phase 2 human run;
      masking pinned by `tests/commands/prompt.test.ts`)
- [x] No proxy route writable without the shared token
- [x] `npm run build`, `npm run lint`, `npm test` and CI all green (local gate green; GitHub
      Actions green on Node 24 + 26, 2026-10-18)
- [x] MIT `LICENSE` + README CLI docs accurate for the shipped commands (Phase 5)


---

# ⚠️ PART 2 — Phase 1 execution record: P1a + P1b (2026-10-18 → 2026-11-03)

> Archived from [workplan.md](../workplan.md) on 2026-11-03 when P1c planning started —
> the complete P1a (collect-only daemon) and P1b (auto-start decision engine) plans, the
> dated execution Log, and the one-shot ↔ REPL drift audit, all moved verbatim. Historical;
> read workplan.md first. P1b closed with step 8 (live validation) confirmed 2026-11-03:
> live `daemon-config.json` shows `autoStart.enabled: true`, geofence 25 m, log + ntfy.
>
> Also archived from workplan's "Decisions on future work" (resolved by P1b step 5):
> **P1b Tesla resilience pointer (noted 2026-10-21, from P1a step 6)** — the Franklin
> self-heal (`FranklinWHService.reconnect()`, wired into the battery tick) has **no Tesla
> analog in P1a** — EV polling is direct Fleet API HTTPS over OAuth (access-token refresh
> is automatic; un-refreshable auth is a degrade-and-surface case for the human to
> `authenticate`, not a retry loop). When the daemon started issuing signed commands in
> P1b, the `tesla-http-proxy` sidecar entered its path: the command executor got an
> alive-check/respawn before each command (`ProcessManager`), which is simpler than
> Franklin's reconnect — the sidecar is a stateless signer (app key on disk), so there is
> no re-auth session to restore.

## P1b — auto-start decision engine (active execution plan)

> Status: **Step 7 — surfaces + docs complete (2026-11-01,
> `p1b/step7-docs-surfaces`); next: Step 8 — live validation (user + car).**
> Standing rules: one step at a time; **branch per step** (`p1b/stepN-<name>`), gate green
> (`npm run check`) + its own commit; stop for review after each step; the user lands each
> step to `main`. Design rationale: [design.md](./docs/design.md) §3.9 + the decisions below.
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
- **Placement (user, 2026-10-25):** decision logic lives in `src/daemon/` beside
  `eventDetector.ts` — EvPoller owns the whole chain (read vehicle state → detect state
  changes → apply filters → act); filters exist only within that chain. Purity is a
  testing discipline, not a claim of other consumers; revisit the split only if a second
  evaluator (CLI preview, remote/GUI) actually appears.

### Steps

1. **Decision config** — `autoStart` block in `daemon-config.json`: `enabled` (default
   `false`), `filters[]` (`always`, `geofence` + `radiusM`), fail-loud validation (unknown
   type, missing/non-positive radius, non-boolean `enabled`); defaults and template stay in
   lockstep. *(branch `p1b/step1-decision-config` — complete)*
2. **Pure filters** — `src/daemon/filters.ts`: `(input) => {pass, reason}`; `always` +
   `geofence` (location injected by the caller — this step stays fetch-free); unit matrix.
   *(branch `p1b/step2-decision-filters` — complete)*
3. **Decision engine + store** — pure engine (`src/daemon/engine.ts`, beside its filters;
   interlock order: enabled → plugged →
   not-already-charging → battery-above-buffer → filters → compute limit → outcome);
   `DecisionStore` writer (migration adds the `decisions` row mapper/reason codes;
   `filter_results_json`, `dry_run`, session-id idempotency); the intentionally-unpinned
   `decisions` schema-pin arrives. *(branch `p1b/step3-decision-engine` — complete)*
4. **Wiring** — decision consumer hooked at `plug_in` in `EvPoller` (narrow injectable
   seam): decision-time location fetch (Option B), engine run, decision row; tests with
   fakes (plug-in → row; location failure → decline reason).
   *(branch `p1b/step4-decision-wiring` — complete)*
5. **Actuation** — shared charge-limit math extracted from `charge-from-battery`;
   `tesla-http-proxy` alive-check/respawn before commands (Decisions pointer above);
   `setChargeLimit` → `startCharging` gated on `enabled`; `daemon --dry-run`; dry/disabled
   ⇒ zero command calls; interlock-matrix tests. *(branch `p1b/step5-actuation` — complete)*
6. **Notifiers** — `Notifier` interface + `log-only`/`ntfy`/Slack; typed events (decision,
   start/stop, interlock decline, service failures); secrets in credential store;
   failure-isolation tests. *(branch `p1b/step6-notifiers` — complete)*
7. **Surfaces + docs** — store-report decisions section, `status` shows auto-start mode,
   README auto-start section, workplan. *(branch `p1b/step7-docs-surfaces` — complete)*
8. **Live validation** (user + car) — disabled-run decision rows → flip `enabled` → real
   auto-start; buffer interlock; park-away geofence decline; optional ntfy.

**Step 5.1 — ops hardening (user, 2026-10-25; one branch `p1b/step5-1-ops-fixes`, one
commit per issue; each gated).** Recorded from live validation: manual tests passed dark
+ live + geofence (`radiusM: 1` rejection); four issues surfaced.

1. **Daemon lifecycle via the program** — `evcc daemon stop|restart|install|uninstall`
   subcommands beside the foreground `daemon` (Commander v12: parent action + optional
   subcommands). `stop` = label derived from the template plist (same single source the
   scripts use) + `launchctl print`/`bootout` (not-loaded = friendly result); `restart` =
   stop-if-loaded + `bootstrap` of the *already-installed* plist (pure reload — upgrades
   stay `daemon install`); `install [--dry-run]` / `uninstall [--dry-run]` spawn the bash
   scripts via `bash` (no exec-bit need; child exit propagated; repo root resolved from
   the module's own location). REPL has no `daemon` dispatch → no REPL work; the drift
   test's source-regex will see the new `.command('…')` names → explicit subcommand
   exclusion map pinned under `daemon`. New `src/commands/daemonLifecycle.ts` (injectable
   exec seam) + tests + README daemon-section note.
2. **oauth.ts 412/422 disambiguation** — 412 body contains `not been paired` ⇒
   enrollment advice (open the `pair-tesla-key --domain` `_ak` link and approve;
   "key already exists" ⇒ remove the vehicle's old entry first; app-side state via
   `--check-only`; `--rotate-key` invalidates approvals); otherwise the observed
   partner-accounts region text. 422: hash-taken keeps short-circuiting via the `known`
   table; origin/domain/empty/uninformative bodies keep the Allowed-Origins advice
   (the observed live shape); any other body ⇒ neutral passthrough (no wrong
   directions). Four pins in `tesla-oauth.test.ts`.
3. **Wake on writes** (the `setChargeLimit` 408: `wakeUp` did run but the non-429 path
   died after 10 cycles × 2 s ≈ 20 s against a documented 3-minute budget, then
   rethrew the original whose message carried *read* advice) — non-429 wakes honor the
   wall budget (state poll every 2 s, re-`wake_up` at most every 10 s; 429 handling
   untouched); wake exit sites wrap with wake-context messages built from the axios
   cause (no "Reads do not wake"; original kept as `cause` for `--debug`);
   `postVehicleCommand` gains a 408 special case ("went unavailable during the signed
   command… retry") beside ECONNREFUSED; `setEvChargeLimit` prints the same pre-wake
   line `charge-from-battery` uses and `wakeUp` prints one wake-notice — all four
   surfaces converge on `TeslaService.setChargeLimit`, so one fix covers REPL,
   one-shot, and daemon. The deliberate "rethrows the original" pin is re-written.
4. **Local timestamps in human logs** — boundary: human log/status text = local
   `YYYY-MM-DD HH:MM:SS` (new `formatLocalTimestamp(ms)`, local getters — TZ-agnostic
   tests); machine surfaces (`status --json`, store-report JSON, `ev_samples.ts_ms`)
   stay ISO-8601 UTC. Swap sites: `[ev-poll] rich read due`, `[daemon] started at`,
   stale-lock `takenAt`, "Stored tokens valid until". `system.ts`'s ISO helper feeds
   the JSON report + relative ages → stays. `samplers` due-line pin re-written.

### Scope

**In:** `autoStart` config; decision engine + `decisions` audit rows; filters (`always`,
`geofence`); battery-buffer interlock; charge-limit computation + gated start; notifiers;
status/report surfaces.
**Out:** weather-adaptive charging, scheduled windows, multi-EV, telemetry, Modbus, GUI —
Phase 6+.

## P1a — collect-only daemon (complete)

> Status: **Complete — steps 1–7 landed; daemon installed on launchd and in validated
> long-run operation (Log 2026-10-24 entries).** Historical detail below; the active plan
> is P1b above. Design rationale: [design.md](./docs/design.md) §3/§5.

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
write-up in [design.md](./docs/design.md) — the forward reference for Phase 1 work:

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


### 2026-10-24 — P1b step 1 addendum: config reconcile on daemon start

Same branch (`p1b/step1-decision-config`), gate green (exit 0; 584 passed / 2 skipped).
User question: does an existing `daemon-config.json` gain the new `autoStart` block on
next start? Behavior was already correct in memory (absent keys resolve to the dark
default), but the file itself stayed untouched — knobs invisible. Confirmed decision:
**additive reconcile on daemon start** (replaces the "never overwrite" rule with
"operator *values* are the truth").

- `ensureDaemonConfigFile` returns `'created' | 'migrated' | 'updated' | 'exists'`
  (precedence migrated → updated → created → exists) and, after the existing
  create/migrate handling, reconciles: `deepMergeDefaults` merges defaults UNDER the
  file content (file values win; arrays like `filters` replaced wholesale, never
  element-merged; unknown keys preserved) and rewrites only when the bytes would change
  (idempotent; temp + rename, private mode). An **invalid** file stays byte-untouched —
  the operator must see the bad edit to fix it. Still daemon-start-only; `status` never
  creates or rewrites (existing pin).
- `daemon` command prints `daemon-config.json updated: added missing keys with defaults
  (operator edits preserved)` for the new `'updated'` result.
- Tests re-pinned deliberately: "never overwrites" → "fills missing keys, preserving
  operator values" (+ `autoStart` materialized); byte-stable second run with no `.tmp`
  litter; unknown keys survive; geofence chain survives wholesale; invalid untouched;
  legacy migration now reconciles (`migrated` status precedence pinned).
- Tooling note: `read_files` rendered the `ensureDaemonConfigFile` body inaccurately
  (omitted `mkdirSync` + `mode: 0o600`, faked a stray blank line) — `sed | cat -e`
  gave the byte-accurate text; prefer that when exact-match edits fail twice.
- Next: unchanged — Step 2, `src/decision/filters.ts` (branch `p1b/step2-decision-filters`).


### 2026-10-25 — P1b step 2 complete: pure decision filters

Branch `p1b/step2-decision-filters` (off landed main `76dca03`), gate green
(`npm run check` exit 0; 602 passed / 2 skipped; `tests/decision/filters.test.ts` 18/18).

- New package `src/decision/filters.ts` — pure module per design §3.3/§4: no I/O, no
  store, no services; the engine (step 3) / poller wiring (step 4) inject everything.
  - `FilterInput` = the design's `decisionContext`: event + plug state, home secret
    (`HomeLocation | null`), decision-time fix (`VehicleLocation | null`, Option B),
    battery context the step-3 interlocks read off the same object. **`radiusM` lives on
    the filter config only** — an input copy would be a second source of truth.
  - `runFilters(filters, input) → {pass, results}`: AND semantics, **no short-circuit**
    (every result lands in `filter_results_json` even after a failure); empty chain
    passes (design: "empty filters array = all plug-in events"); exhaustive switch whose
    default fails `config_error` with `type: 'unknown'` — a type slipping past config
    validation loud-fails, never passes.
  - `always` → pass always. `geofence` → deny-by-default with ordered checks:
    `home_unset` (actionable `set-home-location` detail) → `config_error` (radius
    missing/≤0/NaN — defense behind step-1 validation) → `location_unavailable`
    (fetch failed/skipped; `vehicle_location` scope + awake-car detail) → haversine
    `distanceM` (R = 6 371 000 m, rounded to whole meters) vs radius: `≤ radius` passes
    (boundary equality passes), else `not_at_home` + distance in reason AND detail.
  - `FilterResult.reason`: `'always' | 'geofence' | 'not_at_home' | 'home_unset' |
    'location_unavailable' | 'config_error'` — this vocabulary serializes into
    `filter_results_json` in step 3.
- Tests (new `tests/decision/`, covered by the existing `tests/**/*.test.ts` glob):
  distance identity/1°-lat ≈ 111.19 km/symmetry · always with all-null inputs ·
  geofence matrix (pass+distance, rounded-radius boundary, outside+distance detail,
  home_unset precedence over location failure, location_unavailable, radius 0/-5/
  undefined/NaN) · chain: empty passes, AND records every result after a failure,
  unknown type loud-fails with the offending name in the detail.
- Fixtures learned en route: vitest `toMatchObject({key: undefined})` requires the key
  to EXIST — use a separate `toBeUndefined()` for omitted keys.
- Interlock placement re-confirmed against design §3.3: `bufferPercent` is *not* a
  filter ("unconditional safety interlocks, independent of filters") — it arrives in the
  step-3 engine (`soc > bufferPercent`, from `energy.ts`'s `max(0, soc − buffer)`).
- Next: Step 3 — decision engine + `DecisionStore` + migration (branch
  `p1b/step3-decision-engine`).


### 2026-10-25 — P1b step 2 addendum: filters colocated in src/daemon/

Same branch (`p1b/step2-decision-filters`), gate green (exit 0; 602 passed / 2 skipped).
User placement call after reviewing the `src/decision/` split: **decision logic lives in
`src/daemon/` beside `eventDetector.ts`.** Rationale recorded in the module header and
above in Confirmed decisions: EvPoller owns the whole chain — read vehicle state, detect
state changes (`eventDetector.ts`), apply filters (`filters.ts`), act (SessionStore now;
decisions + actuation next steps) — and filters exist only within that chain. Purity is a
testing discipline, not a claim of other consumers (the earlier `src/decision/` framing
bet on future evaluators — CLI preview, remote/GUI — that do not exist; revisit only if
one appears).

- `git mv src/decision/filters.ts → src/daemon/filters.ts`; `tests/decision/filters.test.ts
  → tests/daemon/filters.test.ts` (mirrors `src/`, like `event-detector.test.ts`); one
  import line changed; no code changes inside the module (import depth unchanged).
- Step 3 retargeted: engine lands in `src/daemon/engine.ts` beside its filters;
  `DecisionStore` stays in `store/` (persistence follows the `*Store.ts` pattern
  regardless of where policy lives).
- Next: unchanged — Step 3 (branch `p1b/step3-decision-engine`).


### 2026-10-25 — P1b step 3 complete: decision engine + DecisionStore + migration 002

Branch `p1b/step3-decision-engine` (off landed main `722c14f`), two commits, gate green
(exit 0; **623 passed / 2 skipped**; engine 15/15, decision-store 6/6, schema-pin 4/4).

**3a — store (`4dcfd9a`):**
- Migration `002-decision-reason-codes.ts`: SQLite cannot ALTER a CHECK → rebuilds
  `decisions` (create v2 → copy → drop → rename → recreate index) with **+`filter_declined`
  +`config_error`** in `reason_code`; registered in the explicit `MIGRATIONS` list
  (user_version → 2).
- `types.ts`: `DecisionReasonCode` (mirrors the CHECK, `EventKind` pattern), `DecisionRow`
  (wire-level integers) / `NewDecision` (intent-level booleans — insert maps to 1/0; no
  precedent existed, so this asymmetry is now the documented pattern for booleans).
- `DecisionStore.ts`: aliased `COLUMNS`, `insertDecision`, `decisionForSession` (dual role:
  read-pin + step-4 idempotency; newest row wins).
- Schema-pin gap closed exactly as its markers planned: fixture + `FIXTURES` entry,
  "every table has a pinned row interface" (`[]`), read-pin entry; the old comment/test
  deleting themselves.
- Collateral gate fixes (honest record): `system-commands` schemaVersion pin 1 → 2 (the
  deliberate-literal pattern doing its job); **tesla-probe now self-seeds its `resolveVin`
  credential dependency** — it had been passing on shared-config-dir state some other
  suite happened to leave behind (order-dependent; a latent flake my extra test file
  exposed: repro'd on clean main in isolation, then fixed properly with a self-seed).

**3b — engine (`src/daemon/engine.ts`, 15 tests):**
- `evaluateDecision(input) → DecisionOutcome` — pure; the poller chain assembles inputs
  and (step 4) persists via `DecisionStore`. Interlock order: `duplicate_session`
  (short-circuit, no filters evaluated) → `not_plugged_in` → `already_charging` → safety
  inputs (`config_error` for missing energy config or battery SoC) → `below_buffer`
  (equality = below, matching `energy.ts`'s 0-available math) → `runFilters` (all results
  recorded; first failure → `filter_declined` + its detail) → `computeChargeLimit` in
  try/catch (`compute_error`) → outcome.
- **Modes, not stops:** `dryRun = !enabled || flag`; dark/dry runs evaluate identical
  verdicts and record them (`dry_run` + would-be limit in detail). Merge-dark pinned:
  disabled + geofence failure records `filter_declined` with `dryRun: 1`; a live decline
  keeps `dryRun: 0`.
- Input narrowed vs the presented plan: `nowMs`/`sessionId` dropped — the pure engine
  makes no time lookups and never touches the store; the wiring stamps `ts_ms` and the
  row's `session_id` (it already owns both).
- Step-4 note: wiring passes `dryRun: true` until the step-5 actuator exists, so
  `started` is engine-tested but unreachable in production until then (still dark).
- Next: Step 4 — decision consumer wired at `plug_in` in `EvPoller` (decision-time
  location fetch per Option B, engine call, decision row) — branch
  `p1b/step4-decision-wiring`.


### 2026-10-25 — P1b step 4 complete: decision consumer wired at the vehicle plug-in

Branch `p1b/step4-decision-wiring` (off landed main `befca99`), gate green (exit 0; **632
passed / 2 skipped**; consumer 6/6, wiring 3/3). First run — no flakes.

- **Terminology directive (user, 2026-10-25):** "plug-in" in this codebase means a
  **vehicle plug-in** (the charge cable going on the car) — from here on code names use
  `vehiclePlugIn` style (`onVehiclePlugIn`, `VehiclePlugInContext`) and comments say
  "vehicle plug-in event", disambiguated from software-plugin usage. The stored
  `plug_in` event kind stays (schema vocabulary).
- `src/daemon/decisionConsumer.ts`: the chain's decision stage — per vehicle plug-in:
  idempotency lookup (`decisionForSession`), **Option-B decision-time location fetch**
  (failure → null + log → geofence declines), home secret (weather's default
  `credentialStore` pattern), latest home-battery SoC, injectable energy config
  (default `resolveEnergyConfig().config`), `evaluateDecision` → `insertDecision` with
  `filterResultsJson` + `limitedBy`, one `[decision]` log line. **Never throws**
  (outer try/catch log-only) and **`DRY_RUN_UNTIL_ACTUATION = true`** (step 5 rewires):
  rows record from the first start, nothing actuates — merge dark holds even if the flag
  is flipped early.
- `src/daemon/EvPoller.ts`: narrow seam — `VehiclePlugInContext` + optional
  `onVehiclePlugIn` dep (absent = collect-only, so P1a tests/behavior untouched); the
  previously discarded `openSession` id is captured and handed over; the await is
  wrapped so a failing decision can never stop sampling (`[ev-poll] decision consumer
  failed: …`).
- `src/daemon/runDaemon.ts`: consumer built in `prepare()` from existing options
  (`config.autoStart`, `getVehicleLocation`, the `getHomeLocation` seam weather already
  used) and passed into `createEvPoller` — attached unconditionally (merge dark records
  decisions while `enabled: false`). `index.ts` untouched: `daemonOptions.config`
  already carried everything.
- Tests: `decision-consumer.test.ts` (dark dry-run row + geofence audit JSON; location
  failure → `location_unavailable` decline + log; home unset → `home_unset`; repeat →
  `duplicate_session` with `[]`; battery under buffer → `below_buffer`; double-failure
  read → still resolves, row lands). `decision-wiring.test.ts` (fires exactly once per
  vehicle plug-in with the fresh session id; rejecting consumer leaves samples +
  sessions intact; omitted dep = collect-only).
- Next: Step 5 — actuation: shared charge-limit math extraction, `tesla-http-proxy`
  alive-check/respawn before commands, `setChargeLimit` → `startCharging` behind
  `autoStart.enabled`, `daemon --dry-run` flag; branch `p1b/step5-actuation`.


### 2026-10-25 — P1b step 5 complete: actuation (limit → start, live only)

Branch `p1b/step5-actuation` (off landed main `7921bd4`), gate green (exit 0; **639
passed / 2 skipped**; decision-consumer 12/12, command-routing 24/24). First run.

**Two step items verified already solved by existing code (pinned, not rebuilt):**
- **Proxy alive-check/respawn before each command** — `TeslaService.postVehicleCommand`
  → `vehicleCommandClient()` calls the `commandProxy` resolver on *every* command (only
  the TLS client is cached by port), and the daemon's `initializeTesla` wires that
  resolver to `startTeslaProxy()`, which attaches when the recorded pid lives and
  respawns when it does not. New pin in `tesla-command-routing.test.ts`: counting
  resolver → 1 harness pre-resolve + 1 per command = 3 across two commands.
- **Shared charge-limit math** — already unified (Phase 1.5, workplan-history): both
  `chargeFromBattery` and the engine call `computeChargeLimit`; their actuation tails
  are the same `setChargeLimit` → `startCharging` sequence. Nothing to extract.

**What changed:**
- `decisionConsumer.ts`: the forced `DRY_RUN_UNTIL_ACTUATION` constant is gone —
  `dryRun: boolean` dep (`daemon --dry-run`; the engine derives mode = `!enabled ||
  flag`). New `chargeCommands` dep; when `outcome.accepted && targetPercent !== null`
  the consumer runs **setChargeLimit(target) → startCharging()** (limit-before-start);
  any throw downgrades the recorded outcome to `accepted: 0, reason_code:
  'service_error'` with detail `"<original verdict> — actuation failed: <msg>"` so the
  computed target stays in the row as evidence. The row is written *after* the attempt
  — `'started'` means commands were issued **and** `confirmChargingState` verified the
  car is charging.
- `runDaemon.ts`: `RunDaemonOptions.dryRun?`; consumer receives `dryRun` + the two
  command wrappers over `tesla` (the per-command proxy resolver rides inside).
- `index.ts`: `daemon --dry-run` flag → `daemonOptions.dryRun`. REPL untouched — the
  drift guard's `oneShotOnly = {start, daemon}` exempts daemon flag tables by design.
- No migration: `service_error` was already in the `reason_code` CHECK.
- Tests: consumer helper now defaults to the **shipped** `enabled: false` (merge dark)
  with a `commandCalls` recorder; all 6 pre-existing expectations held unchanged. New
  `actuation` describe: live pass → `['setChargeLimit:51', 'startCharging']` + `started`
  row · `--dry-run` → zero calls · disabled → zero calls · live decline → zero calls ·
  set-limit throws → `service_error`, no start, target in detail · start throws →
  `service_error` with target evidence.
- Next: Step 6 — notifiers (`Notifier` interface + log-only/ntfy/Slack, typed events,
  credential-store secrets, failure isolation) — branch `p1b/step6-notifiers`.


### 2026-10-25 — P1b step 5.1 complete: ops hardening (4 issues, 4 commits)

Branch `p1b/step5-1-ops-fixes`; gate green after every step (final: **666 passed / 2
skipped**, 49 files).

1. **#1 lifecycle (`cae2027`)** — `evcc daemon stop|restart|install|uninstall`
   subcommands (`src/commands/daemonLifecycle.ts`, injectable exec seam; scripts spawned
   via `bash`). **Incident worth remembering:** the first `--dry-run` smokes ran for REAL
   — Commander silently drops a subcommand option that duplicates a parent option name
   (isolated repro: `SUB {}`), so `daemon uninstall --dry-run` bootout'd the user's
   LaunchAgent and deleted the plist + Login Item. Detected from the output wording,
   **restored with a real `daemon install`** (daemon verified running). Fix:
   `program.enablePositionalOptions()` + `daemonCommand.passThroughOptions()` (canonical
   `daemon uninstall --dry-run` verified to print only would-lines; exit 0) plus a
   `preAction` refusal for stray parent flags (`daemon --dry-run uninstall` → guard,
   exit 1 — verified). Drift test: subcommand exclusion map + parent-registration pins;
   mirror-tree routing tests. README install section rewritten CLI-first.
2. **#2 oauth disambiguation (`1adb975`)** — 412 body `not been paired` → vehicle-side
   enrollment advice (the misleading region/Allowed-Origins text is what the user hit
   after a fully-green `--check-only`); other 412 bodies keep the observed
   partner-accounts text; 422 is body-aware (hash-taken still short-circuits via the
   `known` table; empty/uninformative keeps domain advice; named bodies get neutral
   passthrough). +3 pins, 48/48 oauth tests.
3. **#3 wake on writes (`b3cd926`)** — root causes of the live `set-ev-charge-limit`
   408: the non-429 wake died after 10 cycles × 2 s ≈ 20 s against a documented 3-minute
   budget, then rethrew the interceptor message whose 408 branch carries *read* advice.
   `wakeUp` now polls to the wall deadline (2 s light probes, `wake_up` re-POST ≤ every
   10 s — **only a due POST consumes the cadence**: a poll-failure reset found by the new
   pin would have stranded wake_up), 429 semantics untouched; wake exits wrap with
   wake-context messages (cause preserved for `--debug`); `postVehicleCommand` gained a
   408 branch beside ECONNREFUSED; pre-wake UX lines in `setEvChargeLimit` + one wake
   notice in `wakeUp` (all four surfaces share `setChargeLimit`). Deliberate "rethrows
   the original" pin rewritten; +slow-online, +wake-408, +command-408 pins. **Lesson:**
   axios adapters must THROW a response-carrying AxiosError — the core does not
   re-validate a resolved non-2xx response.
4. **#4 local timestamps (`c03751c`)** — `formatLocalTimestamp(ms)` (`src/utils/time.ts`,
   local getters, TZ-agnostic tests) swapped into the four human log sites: `[ev-poll]
   rich read due` (the reported Zulu line), `[daemon] started at`, stale-lock `takenAt`,
   "Stored tokens valid until". Boundary: machine surfaces keep ISO-8601 UTC
   (`status --json` pin, store-report, `ts_ms`; `system.ts`'s helper feeds JSON + relative
   ages). Samplers due-line pin rewritten.

- Next: Step 6 — notifiers (`Notifier` interface + log-only/ntfy/Slack, typed events,
  credential-store secrets, failure isolation) — branch `p1b/step6-notifiers`.


### 2026-10-26 — P1b step 5.2 complete: decision diagnostics (4 commits)

Branch `p1b/step5-2-decision-diagnostics`, gate green after every commit (final: **674
passed / 2 skipped**). Triggered by the live session-8 row (`service_error … complete
(charging has already completed)`) and three user questions:

1. **Why the limit ≈ SoC (answer, not a bug):** battery 27% − 20% buffer × 13.5 kWh × 0.9
   ≈ **0.85 kWh** = +1.1% on a 75 kWh pack — the math raised the limit, by a
   rounding tick (`67 > 66`, `limitedBy: none` all correct). Commit `b3e4044`:
   - **Engine guard `targetPercent <= evSoc → decline `insufficient_energy``** — the
     engine had never inherited `chargeFromBattery`'s refusal; migration 003 (CHECK
     rebuild) + union + tests (tie, full pack, merge-dark). Zero vehicle commands; the
     limit is not set either. Populated-v1→v3 smoke: row survived, new code accepted.
   - Outcome details now carry the math: `charge limit 51% (none) — 8.5 kWh above 20% buffer`.
2. **The start race** (`791347d`): set-then-start raced the controller — `charge_start`
   answered `complete` from the pre-raise state. Consumer now: post-limit status read
   (paces the start; `isCharging` = auto-resumed → `started` with a note, no redundant
   command) + one complete-rejection retry after 2.5 s (matches proxy and Fleet message
   shapes); a second failure stays honest `service_error`. New deps `getStatus` /
   `startRetryDelayMs`; three fake-driven tests. *Live validation item.*
3. **Debugging tools** (`cc30b83`): `npm run store` decisions section = recent-5 with
   **local wall-clock** lines (ISO in `--json`), accepted/dry flags, reason, full
   `reason_detail`, per-filter audit JSON. Verified against the live store — sessions
   5–9 tell the whole story (radiusM:1 decline, dark dry_run, pre-tap 412, the session-8
   race, an `already_charging` decline).
4. **Franklin tracebacks** (`ad5adb2`): the trace is the retry-exhausted path only
   (attempts 1–2 print single lines; the final re-raise hits
   `handle_franklin_errors.print_exc` — the captured `line 161, in decorated` proves
   it); the second NoneType TypeError shares the path and simply never exhausts.
   `handle_franklin_errors` now suppresses the trace for `_known_flaky_upstream`
   (TypeError + NoneType + subscriptable|container — both live signatures) with one
   compact line; anything else keeps its traceback. Pinned via venv `python -c`
   asserts + py_compile.

- Next: Step 6 — notifiers — branch `p1b/step6-notifiers`. Deploy note: after landing,
  upgrade with `evcc daemon install` (it rebuilds; plain `restart` does not).


### 2026-10-27 — P1b step 6.0 complete: daemon observability (5 commits)

Branch `p1b/step6-0-daemon-observability`, gate green after every commit (final: **681
passed / 3 skipped**). Triggered by the missed 18:15 plug-in — root cause evidence-locked:
`pmset -g log` shows Maintenance-Sleep cycles (17:56 +925 s; ~18:19 +~16 min) mapping
1:1 onto the `/stats` gaps; the car woke on plug-in (touchscreen observed) but the
daemon's timers were frozen, and a non-charging car re-sleeps within minutes. Polling
itself was healthy (120 s exactly *while awake*); the `/stats` lines are the battery
sampler — EV probes are silent while the car sleeps, which doubled the confusion.

1. **`afb4228` keep-awake** — launcher execs through `caffeinate -s` (PreventSystemSleep;
   AC-only assertion so battery behavior stays honest; covers lid-closed clamshell where
   `sleep 0` does not) with plain-exec fallback; launchd-assets pin; README "Keeping the
   Mac awake".
2. **`e9b8dc6` timestamps** — `installConsoleTimestamps()` wraps console in the daemon
   action: every line in daemon.log AND daemon.err.log prefixed with the same local
   `YYYY-MM-DD HH:MM:SS` (per line; console arg semantics kept). The timestampless
   `[daemon] task:` errors that made the 408 era unboundable are now bounded. Event
   times inside messages stay (data, not the log clock).
3. **`9ff5917` watchdog + heartbeat** — scheduler reports ticks starting > max(3×
   interval, 60 s) past cadence (once per task per hour) with a "macOS suspended our
   timers" hint; EvPoller heartbeats on the first non-online probe, hourly after, and
   re-arms after each wake (`vehicle asleep — waiting (poll-while-awake; wakes are
   observed, not triggered)`). Existing transition pins re-written for the heartbeat.
4. **`32b2649` charging progress** — every rich read while `Charging` logs
   `[ev-poll] charging 43% / limit 79% · 11.8 kW · +2.4 kWh` (optional segments omitted
   when the car omits them; session-independent so a restart mid-session still reports).
5. This entry.

- Next: Step 6 — notifiers — branch `p1b/step6-notifiers`. Deploy: `evcc daemon install`
  (rebuild + re-render the caffeinated launcher + bootstrap).


### 2026-10-27 — P1b step 6 complete: notifiers (5 commits)

Branch `p1b/step6-notifiers`, gate green after every commit (final: **746
passed / 3 skipped**). Implements design.md §3.7 with the approved plan's four
defaults: log-only is the default client, two events per plug-in in dark mode
(plug-in-detected + decision-made) are intentional, unplug is not notified
(the seam makes it free later), and charging-started/stopped is state truth
(it fires for manual/REPL starts too).

1. `10cfc95` — `src/notifiers/`: `NotificationEvent` union (plug-in-detected,
   decision-made, charging-started/stopped, failure, + `test` for the CLI),
   `Notifier` interface, single pure formatter (reason-shaped voices: ✅
   started / 🧪 dry-run / ⛔ interlock / ❌ actuation-failed / ⚠ failure;
   timestamp-free — push services stamp delivery, daemon.log stamps its own),
   fanout that isolates every client failure by name and never rejects.
2. `5806a20` — `DaemonConfig.notifiers` (log|ntfy|slack + ntfy priority/server
   knobs; default `[{type:'log'}]`; arrays wholesale; fail-loud per-entry
   problems; reconcile fills the key into existing files; the numeric-field
   derivation now excludes both nested blocks) + `CredentialStore`
   get/set/clear notifier secrets (merged partial updates, store-side
   validation) — topics/webhooks never touch config.json.
3. `08dbeb2` — ntfy client (POST `<server>/<topic>`, Title + Priority
   headers, default ntfy.sh) + Slack client (POST `{"text"}`), both rejecting
   on non-2xx; `buildNotifiers` skips a secretless client with a loud line
   naming the fix; `evcc notify set|clear|test` (masked prompt when the flag
   is omitted; test exits non-zero when nothing could be sent).
4. `d14b544` — wiring: decisionConsumer emits decision-made after the row
   (duplicate_session excepted — audit rows, not decisions); EvPoller emits
   plug-in/charging start/stop where the events rows are written (unplug
   silent); runDaemon builds the fanout (lazy secret read — log-only configs
   never touch the credential store; `options.notifier` test override) and
   both scheduler error handlers emit throttled failure events (first per
   component, then hourly).
5. This entry.

- Isolation is layered: fanout catches per client → emit helpers catch per
  site (logged) → daemon call sites belt-and-braces `.catch`.
- Next: Step 7 — surfaces + docs — branch `p1b/step7-docs-surfaces`.

### 2026-10-29 — PR #47 review round + proxy timeout hardening (5 commits)

All PR #47 review comments addressed locally (the reply itself is the code —
nothing was posted to GitHub), plus the evidence-backed Franklin timeout fix
(26×/day `httpx.ReadTimeout` on the switch-usage POST). Gate green after each
commit (final: **759 passed / 2 skipped**).

1. `818ad2c` — emoji pins aligned with the user's formatter fix (`653034e`:
   ⚠️ / ⚡️); source untouched (review comment 1).
2. `16eab7e` — named event types (`PlugInDetectedEvent` … `TestEvent`, the
   union as their sum; comment 2) + `logOnly.ts` → `logLocal.ts`
   (`createLogLocalNotifier`; comment 4).
3. `a5dab34` — the leakage cleanup (issue comment + 5–10, 12, 14, 15):
   `NOTIFIER_TYPES` (as const, single source) / `NotifierType` /
   `NotifierConfigEntry` in `notifiers/types`; `NTFY_PRIORITIES` +
   `parseNtfyEntry` in `ntfy.ts`; new `notifiers/config.ts` owns
   `DEFAULT_NOTIFIERS`/`clone`/`validateNotifierEntries` — daemonConfig
   delegates and keeps only the field; type-list error strings interpolate;
   `build.ts` exports `notifierRequiresSecret` for runDaemon's lazy read;
   `notify.ts` imports from the notifier package. Notifier-land tests added.
4. `cf623b3` — runtime kind guard in `runNotifySet` (comment 13; type-level
   SetKind checked at the boundary, before any prompt or write).
5. `9d90ad7` — proxy: `Client.set_client_factory` injects a 15 s httpx
   timeout (franklinwh ships none → httpx's 5 s default) + `_is_retried_transient`
   suppresses timeout tracebacks to one line (`upstream timeout, already
   retried`); TokenFetcher's explicit `timeout=10` untouched; smoke-test pins
   for Read/Connect/PoolTimeout + negatives. Comment 3/11 (secrets) resolved
   by the reviewer: design unchanged.

- Deploy note: proxy changes take effect on the next proxy spawn —
  `evcc daemon restart` (per-session proxy) or a new one-shot command run.

## One-shot ↔ REPL drift audit (2026-10-31)

Branch `fix/repl-cli-parity`. Audited every command surface against its
one-shot counterpart and corrected the deviations found. The shared-handler
refactor plus `parseCommandArgs` had already fixed most historical drift; what
remained:

1. **`set-ev-charge-limit` ignored its argument in the REPL** — the dispatch
   case discarded `args` and always prompted. Now accepts an optional inline
   `<percent>` (validated by the shared handler, same message as the one-shot),
   honors `--help`/`-h` via `printCommandHelp`, rejects stray positionals with
   Commander's wording, and keeps the numeric prompt as the no-argument
   fallback (`src/index.ts`).
2. **`set-home-location --help` parsed `--help` as a latitude in the REPL** —
   now intercepted and rendered from the Commander definition, and >2
   positionals are rejected like the one-shot.
3. **`notify` was one-shot-only** — invisible to both the REPL and the
   drift-guard scan (registered via `program.addCommand`, which the guard's
   `.command('name')` regex cannot see). Wired in: `NOTIFY_SUBCOMMANDS` /
   `NOTIFY_SET_VALUE_FLAGS` / `parseNotifyArgs` in `src/commands/repl.ts`
   (subcommand + kind + flags with Commander-style errors; a subcommand
   structure the flat `parseCommandArgs` cannot express), a `notify` dispatch
   case in `index.ts` sharing `buildNotifyDeps()` with the one-shot
   registration and the same `runNotifySet`/`runNotifyClear`/`runNotifyTest`
   runners, `printCommandHelp` gained an optional subcommand parameter, and
   the completer offers subcommands/kind values/flags in their slots.
4. **One-shot silently ignored stray positionals** (`config extra`,
   `set-ev-charge-limit 80 90` ran anyway) while the REPL rejected them —
   `repl.ts`'s doc comment claimed both rejected, which was false. Fixed the
   one-shot side: `program.allowExcessArguments(false)` (inherited by all
   `.command()` subcommands) and explicitly on the notify command
   (`addCommand` does not copy inherited settings — verified in Commander
   12.1.0 source).
5. **One-shot rejected negative home coordinates** (`set-home-location -33.9
   151.2` → `unknown option '-33.9'`) while the REPL accepted them — anyone
   south of the equator or west of the prime meridian could not set a home
   location from the one-shot CLI. New `src/utils/argv.ts`:
   `normalizeNegativePositionals` inserts `--` before the first
   negative-number operand of that command before `program.parse` (respects an
   existing `--`; `-h`/`--help` untouched).

Tests: `tests/utils/argv.test.ts` (7 cases for the normalizer);
`repl-commands.test.ts` grew notify parity pins (subcommand/flag sync against
the real `notify.ts` source — closing the `addCommand` blind spot — plus
wiring pins through `parseNotifyArgs`/`buildNotifyDeps`/the runners),
`parseNotifyArgs` behavior (10 cases), notify completer slots, and
positional-command pins (inline value, `--help`, strictness, normalization).
Gate green: **788 passed / 2 skipped**; live-verified the one-shot behaviors
(`config extra` → error, `set-home-location -33.9 151.2` → confirmation
prompt, `notify --help`/`notify clear extra`/`notify bogus` mirror the REPL
parse, `set-ev-charge-limit 80 --help` → help).

Deliberate asymmetries that stay: exit codes (a REPL failure never exits the
session), sidecar teardown timing (`runCommand` stops per-run sidecars; the
REPL stops at session close), REPL error wording for single-dash typos vs
Commander's phrasing (both reject).



### 2026-10-30 — `evcc daemon logs` (one commit, branch `p1b/daemon-logs`)

QoL one-shot: `daemon logs [--lines <n>]` is the install-output `tail -f`
alias, upgraded to `tail -F` over BOTH streams (`daemon.log` +
`daemon.err.log`), default 50 recent lines then follow, stdio inherited
(Ctrl-C ends it). `followLogs` in `daemonLifecycle` behind the same ExecFn
seam — missing logs dir refuses with the `daemon install` hint; signal exit
is a clean stop. Pins that moved: drift-map `logs: 'daemon'`, install
verification hint, README CLI row + verify block.

- Gotcha recorded: commander does **not** catch `argParser` throws —
  validating `--lines` inside the argParser printed a raw stack trace in
  smoke; the action validates instead (repo's established pattern).
- Smoke-proven live with an isolated `ECC_CONFIG_DIR`: headers per file,
  `-n` respected, alarm-kill = Ctrl-C analog.
- Next: Step 7 — surfaces + docs — branch `p1b/step7-docs-surfaces`.


### 2026-10-30 — `daemon logs` behavior change + silent-log incident diagnosed

Follow-up on the same branch, **one commit** (`0280487`; gate: **769 passed /
2 skipped**): `followLogs` → `showLogs` —

1. Default is **print-and-exit** (`tail -n 50 daemon.log`): the command
   returns on its own, no ^C. `-f/--follow` opts back into the `tail -F`
   stream (original alias semantics, Ctrl-C stops).
2. `daemon.err.log` only when **`--err`** is passed (headers per file).
   Existing-file filtering; empty logs dir refuses with "the daemon has not
   started". Ten unit tests cover every flag combination + refusals; live
   smoke: default exits 0 immediately, `--err` gates the stream.

**Incident (diagnosis, 2026-10-30):** "no daemon.log writes since ~9am" —
`daemon.log` is ONLY the launchd job's redirected stdout/stderr (plist
`StandardOutPath`/`StandardErrorPath`); a **foreground daemon logs to its
terminal, never to the file**. Timeline: 09:00 `daemon install` (plist
mtime), 09:01:15 the user's `npm start daemon stop` → bootout → job unloaded
(`RunAtLoad`/`KeepAlive` don't resurrect a booted-out job); the evening
foreground daemon was healthy but terminal-only. Remember: KeepAlive covers
crashes, not explicit bootouts — back to background needs `daemon restart`.
Launcher stderr noise (`getcwd … not permitted`, `nvm.sh: PWD: unbound
variable`) noted as a possible future hardening target; did not block starts.


### 2026-10-31 — index.ts extraction: one file per command (branch `refactor/extract-command-modules`)

Pure refactor: `src/index.ts` went 2,019 → 98 lines — wiring only
(program setup, one session object, `program.addCommand` per command in
the original registration order, so `--help` output is unchanged). Each
command's behavior now lives in its `createXCommand` factory, following
the `createNotifyCommand` pattern:

- `session.ts` (new): the service singletons (`initializeFranklin` /
  `initializeTesla`), `currentContext`, `runCommand`, `requireService`,
  `ServiceStart`, `reportDebugDetails`, `DEFAULT_PROXY_PORT`. The
  existing process-lifetime state (the two service instances) moved here
  unchanged — no new state added; relocation flagged for approval.
- `start.ts` (new): the `start` action incl. the REPL dispatch switch
  (each case still calls the shared handlers, unchanged).
  `printCommandHelp` stays in index.ts (it needs the Commander program)
  and is injected into `createStartCommand`.
- `exit.ts`, `daemon.ts`, `config.ts`, `pairTeslaKey.ts` (new): logic
  moved verbatim out of index.ts.
- `authenticate.ts` gains `runAuthenticate`; `vehicle.ts` / `system.ts`
  gain their per-command factories co-located with the handlers
  (approved choice over seven wiring-only files).
- Tests: the source-scanning drift guards now read
  `tests/helpers/commandSources.ts` (index.ts + src/commands/*
  concatenation, file-marked); the `daemon-config` wiring test reads
  `daemon.ts`; the flag-table guard accepts `new Command('name')`, skips
  `notify` (a real REPL command since the drift audit — its flags are
  pinned by the NOTIFY_* parity tests), and pins its subcommands under
  their renamed `notifyCommand` parent.

Rebased onto `main` after the one-shot ↔ REPL drift audit: the audit's
dispatch changes (inline `set-ev-charge-limit`, `--help` interception,
`notify` REPL case, `buildNotifyDeps`, subcommand-aware
`printCommandHelp`, `allowExcessArguments(false)` on every factory —
`addCommand` does not inherit the program's setting — and
`normalizeNegativePositionals` at parse) were ported into the new
modules during conflict resolution.

Gate: `npm run check` green (798 passed / 2 skipped); `node dist/index.js
--help` order verified unchanged.

### 2026-11-01 — REPL dispatch extracted + factory/dispatch unit tests

Follow-up to the extraction, in three parts (branch
`refactor/extract-command-modules`):

1. **`exit` NOT moved to repl.ts** — checked the precondition first and it is
   false: `exit` is a one-shot command (`node dist/index.js exit`, advertised
   cross-process by `start --daemon`) and the REPL's `exit`/`quit` case never
   used `exit.ts` (it closes the readline; teardown runs in the close
   handler). `repl.ts` stays metadata-only.
2. **Dispatch extracted for testability**: the `start` action's switch is now
   the module-level `dispatchCommand(cmd, args, env: DispatchEnv)` in
   `start.ts` (env = session, printCommandHelp, buildNotifyDeps, onExit).
   Behavior unchanged — the busy gate, prompt handling, and readline lifecycle
   stay in the action; two repl-commands pins updated to the new call shape
   (`dispatchCommand(cmd, rest, env)`).
3. **New executing tests** (the gap from the extraction review):
   - `tests/commands/command-factories.test.ts` (50): every createXCommand
     constructed with fake deps — name/description/options/arguments/
     subcommands pinned; `allowExcessArguments(false)` proven per command by
     replacing actions with a recorder (19 excess cases incl. daemon/notify
     subcommands); action routing through a fake session (requireService order,
     Franklin teardown, exit-1 on bad limit); notify set/clear through hermetic
     deps; `--help` registration order pinned from index.ts source.
   - `tests/commands/repl-dispatch.test.ts` (28): every dispatch case executed
     against a fake DispatchEnv. Discovery recorded in the file header: the
     REPL dispatch calls handlers DIRECTLY (session.runCommand is the
     one-shot seam), so handlers with real I/O (`status`, `set-home-location`
     manual flow) are exercised only via help/error branches here — their
     valid paths stay covered by their handler tests + source pins.

Gotchas: Commander's `exitOverride`/`configureOutput` do not propagate to
subcommands created earlier (settings copy at `.command()` time) — the excess
helper hardens every level recursively. BSD `sed -i` broke the first
extraction attempt mid-pipeline (no files mutated); the redo used a validated
Node script.

Gate: `npm run check` green (**876 passed / 2 skipped**); `--help` output
verified unchanged.

### 2026-11-01 — docs moved into `/docs/`: workplan pointers updated (branch `docs/doc-sort`)

The user reorganized docs (`d7f2252`): `TODO.md`, `design.md`, `requirements.md`, and
`workplan-history.md` now live in `docs/`, alongside a new `docs/charts-research.md`
(dashboard charting-library evaluation). Updated every pointer in this file to the new
locations: the header block's links (workplan-history / requirements / TODO / design),
the §Battery-buffer `requirements.md` mention, both "Design rationale: design.md" links,
and the Phase 1 design write-up link. Historical log entries below keep bare filename
mentions (`design.md §7`, `TODO.md item 26`) as written at the time — they name, not
link. No code changes; docs only. Gate not required (markdown-only), but note AGENTS.md
was already updated in the move commit.


### 2026-10-31 — README command reference unified with a mode column (branch `docs/unify-cli-reference-table`)

Task 9aab3, executed after the extraction refactor landed (user's option (c):
wait, so the project tree reflects the final file layout). Docs only; gate green.

- **One table:** README's `## CLI Reference` table and the `### Interactive Mode
  Commands` bullet list are merged into a single `Command | Mode | Description`
  table with a legend — ➡️ one-shot only, 🔁 interactive only, 👯 both. The bullet
  list is replaced by a short "Interactive mode notes" (inline
  `set-ev-charge-limit [<percent>]`, `exit`/`quit`, `help <command>` /
  `notify help <sub>`, tab completion, stray-positional rejection).
- **Mode column derived from code, not the old docs:** `REPL_COMMANDS` in
  `repl.ts`, the dispatch switch in `start.ts`, and `--help` from the built CLI.
  Notably `notify set/clear/test` is 👯 — the drift-audit fix (`a3a7cf6`) gave
  the REPL a notify parser; `daemon …`/`start` stay ➡️; nothing is 🔁-only (the
  `quit` alias rides in the `exit` row).
- **Accuracy fixes:** `<command> -help` → `--help` in Usage (the REPL rejects
  single-dash `-help`); missing rows added (`help`, `daemon
  stop|restart|install [--dry-run]|uninstall [--dry-run]`); the `daemon` row
  gains `--dry-run`/`--debug`; `set-home-location`/`set-ev-charge-limit` rows
  note `--help` and the REPL's inline-percent/prompt fallback;
  `config`/`pair-tesla-key` rows note `--help`; `(design.md §3.7)` →
  `(docs/design.md §3.7)` (broken by the docs move).
- **Project tree refreshed (option c):** all 15 `src/commands/` modules
  (post-refactor), `notifiers/`, updated `daemon/` + `utils/` listings, the new
  `docs/` folder, and `workplan.md` itself.
- Validation: `node dist/index.js --help` plus `daemon --help`/`notify --help`
  diffed against the table (17 commands + help; registration order unchanged);
  stale-reference sweep clean; `npm run check` green — **876 passed / 2 skipped**.
- Environment note: this worktree's `dist` was a symlink into the main checkout
  (which has no `node_modules`); replaced with a real build directory so the CLI
  runs from here. `dist/` is gitignored — no repo impact.

### 2026-11-01 — daemon init plug-in check + one-time init wake (branch `feat/daemon-init-plug-in-check`)

- **Gap:** `daemon not running → vehicle plug-in → daemon running` did not
  auto-start when the car had re-slept at daemon start (poll-while-awake never
  reads a sleeping car), when the store had no EV baseline
  (`detectTransitions(null, …)` → `[]`), or when a session was left open
  without a decision (interrupted run). Awake + `Disconnected` baseline
  already worked via the first tick — the reconciliation must not double it.
- `src/daemon/EvPoller.ts`:
  - **First-rich-read reconciliation** (runs once; skipped when that tick saw
    a `plug_in` — the transition path owns it): plugged & not charging →
    no session ⇒ insert `plug_in` event (`from_state` null) + open session +
    `plug-in-detected` + decision; open session without a `decisions` row ⇒
    evaluate with the *existing* session id; decided ⇒ skip (log
    `already decided`). `Charging`/`Disconnected` are left to the transition
    path. Extracted `runVehiclePlugIn` — the isolated consumer call now shared
    by the transition and reconciliation paths.
  - **One-time init wake** (Option A, user-approved): first probe `asleep`
    while the init check is pending and live auto-start is on ⇒ `wakeUp()`
    once per process (new optional deps `wakeUp`/`wakeAtInit`); failure logs
    `init wake failed …` and is never retried. Collect-only and `--dry-run`
    never wake — otherwise poll-while-awake is unchanged.
- `src/daemon/runDaemon.ts`: wires `wakeUp: () => tesla.wakeUp()` and
  `wakeAtInit: config.autoStart.enabled && !dryRun`.
- Tests: new `tests/daemon/init-check.test.ts` (10: baseline-less plug-in,
  no double-fire with a store baseline, decided/undecided session restarts,
  charging/disconnected silence, wake-once + no-retry + failure isolation +
  no wake after init) + 2 `runDaemonOnce` integration tests in
  `run-daemon.test.ts` (session + `plug_in` + decision row land; wake fires
  once with live auto-start). Restart/idempotency coverage re-verified by the
  existing samplers + decision-wiring suites.
- Docs: README Collect Daemon (init-check paragraph) + Keeping-the-Mac-awake
  log bullet (init-wake line). `docs/design.md` §3.2 still says "wakes are
  observed, not triggered" — candidate one-line addendum on review.
- Gate: `npm run check` green — **888 passed / 2 skipped**;
  `node dist/index.js --help` verified. Environment: main checkout
  `node_modules` was empty; ran `npm ci` there and restored this worktree's
  shared symlink (the earlier `npm ci` here had replaced it with a real dir).
### 2026-11-01 — P1b step 7 complete: surfaces + docs (3 commits)

Branch `p1b/step7-docs-surfaces` (off `ae695c9`), gate green after every
commit (final: **879 passed / 2 skipped**, baseline 876 + 3 new).

- **Environment note:** this worktree's `node_modules` was a symlink into the
  main checkout, whose directory had been emptied — `npm run check` died with
  `tsc: command not found`. `npm ci` replaced the symlink with a real install;
  baseline verified (876/2) before touching code.
- `a40e48f` **feat(status): auto-start surface** — the Config section gains
  `auto-start: enabled | disabled (dark) — decisions are recorded, nothing
  actuates · filters: …` (empty chain renders `all plug-ins`, geofence as
  `≤N m`). `StatusReport.config.daemon` retyped `DaemonConfig | null` — the
  `Record<string, number>` cast had hidden `autoStart`/`notifiers` from
  typecheck (`--json` already carried them at runtime; now pinned). New
  `StatusOptions.daemonConfig` injection seam (the `getHomeLocation` pattern)
  keeps tests off the shared vitest config dir; `formatAutoStart` exported for
  unit tests. +3 tests: enabled-geofence render, invalid-config → problems and
  no line, formatter cases (the JSON auto-start pin and the dark-default line
  rode in existing tests).
- `cf3a2ef` **docs(readme)** — new `### Auto-start decisions` under Collect
  Daemon (flow: interlocks → filters → kWh math → `decisions` row →
  limit-then-start; ships-dark default; `daemon --dry-run`; `daemon-config.json`
  example; geofence deny-by-default; "why didn't it charge?" pointers to
  `npm run store` + `status`). The two stale "collect-only" claims replaced —
  the daemon now evaluates decisions. CLI table untouched (`daemon --dry-run`
  was already documented there).
- **store-report decisions section: verified already complete** — it landed
  early in step 5.2 (`cc30b83`); its tests re-ran green, no change (a
  `byReason` aggregate was considered and skipped as scope creep).
- **Store-report verification + docs gate:** `npm run check` green at each
  commit; README section placement and `docs/design.md §3.3` reference
  checked; no "collect-only" wording left in the README.
- Next: Step 8 — live validation (user + car): disabled-run decision rows →
  flip `enabled` → real auto-start; buffer interlock; park-away geofence
  decline; optional ntfy. Deploy note: `evcc daemon install` (rebuild) after
  landing — plain `restart` does not rebuild.


### 2026-11-03 — fix: `daemon restart` first-run bootstrap race

Branch `fix/daemon-restart-bootstrap-retry` (from the user's TODO.md report:
every `npm start daemon restart` failed its first run with `Bootstrap failed:
5: Input/output error`, succeeded on the second). Root cause = the race already
evidence-locked on 2026-10-24 for `daemon install`: launchd tears the old job
down asynchronously, and `restartDaemon`'s immediate post-bootout
`launchctl bootstrap` hit it (EALREADY → client-visible error 5). The
install-script fix (5 attempts, 1 s apart, first immediate) never reached the
TS lifecycle path.

- `src/commands/daemonLifecycle.ts`: `bootstrapWithRetry` — same policy as
  `scripts/install-daemon.sh`; new `LifecycleDeps.sleep` seam (default a
  blocking `/bin/sleep`, keeping the module's synchronous exec style);
  all-fail message now `bootstrap of <plist> failed after 5 attempts:
  <last error>`.
- Tests (+2): retry-then-success (`print, bootout, bootstrap, bootstrap` with
  one recorded 1000 ms sleep) and give-up-after-5 (5 bootstrap calls, 4
  sleeps, last error in the message); the existing sequence pins are unchanged
  — a first-attempt success never sleeps.
- Gate: `npm run check` green — **893 passed / 2 skipped**.
- Live: two consecutive `npm start daemon restart` runs — both exit 0 on the
  FIRST run, job `state = running` after each (old behavior failed every first
  run). The TODO.md item stays for the user to tick (human-maintained file).

