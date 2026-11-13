# EV Charge Coordinator — Workplan (living)

> **Current context and forward decisions.** Created 2026-10-18 after Phases 0–5 landed on
> `main`; restructured 2026-11-03 for P1c; restructured 2026-11-10 for Phase 2. The
> completed execution records — Phase 0–5, P1a, P1b, and P1c (now **Parts 1–3**) — are
> archived in [workplan-history.md](./docs/workplan-history.md) — **historical, backup
> context only**; read this file first and consult history only when deeper context is
> needed. Product requirements live in [requirements.md](./docs/requirements.md),
> including the 2026.Nov.07 mobile + desktop UX entry; the user's backlog lives in
> [TODO.md](./docs/TODO.md) (keep it there — do not mirror backlog items into this file).
> Design lives in [design.md](./docs/design.md): Phase 1 (approved 2026-10-18) plus the
> Phase 2 pointer in §8.

## Current state (verified 2026-11-10)

- **Phase 1 complete:** Phases 0–5, P1a, P1b, and P1c (steps 1–4 complete; step 5
  partial — see Open items below) are landed on `main`; GitHub Actions CI green on
  Node 24 + 26. Gate for every change: `npm run check` (build + lint + typecheck +
  unit tests; **1016 passed / 3 skipped** at last run).
- **Auto-start is live** (P1b step 8 validated 2026-11-03): `daemon-config.json` has
  `autoStart.enabled: true`, a 25 m geofence filter, and log + ntfy notifiers.
- **Shipped surface:** `start` / `exit` lifecycle; SoC + charging reads and signed
  commands (`get-battery-soc`, `get-ev-bsoc`, `get-charging-state`,
  `set-ev-charge-limit`, `start/stop-ev-charging`, `charge-from-battery`); `config`
  setters; `daemon` (lifecycle subcommands, `logs`, `--once`, `--dry-run`); `status`,
  `sessions`, `set-home-location`, `notify set|clear|test`; interactive REPL with
  masked credential prompts. Start-charging consent is explicit flags only
  (`--start` / `--dry-run` / `--stop`); `charge-from-battery` prints its consent
  prompt for approval.
- **P1c intelligence shipped:** session monitor (target + battery-buffer stops with
  `stop_reason`), observed-efficiency limits (≥ 5 clean sessions gate), weather
  reserve (binary threshold, default off), solar-surplus re-targeting + resume
  (1-EV-point deadband, resume at buffer + 2%, battery-tick resume while the car
  sleeps), Franklin cloud-history spike (10/10, 2026-11-06).
- **Architecture:** FranklinWH via per-session/one-shot token-guarded Flask proxy
  (`python/franklin_proxy.py`); Tesla signed commands via managed `tesla-http-proxy`
  sidecar (TLS :4443, per-spawn token in `~/.ev-charge-coordinator/runtime.json`;
  alive-check/respawn before each daemon-issued command); OAuth tokens in keychain
  with AES-256-GCM encrypted-file fallback; daemon behind launchd KeepAlive +
  single-instance lockfile; SQLite (WAL) store behind repository interfaces with a
  three-way schema pin.
- **Live-verified:** both SoC reads; signed limit/start/stop against a real Model Y;
  `charge-from-battery` consent flow and kWh-derived limit (math in
  `src/utils/energy.ts`); asleep-car `get-charging-state` 408 wake-gap message;
  unplugged `start-ev-charging` fails loudly; auto-start decision rows → real start
  (buffer interlock + geofence + ntfy); monitor stops + re-target raise with observed
  efficiency back-computed (2026-11-07); resume from battery ticks (2026-11-09).
- **Phase 2 (graphical UX) underway** — requirements 2026.Nov.07; all decisions
  resolved with the user (2026-11-10); see **P2 — graphical UX** below. Steps 1–4
  (web scaffold + shell; daemon HTTP seam + read API; Now tab live data; Then tab
  BSoC + Sessions chart) landed 2026-11-11.

## Decisions on future work

- **Deferred by explicit decision (2026-10-17):** `CONTRIBUTING.md`, issue/PR templates,
  `CHANGELOG.md` — revisit before any outreach to external contributors.
- **Out of scope by decision (Phase 6 list):** multi-EV / multi-gateway fan-out,
  scheduled charging windows + solar-aware rate timing, Fleet Telemetry WebSocket instead of
  polling, `npx` publishing. (Web GUI sat on this list until 2026-11-07, when the
  mobile + desktop requirements made it Phase 2 — see P2 below. The keytar replacement
  formerly listed here was done 2026-10-18: `@napi-rs/keyring`.)
