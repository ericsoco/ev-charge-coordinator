# EV Charge Coordinator — Phase 1 Design (daemon, auto-start, storage)

> **Status:** approved 2026-10-18 in plan mode. This is the living design doc for
> Phase 1; [workplan.md](./workplan.md) carries status/log,
> [requirements.md](./requirements.md) carries product requirements,
> [TODO.md](./TODO.md) carries the user's backlog (do not duplicate backlog here).

## 1. Context and goals

Two upcoming functionality changes drive a shift from a single-shot CLI to a
long-running process:

1. **Detect vehicle plugged-in events** (at home) and trigger the
   charge-from-battery decision + auto-start charging (requirements Oct 14).
2. **Persist history**: charging efficiency, historical home battery depletion,
   and weather forecasts, feeding a smarter charge-limit algorithm (TODO
   "base charge amount on" items).

**Product trajectory this design keeps in mind:**

- **Phase 1 (this doc):** keep the current CLI UX; add auto-charging and
  smarter charge-limit intelligence. Single user, home-hosted.
- **Phase 2:** mobile UX with the same functionality, still single user.
- **Phase 3:** multi-user, cloud-hosted, backed by cloud services.

## 2. Decisions (2026-10-18)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Auto-start from day one** (no notify-only stage) | Product requirement; confidence built via `--dry-run` mode + decision audit table instead |
| 2 | **Home-hosted on this Mac** (launchd); OrangePi/systemd later | No hosting cost now; daemon is host-agnostic so the move is trivial |
| 3 | **Poll-while-awake polling (Fleet API)**; Fleet Telemetry **deferred** | Telemetry requires a public domain + publicly-trusted TLS terminating directly on Tesla's server → forces cloud hosting now. Polling is cheap and effective (see §4) |
| 4 | **SQLite** behind repository interfaces; `site_id`/`vehicle_id` on every table | Zero-ops, vastly ample at our scale; repos + IDs are the Phase-3 Postgres/multi-tenant insurance |
| 5 | **Forward-sample** battery/EV data; **Franklin history backfill** as a spike | Backfill jump-starts seasonal baselines; sampling gives within-session deltas history can't |
| 6 | **Geofence is an optional filter, not a hard interlock** — auto-start uses a general event-filter framework | `vehicle_location` scope stays optional; users can trigger on all plug-ins or arbitrary filters (time, day, SoC, weather…) |
| 7 | **Home location is a secret**; only `at_home` (boolean) persisted | Privacy: coordinates live in the credential store (keychain now), never in `config.json` or SQLite |
| 8 | **Pluggable `Notifier`** with **ntfy** and **Slack** clients shipped | Auto-start still needs visibility; interface allows more clients later |
| 9 | **Modbus local access** (`franklinwh-local-api`) kept as long-term option for Phase 3 | In the cloud multiuser future, a per-home edge collector sampling the gateway over LAN (port 502) is cloud-independent and outage-resilient |

## 3. Architecture

```
┌── evcc daemon (new long-running entry point, home host) ──────────────┐
│                                                                       │
│  VehicleEventSource        Decision engine         Actuator          │
│  (PollingEventSource) ───► (pure, extended         (existing signed   │
│   poll-while-awake:         energy.ts):             VCP commands +    │
│   cheap `vehicle`           inputs = EV SoC,        post-condition    │
│   endpoint →                home SoC, weather,      verification)     │
│   `vehicle_data`            measured efficiency,                      │
│   when awake:               history, config                          │
│   charge_state,                                     Session monitor  │
│   battery_level,  ──────►   filter chain →          (stop at target / │
│   drive_state(lat/long)     decision + rationale     hit-buffer; the  │
│                              (all audited)           sub-50% case)   │
│  Samplers ──────────►  Store (SQLite, repositories)  ◄── CLI/REPL     │
│   battery 1–5m        samples, sessions, decisions,   (reads + manual │
│   EV while awake      efficiency, weather, events      commands, same  │
│   weather 1/day                                          store)        │
│  Notifier (ntfy, Slack, log-only) ── actions, decisions, failures     │
└───────────────────────────────────────────────────────────────────────┘
   deferred (phase 2+): fleet-telemetry ─► TelemetryEventSource (same seam)
                        Modbus edge collector; Postgres; HTTP API seam
```

