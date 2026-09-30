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

1. Create a Tesla Developer account at https://developer.tesla.com (accounts in
   China register on the separate https://developer.tesla.cn portal)
2. Create a new application and note the Client ID and Client Secret
3. Register the redirect URI `http://localhost:8089/callback` (must match exactly,
   or the token exchange fails with `invalid_redirect_url`) and enable these scopes:
   `openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds`.
   `offline_access` is what makes Tesla issue a refresh token at all.
4. Generate a public/private key pair for command signing (`src/services/tesla/
   VirtualKeyService.ts` generates and validates the same pair programmatically):
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
   openssl ec -in private-key.pem -pubout -out public-key.pem
   ```
5. Host the public key at `https://your-domain.com/.well-known/appspecific/com.tesla.3p.public-key.pem`
   (the domain is registered as the application's allowed origin; the file must be
   reachable over HTTPS with no redirect)
6. Run `node dist/index.js config --tesla-region <na|eu|cn>` if your account is not
   served by the North America deployment. Asia-Pacific accounts use `na`.

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
| `exit` | Terminate all services |
| `get-ev-bsoc` | Get the current battery state of charge from the EV |
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
│                    EV Charge Coordinator                     │
│                      (TypeScript/Node.js)                    │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐         ┌─────────────────┐            │
│  │   Tesla Service │         │ FranklinWH Svc  │            │
│  │  (Fleet API)    │         │ (HTTP Proxy)    │            │
│  └────────┬────────┘         └────────┬────────┘            │
└───────────┼──────────────────────────┼─────────────────────┘
            │                          │
            ▼                          ▼
     ┌──────────────┐         ┌──────────────────┐
     │ Tesla Fleet  │         │  Python Proxy    │
     │     API      │         │  (Flask Server)  │
     └──────────────┘         └────────┬─────────┘
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
  | `invalid_auth_code` | the code was already used or expired; authenticate again |
  | `login_required` | password reset or the refresh token was already consumed; re-authenticate |
  | HTTP 412 | application key not registered; complete the pairing step |
  | HTTP 421 | right credentials, wrong region; set `--tesla-region` |

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