- **Battery-buffer product evolution** (`docs/requirements.md` Oct 10 / Oct 14 entries:
  sub-50% target handling with polling stop) — **picked up as P1c and completed**
  (2026-11-03 → 2026-11-09; record in workplan-history.md Part 3); the plug-in trigger
  half of those entries shipped with P1b.
- **EV #2 / second vehicle API (deferred — shape driven by the second
  implementation, not speculation):** rename the Tesla wiring seams then
  (`ctx.tesla`, `services.tesla`, `session.initializeTesla()`), flow
  `ChargeLimitBounds` from the service descriptor into the CLI setter, and
  relocate `TeslaTokens` out of `types/ev.ts`. **Naming decision (user,
  2026-11-06): prefer the token `vehicle` over `ev`** for that work — the
  plain word beats a lowercased acronym (`ctx.vehicle`,
  `initializeVehicle()`, never `ctx.ev`/`services.ev`); the same preference
  applies to any existing `ev*` renames decided then. The bounds seam itself
  already landed (Log, 2026-11-06).

## Open items carried from Phase 1

> Extracted from P1c when Phase 2 planning began (2026-11-10); detail in
> workplan-history.md Part 3. The manual step-5 checklist itself lives in TODO.md.

1. **P1c step-5 remainder** — manual checks B2 (target stop), B3 (explicit buffer-stop
   confirm), B6 (weather on-path), B7 (robustness) per the TODO.md runbook; README
   intelligence gap-check; closing step-5 Log entry.
2. **meter-reset-edge decision** — (a) implement quarantine (`monotonicDelta` reports a
   dropped negative step → session closes with `efficiency = NULL`) or (b) re-defer with
   the recorded bound (lost slice ≤ one 120-s sample interval ≈ 0.1–0.2 kWh, below the
   0.5 kWh clean-floor; >1 outcomes already self-exclude).
3. **Bug — `runtime.json` stale after reconnect-respawn** — the daemon records only at
   startup while `FranklinWHService.reconnect()` respawns the proxy with a new token;
   interactive-CLI attach then fails ("rejected this CLI's token") and the error's
   `lsof kill` advice does not fix it (the next respawn is still unrecorded). Fix:
   rewrite the record when `spawnedProxyPid` diverges (battery-tick check or an
   `onProxySpawned` hook) + error-text guidance toward `evcc daemon restart`.
   Live-verified 2026-11-07.
4. **Wording — re-target raise label** — `(solar surplus, …)` is unconditional
   (`reTarget.ts:137`), but raises can be discharge-driven (2026-11-06 session: battery
   fell 65→37 while the raw target rose). Make the label reflect the actual
   direction/cause.
5. **Franklin cloud-history backfill** — 1–2 Flask proxy methods + baseline ingestion
   (design §6; spike-verified 2026-11-06, 10/10 probes). **Absorbed into P2 step 8**
   (home-side history feeding the 1-year chart) — no separate implementation.

## P2 — graphical UX (active plan)

> Status: **steps 1–4 complete (2026-11-11); step 5 (sessions selector) next.**
> Design basis:
> [requirements.md](./docs/requirements.md) 2026.Nov.07 entry, [design.md](./docs/design.md)
> §3.9/§7 seams + §8, [charts-research.md](./docs/charts-research.md). Same discipline as
> Phase 1: each step = separate branch, gated on `npm run check`, dated Log entry.

**Scope:** responsive web app — mobile portrait first, landscape + desktop too — with
three tabs (**Now ⚡️ / Then 🔄 / Messages 💬**), served by the daemon's HTTP seam.
Display-only in v1. Out of scope: actuation (fast-follow), multi-user, native apps
(PWA only), hosting beyond the decided tunnel.

### Decided (user, decision pass recorded 2026-11-10)

- **Framework: Svelte 5 + Vite, SPA.** SSR considered and rejected: a private,
  data-driven single-user app gets zero first-paint benefit (content is API-bound
  after load anyway), while SSR would add a render server + hydration inside the
  daemon process. Not a one-way door — SSR/prerender can be adopted later via the
  appropriate adapter if a real need appears.
- **Hosting/access: Cloudflare Tunnel** — HTTPS everywhere (secure context for
  service workers + push), phone reaches home from anywhere, no origin move, free.
- **Auth: shared bearer token**, stored per device.
- **Push: in-app Web Push (VAPID** + service worker + manifest/PWA); ntfy stays the
  CLI/daemon notifier (the queued self-hosted ntfy plan is untouched by this).
- **Charts: ECharts** (modular `echarts/core` imports for bundle size; Apache-2.0 →
  `NOTICE` attribution file next to the MIT `LICENSE`) — chosen over uPlot for
  built-in interaction: `dataZoom` (zoom/pan), `tooltip`, `legend`,
  `markLine`/`markArea` (session markers + tint bands).
