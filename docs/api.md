# ev-charge-coordinator read API

Display-only HTTP API hosted **inside the daemon** (design §7 HTTP seam,
P2 step 2). It serves the web app's data and, when `web/dist` has been
built, the app itself. There are **no control endpoints** in this step —
the actuator stays wrapped for the start/stop fast-follow.

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

The Vite dev origin `http://localhost:5173` is allowed (preflight
answered without auth; `Authorization` permitted). All other origins get
no CORS headers — production is same-origin behind the Cloudflare Tunnel
and needs none.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/now` | Current vehicle + home-battery state, active session, sample freshness |
| GET | `/api/series` | Downsampled time series for the charts |
| GET | `/api/sessions` | Paginated charging-session list with tooltip data |
| GET | `/api/messages` | Notification history (empty until P2 step 7) |
| GET | `/` | The built web app (`web/dist`) or a placeholder page |

Anything else under `/api` — unknown paths **and** non-GET verbs — is a
JSON `404` (`{"error":"no such endpoint: <METHOD> <path>"}`): step 2 is
GET-only by construction.

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

Final response shape now; the list is **always empty** until the
`notifications` table lands in P2 step 7 (out of scope for step 2):

```json
{ "messages": [] }
```

A message object will be (provisional — bound to this shape now so the
app can be built against it):

```json
{
  "id": 42,
  "tsMs": 1794356800000,
  "type": "charging-started",
  "title": "Charging started",
  "body": "session 42 — EV 54% → 60%, target 62%"
}
```

- `type` is a `NotificationEvent.type` value (`plug-in-detected`,
  `decision-made`, `charging-started`, `charging-stopped`,
  `session-retargeted`, `failure`, `test`).
- `title`/`body` are the human headline/detail — what ntfy/Slack show.

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


