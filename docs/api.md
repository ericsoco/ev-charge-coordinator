# ev-charge-coordinator read API

Display-only HTTP API hosted **inside the daemon** (design §7 HTTP seam,
P2 step 2). It serves the web app's data and, when `web/dist` has been
built, the app itself. There are **no vehicle-control endpoints** — the
actuator stays wrapped for the start/stop fast-follow. P2 step 7 added the
Web Push subscription routes (app plumbing, not actuation).

## Base URL, port, binding

| | |
|---|---|
| Base URL | `http://127.0.0.1:3002` |
| Port override | env `ECC_API_PORT` (integer `0`–`65535`; `0` = ephemeral, for tests) |
| Bind address | loopback only (`127.0.0.1`) — never reachable off-machine without the tunnel |
| Started by | `ev-charge-coordinator daemon` (continuous mode; `daemon --once` never starts it) |
| Stopped by | daemon shutdown — the server closes before the store, in-process |

The step-1 Vite dev proxy targets `/api → http://127.0.0.1:3002`; the
default port is fixed to match.

## Authentication

Every `/api` route requires:

```
Authorization: Bearer <token>
```

Missing/wrong token → `401` with `WWW-Authenticate: Bearer` and body
`{"error":"unauthorized"}`. Comparison is constant-time (SHA-256 first).

The response shapes are mirrored as TypeScript in
[`src/api/types.ts`](../src/api/types.ts) — the single definition shared by
the server handlers and the web app.

The token is a **shared secret** (32 random bytes, hex = 64 chars):

- **Stored** in the credential store (`api.token`, alongside the notifier
  secrets — macOS keychain with encrypted-file fallback; never
  `config.json`).
- **Minted** on first use (`CredentialStore.ensureApiToken()`).
- **Surfaced** two ways:
  1. The daemon's boot log line —
     `[api] read API on http://127.0.0.1:3002 — bearer token: <token>`
     (readable via `ev-charge-coordinator daemon logs`);
  2. `ev-charge-coordinator api-token` — prints the token alone on stdout
     (mints on first use; pipeable, e.g. `| pbcopy`).

The token is stable across daemon restarts; the web app stores it per
device (P2 decision: "shared bearer token, stored per device").

## CORS