- **UI: Noph UI (Material 3 Expressive for Svelte) + M3 spacing** — fallback
  hand-rolled M3 CSS if the young package misbehaves. App lives in `web/`.
- **API server: express inside the daemon**; display-only endpoints in v1; the
  actuator stays wrapped / seam-ready (design §7) for the start/stop fast-follow.
- **Live data: polling** (SSE later if wanted).
- **History depth:** raise `retentionDays` 90 → ~400 + hourly rollups for > 90 d;
  Franklin cloud-history backfill (home side) — **absorbs Open item 5**.
- **Weather bar:** rolling Open-Meteo `past_days` fetch cached daily, extending the
  current fetch with `weather_code` + `is_day` (archive API only if needed).
- **Actuation: display-only v1**; **start/stop and a manual-refresh UI are
  fast-follows**.
- **Scope = exactly the 2026.Nov.07 requirements**; Messages icon 💬.

### Steps

1. **Scaffold + shell** — `web/`: Vite + Svelte 5; responsive 3-tab shell (bottom nav
   with labeled icons, M3/Noph theming); portrait/landscape/desktop breakpoints; dev
   proxy → daemon; `NOTICE` file (ECharts Apache-2.0); CI gate extended (app
   build/typecheck/tests run inside `npm run check`).
   *(Branch `p2/step1-scaffold-shell` — **complete 2026-11-11**; details in the Log.)*
2. **Daemon HTTP seam + read API** — express in the daemon: `GET /api/now`,
   `GET /api/series?metric&from&to&bucket` (server-side downsampling for the 2 h–1 yr
   zoom), `GET /api/sessions`, `GET /api/messages`; bearer auth; CORS/dev mode;
   actuator kept seam-ready for the fast-follow.
3. **Now tab** — big-number EV + home SoC, brief active-session text, poll refresh,
   stale-data indicator.
4. **BSoC + Sessions chart** — ECharts dual series; `dataZoom` (vertical = zoom,
   clamped 2 h–1 yr; horizontal = scrub); session `markLine` start/end + `markArea`
   tint band; touch/hover tooltip (start/end time, EV % start→end, home %
   start→end); legend below.
   *(Branch `p2/step4-bsoc-chart` — **complete 2026-11-11**; details in the Log.)*
5. **Sessions selector** — lazy/paginated dropdown (start date + time labels);
   select → 1 s eased `dataZoom` focus on the session.
6. **System monitor + weather bar** — ±kWh area charts around a centered zero line
   (grid export ↑, grid import ↓, solar ↑, home/vehicle use ↓; kWh buckets
   integrated server-side from the sampled W columns); weather bar overlaid
   (light-dark irradiance gradient at 60% alpha, `weather_code`/`is_day` icons
   ≤ 1/hour, thinning on zoom-out, shown only when ≤ 1 week is visible, 0.5 s fade).
7. **Messages + push** — `notifications` migration + write at the notifier fanout;
   Messages list; Web Push (VAPID keys, service worker, manifest). Verify iOS-PWA
   constraints before promising parity.
8. **History depth** — retention + rollups + Franklin home-side backfill feeding the
   1-year zoom (the EV BSoC line starts at our own sampling — "if available" per the
   requirement). Absorbs Open item 5.
9. **Live validation + docs** — cross-device QA (portrait/landscape/desktop,
   gestures), load/interaction perf budget (requirements 1b priorities), README
   "Graphical UX" section, closing Log entry.

### Fast-follows (queued, not started)