### 3.1 Daemon entry point

- New `evcc daemon` command: long-running process owning the samplers,
  poller, decision loop, and session monitor.
- **Single-instance lockfile** so the daemon and one-shot CLI/REPL never both
  actuate; existing commands keep working against live services.
- Phase 1 runs under **launchd** on this Mac. Operational caveat: the Mac must
  not sleep (a sleeping Mac misses plug-in events — the car wakes itself, the
  Mac does not). Move to OrangePi + systemd later = same binary, new unit file.

### 3.2 VehicleEventSource (polling now, telemetry later)

Interface: emits `plug-in`, `unplug`, `charging-started/stopped`, and state
snapshots. Two implementations planned; only the first is built in Phase 1:

- **`PollingEventSource` (Phase 1):**
  - Cheap `vehicle` endpoint for online/asleep status; `vehicle_data` **only
    when awake** — ~60 s cadence while plugged/charging, ~5 min while awake
    idle, nothing while asleep.
  - Plug-in = `charging_state` leaves `Disconnected`.
  - **Why this is cheap:** plugging in a sleeping Tesla wakes it (it must
    decide on charging), so every real plug-in event is followed by an awake,
    pollable car within one poll interval — near-instant detection with zero
    wake cost from us. A sleeping car is already plugged in; nothing to detect.
  - Cost: billable device-data requests are fractions of a cent each; a $10/mo
    individual-developer credit should cover personal usage. Realtime rate
    limit 60 req/min, wakes 3/min — both far above our cadence.
- **`TelemetryEventSource` (deferred):** Tesla's open-source `fleet-telemetry`
  server beside the daemon; requires a public hostname + publicly-trusted TLS
  terminating **directly on that server** (mutual TLS; no L7 proxy in front),
  firmware ≥ 2024.26, virtual key paired to the domain, signed per-vehicle
  config pushed via the vehicle-command proxy. Benefits when we do it: seconds
  latency, no wakes, "connected to home Wi-Fi ⇒ at home" signal for free, and
  Tesla's documented recommendation over polling. Deferred until cloud hosting
  is adopted (Phase 3 direction).

### 3.3 Decision engine + auto-start filters

```
plug-in event ─► filter chain (all must pass) ─► computeChargeLimit ─► actuate
```

- **Filter** = pure, testable function: `(event, decisionContext) → { pass, reason }`.
  Every filter's result — pass *or* fail — is written to the `decisions` audit
  table with its reason, so "why didn't it charge?" is always answerable.
- **Shipped filter types:**
  - `always` — trigger on every plug-in (what auto-start without any location
    scope looks like).
  - `geofence` — optional; home coordinates within `radiusM`. Requires the
    optional `vehicle_location` OAuth scope and a stored home location; either
    missing ⇒ the filter **fails loudly, never silently passes**.
  - Seam open for arbitrary future filters: time windows, day-of-week, EV or
    home SoC thresholds, weather conditions, arm/disarm state.
- **Config shape** (validated on read like all config — fail loudly, no
  defaults, unknown filter types rejected):

  ```json
  { "autoStart": { "enabled": true, "filters": [ { "type": "always" } ] } }
  ```

  Empty `filters` array = all plug-in events. Filters compose with AND.
- **Unconditional safety interlocks** (independent of filters):
  `autoStart.enabled`; home battery SoC above `bufferPercent`; vehicle plugged
  and not already charging; per-session idempotency (never re-fire for the
  same session); `--dry-run` mode logs decisions without actuating.

### 3.4 Actuator and session monitor

- Reuse existing `TeslaService` signed commands (limit/start/stop) with the
  existing double-verification (response body + post-condition poll).
- **Session monitor:** while charging, poll progress and **stop at the
  computed target** (the sub-50% case from requirements Oct 10) and **stop
  when the home battery hits the buffer**; record session end reason.
