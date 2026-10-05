# EV Charge Coordinator

Coordinate electric vehicle (EV) charging with home solar battery storage. This application allows you to charge your EV using the energy stored in your home battery system, helping you maximize the use of solar-generated power.

## Features

- **Multi-system support**: Designed to support any EV and home battery system (currently implements Tesla and FranklinWH)
- **Solar battery integration**: Read state of charge from your home battery
- **EV control**: Get battery status, set charge limits, and start/stop charging
- **Smart charging**: Automatically set EV charge limit based on available solar battery energy
- **Battery buffer**: Configure a reserve amount to keep in your home battery
- **Secure credentials**: Credentials stored securely using system keychain or encrypted file storage

## Supported Systems

### Electric Vehicles
- **Tesla** (Model S, 3, X, Y) via Tesla Fleet API

### Home Battery Systems
- **FranklinWH aPower** via Python proxy to FranklinWH API

## Prerequisites

- **Node.js** 18.0.0 or higher
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
npm install
```

### 3. Install Python dependencies

```bash
pip install -r python/requirements.txt
```

### 4. Build the application

```bash
npm run build
```

## Configuration

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

**Pairing cannot be verified from the command line.** Tesla documents no endpoint
that reports whether a given VIN holds an application key — the only documented
signal is `key_paired` in a fleet-telemetry response, which requires a signed
request and a configured telemetry server. To confirm afterwards, run a command; a
vehicle that rejects the key answers
`your public key has not been paired with the vehicle`.

### FranklinWH Setup

1. You need your FranklinWH account credentials (email/password)
2. Find your Gateway ID in the FranklinWH app under **More → Site Address** (shown as SN)

## Usage

### Interactive Mode

Start the interactive CLI:

```bash
npm start start
# or after building:
node dist/index.js start
```

This launches an interactive session where you can run commands.

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

# Set charge limit based on solar battery (minus buffer)
npm start charge-from-battery

# Set battery buffer to 20%
npm start set-battery-buffer 20

# View configuration
npm start config

# Clear stored credentials
npm start config --clear-all
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `start` | Start the Python API proxy and enter interactive mode |
| `start --daemon` | Start and stay resident without a prompt, for running in the background |
| `start --debug` | Print full stack traces for service startup failures |
| `exit` | Terminate all services |
| `get-ev-bsoc` | Get the current battery state of charge from the EV |
| `authenticate` | Sign in to Tesla and store credentials (no other side effects) |
| `get-battery-soc` | Get the current battery state of charge from the solar battery |
| `set-ev-charge-limit <percent>` | Set the EV's charge limit (50-100%) |
| `start-ev-charging` | Start charging the EV |
| `stop-ev-charging` | Stop charging the EV |
| `charge-from-battery` | Set EV charge limit to available solar battery charge minus buffer |
| `set-battery-buffer <percent>` | Set the amount of charge to keep in the solar battery (0-100%) |
| `config` | Show current configuration |
| `config --clear-franklin` | Clear FranklinWH credentials |
| `config --clear-tesla` | Clear Tesla credentials |
| `config --clear-all` | Clear all stored credentials |
| `config --tesla-region <na\|eu\|cn>` | Choose the Tesla Fleet API deployment |
| `config --tesla-domain <domain>` | Set the domain that hosts the virtual key public key |
| `config --show-public-key` | Print the virtual key public key Tesla reads |
| `pair-tesla-key` | Register the virtual key with Tesla and print the vehicle pairing link |

### Interactive Mode Commands

When running in interactive mode (`start`), the following commands are available:

- `help` - Show available commands
- `status` - Show current status of all systems
- `get-ev-bsoc` - Get EV battery state of charge
- `get-battery-soc` - Get solar battery state of charge
- `set-ev-charge-limit` - Set EV charge limit (prompts for value)
- `start-ev-charging` - Start EV charging
- `stop-ev-charging` - Stop EV charging
- `charge-from-battery` - Smart charging based on solar battery
- `set-battery-buffer` - Set battery buffer percentage
- `exit` - Exit the application

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    EV Charge Coordinator                    │
│                      (TypeScript/Node.js)                   │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐         ┌──────────────────┐           │
│  │   Tesla Service │         │ FranklinWH Svc   │           │
│  │  (Fleet API)    │         │ (HTTP Proxy)     │           │
│  └────────┬────────┘         └────────┬─────────┘           │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            ▼                           ▼
     ┌──────────────┐          ┌──────────────────┐
     │ Tesla Fleet  │          │  Python Proxy    │
     │     API      │          │  (Flask Server)  │
     └──────────────┘          └────────┬─────────┘
                                        │
                                        ▼
                               ┌──────────────────┐
                               │  FranklinWH API  │
                               │   (franklinwh)   │
                               └──────────────────┘
```

### Smart Charging Flow

1. Read the current state of charge from your solar battery
2. Subtract your configured buffer (energy you want to keep in reserve)
3. Set the EV charge limit to the available percentage
4. Optionally start charging immediately

This ensures your EV only charges using excess energy from your solar battery system.

## Security

- Credentials are stored securely using:
  - System keychain (via `keytar`) when available
  - AES-256-GCM encrypted file storage as fallback
- OAuth tokens are automatically refreshed
- No credentials are logged or exposed in error messages

## Development

### Project Structure

```
ev-charge-coordinator/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── services/
│   │   ├── FranklinWHService.ts
│   │   └── TeslaService.ts
│   ├── types/
│   │   ├── battery.ts
│   │   └── ev.ts
│   └── utils/
│       └── credentials.ts
├── python/
│   ├── franklin_proxy.py     # FranklinWH API proxy server
│   └── requirements.txt
├── dist/                     # Compiled JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

### Building

```bash
npm run build
```

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

Passwords and client secrets are prompted for without echo — they never appear on
screen or in terminal scrollback. If the masking library cannot be loaded, the
prompt says so rather than echoing silently.

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
  | HTTP 421 | right credentials, wrong region; set `--tesla-region` |
  | `your public key has not been paired with the vehicle` | the key was never
    approved on the phone, or Tesla holds a different key; re-run
    `pair-tesla-key --check-only` |

- Refresh tokens are single use: Tesla returns a new one on every refresh and the
  old one stops working, so never copy the stored token to another machine
- Escape hatches, if Tesla changes its wire format: `ECC_TESLA_TOKEN_URL` overrides
  the token endpoint and `ECC_TESLA_PKCE=0` drops the PKCE parameters from the
  authorize request (Tesla does not document PKCE, so this restores the strictly
  documented request shape)

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