- **Start/stop actuation from the app** — endpoints + consent semantics on the seam
  kept in step 2 (the CLI's explicit-flag consent is the model).
- **Manual refresh UI** — user-triggered fetch alongside polling.

### Risks / notes

- Web Push + service worker need a secure context — satisfied by the Tunnel decision.
- Noph UI is young (zero-dep M3E for Svelte); fallback is hand-rolled M3 CSS.
- ECharts bundle discipline via `echarts/core`; mobile load budget enforced in step 9.
- Weather history is a new fetch path (the store is forecast-only today).
- iOS PWA push constraints — same family as the ntfy iOS caveat; verify before
  promising parity.

## Log

<!-- Append dated entries below after each Act response, per AGENTS.md. -->

### 2026-11-11 — `dev:webhost` script added (LAN testing)

Branch `dev-webhost-script`. Root `package.json` gains **`dev:webhost`** =
`npm run dev --workspace=evcc-web -- --host`. The existing `dev:web` couldn't take a
`--host` flag: `npm run dev:web -- --host` appends the flag to the *inner* npm command
(`npm run dev --workspace=evcc-web --host`), where npm swallows it as unknown config
(`npm warn Unknown cli config "--host"`) — Vite then binds `127.0.0.1` only, so phones
on the LAN get "couldn't connect". Verified live: `dev:webhost` → `vite --host` →
`*:5173 (LISTEN)` + HTTP 200 at `http://192.168.42.43:5173/`; extra params also pass
through (`dev:webhost -- --port 5199` → `vite --host --port 5199`). Gate:
`npm run check` green.

### 2026-11-10 — workplan restructured for Phase 2; P2 plan + decisions recorded

Branch `docs/phase2-workplan-restructure`. **Phase 1 → history:** the P1c section and
all Log entries 2026-11-03 → 2026-11-09 moved to workplan-history.md as **Part 3**
(both headers and cross-pointers updated; history is now Parts 1–3). **workplan.md
now carries:** a refreshed Current state, the five **Open items carried from Phase 1**
(step-5 remainder per TODO.md, meter-reset-edge decision, `runtime.json` re-record bug,
re-target label wording, Franklin backfill → absorbed by P2 step 8), and the
**P2 — graphical UX** plan: scope = requirements 2026.Nov.07 exactly; steps 1–9
(scaffold → HTTP seam → Now → ECharts BSoC+Sessions → sessions selector → System
monitor + weather bar → Messages + Web Push → history depth → validation/docs);
fast-follows (start/stop actuation, manual refresh). All decisions resolved with the
user (Svelte 5 SPA, Cloudflare Tunnel, bearer token, in-app Web Push, ECharts over
uPlot, Noph UI, `web/`, express, polling, retention+rollups+backfill, `past_days`
weather, display-only v1) — rationale recorded in the decisions block, including the
SPA-vs-SSR answer (SSR adds a render server + hydration to a private data-driven app
for zero first-paint benefit; not a one-way door). design.md gains a §8 pointer. Also
retired the stale "Web GUI out of scope" bullet (superseded by Phase 2).
Gate: `npm run check` green — **1016 passed / 3 skipped** (docs only).

### 2026-11-11 — P2 step 1 complete: web scaffold + responsive shell

Branch `p2/step1-scaffold-shell`. `web/` added as npm workspace **`evcc-web`** —
single root lockfile, `npm ci` unchanged. Svelte 5 + Vite SPA: Noph UI
(`defaultTheme` + `NavigationBar`/`NavigationRail`), emoji tabs ⚡️/🔄/💬 exactly per
requirements, M3 4dp spacing, responsive swap at 840 px (bottom bar → left rail) with
safe-area insets; the three placeholder pages name the steps that fill them (3 / 4–6 /
7). Dev server proxies `/api` → `127.0.0.1:3002` (`ECC_API_PORT` overridable — the
step-2 contract). Root wiring: `check` now ends in `check:web` (vite build +
svelte-check + web vitest), new `dev:web`, `clean` covers `web/dist`, CI gains a
"Web app" step; root vitest was already scoped to `tests/**` (no change needed).
`NOTICE` created for ECharts (Apache-2.0, lands step 4). Fixes found while greening:
`.svelte` imports needed a local ambient shim (svelte's own `*.svelte` wildcard is
not pulled into the svelte-check program), tsconfig must include `src/**/*.svelte`,
vitest must resolve Svelte's **browser** build (server build throws
`lifecycle_function_unavailable`), and jsdom needs matchMedia/ResizeObserver/
IntersectionObserver/Web Animations polyfills (`web/src/test-setup.ts`). Noph license
read from its package at install — permissive (recorded here rather than NOTICE).
Gate: `npm run check` green — **1016 passed / 3 skipped** (root) + web build +
svelte-check **0 errors / 0 warnings** + **4/4 web tests**; `node dist/index.js --help`
OK. Dev-server smoke: index + `main.ts` 200, `/api/now` → 502 (proxy wired; step-2
server absent as expected). Known gap: README gets its "Graphical UX" section in
step 9 per plan.

### 2026-11-11 — P2 step 1 follow-up: web tests relocated to `web/tests/`

Review response: test files had been colocated under `web/src/` (a common modern
default) — but the repo pattern is a top-level `tests/` tree, and `web/` now mirrors
the root layout (`src/` + `tests/`). `git mv` moved `App.test.ts`, `tabs.test.ts`,
and `test-setup.ts` (→ `tests/setup.ts`, test infra out of shippable `src/`);
imports point at `../src/...`; `vite.config.ts` `test.include`/`setupFiles`
updated; `tsconfig` include gains `tests/**/*.ts` so svelte-check still typechecks
the tests. Root vitest is unaffected — its `tests/**` glob is root-relative and
does not match `web/tests/` (root count unchanged). Also answered for the record:
`vite-env.d.ts` in the scaffold is the standard Vite declaration file holding
`/// <reference types="vite/client" />` (import.meta.env/HMR + asset-import
typings); no runtime effect. Gate: `npm run check` green — **1016 passed /
3 skipped** (root) + web build + svelte-check **0/0** + **4/4 web tests**.

