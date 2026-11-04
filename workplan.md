# EV Charge Coordinator — Workplan (living)

> **Current context and forward decisions.** Created 2026-10-18 after Phases 0–5 landed on
> `main` (`6891126`); restructured 2026-11-03 for P1c. The completed Phase 0–5, P1a, and P1b
> execution records are archived in
> [workplan-history.md](./docs/workplan-history.md) — **historical, backup context only**;
> read this file first and consult history only when deeper context is needed. Product
> requirements live in [requirements.md](./docs/requirements.md); the user's backlog lives in
> [TODO.md](./docs/TODO.md) (keep it there — do not mirror backlog items into this file).
> The Phase 1 design (long-running daemon, auto-start event filters, storage, hosting)
> lives in [design.md](./docs/design.md) (approved 2026-10-18).

## Current state (verified 2026-11-03)

- **Phases 0–5, P1a (collect-only daemon), and P1b (auto-start decision engine) complete
  and landed on `main`;** GitHub Actions CI green on Node 24 + 26. Gate for every change:
  `npm run check` (build + lint + typecheck + unit tests; 893 passed / 2 skipped at last run).
- **Auto-start is live** (P1b step 8 validated 2026-11-03): `daemon-config.json` has
  `autoStart.enabled: true`, a 25 m geofence filter, and log + ntfy notifiers.
- **Shipped surface:** `start` / `exit` lifecycle; SoC + charging reads and signed commands
  (`get-battery-soc`, `get-ev-bsoc`, `get-charging-state`, `set-ev-charge-limit`,
  `start/stop-ev-charging`, `charge-from-battery`); `config` setters; `daemon` (lifecycle
  subcommands, `logs`, `--once`, `--dry-run`); `status`, `sessions`, `set-home-location`,
  `notify set|clear|test`; interactive REPL with masked credential prompts. Start-charging
  consent is explicit flags only (`--start` / `--dry-run` / `--stop`); `charge-from-battery`
  prints its consent prompt for approval.
- **Architecture:** FranklinWH via per-session/one-shot token-guarded Flask proxy
  (`python/franklin_proxy.py`); Tesla signed commands via managed `tesla-http-proxy` sidecar
  (TLS :4443, per-spawn token in `~/.ev-charge-coordinator/runtime.json`; alive-check/respawn
  before each daemon-issued command); OAuth tokens in keychain with AES-256-GCM
  encrypted-file fallback; daemon behind launchd KeepAlive + single-instance lockfile;
  SQLite (WAL) store behind repository interfaces with a three-way schema pin.
- **Live-verified:** both SoC reads; signed limit/start/stop against a real Model Y;
  `charge-from-battery` consent flow and kWh-derived limit (math in `src/utils/energy.ts`);
  asleep-car `get-charging-state` 408 wake-gap message; unplugged `start-ev-charging` fails
  loudly; auto-start decision rows → real start (buffer interlock + geofence + ntfy).

## Decisions on future work

- **Deferred by explicit decision (2026-10-17):** `CONTRIBUTING.md`, issue/PR templates,
  `CHANGELOG.md` — revisit before any outreach to external contributors.
- **Out of scope by decision (Phase 6 list):** Web GUI, multi-EV / multi-gateway fan-out,
  scheduled charging windows + solar-aware rate timing, Fleet Telemetry WebSocket instead of
  polling, `npx` publishing. (The keytar replacement formerly listed here was done 2026-10-18:
  `@napi-rs/keyring`.)
- **Battery-buffer product evolution** (`docs/requirements.md` Oct 10 / Oct 14 entries:
  sub-50% target handling with polling stop) — **picked up as P1c below** (2026-11-03); the
  plug-in trigger half of those entries shipped with P1b.

## P1c — intelligence (active plan)