The Vite dev origin `http://localhost:5173` is allowed (`GET`, `POST`, and
preflight answered without auth; `Authorization` permitted). All other
origins get no CORS headers — production is same-origin behind the
Cloudflare Tunnel and needs none.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/now` | Current vehicle + home-battery state, active session, sample freshness |
| GET | `/api/series` | Downsampled time series for the charts |
| GET | `/api/sessions` | Paginated charging-session list with tooltip data |
| GET | `/api/messages` | Paged notification history (newest first) |
| GET | `/api/push/public-key` | VAPID public key for `PushManager.subscribe` |
| POST | `/api/push/subscribe` | Store this device's push subscription |
| POST | `/api/push/unsubscribe` | Drop this device's push subscription (idempotent) |
| GET | `/` | The built web app (`web/dist`) or a placeholder page |

Anything else under `/api` — unknown paths and verbs no route registered —
is a JSON `404` (`{"error":"no such endpoint: <METHOD> <path>"}`): every
registered route is a read or push-subscription plumbing; vehicle control
stays out.

### Errors

All error bodies are `{"error": "<message>"}` with status `400`
(validation), `401` (auth), `404` (unknown route/verb), `500` (unexpected).

---

## GET /api/now

Latest store rows only — no live probes (the daemon's samplers own
freshness). `ageMs = nowMs − sampleTsMs` feeds the Now tab's stale-data
indicator.

```json
{
  "nowMs": 1794356800000,
  "vehicle": {
    "vehicleId": "5YJ…",
    "socPercent": 60,
    "chargingState": "Stopped",
    "chargeLimitSoc": 80,
    "sampleTsMs": 1794356750000,
    "ageMs": 50000
  },
  "battery": {
    "socPercent": 72,
    "powerW": 100,
    "homeLoadW": 500,
    "solarW": 200,
    "gridW": -50,
    "sampleTsMs": 1794356750000,
    "ageMs": 50000
  },
  "session": { "id": 42, "plugTsMs": 1794356150000, "targetPercent": 60, "stopReason": null }
}
```

- `vehicle: null` — no EV sample rows yet, or the daemon has no vehicle id.
- `battery: null` — no home-battery samples yet.
- `session: null` — no open session. Fields: session id, plug-in time,
  current target SoC (`null` = no computed target), and the monitor's
  `stopReason` (`"target_reached"` | `"battery_buffer"` | `null`).
- `gridW > 0` = importing, `< 0` = exporting (gateway sign convention).

## GET /api/series

Server-side downsampling — the charts never pull raw sample rows.

| Param | Required | Meaning |
|---|---|---|
| `metric` | yes | one of the metrics below |
| `from`, `to` | yes | epoch **milliseconds**; `from < to`, span ≤ ~3 years |
| `bucket` | no | bucket width in **ms**, epoch-aligned multiples; ≥ 1000, and `span/bucket ≤ 4000` |

When `bucket` is omitted it is auto-chosen from a ladder
(1m, 2m, 5m, 10m, 15m, 30m, 1h, 2h, 3h, 6h, 12h, 1d, 2d, 7d, 14d, 30d, 90d)
— the finest bucket keeping the range within **400 points**. This matches
the chart zooms (2 h → ~120 pts, 1 y → ~365 pts).

| metric | Source | Unit | Aggregation |
|---|---|---|---|
| `ev_soc` | `ev_samples.soc_percent` | percent | average per bucket |
| `battery_soc` | `home_battery_samples.soc_percent` | percent | average per bucket |
| `grid_import` | `grid_w` positive part | kWh per bucket | trapezoid integration |
| `grid_export` | `grid_w` negative part (flipped) | kWh per bucket | trapezoid integration |
| `solar` | `solar_w` clamped ≥ 0 | kWh per bucket | trapezoid integration |
| `home_load` | `home_load_w` clamped ≥ 0 | kWh per bucket | trapezoid integration |

Energy metrics integrate the sampled W columns **on the server**
(P2 step 6: "kWh buckets integrated server-side"): each consecutive sample
pair contributes `avg(W) × Δt`, attributed to the **later** sample's
bucket. Pairs further apart than **15 minutes** are skipped (a daemon
outage is an unobserved window, not energy), and the first sample inside
`from` starts the integration. Null power columns are excluded.

```json
{
  "metric": "battery_soc",
  "unit": "percent",
  "aggregation": "avg",
  "from": 1794353200000,
  "to": 1794356800000,
  "bucketMs": 300000,
  "points": [[1794353200000, 71.5], [1794353500000, 72]]
}
```

`points` are `[epochMs, value]` pairs, oldest bucket first; a range with
no samples returns `[]`. Values are raw (client formats); energy values
are kWh per bucket.

## GET /api/sessions

| Param | Default | Meaning |
|---|---|---|
| `limit` | 50 | page size, 1–200 |
| `offset` | 0 | rows to skip (newest-first ordering) |

```json
{
  "total": 57,
  "limit": 50,
  "offset": 0,
  "sessions": [
    {
      "id": 57,
      "label": "2026-11-08 14:03",
      "plugTsMs": 1794181380000,
      "unplugTsMs": null,
      "open": true,
      "targetPercent": 62,
      "initialTargetPercent": 60,
      "targetChangeReason": "raised 60 → 62 (solar surplus, …)",
      "stopReason": null,
      "energyKwh": null,
      "energyPercent": null,
      "efficiency": null,
      "evSocStartPercent": 54,
      "evSocEndPercent": null,
      "batterySocStartPercent": 71.5,
      "batterySocEndPercent": null
    }
  ]
}
```

- `label` = session start date+time, local `YYYY-MM-DD HH:MM` — the
  sessions-selector label (requirements 2b).
- Tooltip fields: `targetPercent` / `initialTargetPercent` / `stopReason`
  and the `*SocStart/EndPercent` pairs (vehicle + home battery, %).
- SoC **end** values are `null` while a session is open — an open session
  has no final value yet; the chart can show "start → now" from the series
  endpoints. Start/end are also `null` when the window holds no samples.
- `energyKwh` / `energyPercent` / `efficiency` are closing aggregates
  (null until the session closes; `efficiency` = EV kWh ÷ house kWh).

## GET /api/messages

Paged notification history — one row per event the daemon's notifier
fanout dispatched (P2 step 7), newest first.

Query: `limit` (1–500, default 200), `offset` (≥ 0, default 0).

```json
{
  "messages": [
    {
      "id": 42,
      "tsMs": 1794356800000,
      "type": "charging-started",
      "title": "Charging started",
      "body": "⚡️ charging started (SoC 54%)"
    }
  ]
}
```

- `type` is a `NotificationEvent.type` value (`plug-in-detected`,
  `decision-made`, `charging-started`, `charging-stopped`,
  `session-retargeted`, `failure`, `test`).
- `title`/`body` are the rendered headline/detail — the exact text ntfy/Slack
  show (`notificationTitle` + `formatNotificationEvent`).
- A row is written when the fanout **dispatches** the event (before
  per-client delivery), so a failed ntfy/Slack post still appears in the
  list; per-client delivery failures are logged, not reflected here.
- Rows are pruned with the samples' `retentionDays` by the daemon's daily
  retention task.

## Web Push (P2 step 7)

Flow between this API, the web app, and the daemon's `webpush` fanout
target:

1. `GET /api/push/public-key` → `{ "publicKey": "…" }` — the VAPID keypair
   is minted on first use into the credential store (`ensureVapidKeys()`),
   same pattern as the bearer token.
2. The app registers `/sw.js`, `Notification.requestPermission()` runs from
   a direct user tap, then `PushManager.subscribe({ userVisibleOnly:
   true, applicationServerKey })`.
3. `POST /api/push/subscribe` with `{ endpoint, keys: { p256dh, auth } }`
   → `{ "ok": true }` — an **upsert**: re-subscribing rotates the keys for
   that endpoint, never duplicates it.
4. Every dispatched event is pushed to all stored subscriptions with the
   same `title`/`body` as `/api/messages`; a `404`/`410` answer from the
   push service drops that subscription.
5. `POST /api/push/unsubscribe` with `{ endpoint }` → `{ "ok": true }` —
   idempotent (unknown endpoint still succeeds).

**iOS/iPadOS caveat (verified against WebKit's announcement):** Web Push on
iOS/iPadOS requires **16.4+** and works only for the app **added to the
Home Screen** (standalone PWA), with the permission prompt tied to a direct
user gesture. The Messages tab detects that context and shows the
Add-to-Home-Screen guidance instead of the enable button — parity with
desktop/Android is deliberately not promised for plain Safari tabs.

## Static serving

- If `<repo>/web/dist/index.html` exists, it is served at `/` with an
  SPA fallback (any non-`/api` GET returns the app shell for
  client-side routing). `/api` routes keep their JSON contract.
- If not (step 1 not built yet), `GET /` returns a plain placeholder
  page saying the UI is not built. The API never depends on `web/`.

## Actuator seam (design §7) — no control endpoints yet

The daemon wires the wrapped Tesla actuator
(`setChargeLimit` / `startCharging` / `stopCharging`) into the express app
(`app.locals.actuator`) so the start/stop fast-follow can register routes
on it without touching the daemon. In this step no route reads it:
control-style requests fall through to the JSON 404 above.

## Example

```bash
TOKEN=$(ev-charge-coordinator api-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:3002/api/series?metric=grid_import&from=1794268800000&to=1794355200000'
```