### 2026-11-11 — P2 step 2: daemon HTTP seam + read API

Branch `p2/step2-read-api` (3 commits; rebased onto main after step 1 landed).
**Shipped:** express read API inside the daemon (design §7): `GET /api/now`,
`/api/series` (server-side downsampling — bucketed AVG + W→kWh trapezoid
integration, 15-min gap cap, auto-bucket ladder ≤400 pts / hard cap 4000),
`/api/sessions` (paginated; label, target/stop_reason/SoC start–end tooltips),
`/api/messages` (final envelope, empty until step 7); bearer auth on every /api
route, dev-origin CORS, loopback `ECC_API_PORT ?? 3002`, static `web/dist` with
placeholder fallback, JSON 404s (no control endpoints), actuator wrapped on
`app.locals` for the start/stop fast-follow. Token:
`credentialStore.ensureApiToken()` (32-byte hex, notifiers-merge pattern)
surfaced via the daemon boot log + new `evcc api-token`; endpoint shapes in the
new `docs/api.md`.
Gate: `npm run check` green — **1053 passed / 3 skipped** (root) + web 4/4, svelte-check 0 errors.

### 2026-11-11 — P2 step 3 complete: Now tab live data

Branch `p2/step3-now-tab`. `GET /api/now` (step 2) now drives the Now tab:
single-column stack per the layout brief — vehicle card (giant SoC,
charging state + limit, freshness), home-battery card (SoC, solar/load,
freshness), brief session sentence ("Charging since 14:03, target 60%").
Stale badge when the battery sample is >5 min old (the sampler heartbeat —
vehicle age legitimately grows while the car sleeps). 10 s poll + refresh
on tab focus; skeleton first paint, friendly empty-store state, error +
retry, and a token panel on 401 (bearer token stored per device in
localStorage; paste from `evcc api-token`). New: `web/src/lib/api.ts`
(typed client), `web/src/lib/nowText.ts` (pure formatting),
`web/tests/now.test.ts` + `api.test.ts` (13 tests); App.test now stubs
/api/now.
Gate: `npm run check` green — **1053 passed / 3 skipped** (root) + web **17/17**, svelte-check 0 errors.

### 2026-11-11 — P2 step 3 follow-up: shared API types + page-agnostic load session

Branch `p2/step3-now-tab` (3 refactor commits). **Shared contract:** response
shapes lift to `src/api/types.ts` — one definition imported by the server
(`./types.js`, NodeNext) and the web app (bundler path; added to
`web/tsconfig.json` include); `docs/api.md` links it as the executable mirror.
**Colocation:** `nowText.ts` moves to `web/src/pages/` beside Now.svelte.
**Auth/refresh seam:** new `web/src/lib/apiSession.svelte.ts` — module-global
`session.needsToken` (any endpoint's 401, so whichever page is deeplinked first
gates the same way) + `createApiLoader` (initial fetch, interval, focus
refresh, keep-last-good-data, refetch-after-save); `TokenPanel.svelte` renders
from App off that flag; Now slims to rendering only.
Gate: `npm run check` green — **1054 passed / 2 skipped** (root) + web **18/18**, svelte-check 0 errors / 0 warnings.

### 2026-11-11 — P2 step 4 complete: BSoC + Sessions chart

Branch `p2/step4-bsoc-chart` (4 commits). **Shipped:** ECharts 6.1 (modular
`echarts/core` registration; `NOTICE` already credited it in step 1) driving the
Then tab per requirements 2b — dual BSoC line series (Vehicle + Home battery,
distinct colors) over one time x-axis, y-axis 0–100 %, **legend below**;
direction-aware wheel input (`classifyWheel`: vertical-dominant → zoom anchored
at the cursor pixel, horizontal-dominant → scrub) with ECharts pinch/mouse-drag
kept for touch/mouse, inside `dataZoom` clamped `minValueSpan`/`maxValueSpan`
2 h–1 yr plus axis bounds; session markers — dashed start/end `markLine`s (open
session: start line only) + tinted `markArea` band plug→unplug (open → now).
Axis tooltip carries the session block on hover/touch inside a band: start/end
time, EV % start→end, home % start→end (open → "in progress" / "→ now"; null
edges → "—"), then both series values. **Lazy loading** (requirements 2b): initial
24 h fetch, debounced refetch of the visible window +25 % padding when the view
leaves the loaded bounds or loaded data is >16× too coarse; sessions paged
(≤10 × 200, newest-first) until they cover the window; the user's window is
preserved and clamped into fresh bounds across refetches (also breaks the
fetch loop if bounds tighten).