> Status: **Planning complete (2026-11-03) — high-level; no code started.** Design basis:
> [design.md](./docs/design.md) §3.4 (actuator + session monitor), §3.6 (intelligence
> inputs), §5 (phasing). Product basis: [requirements.md](./docs/requirements.md) Oct 10
> (sub-50% stop-at-target) + the battery-buffer evolution note above. Each step below is a
> separate branch, gated on `npm run check`, with a dated Log entry when it lands — same
> discipline as P1a/P1b.

**Scope (design.md §5 + §3.6.4):** measured efficiency + Open-Meteo-adjusted limits;
sub-50% stop-at-target session monitor; battery-hit-buffer stop; **solar-surplus
re-targeting** (added by user 2026-11-03).

**Already in place from P1a/P1b (verified 2026-11-03):** session closing aggregates
(`sessions.energy_kwh / energy_percent / house_energy_kwh / efficiency`, computed at unplug
by `src/daemon/sessionAggregates.ts` — raw values, anomalies like efficiency > 1 left for
P1c to interpret); daily Open-Meteo vintages in `weather_forecasts`
(`WeatherForecastStore.latestVintage()`); `computeChargeLimit()` in `src/utils/energy.ts`
with the static `chargeEfficiency` config; actuation path with signed
limit → start and double-verification; notifier events for start/stop; `decisions` audit
rows. What P1c adds is the *interpretation* layer: use this data to shape limits and to
end sessions.

### Steps (high-level; details written here when each is picked up)

