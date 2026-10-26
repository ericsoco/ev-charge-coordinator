# EV Charge Coordinator

[![CI](https://github.com/ericsoco/ev-charge-coordinator/actions/workflows/ci.yml/badge.svg)](https://github.com/ericsoco/ev-charge-coordinator/actions/workflows/ci.yml)

Coordinate electric vehicle (EV) charging with home solar battery storage. This application allows you to charge your EV using the energy stored in your home battery system, to charge your car with sunlight 🌞 instead of from the grid 💸

- **Modular**: Designed to support any EV and home battery system; see below for currently supported vehicles + battery storage
- **Multimodal**: One-shot and interactive CLI. Coming soon: desktop and mobile UX.
- **Inspect + command**: Get vehicle and battery state of charge, set charge limit, start/stop charging
- **Smart charging**: Automatically set EV charge limit based on available solar battery energy, with a configurable battery reserve buffer
- **Secure credentials**: Credentials stored securely using system keychain or encrypted file storage

## Supported Systems

### Electric Vehicles
- **Tesla** (Model S, 3, X, Y) via Tesla Fleet API (using [Vehicle Command Proxy](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-commands))

### Home Battery Systems
- **FranklinWH aPower** via [Python proxy](https://github.com/richo/franklinwh-python/) to FranklinWH API (thanks @richo!)

## Prerequisites

- **Node.js** 24 or higher
- **Python** 3.10 or higher (for FranklinWH API proxy)
- **Tesla Developer Account** with a registered application (for Tesla integration)
- **FranklinWH Account** with access to your gateway (for FranklinWH integration)

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/ericsoco/ev-charge-coordinator.git
cd ev-charge-coordinator
```

### 2. Install Node.js dependencies

```bash
npm ci
```

(`npm install` instead if you plan to change `package.json` or add dependencies.)

### 3. Install Python dependencies

```bash
pip install -r python/requirements.txt
```

### 4. Build the application

```bash
npm run build
```

## Configuration

### Energy config (`config.json`)

`charge-from-battery` reads every energy setting from a single hand-editable
JSON file, `~/.ev-charge-coordinator/config.json` (its path is shown by
`config`):

```json
{
  "batteryCapacityKwh": 13.5,
  "evBatteryKwh": 75,
  "bufferPercent": 20,
  "chargeEfficiency": 0.9
}
```

- **First run:** when fields are missing, `charge-from-battery` prompts for
  them (only on a TTY) and writes the file; without a TTY it fails with the
  list of missing fields and how to set them.
- **Hand-editing:** the file is validated on every read; bad values are echoed
  with the file path and the command fails instead of guessing a correction.
- **Setters write here too:** `config --set-battery-kwh` / `--set-ev-kwh` /
  `--set-buffer` / `--set-efficiency` all update the same file, so it
  stays the single source of truth.

### Tesla Fleet API Setup

> **Registration is a separate step from signing in.** Authorizing the app in the
> browser, and setting an Allowed Origin, neither of them registers your application
> with Tesla. Until `POST /api/1/partner_accounts` has been called, Tesla answers
> *every* `/api/1` call with `HTTP 412`, so sign-in appears to succeed and then
> nothing works. `pair-tesla-key` (step 8) performs it.

1. Create a Tesla Developer account at https://developer.tesla.com (accounts in
   China register on the separate https://developer.tesla.cn portal)
2. Create a new application and note the Client ID and Client Secret
3. Register the origin URL `http://localhost:8089/`, and redirect URI `http://localhost:8089/callback`
   (must match exactly, or the token exchange fails with `invalid_redirect_url`).
   **Also add your key's domain** (e.g. `https://your-domain.com`) as an origin —
   Tesla requires the registered domain to match the root domain of your app's
   `allowed_origins`, and pairing fails without it.
4. Select the vehicle scopes on developer.tesla.com:
     * Vehicle Information (`vehicle_device_data`)
     * Vehicle Location (`vehicle_location`) — used to detect vehicle at home
     * Vehicle Commands (`vehicle_cmds`)
     * Vehicle Charging Management (`vehicle_charging_cmds`)
5. Generate a public/private key pair for command signing. `pair-tesla-key` does this
   for you on first run; to do it by hand instead, the equivalent of what it produces
   is:
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
   openssl ec -in private-key.pem -pubout -out public-key.pem
   ```
6. Host the public key at `https://your-domain.com/.well-known/appspecific/com.tesla.3p.public-key.pem`
   (the domain is registered as the application's allowed origin; the file must be
   reachable over HTTPS with no redirect)
7. Run `node dist/index.js config --tesla-region <na|eu|cn>` if your account is not
   served by the North America deployment. Asia-Pacific accounts use `na`.
8. Run `node dist/index.js pair-tesla-key --domain your-domain.com` to generate the
   key pair, verify the published key, register the domain, and print the pairing
   link (see [Virtual key pairing](#virtual-key-pairing)).
9. Sign in so the app is granted access to your account:
   ```bash
   node dist/index.js authenticate
   ```
   This is a **separate requirement** from step 8 — Tesla's pairing flow only adds a
   key if you have already authorized the app. `pair-tesla-key` checks for it and
   tells you if it is missing, rather than letting you discover it as an error in
   the Tesla app.
10. Re-run `node dist/index.js pair-tesla-key --domain your-domain.com` and open the
    pairing link on your phone.

### Authorize host vs. token host

Tesla uses two different OAuth hosts, and sending a token exchange to the wrong
one fails in a way the docs make easy to miss:

- **Authorize** (browser consent): `https://auth.tesla.com/oauth2/v3/authorize`
- **Token exchange** (`authorization_code` and `client_credentials` grants):
  `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token`

The OIDC metadata document advertises `auth.tesla.com/oauth2/v3/token`, but
Tesla's Partner Tokens and Third-Party Tokens pages carry an explicit "Important"
note -- and curl examples -- requiring `fleet-auth.prd.vn.cloud.tesla.com`. The
CLI follows the explicit note. If Tesla changes this, override with
`ECC_TESLA_TOKEN_URL` (see Troubleshooting).

### Tesla Virtual Key pairing

Vehicles that use the Vehicle Command Protocol verify a signature on every command,
made with an application key pair that a trusted human must add to the car. Tesla's
docs are explicit that this step cannot be automated away.

`pair-tesla-key` does everything up to that tap, in three steps:

```bash
npm start -- pair-tesla-key --domain your-domain.com
```

1. **Host the public key.** The command generates (or reuses) a P-256 key pair in
   your config directory and prints the exact URL to serve the public key from. The
   private key is written `0600` and is reused on every run — replacing it
   invalidates the pairing on every already-paired vehicle.
2. **Verify the published key.** It fetches the well-known URL and compares what
   comes back against the local key, so a 200 that serves an HTML error page or a
   stale key from another machine is caught before you tap Approve in the Tesla
   app. Registering can be repeated, but a mismatched key makes pairing appear to
   succeed and every later command fail.
3. **Register the domain with Tesla**, then re-read the key back to confirm Tesla
   holds the same one. A mismatch is reported rather than waved through, because it
   pairs successfully and then fails every command.

   This step mints a *partner* token from your Client ID/Secret using the
   `client_credentials` grant, which is separate from signing in. Tesla documents no
   `refresh_token` and no `offline_access` scope for that grant — it is re-minted from
   client credentials rather than refreshed.

Finally it prints the pairing deep link:

```
https://tesla.com/_ak/your-domain.com?vin=<your-vin>
```

Open it on a device signed in to the Tesla app that owns the car, and approve the
key when the app prompts. Re-running the command is safe: it does not regenerate
the key.

**Three separate gates, in this order.** Each is checked by Tesla independently, and
the second and third are easy to mistake for the first:

1. **Registration** — `POST /api/1/partner_accounts` enrolls your *key*. This command.
2. **Consent** — you must have authorized the app for your *account*. Tesla's developer
   guide states the pairing flow requires the user to have already granted
   `vehicle_device_data`, `vehicle_cmds` or `vehicle_location`. Signing in
   (`authenticate`) does this; registering does not.
3. **Pairing** — the `_ak/` tap in the app, which only works once 1 and 2 are done.

If you tap the link before consenting, the Tesla app displays an error dialog:

```
Unable to Grant Third-Party Access
Adding a virtual key for "<domain>" is forbidden because you have not granted
"<domain>" access to your account
```

`pair-tesla-key` checks gate 2 before printing the link, and `--check-only` reports the
state of all three at once.

Options:

| Option | Effect |
| --- | --- |
| `--domain <domain>` | Domain to use (defaults to the stored one) |
| `--vin <vin>` | Vehicle to pair (defaults to the stored VIN) |
| `--check-only` | Report key/registration state; change nothing |
| `--skip-registration` | Verify the hosted key and print the link, without calling Tesla |
| `--rotate-key` | Generate a fresh key pair (every already-paired vehicle must re-approve) |

**Pairing cannot be verified from the command line.** Tesla documents no endpoint
that reports whether a given VIN holds an application key — the only documented
signal is `key_paired` in a fleet-telemetry response, which requires a signed
request and a configured telemetry server. To confirm afterwards, run a command; a
vehicle that rejects the key answers
`your public key has not been paired with the vehicle`.

### Recreated your Tesla application?

Deleting and recreating the app on developer.tesla.com invalidates the client
ID/secret but **not** your application key pair (`private-key.pem` never left
this machine). To get back to a working state:

1. `node dist/index.js authenticate --reauth` — the CLI detects the dead client
   ID at the token endpoint and prompts for the new ID/secret (or pass
   `--client-id` / `--client-secret`).
2. On developer.tesla.com, set the new app's **Allowed Origins** to include
   `https://<your-domain>` — domain registration fails with HTTP 422 without it.
3. `node dist/index.js pair-tesla-key --domain <your-domain>` — re-registers the
   domain under the new app and prints the pairing link.
   - **`Public key hash has already been taken`?** The recreated app cannot claim
     the old key (confirmed live 2026-10-24): re-run with `--rotate-key`, upload
     the printed public key to the hosting path, re-run **without** the flag,
     then re-approve on every vehicle.
4. Open the printed `https://tesla.com/_ak/<domain>` link and approve in the
   Tesla app; confirm with `pair-tesla-key --check-only`.

Rotation is required exactly when Tesla reports the hash conflict above — the
common case after recreating an app — and is otherwise unnecessary (the private
key never left this machine). Whenever it runs, `--rotate-key` re-uploads the
new public key to the hosting path and re-pairs every vehicle, and the flag must
be dropped from the re-run so the key is not rotated twice.

### Signed commands (Vehicle Command Proxy)

Vehicles built from 2021 reject plain-REST commands with HTTP 403
("Vehicle Command Protocol required"): every command must be signed with the
enrolled virtual key. The CLI drives Tesla's official
[`tesla-http-proxy`](https://github.com/teslamotors/vehicle-command) to do the
signing — it exposes the identical Fleet API REST paths on a local TLS port and
forwards signed requests upstream with your OAuth token.

**Install the proxy** (needs [Go](https://go.dev/dl/)):

```bash
git clone https://github.com/teslamotors/vehicle-command
(cd vehicle-command && go build -o ~/go/bin/tesla-http-proxy ./cmd/tesla-http-proxy)
```

Or set `ECC_TESLA_PROXY_BIN` to the binary's location. Then:

- `start` launches the proxy (status line: `✓ Tesla command proxy: pid …, port 4443`),
  and `exit` stops it. A one-shot `charge-from-battery` starts it on demand.
- TLS material is generated once into the config directory (`tesla-proxy/`,
  owner-only) — the proxy refuses to run without TLS, and its TLS key must differ
  from the command key.
- The command key is your existing `private-key.pem` from `pair-tesla-key`. That
  pairing tap is what enrolls the key **in the vehicle**; without it, a command
  fails with `your public key has not been paired with the vehicle`. Re-running
  `pair-tesla-key` only re-prints the link — the tap is the enrollment. If the
  app says the key already exists, remove it from the vehicle's key list first,
  then re-tap the link. (Verified end-to-end 2026-10-16: an idempotent
  `set_charge_limit` was signed by the proxy and accepted by the physical
  vehicle.)

### FranklinWH Setup

1. You need your FranklinWH account credentials (email/password)
2. Find your Gateway ID in the FranklinWH app under **More → Site Address** (shown as SN)

## Usage

### Interactive Mode

Start the interactive CLI:

```bash
npm start start
# ...which aliases...
node dist/index.js start
```

This launches an interactive session where you can run commands.
Type `help` to list available commands, and `<command> -help` to list available flags for a given command.

### Individual Commands

You can also run commands directly:

```bash
# Get EV battery state of charge
npm start get-ev-bsoc

# Get solar battery state of charge
npm start get-battery-soc

# Set EV charge limit to 80%
npm start set-ev-charge-limit 80

# Start EV charging
npm start start-ev-charging

# Stop EV charging
npm start stop-ev-charging

# Set charge limit from the energy the solar battery can spare (kWh math);
# in a terminal this shows the computed plan and asks
# "Set the EV charge limit to N% and start charging? (y/n)"
npm start charge-from-battery

# ... the same, and start charging without prompting
npm start charge-from-battery --start

# ... preview the computed limit without sending anything to the vehicle
npm start charge-from-battery --dry-run

# Set the battery buffer reserve to 20%
# See CLI Reference below for full config functionality
npm start config --set-buffer 20

# View configuration
npm start config

# Clear stored third-party credentials
npm start config --clear-credentials
```

## Collect Daemon

`evcc daemon` is the long-running, collect-only process: it samples the home
battery (every 2 min), polls EV state (a non-waking status probe every minute;
rich reads only while the car is awake), fetches a daily weather forecast,
aggregates charging sessions, and prunes old rows — all into the local SQLite
store. Observe it with `status`, `sessions`, and `npm run store` (see
[Data Storage & Schema](#data-storage--schema)).

`daemon` here is collect-only; `start --daemon` (see CLI Reference) is the
separate "stay resident" mode that keeps the interactive services running.

```bash
node dist/index.js daemon        # foreground
node dist/index.js daemon --once # one cycle, then exit (non-zero if any task failed)
```

### Run at login (macOS launchd)

To keep it running without an open terminal, install it as a per-user
**LaunchAgent**:

```bash
node dist/index.js daemon install           # build + render launcher & plist + bootstrap into your gui domain
node dist/index.js daemon install --dry-run # show exactly what it would do; changes nothing
node dist/index.js daemon stop              # bootout only — the agent stays installed
node dist/index.js daemon restart           # stop (if loaded) + bootstrap the installed plist; no file changes
node dist/index.js daemon uninstall         # bootout + remove the plist (keeps store, logs, credentials)
```

These wrap `scripts/install-daemon.sh` / `scripts/uninstall-daemon.sh` — the
same actions, runnable without leaving the program.

Why an agent and not a LaunchDaemon: agents run inside your login session,
which login-keychain access (`@napi-rs/keyring`) requires — a LaunchDaemon
starts as root before login, where the keychain session does not exist.

Verify and operate (label `com.transmote.ev-charge-coordinator.daemon`):

```bash
launchctl print gui/$(id -u)/com.transmote.ev-charge-coordinator.daemon | grep -E $'^\t(state|pid) ='
tail -f ~/.ev-charge-coordinator/logs/daemon.log
launchctl kickstart -k gui/$(id -u)/com.transmote.ev-charge-coordinator.daemon  # restart in place
launchctl bootout gui/$(id -u)/com.transmote.ev-charge-coordinator.daemon       # stop (until reinstall/login)
node dist/index.js status                                                       # daemon + store summary
```

The tab-anchored grep selects only the job-level lines: `launchctl print`
also reports the job's `resource coalition` and `jetsam coalition` entries,
each with its own deeper-indented `state = active`.

First run: choose **Always Allow** if macOS asks whether `node` may access the
`ev-charge-coordinator` keychain item. If you have not re-authenticated since
the `vehicle_location` scope was added, run `node dist/index.js authenticate`.

Caveats:

- **Node upgrades:** the agent runs a launcher shim
  (`~/.ev-charge-coordinator/EV Charge Coordinator`) that resolves `node`
  (via nvm or PATH) at each launch — a node upgrade needs no reinstall.
  Re-run `scripts/install-daemon.sh` if the repo directory moves.
- **Login Items title:** macOS names the login item after the launcher shim,
  so it appears as **"EV Charge Coordinator"** (previously "Node.js
  Foundation" — the node binary's signer identity). The old entry may linger
  in System Settings → Login Items until logout/restart.
- **Sleep:** launchd suspends the agent while the Mac sleeps; the first poll
  after wake catches up (a car is usually awake then).
- **Logs:** launchd does not rotate them; the daemon logs sparsely — truncate
  with `: > ~/.ev-charge-coordinator/logs/daemon.log`.
- **`exit` interplay:** `node dist/index.js exit` stops the Franklin proxy the
  daemon owns; the next battery tick re-attaches (respawning it if needed) and
  re-authenticates, so sampling self-heals. The daemon itself keeps running.
- **Weather** collects only after `set-home-location` has stored the home
  location; **EV rows** accumulate only while the car is awake (by design).

## CLI Reference

| Command | Description |
|---------|-------------|
| `start` | Start the Python API proxy and enter interactive mode |
| `start --daemon` | Start and stay resident without a prompt, for running in the background |
| `start --debug` | Print full stack traces for service startup failures |
| `exit` | Terminate all services |
| `daemon [--once]` | Run the collect daemon in the foreground (battery/EV/weather samplers, session tracking, history); `--once` runs a single collection cycle and exits non-zero if any task failed |
| `status [--json]` | Show daemon, store, proxy, and config status — reads only, starts nothing (service lines reflect this process; proxies are probed on localhost) |
| `sessions [--limit <n>] [--open]` | Show recent charging sessions from the store (default 10; `--open` lists only sessions still open) |
| `set-home-location [<latitude> <longitude>]` | Set the home location (a secret — stored in the keychain, never config.json or the store). With arguments: manual. With none: wakes the vehicle and reads its current position. Both forms confirm with current → new before writing; requires the `vehicle_location` scope |
| `get-ev-bsoc` | Get the current battery state of charge from the EV |
| `authenticate [--client-id <id>] [--client-secret <secret>] [--reauth]` | Sign in to Tesla and store credentials (no other side effects); `--reauth` re-authorizes, detecting a rejected (recreated) app and prompting for the new pair |
| `get-battery-soc` | Get the current battery state of charge from the solar battery |
| `get-charging-state` | Get the EV's charging state, battery level, and charge limit (`charge_state`; does not wake the vehicle — a sleeping car returns HTTP 408 with asleep/offline advice) |
| `set-ev-charge-limit <percent>` | Set the EV's charge limit (50-100%) |
| `start-ev-charging` | Start charging the EV |
| `stop-ev-charging` | Stop charging the EV |
| `charge-from-battery [--start] [--dry-run]` | Set EV charge limit from the energy the solar battery can spare (kWh math). With no flags, a terminal is shown the computed plan and prompted `Set the EV charge limit to N% and start charging? (y/n)`; declining sends nothing, and a non-TTY run is a no-op that points at the flags; `--start` sets the limit and starts charging without prompting; `--dry-run` calculates and prints BSoC and the computed charge target, without issuing any commands |
| `config` | Show current credentials and the energy config (with its file path) |
| `config --clear-franklin` | Clear FranklinWH credentials |
| `config --clear-tesla` | Clear Tesla credentials |
| `config --clear-credentials` | Clear all stored credentials |
| `config --tesla-region <na\|eu\|cn>` | Choose the Tesla Fleet API deployment |
| `config --tesla-domain <domain>` | Set the domain that hosts the virtual key public key |
| `config --show-public-key` | Print the virtual key public key Tesla reads |
| `config --set-battery-kwh <n>` | Set house battery capacity in `config.json` |
| `config --set-ev-kwh <n>` | Set EV battery capacity in `config.json` |
| `config --set-efficiency <0-1>` | Set charge efficiency in `config.json` |
| `config --set-buffer <percent>` | Set the battery buffer reserve, 0-100%, in `config.json` |
| `pair-tesla-key [--domain <d>] [--vin <vin>] [--check-only] [--skip-registration] [--rotate-key]` | Register the virtual key with Tesla and print the vehicle pairing link |

### Interactive Mode Commands

When running in interactive mode (`start`), the following commands are available:

- `help` - Show available commands
- `status` - Show daemon, store, proxy, and config status (reads only; `--json`
  for machine-readable output)
- `sessions` - Show recent charging sessions (`--limit <n>`, `--open`)
- `set-home-location` - Set the home location (secret): with `<lat> <lng>`
  sets manually; with no arguments wakes the vehicle and uses its current
  position; both forms confirm with current → new before writing
- `authenticate` - Sign in to Tesla and store the credentials (`--reauth` to
  re-authorize; `--client-id` / `--client-secret` to override the stored app pair)
- `get-ev-bsoc` - Get EV battery state of charge
- `get-battery-soc` - Get solar battery state of charge
- `get-charging-state` - Get the EV's charging state (does not wake the vehicle)
- `set-ev-charge-limit` - Set EV charge limit (prompts for value)
- `start-ev-charging` - Start EV charging
- `stop-ev-charging` - Stop EV charging
- `charge-from-battery` - Smart charging based on solar battery (shows the
  computed plan, then prompts `Set the EV charge limit to N% and start charging? (y/n)`
  when no flag is given; declining sends nothing; `--start` to set the limit and
  start charging without prompting, `--dry-run` to preview; same flags as the
  one-shot)
- `config` - Show or update configuration; accepts the same flags as the
  one-shot command (e.g. `config --set-efficiency 0.9`); `config --help`
  prints the flag list
- `pair-tesla-key` - Register the virtual key with Tesla; accepts `--domain`,
  `--vin`, `--check-only`, `--skip-registration`, `--rotate-key`; `--help` prints the flag list
- `exit` - Exit the application

`help <command>` inside the REPL prints that command's help, matching the
one-shot `node dist/index.js help <command>`.

Tab completion covers command names, the flags of the typed command (e.g.
`config --se` → `--set-`, double-Tab lists the matches), the accepted values
of `config --tesla-region`, and `help` topics.

## How It Works

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      EV Charge Coordinator                       │
│                        (TypeScript/Node.js)                      │
│                                                                  │
│  ┌────────────┐   ┌─────────────────┐   ┌────────────────────┐   │
│  │ Commands   │   │ TeslaService    │   │ FranklinWHService  │   │
│  │ (vehicle,  │   │ (Fleet API +    │   │ (BatteryService,   │   │
│  │  repl, …)  │   │  OAuth)         │   │  reads via proxy)  │   │
│  └────────────┘   └───────┬─────────┘   └─────────┬──────────┘   │
└───────────────────────────┼───────────────────────┼──────────────┘
                            │ commands (REST)       │ spawns
                            ▼                       ▼
                ┌───────────────────────┐ ┌──────────────────────┐
                │  tesla-http-proxy     │ │  Python Proxy        │
                │  (Tesla's Go sidecar, │ │  (Flask, spawned per │
                │  TLS :4443; spawned   │ │  session or one-shot)│
                │  per session/one-shot)│ └──────────┬───────────┘
                └───────────┬───────────┘            │ franklinwh
                            │ signed + OAuth         ▼
                            ▼              ┌──────────────────────┐
                   ┌──────────────────┐    │   FranklinWH API     │
                   │ Tesla Fleet API  │    └──────────────────────┘
                   └──────────────────┘
```

Reads (`get-battery-soc`, `get-charging-state`, …) go straight to the Fleet
API; only command endpoints need the signing sidecar. Both sidecars are torn
down on `exit` and by one-shot commands when they exit.

### Smart Charging Flow

1. Read the current state of charge from your solar battery
2. Convert the energy above your configured buffer (your reserve) into kWh
3. Add that energy to the EV's current charge, accounting for charging
   efficiency, and request the resulting percent limit (Tesla clamps to 50-100%)
4. Show the computed plan, then (with no flag in a terminal) ask to apply it:
   `y` sets the limit and starts charging, `n` sends nothing; `--start` skips
   the prompt and does both, `--dry-run` stops after the preview

The math in full (`src/utils/energy.ts`; done in kWh, never percent-on-percent,
because a percent of the ~13.5 kWh house pack and a percent of a ~75 kWh car are
different quantities):

```
available   = batteryCapacityKwh × max(0, batterySoc − bufferPercent) / 100
evCurrent   = evBatteryKwh × evSoc / 100
evTarget    = min(evBatteryKwh, evCurrent + available × chargeEfficiency)
targetLimit = clamp(round(evTarget / evBatteryKwh × 100), 50, 100)
```

The plan also reports *why* the target landed where it did: `battery` (the house
pack cannot lift the limit further), `ev-capacity` (the car would overfill), or
`tesla-minimum` (the kWh math fell below Tesla's 50% floor).

This ensures your EV only charges using excess energy from your solar battery system.

Note: The above is subject to refinement in upcoming iterations, to account for
historical usage, weather forecasts, observed energy transfer efficiency, etc.

### Data Storage & Schema

Application history lives in a single SQLite file, `<config-dir>/data.sqlite`
(WAL mode). Exactly one process ever writes it — the background collector
daemon — while CLI commands open a separate read-only connection. Three rules
keep the database and the TypeScript in agreement:

**1. The schema is defined in versioned migrations — SQL, frozen once
applied.** Each migration is a file, `src/store/migrations/NNN-name.ts`, with
an integer version; `src/store/migrations/index.ts` holds the explicit
ordered chain. A migration exports `{ version, up(db) }` containing plain
DDL. `openStore()` applies pending versions in order against
`PRAGMA user_version`, each inside a transaction; a store written by a
*newer* build is refused loudly instead of guessed at; read-only connections
never migrate.

**2. The application runtime speaks only the current schema.** Row shapes
are the camelCase interfaces in `src/store/types.ts`; behavior lives in the
`src/store/*Store.ts` repositories, whose SELECTs alias columns
(`site_id AS siteId`) so the driver output *is* the interface shape. No ORM,
no codegen. Migrations carry history; interfaces never version — a schema
change updates the migration, the interface, and the repositories together
in one commit.

**3. Tests enforce the match: a three-way schema pin**
(`tests/store/schema-pin.test.ts`):

- `PRAGMA table_info` is pinned to literal column-order, NOT NULL, and
  primary-key lists;
- every DDL column camel-converts to an interface key — the fixtures are
  *typed* as the interfaces, so `tsc` itself rejects fixture drift;
- repository reads must return exactly the interface's key set, catching a
  missing, misspelled, or extra column alias.

Round-trip tests in `tests/store/` cover behavior alongside the pin:
insert→read fidelity, NULL mapping, retention cutoffs, migration idempotency,
and the newer-store refusal. Changing the schema therefore forces migration +
interface + repositories + pin lists to move together — any omission fails
`npm run check`.

## Security

- Credentials are stored securely using:
  - System keychain (via `@napi-rs/keyring`, prebuilt native binaries) when available
  - AES-256-GCM encrypted file storage as fallback
  (the keychain store is pinned to the Linux Secret Service so it degrades to the
  encrypted-file path instead of the kernel keyring, which does not persist across
  reboots; on headless/CI setups `ECC_DISABLE_KEYCHAIN` forces the file path)
- OAuth tokens are automatically refreshed
- No credentials are logged or exposed in error messages

## Development

### Project Structure

```
ev-charge-coordinator/
├── src/
│   ├── index.ts                  # CLI entry point (Commander)
│   ├── commands/
│   │   ├── context.ts            # shared command context, services, prompts
│   │   ├── prompt.ts             # masked prompts on one readline interface
│   │   ├── repl.ts               # interactive mode
│   │   └── vehicle.ts            # vehicle commands + VCP sidecar wiring
│   ├── services/
│   │   ├── FranklinWHService.ts  # BatteryService via the Python proxy
│   │   ├── TeslaService.ts       # EVService via the Fleet API
│   │   ├── TeslaCommandProxy.ts  # manages the tesla-http-proxy sidecar
│   │   ├── ProcessManager.ts     # generic sidecar spawn/teardown
│   │   └── tesla/                # Fleet API wire format (oauth, endpoints, virtual key)
│   ├── daemon/                   # daemon runtime: lock, scheduler adapter, event detector
│   ├── store/                    # SQLite: database.ts (open/migrate), migrations/ (DDL), repositories
│   ├── types/                    # BatteryService / EVService interfaces
│   └── utils/
│       ├── config.ts             # ~/.ev-charge-coordinator/config.json
│       ├── daemonConfig.ts       # ~/.ev-charge-coordinator/daemon-config.json (daemon tunables)
│       ├── credentials.ts        # keychain (@napi-rs/keyring) / encrypted-file storage
│       ├── energy.ts             # charge-from-battery math (pure)
│       └── color.ts              # output theming
├── python/
│   ├── franklin_proxy.py         # Flask proxy around the franklinwh package
│   └── requirements.txt
├── scripts/                      # launchd install/uninstall (install-daemon.sh, …) + dev checks
├── tests/                        # vitest suites; live tests gated by RUN_LIVE_TESTS=1
├── dist/                         # Compiled JavaScript (npm run build)
├── package.json
├── tsconfig.json
└── README.md
```

### Building

```bash
npm run build
```

### Checks

```bash
npm run check       # build + lint + typecheck + unit tests — the gate for any change
npm run test        # unit tests only (vitest)
npm run lint
npm run typecheck
```

Tests that hit the real FranklinWH / Tesla APIs are gated behind
`RUN_LIVE_TESTS=1` and need local credentials; everything else runs offline.
CI (`.github/workflows/ci.yml`) runs the same checks on Node 24 and 26 and
verifies that the Python proxy compiles.
`tests/store/schema-pin.test.ts` also pins the database schema, the TypeScript
row interfaces, and the repositories' SELECT aliases together (see
**Data Storage & Schema** above).

### Running in Development

```bash
npm run dev start
```

## Adding Support for Other Systems

The architecture is designed to be extensible. To add support for a new EV or battery system:

### New EV Type

1. Create a new service class implementing the `EVService` interface in `src/types/ev.ts`
2. Implement all required methods (authenticate, getStateOfCharge, setChargeLimit, etc.)
3. Add the service to the CLI

### New Battery Type

1. Create a new service class implementing the `BatteryService` interface in `src/types/battery.ts`
2. Implement all required methods (authenticate, getStateOfCharge, getStats, etc.)
3. Add the service to the CLI

## Troubleshooting

### FranklinWH Authentication

A wrong password and a FranklinWH outage look identical from the CLI: every
exception in `python/franklin_proxy.py`'s handler is flattened to HTTP 500, so both
arrive as `Internal error`. To tell them apart:

```bash
npm run check:franklin -- --email you@example.com
```

This calls the real library and reports the exception type, which separates an
`InvalidCredentialsException` (your credentials) from a gateway error (FranklinWH's
outage). Add `--gateway-id` to exercise the gateway too. It exits non-zero on
failure, so it works as a check in a script.

Passwords and client secrets are prompted for with masked input (`*` per
keystroke) on the same single readline interface as every other prompt -- no
prompt library, no second interface to double-echo against. The Gateway ID is
deliberately unmasked: it is a device identifier visible in the FranklinWH app,
not a secret. Without a TTY (piped input, CI) there is nothing to mask with, so
the prompt says so rather than echoing silently.

### Python interpreter resolution

The FranklinWH proxy runs on your local Python, resolved in this order:

1. the project's `.venv/bin/python`
2. `$ECC_PYTHON`, if set
3. `python3` on your `PATH`

If none of those can run the proxy, the CLI stops with the interpreter it tried
and the fix:

```
✗ Could not run the project .venv (/path/to/.venv/bin/python).
  Fix: python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt
```

To check that your interpreter and credentials reach the real FranklinWH
library:

```bash
npm run check:franklin -- --email you@example.com
```

### Tesla Authentication Issues

- Ensure your Tesla Developer application has the correct scopes enabled
- Make sure your public key is properly hosted and accessible
- Check that you've registered with the Fleet API in your region
- The OAuth redirect URI registered on developer.tesla.com must equal
  `http://localhost:8089/callback` character for character
- What Tesla's answer actually means:

  | Message | Fix |
  |---------|-----|
  | `client_not_found` | wrong Client ID; copy it from developer.tesla.com > your app |
  | `invalid_redirect_url` | registered redirect URI differs from the one sent |
  | `invalid_auth_code` | the code was already used or expired; sign in again (`authenticate`) |
  | `login_required` | password reset or the refresh token was already consumed; re-authenticate |
  | HTTP 412 | app not registered with Tesla in this region; run `pair-tesla-key` |
  | HTTP 422 | request invalid — for domain registration, Allowed Origins on developer.tesla.com must include the domain's origin |
  | HTTP 421 | right credentials, wrong region; set `--tesla-region` |
  | HTTP 429 | rate limit ("Retry in 12 seconds"); wait the stated time — wake loops honor it automatically and never burn retries on it |
  | `your public key has not been paired with the vehicle` | the key was never
    approved on the phone, or Tesla holds a different key; re-run
    `pair-tesla-key --check-only` |

- Refresh tokens are single use: Tesla returns a new one on every refresh and the
  old one stops working, so never copy the stored token to another machine
- Escape hatches, if Tesla changes its wire format: `ECC_TESLA_TOKEN_URL` overrides
  the token endpoint and `ECC_TESLA_PKCE=0` drops the PKCE parameters from the
  authorize request (Tesla does not document PKCE, so this restores the strictly
  documented request shape)

### `set-home-location`: "Location is not in the vehicle response"

Location fields live behind Tesla's **`location_data`** endpoint selector.

The CLI requests `location_data`, so a missing location after a successful wake means the
`vehicle_location` scope is missing from the **account grant** (checking it on
developer.tesla.com is not enough): revoke the app at
`https://accounts.tesla.com/en_us/account-settings/security?tab=tpty-apps`, then re-run
`authenticate` and approve Vehicle Location on the consent screen.

### `✓ EV charging started` but nothing happens

- Older versions trusted the HTTP status of a charging command. Tesla's command
  proxy reports an action the car refused (for example `charge_start` while
  unplugged) as **HTTP 200** with an error body
  (`{"response":null,"error":"car could not execute command: …"}`), so the CLI
  printed success for a command that never happened.
- Charging commands now verify twice: the response body must not report a
  failure, and a post-condition check polls `charge_state` for up to ~12 seconds
  to confirm the car actually reports `Charging` (or not-charging, for
  `stop-ev-charging`). A failure names the observed state, e.g.
  `state: Disconnected - plug in the vehicle`.
- To inspect the live state yourself, run `get-charging-state`. Note it does not
  wake the vehicle: a sleeping car returns HTTP 408 - either wait for the next
  charging command (which wakes it) or accept the wake cost is only paid on
  commands.

### FranklinWH Connection Issues

- Verify your Gateway ID is correct (found in app under More → Site Address)
- Ensure your account credentials are valid
- Check that the Python proxy can connect to FranklinWH servers

### Credential Storage Issues

- If using system keychain fails, credentials will be stored in `~/.ev-charge-coordinator/`
- Ensure the directory has proper permissions (should be 700)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by Tesla, Inc. or FranklinWH. Use at your own risk. Always monitor your charging sessions and ensure your electrical system is properly configured for EV charging.