**Plumbing:** the shared contract from the step-3 follow-up completed —
`SeriesResult` (+ `SeriesMetricName`/`Unit`/`Aggregation`), `SessionSummary`,
`SessionsResponse`, `ApiMessage`, `MessagesResponse` moved into the pure
`src/api/types.ts` (its header + docs/api.md already promised this; only `Now*`
lived there), server modules re-export so nothing downstream changes, and
`SERIES_METRICS satisfies Record<SeriesMetricName, MetricDef>` pins
registry↔union parity. `web/src/lib/api.ts` factors `apiGet` (same AuthError
semantics) and gains `fetchSeries`/`fetchSessions`.

**Structure:** pure `web/src/pages/bsocChart.ts` (option builder, window math,
tooltip formatter — 33 unit pins) + thin `bsocChartView.ts` (the only ECharts
runtime import; `createChart` returns null when the environment has no 2D
canvas, so jsdom never inits — it prints the expected `getContext`
not-implemented notice) + `Then.svelte` (skeleton / error+retry / keep-last-good
/ shared 401 gate mirror Now; ResizeObserver → `resize()`; chart element swap
disposes the old view). App shell test's fetch stub became route-aware
(`/api/now` | `/api/series` | `/api/sessions`).

Gate: `npm run check` green — **1054 passed / 2 skipped** (root) + web
**55/55** (was 18), svelte-check 0/0, vite build OK. Built JS after ECharts:
660 kB raw / 224 kB gz — step 9's load budget reviews this (modular imports
already applied). Known follow-ups for step 9 device QA: touch pinch/drag feel,
wheel scrub direction sign, legend/tooltip rendering on real screens.

### 2026-11-11 — P2 step 4 follow-up: helper header comments

Branch `p2/step4-bsoc-chart` — one-line `/** … */` headers on
`windowToPercent`/`percentToWindow` naming their semantics (displayed window ↔
dataZoom percent of the loaded `bounds`). Gate: web check green (55/55).

### 2026-11-12 — Then tab: static readout row replaces the hover tooltip + legend

Branch `fix/web-then-legend-readout` — docs/TODO.md "Then tab" legend +
tooltip-interaction items:
- The hover tooltip and the in-chart ECharts legend are both gone
  (`TooltipComponent`/`LegendComponent` unregistered). The page renders one
  static row below the chart:
  `Nov 12 09:35   [🟧] 🏠: 71.3% | [🟦] 🚗: 54.0%` — CSS squares colored with
  the `HOME_COLOR`/`EV_COLOR` exports (the missing color key), emoji glyphs in
  the labels, values rounded to the nearest tenth with exactly one decimal
  (em-dash when a series has no sample at or before the ts).
- X-only interaction: `ChartHandle.onPointerMove` (zrender `mousemove`/
  `globalout` → `convertFromPixel` on x) drives the readout, so session
  markLine/markArea hit areas cannot capture or affect it. On load and after
  pointer leave the row shows the newest loaded sample. Touch/pinch never
  emits mousemove, so values don't update mid-pinch (the TODO's mobile item).
- Pure logic lives in `bsocChart.ts` (`formatReadoutTs`, `formatBsocValue`,
  `sampleAtOrBefore`, `newestSampleTs`, `readoutAt`); deleted the tooltip
  formatter + helpers (`formatBsocTooltip`, `sessionAt`, `socSpan`,
  `sessionEndLabel`, `paramValue`, `TooltipParamLike`, `formatDateTime`).
- **Assumption:** the spec's ts format `MMM DD HH:SS` was read as a typo for
  `MMM DD HH:MM` and implemented as HH:MM.
- Gate: `npm run check` green — root **1053 passed / 3 skipped**, web **63/63**,
  svelte-check 0/0.

### 2026-11-13 — Then tab: chart interaction + lazy loading + dashed EV gaps

Branch `fix/web-then-chart-interaction` — the Then-tab chart interaction items
(follows the readout rework above):
- **Wheel dead at the chart**: zrender's dataZoom roam controller calls
  `eventTool.stop()` on every wheel over the grid (its per-dataZoom
  `zoomOnMouseWheel: false` filter runs *after* the stop, at another layer) on
  `painter.getViewportRoot()` — an inner div — so the bubble listener on the
  chart element never fired (root cause confirmed in-browser). The wheel path is
  now a capture-phase listener that owns the event (`preventDefault` +
  `stopPropagation`); zoom/scrub stay on `classifyWheel`/`zoomAt`/`panBy`.