1. **Session monitor — stop at target + stop at battery buffer.** While a session is
   charging, poll progress (EV already sampled at `evSamplePluggedSec`) and (a) stop when
   EV reaches our computed target in the sub-50% case — Tesla clamps limits to ≥50%, so a
   kWh math result below that can only be honored by polling and issuing an API stop
   (requirements Oct 10, phase 2); (b) stop when home-battery SoC hits `bufferPercent`.
   Records the session end reason. Needs: migration 004 (`sessions` gains target
   percent + stop-reason columns — design §3.5 "planned vs actual target, `limited_by`,
   stop reason"; schema-pin update), monitor loop wiring in `runDaemon`/`EvPoller`,
   notifier events for monitor-initiated stops, and safety posture decided below.
   The stored target is **mutable by design** (last write wins): step 4 re-targets
   it mid-session, and the monitor re-reads it from the store every tick, so an
   updated target is enforced with no monitor changes. The charging-progress hook
   added here is the seam step 4 reuses (its re-target evaluation runs before the
   stop check in the same tick).
2. **Measured efficiency.** Rolling estimate over closed sessions' `efficiency`
   (`sessionStats.avgEfficiency` exists; likely weighted by `energy_kwh` + outlier
   handling) that progressively replaces the static `chargeEfficiency` input to
   `computeChargeLimit` (design §3.6.1 — config value stays the fallback until enough
   clean samples exist). Anomaly interpretation lives here: efficiency > 1, zero/near-zero
   house energy, meter-reset edges (the aggregate math deliberately never guesses).
3. **Weather-adjusted limits.** Consume the newest `weather_forecasts` vintage to adjust
   buffer/target — e.g. low expected shortwave radiation tomorrow ⇒ keep more reserve
   (design §3.6.2). Pure policy module + config knobs; inputs flow through
   `DecisionInput`/`engine.ts` so `decisions.reason_detail` shows the adjustment
   (auditability, consistent with P1b). Policy shape is an open decision below.
4. **Solar-surplus re-targeting** *(user 2026-11-03; future goal — not enabled until
   picked up; design.md §3.6.4)*. When sun charges the house battery mid-session, energy
   above the original plan appears: recompute the charge limit from the **latest**
   home-battery SoC + current EV SoC on a cadence (both inputs already sampled — battery
   `batterySampleSec`, EV rich read `evSamplePluggedSec`) and adjust the target while
   charging continues.
   - **Symmetric raise/lower** (decided). *Raise* = two writes: new Tesla limit
     (`setChargeLimit`, signed) **and** `sessions.target_percent` — otherwise the car's
     own limit stops charging first (acutely so in the sub-50 case: limit 50, raw target
     now ≥50). *Lower* (cloud/other loads drain the battery) = update
     `sessions.target_percent` only — the step-1 monitor enforces it at its next tick;
     no vehicle command needed.
   - **Hysteresis** (decided): no more than ~1 change per 20 min — when step 4 is
     planned, analyze our historical samples so far to translate the 20-min cadence into
     a % SoC margin.
   - **Resume** (decided): after a step-1 monitor stop, restart charging later once
     home-battery SoC is sufficient again.
   - **Notify** (decided) on mid-session target changes.
   - Cadence: piggyback the step-1 charging-progress hook (a separate task would lack
     EV SoC); the re-target evaluation runs before the stop check in the same tick.
5. **Live validation + docs** — exercise all of the above against the car/house; README
   intelligence section; workplan Log entries.

**Possible parallel spike (design §5 spike 1):** Franklin cloud history endpoints live
test → day-of-week/seasonal baselines without waiting months for local history
(§3.6.3). Independent of steps 1–4; decide in/out below.

### Decisions

**Decided (2026-11-03, user):**
- **Monitor authority:** while live (`autoStart.enabled && !dryRun`), the monitor may stop
  *any* charging session — the buffer stop protects the house battery regardless of who
  started charging; the target stop fires wherever the decision engine recorded a
  computed target on the session.
- **Sub-50% semantics:** the monitor stops at the *unclamped* computed target
  (`Math.floor(rawPercent)`), never at Tesla's 50% floor.
- **Re-target policy (step 4):** symmetric raise/lower; hysteresis ≤ ~1 change per 20 min
  (translate to a % SoC margin by analyzing our historical samples when step 4 is
  planned); resume charging after a monitor stop once home-battery SoC is sufficient;
  notify on mid-session target changes.

**Pending (user, at step pickup):**
- **Weather policy:** simple rule (e.g. reserve +N% buffer on low-solar days) vs. computed
  forecast integral — start simple?
- **Efficiency adoption:** min sample count / confidence gate before the rolling estimate
  overrides config; which estimate (mean vs. energy-weighted mean vs. median).
- **Backfill spike:** in scope for P1c or deferred to a later phase?

### ⚠️ Reminder — end of planning phase

**Set model reasoning back to Medium** now that P1c planning is complete (user request,
2026-11-03 — TODO.md's "switch cline to smarter model for Plan mode" toggle).

## Log

<!-- Append dated entries below after each Act response, per AGENTS.md. -->

### 2026-11-03 — P1c scope: solar-surplus re-targeting planned as step 4 (docs only)

Branch `docs/p1c-solar-retarget-plan`. User added a future goal between steps 3 and 4:
when sun charges the house battery mid-session, recompute the charge limit from the
latest home-battery SoC and raise/lower the vehicle target while charging continues.
Recorded as **step 4** (live validation renumbered to step 5) with all four policy
decisions locked: **symmetric** raise/lower, **hysteresis ≤ ~1 change per 20 min**
(% SoC margin to be derived from our historical samples when step 4 is planned),
**resume** charging after a monitor stop once home-battery SoC is sufficient, **notify**
on mid-session target changes. Also recorded: monitor authority (any charging, live
only) and sub-50% semantics (`Math.floor(rawPercent)` stop target) as decided.
Step 1 impact assessed — no structural change: `sessions.target_percent` documented as
mutable (last write wins), the monitor already re-reads it per tick (test to pin this),
and the step-1 charging-progress hook is the seam step 4 reuses. design.md §3.6.4 added.
Gate: `npm run check` green (docs only).

## Queued plan — self-hosted ntfy (2026-11-01; NOT started)

Purpose: (1) kill the "anyone who learns the topic name can publish/read it"
weakness of ntfy.sh, (2) reuse the same infra when the whole app moves to the
cloud. Motivation and syntax researched 2026-11-01 against docs.ntfy.sh; the
EVCC config switch needs no daemon changes except the auth gap noted below.

### Decisions pending (user)
- Hosting target: **VPS + Docker Compose (recommended)** vs Cloudflare Tunnel
  to the Mac (zero cost; requires DNS on Cloudflare).
- Subdomain assumed: `ntfy.transmote.com`; DNS host for the record TBD.

### Steps (when started)
1. **DNS**: `A` record `ntfy` → VPS IP (or CNAME behind a tunnel).
2. **Provision**: minimal Ubuntu VPS; Docker + compose plugin; firewall only
   22/80/443.
3. **Layout** (`~/ntfy/`): `docker-compose.yml` (Caddy +
   `binwiederhier/ntfy` pinned tag; volumes for `./etc ./db ./cache`),
   `etc/server.yml`, `Caddyfile`.
   - `server.yml` (keys verified against docs):
     ```yaml
     base-url: "https://ntfy.transmote.com"
     behind-proxy: true                # real visitor IPs from X-Forwarded-For
     auth-file: "/var/lib/ntfy/user.db"
     auth-default-access: "deny-all"   # anonymous: no read, no write
     cache-file: "/var/cache/ntfy/cache.db"
     cache-duration: "24h"             # caches home-energy messages — cap it
     ```
   - `Caddyfile`: `ntfy.transmote.com { reverse_proxy ntfy:80 }` (automatic
     Let's Encrypt; TLS terminates at Caddy).
   - Verify at execution: `enable-registration` key name + visitor
     rate-limit defaults in the shipped sample `server.yml`; exact
     `ntfy token` CLI syntax.
4. **Users/ACL/tokens** (first boot via `docker exec`):
   ```bash
   docker exec -it ntfy ntfy user add --role=admin  eric      # management + web
   docker exec -it ntfy ntfy user add --role=user   evcc-pub  # publisher-only
   docker exec -it ntfy ntfy user add --role=user   phone     # subscriber-only
   docker exec -it ntfy ntfy access evcc-pub '<topic>' write-only
   docker exec -it ntfy ntfy access phone   '<topic>' read-only
   docker exec -it ntfy ntfy token evcc-pub   # tk_… → EVCC credential store
   ```
   Topic stays a secret anyway (defense in depth).
5. **EVCC code change** (branch `p1b/ntfy-auth`, one commit, gate green) —
   the ONLY gap: our ntfy client publishes unauthenticated, which
   `deny-all` would 403:
   - `src/notifiers/ntfy.ts`: `NtfyOptions.authToken?` → `Authorization:
     Bearer <token>` header when set (absent = today's behavior).
   - `src/utils/credentials.ts`: `notifiers.ntfyToken` (merged set/clear).
   - `src/notifiers/build.ts`: forwards `secrets.ntfyToken`.
   - `src/commands/notify.ts`: `evcc notify set ntfy --token …`, composes
     with `--topic`.
   - Tests: header present/absent pins, build wiring, CLI paths.
6. **Switch over** (Mac):
   `"notifiers": [{ "type": "ntfy", "server": "https://ntfy.transmote.com" }]`
   in daemon-config.json, then
   `evcc notify set ntfy --topic … --token tk_…` → `evcc notify test` →
   `evcc daemon restart`.
7. **Devices**: ntfy app/web → add server URL, log in as `phone`, subscribe.
8. **Verification matrix**: anonymous publish → 403; anonymous subscribe →
   401/403; wrong-token publish → 403; `evcc notify test` → 200 + push
   arrives on the phone.
9. **Hardening/ops**: visitor rate limits, cap `cache-size`, back up
   `user.db`, `docker compose pull` updates, optional fail2ban off Caddy.
10. **Cloud move later**: compose ships as-is; cloud EVCC points `server` at
    the same URL with its own secret.

### Caveats
- No `firebase-key-file`: Android app falls back to polling (later delivery,
  battery cost); iOS instant push for self-hosted servers has documented
  constraints — check docs "iOS instant notifications" before promising
  instant phone alerts.
- Cost: ~$4–6/mo VPS (or $0 via Cloudflare Tunnel).