- Every actuation fires a `Notifier` event; notifier failures are isolated (a
  dead webhook never blocks or rolls back an action).

### 3.5 Storage (SQLite)

Single SQLite file (WAL) behind repository interfaces (`SampleStore`,
`SessionStore`, …) so a Postgres swap stays contained. Schema sketch:

| Table | Contents |
|-------|----------|
| `battery_samples` | timestamp, soc, power (charge/discharge), home load, solar, grid, day-total deltas |
| `ev_samples` | timestamp, bSOC, charge_state, charge_rate, charge_energy_added, `at_home` (boolean only — never raw coordinates) |
| `sessions` | plug-in → end, planned vs actual target, `limited_by`, stop reason |
| `decisions` | audit: inputs, filter results + reasons, output, dry-run or acted |
| `efficiency_observations` | per session: house kWh discharged vs EV kWh added → rolling measured efficiency |
| `weather_forecasts` | hourly irradiance/etc., 48–72 h rolling |
| `events` | plug-in/unplug/charging transitions |

- Scale: even 1-minute sampling ≈ tens of MB/year — trivially ample.
- Retention: raw samples ~90 days; sessions/decisions/rollups kept long-term.
- **Every table carries `site_id` / `vehicle_id`** (defaults `'home'` / VIN):
  near-free now, makes Phase-3 multi-tenancy additive instead of migratory.
- **Privacy:** raw GPS coordinates are never persisted (only `at_home`); the
  home location itself is a credential-store secret.

### 3.6 Intelligence inputs

1. **Measured efficiency** — per session, house kWh discharged (integral of
   Franklin `batteryUse`/`batteryDischarge` deltas over the session) vs EV
   `charge_energy_added` delta (small `TeslaChargeState` extension). A rolling
   estimate replaces the static `chargeEfficiency` config value over time.
2. **Weather forecast** — Open-Meteo (free, no key) hourly shortwave-radiation
   forecast for home lat/long; fetched daily, stored 48–72 h; adjusts the
   buffer/target (e.g., low expected solar tomorrow ⇒ keep more reserve).
3. **Historical baselines** — our forward samples plus the Franklin history
   **backfill spike** (§6) for day-of-week/seasonal averages instead of
   waiting months to accumulate.

### 3.7 Notifications

```ts
interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}
```

- Typed events: `plug-in-detected`, `decision-made` (incl. declined),
  `charging-started/stopped`, `failure`, `daemon-error`.
- Shipped clients: **ntfy**, **Slack** (incoming webhook), **log-only**
  fallback. Config selects a list; all are invoked; failures isolated and
  logged. Webhook URLs/topic tokens are stored as secrets in the credential
  store, not in `config.json`.

### 3.8 Secrets and credentials

Phase 1 keeps the current stores: macOS keychain (via `@napi-rs/keyring`) with
encrypted-file fallback. All secret access stays behind `credentials.ts` — the
Phase-3 swap (env-injected / cloud KMS backend for a hosted deployment) lands
without touching services. New secrets: home location, ntfy/Slack webhook
URLs. Note: Tesla refresh tokens are single-use — relevant to any future
redeploy flow.

### 3.9 CLI coexistence

- One-shot commands and the REPL keep working; they gain read-only commands
  (`sessions`, `status`) reading the same SQLite store.
- The decision engine and actuator are reachable through a narrow in-process
  interface deliberately shaped to be wrappable by an HTTP handler in Phase 2
  (same injection style as `CommandContext` today — no CLI-only assumptions
  in the engine).

## 4. Geofence design (optional filter)

Options evaluated for determining "at home" under polling (Fleet API exposes
**no Wi-Fi SSID**, so the telemetry-only "on home Wi-Fi" signal is unavailable):

