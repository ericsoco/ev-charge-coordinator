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

## Log

<!-- Append dated entries below after each Act response, per AGENTS.md. -->

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

