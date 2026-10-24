# EV Charge Coordinator - Development Guide

## Project Overview
TypeScript/Node.js application that coordinates EV charging with home solar battery systems.

## Architecture
- **TypeScript CLI** (`src/index.ts`): Main entry point with Commander.js
- **Commands** (`src/commands/`): `vehicle.ts` (vehicle commands + VCP sidecar wiring),
  `repl.ts` (interactive mode), `context.ts` (shared services/prompt plumbing),
  `prompt.ts` (masked prompts on one readline interface)
- **Services**: `FranklinWHService.ts` (battery), `TeslaService.ts` (EV)
- **Tesla sidecar** (`src/services/TeslaCommandProxy.ts` + `ProcessManager.ts`): spawns
  Tesla's `tesla-http-proxy` for signed Vehicle Command Protocol commands (TLS :4443);
  per-spawn token lives in `~/.ev-charge-coordinator/runtime.json`
- **Tesla wire format** (`src/services/tesla/`): `oauth.ts` (request/response shapes),
  `endpoints.ts` (region -> hostnames, scopes), `VirtualKeyService.ts` (app key pair)
- **Python Proxy** (`python/franklin_proxy.py`): Flask server for FranklinWH API, spawned
  per session or one-shot
- **Utils**: `credentials.ts` (@napi-rs/keyring/encrypted files), `config.ts`
  (`~/.ev-charge-coordinator/config.json` energy config), `energy.ts` (charge-from-battery
  math, pure), `color.ts` (output theming)

## Build Commands
```bash
npm ci                # Install dependencies (lockfile-exact)
npm run build         # Compile TypeScript
npm run check         # build + lint + typecheck + unit tests (gate for any change)
npm run test          # unit tests only (vitest); live tests need RUN_LIVE_TESTS=1
npm run lint          # ESLint
npm run typecheck     # tsc --noEmit over src + tests
npm run dev           # Run with tsx (dev mode)
npm start             # Run compiled version
python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt  # Python deps
```

## Key Files
- `src/types/battery.ts`: BatteryService interface
- `src/types/ev.ts`: EVService interface
- `src/store/`: SQLite store — `database.ts` (open/migrate/WAL), `migrations/` (versioned
  DDL), `*Store.ts` repositories, `types.ts` row interfaces; schema↔code is enforced by
  `tests/store/schema-pin.test.ts`
- `python/franklin_proxy.py`: Proxies requests to franklinwh Python library

## External APIs
- **Tesla Fleet API**: OAuth2 auth, requires developer account and virtual key
- **FranklinWH**: Uses `franklinwh` Python package, auth via username/password/gateway_id

## Testing
- Run `npm run check` before landing any change (build + lint + typecheck + unit tests)
- CI (`.github/workflows/ci.yml`) runs the same gate on Node 24 and 26, plus
  `python -m py_compile python/franklin_proxy.py`
- Tests hitting the real FranklinWH / Tesla APIs are gated behind `RUN_LIVE_TESTS=1`
- Run `node dist/index.js --help` to verify CLI
- Run `FRANKLIN_PROXY_TOKEN=dev python3 python/franklin_proxy.py` to test proxy startup (the proxy refuses to boot without a token)
- Run `npm run test` to run tests with vitest
- Run `npm run lint` to run linter

## git workflow
Each user prompt to the agent should be written to a new local branch.
Create local commits as needed to separate logical chunks of work to enable human review.
Do not push the branch to remote; keep it local and let user check and land changes to main.

## Adding New Systems
1. Implement `BatteryService` or `EVService` interface
2. Add service to CLI commands in `src/index.ts`

## Handling state within the application
Prefer stateless architectures / implementations whenever possible.
When business logic seems to require storing state, verify the approach with the human developer
with clear reasoning and a detailed description of the proposed approach.

## Comments
Keep inline comments succinct.
Do not clutter inline comments with information about previous implementations;
this historical information can be left in the workplan if valuable.

## Development
- Write a timestamp (date + local time) at the top of every final response summary, whether Plan or Act mode.
- Update workplan.md after every Act response to ensure other agents can pick up where you left off.
- For the completed Phase 0–5 record, see workplan-history.md (historical — reference only).
- Do not edit TODO.md, the human user maintains this file.