| Option | Verdict |
|--------|---------|
| **GPS geofence** via `drive_state` in `vehicle_data` (needs optional `vehicle_location` scope) + home-coords radius | **Chosen as an optional filter type** — works on Wi-Fi or cellular; coordinates stored as secrets; only `at_home` persisted |
| Last-known-location cache (short staleness window, e.g. 30 min) | Complement — the plug-in wake means the first poll returns a fresh fix quickly |
| No geofence / heuristic | Supported by configuration (`always` filter) — user's explicit choice; without location scope this is the only auto-start mode |
| Wi-Fi SSID identity | Not available via Fleet API; telemetry-only |

Failure semantics: geofence configured but scope missing or location secret
absent ⇒ that filter fails loudly (auto-start does not fire for that event)
and the user is told how to fix it — never a silent allow.

## 5. Phasing

- **P1a — collect-only:** daemon skeleton (launchd on this Mac) + SQLite +
  samplers + session/event records. No auto-actuation; history starts
  accumulating immediately.
- **P1b — auto-start:** plug-in detection + filter framework + decision
  engine + notifier clients (ntfy, Slack) + `--dry-run`; then enable live.
- **P1c — intelligence:** measured efficiency + Open-Meteo-adjusted limits;
  sub-50% stop-at-target session monitor; battery-hit-buffer stop.
- **Spikes (parallel, small):**
  1. Franklin cloud history endpoints live test (auth + response shapes);
  2. Open-Meteo response shape for home lat/long;
  3. `vehicle_location` scope re-auth (only if the geofence filter is wanted).

## 6. Research findings (2026-10-18, sources)

- **Tesla pushes nothing:** no webhooks exist; Fleet Telemetry *is* the push
  mechanism — <https://developer.tesla.com/docs/fleet-api/fleet-telemetry>.
  Setup requires a public server, domain + publicly-trusted cert terminating
  directly on Tesla's open-source server (mTLS — L7 termination breaks it),
  firmware ≥ 2024.26, key pairing at `tesla.com/_ak/<domain>`, signed config
  via the vehicle-command proxy.
- **Billing/limits:** <https://developer.tesla.com/docs/fleet-api/billing-and-limits> —
  realtime data 60 req/min, wakes 3 req/min (per account); all <500 responses
  billable (fractions of a cent); $10/mo individual-developer credit;
  telemetry ~$0.007/vehicle-hour driving-class, change-driven while parked.
- **Franklin history:** our `franklinwh` lib (richo) is realtime-only —
  methods are `get_stats`, `get_mode`, `get_composite_info`,
  `set_export_settings`, `set_generator`, `get_home_gateway_list`. The
  Franklin **cloud API does have history endpoints** used by the app's charts
  (independently mapped by [david2069/franklinwh-cloud](https://david2069.github.io/franklinwh-cloud/API_ENDPOINTS_MAPPING/):
  `get_electric_data(data_type, day_time)`, `get_power_by_day(dayTime)`,
  `get_power_details(type, timeperiod)`, `get_backup_history(...)`). Backfill
  = add 1–2 methods to our Flask proxy; **needs a live spike** (dynamic URLs,
  undocumented).
- **Franklin local access:**
  [`franklinwh-local-api`](https://pypi.org/project/franklinwh-local-api/) —
  async Modbus TCP client to the aGate on **LAN port 502**: no cloud/account,
  ~1 W precision home-load register, battery charge/discharge control via
  SunSpec M704. Realtime registers only (no on-device history), 0.1.x
  maturity. **Long-term option** for a per-home edge collector in Phase 3.

## 7. Phase 2/3 seams (kept open deliberately)

- **HTTP API:** decision engine + actuator behind a narrow interface → wrap
  in an HTTP handler for the mobile app (Phase 2).
- **Storage:** repository interfaces + `site_id`/`vehicle_id` → Postgres
  (Phase 3).
- **Secrets:** `credentials.ts` isolation → env/KMS backend (Phase 3).
- **Event source:** `VehicleEventSource` seam → Fleet Telemetry when hosting
  allows (Phase 3).
- **Edge collector:** Modbus local sampling per home → cloud sync (Phase 3).
- **Multiuser safety:** filters + decision audit generalize naturally to
  per-user/per-site policy.




