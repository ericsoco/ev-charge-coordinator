# EV Charge Coordinator - Development Guide

## Project Overview
TypeScript/Node.js application that coordinates EV charging with home solar battery systems.

## Architecture
- **TypeScript CLI** (`src/index.ts`): Main entry point with Commander.js
- **Services**: `FranklinWHService.ts` (battery), `TeslaService.ts` (EV)
- **Tesla wire format** (`src/services/tesla/`): `oauth.ts` (request/response shapes),
  `endpoints.ts` (region -> hostnames, scopes), `VirtualKeyService.ts` (app key pair)
- **Python Proxy** (`python/franklin_proxy.py`): Flask server for FranklinWH API
- **Credential Store** (`src/utils/credentials.ts`): Secure storage using keytar/encrypted files

## Build Commands
```bash
npm install           # Install dependencies
npm run build         # Compile TypeScript
npm run dev           # Run with tsx (dev mode)
npm start             # Run compiled version
pip install -r python/requirements.txt  # Python deps
```

## Key Files
- `src/types/battery.ts`: BatteryService interface
- `src/types/ev.ts`: EVService interface
- `python/franklin_proxy.py`: Proxies requests to franklinwh Python library

## External APIs
- **Tesla Fleet API**: OAuth2 auth, requires developer account and virtual key
- **FranklinWH**: Uses `franklinwh` Python package, auth via username/password/gateway_id

## Testing
- Run `node dist/index.js --help` to verify CLI
- Run `python3 python/franklin_proxy.py` to test proxy startup
- Run `npm run test` to run tests with vitest
- Run `npm run lint` to run linter

## git workflow
Each user prompt to the agent should be written to a new local branch.
Create local commits as needed to separate logical chunks of work to enable human review.
Do not push the branch to remote; keep it local and let user check and land changes to main.

## Adding New Systems
1. Implement `BatteryService` or `EVService` interface
2. Add service to CLI commands in `src/index.ts`

## Handling state
Prefer stateless architectures / implementations whenever possible.
When business logic seems to require storing state, verify the approach with the human developer
with clear reasoning and a detailed description of the proposed approach.

## Comments
Keep inline comments succinct.
Do not clutter inline comments with information about previous implementations;
this historical information can be left in the workplan if valuable.