- **Cursor-anchored zoom + hover readout were silently broken**: in ECharts 6
  `convertFromPixel({xAxisIndex: 0}, [px, 0])` returns NaN (the axis finder
  wants a scalar px), so `tsAtX` always returned null — the zoom anchor fell
  back to the window center and the readout to the newest sample. Fixed to the
  scalar form.
- **Zoom direction inverted**: `zoomAt` multiplied the span by its factor while
  its contract (and `ZOOM_PER_NOTCH`'s "×1.25 in") say factor > 1 zooms in —
  now divides; tests updated to the contract.
- **Lazy loading never fired**: the visible window was clamped into the loaded
  bounds, so `needsRefetch` could never see out of bounds and zoom-out stopped
  at the initial 24 h. Split the DOMAIN (now − 1 yr .. now, fixed at page init)
  from the loaded window: zoom/pan clamp into the domain, refetch
  (`fetchWindowFor(visible)`, 25 % pad) triggers when a visible edge enters a
  10 % buffer of a loadable loaded edge (or exceeds it) or on coarseness
  (unchanged); domain edges are excluded so a view parked at now cannot loop
  refetches. xAxis min/max follow the domain. Zoom-out past 24 h verified end
  to end in the browser.
- **Pinch freeze** (correcting the assumption in the entry above — zrender *does*
  synthesize `mousemove` from touch): the readout freezes while touches are down
  (capture-phase touch counting; fingers land one touchstart at a time) and
  resets to the newest-sample default when the last finger lifts.
- **Dashed EV gap lines**: pure `evGapLine` splits EV samples into runs at gaps
  > 2.5 × bucket width — solid runs with null breaks, dashed gap bridges, and
  dashed extensions from the first/last sample to the chart edges when the edge
  is more than a gap away; rendered as `[from, to]` coord-pair markLine items on
  the EV series (ECharts 6 has no `{coords}` item form — it logs "Invalid
  markLine data" and half-parses). Home series + session markers untouched.
- Window/refetch/gap math pinned in `web/tests/bsoc.test.ts`; canvas behavior
  verified in headless Chrome with mocked `/api` (18/18 checks: wheel root-cause
  probe, zoom/scrub, cursor anchor, zoom-out > 24 h, lazy-refetch coverage +
  loop-freedom, coarseness refetch, dashed segments over a planted 3 h EV hole,
  pinch freeze + resume).

### 2026-11-12 — Now tab: BSoC rounded to one decimal digit

Branch `fix/web-now-bsoc-rounding` — vehicle + home-battery big numbers rendered
raw `socPercent` (54.263). New pure `formatSocPercent` in `nowText.ts`
(`toFixed(1)`, null-safe "—") renders exactly one decimal (54.263 → 54.3,
54 → 54.0); `Now.svelte` routes both big numbers through it. Copy scan: the
captions/session line only show `chargeLimitSoc` and session `targetPercent` —
integer limit values, left unchanged. Tests: pure cases (rounding up/down,
54→54.0, 0/100, null/undefined) + a render-level case (54.263/54 → 54.3/54.0)
in `web/tests/now.test.ts`; existing render assertions updated to the
one-decimal form. Gate: `npm run check` green — 1053 passed / 3 skipped (root),
web 57/57, svelte-check 0/0.

### 2026-11-13 — Now tab BSoC rounding follow-up: trailing zero suppressed

Same branch `fix/web-now-bsoc-rounding`. Whole-number BSoC now renders `54%`,
not `54.0%`: `formatSocPercent` strips a trailing `.0` after `toFixed(1)`
(fractional values keep one decimal, `54.3`). Pure + render tests updated to
pin both forms. Gate: `npm run check` green — 1053 passed / 3 skipped (root),
web 57/57, svelte-check 0/0.

### 2026-11-12 — Then-tab session displays investigated: modeling, not rendering

Branch `fix/web-then-sessions-analysis` — read-only investigation, no code change.
Report (Nov 12, local): on the Then-tab BSoC chart, (a) a session ~09:30–15:40 with
EV BSoC flat the whole time while home battery BSoC rose significantly, and (b) a
session ~16:55 → still open at ~23:00 with EV BSoC rising until ~18:00 then flat.
Live store (`~/.ev-charge-coordinator/data.sqlite`) queried **read-only** and
compared against `ev_samples` / `home_battery_samples` / `events` / `decisions` in
those windows.

**1. What a session means today.** A session is one physical plug-in: opened on the
`plug_in` transition (Disconnected → anything) and closed on `unplug` (→
Disconnected) in `src/daemon/EvPoller.ts` (transition loop + `reconcileInitPlugIn`
for daemon-off plug-ins), persisted as `sessions.plug_ts_ms`/`unplug_ts_ms` by
`src/store/SessionStore.ts`, with closing aggregates computed over the full
plug→unplug span (`src/daemon/sessionAggregates.ts`). It **includes
plugged-in-but-not-charging (idle) stretches** — charging activity appears only as
`charging_start`/`charging_stop` rows in `events` *inside* the session, never as
its boundaries.

**2. What produced the two Nov 12 spans** (plug/unplug timestamps plausible in
both cases — observed live, precise to the second; `ev_samples` coverage is sparse
where the car slept, by design):
- **Session 35 — 09:32:14 → 15:38:15 (closed; 0.0 kWh / 0.0%):** `plug_in` at
  09:32:14 (Disconnected→Stopped). The decision engine declined to charge —
  `below_buffer`: "home battery 23.158% is at or below the 30% buffer". The car sat
  plugged in, `Stopped`, EV BSoC flat at 36% the entire window (no
  `charging_start` ever fired). Home battery BSoC rose 23.6%→80.9% on solar
  (~2.0–3.3 kW PV charging the battery). "Flat EV BSoC + rising home battery" is
  one real plug-in session with **zero charging activity** — the designed
  below-buffer behavior, folded into one tinted band.
- **Session 36 — 16:51:20 → open (~23:40):** `plug_in` 16:51:20, decision
  `started`, `charging_start` 16:53:17 — charged 32%→42% at ~22.8 kW (+6.3 kWh)
  until `charging_stop` 18:01:21 (`stop_reason: target_reached`, session target
  42%). The car then stayed plugged in (`Stopped`, SoC flat ~42→41%) with no unplug
  observed, so the session is still open and its band runs plug→now. "Rising until
  ~18:00 then flat" is charge-then-idle inside one plug-in session.
(Session 34 — Nov 10 19:27 → Nov 11 16:54, 14.98 kWh — has the same shape:
overnight idle after charging completes is folded into the session.)

**3. Does the chart render the rows correctly?** Yes. `web/src/pages/bsocChart.ts`
draws `markArea [plugTsMs, unplugTsMs ?? now]` + dashed `markLine` at plugTsMs
(+ unplugTsMs when closed), filtered by overlap with the loaded bounds
(`sessionsInWindow`); tooltip membership (`sessionAt`) matches the band bounds
exactly; `src/api/reads.ts` passes `plug_ts_ms`/`unplug_ts_ms` through unchanged;
`Then.svelte` pages sessions until they cover the fetch window. Bands cannot be
misplaced or mislabelled relative to the session rows — the chart faithfully
renders what the rows record. The mismatch is between what a tinted
"Charging session" band *implies* and what a plug→unplug row *means*.

**4. Root cause + options (NOT implemented — plan only).** Root cause is
data-modeling/semantics: "session" = plugged-in time, but users read the band as
"charging". Options for a future change:
- **A. Charge-scoped sessions** — session = `charging_start`→`charging_stop`
  (possibly several per plug-in). Fixes the reading directly but changes the
  semantics the decision engine and closing aggregates (energy/efficiency over
  plug→unplug) and the CLI `sessions` view are built on; would need a separate
  plug/visit concept.
- **B. Charging spans inside the band (recommended lean)** — keep session semantics
  (decisions/aggregates untouched); derive charging intervals from `events`
  (already records `charging_start`/`charging_stop`) or `ev_samples` charge-rate
  columns, expose them on `/api/sessions`, and render them as the tinted band with
  the plug→unplug span as a lighter outer band. Tooltip gains "charging
  16:53–18:01 (+6.3 kWh)" vs "plugged in 09:32–15:38 (0 kWh)".
- **C. Label/affordance only** — rename the band "Plugged in", dim/hatch idle
  portions, tooltip carries charging time + energy. Cheap, but flat lines inside
  bands still read as missing data.
- **D. Sample-derived spans** — as B, but charging spans computed at chart/API time
  from `ev_samples` charge-rate/SoC deltas; no event dependency, noisier across
  sleep gaps.

Recommendation: **B** (optionally +C): the `events` data already exists, session
semantics stay stable for the decision engine/aggregates, and the chart gains an
honest charging-vs-idle-plugged distinction. Also decide whether a zero-charge
plug-in like session 35 should tint at all.

Gate: `npm run check` green (no code change; verified before commit). Live-store
access strictly read-only (`sqlite3 …?mode=ro`); no data mutated.

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

