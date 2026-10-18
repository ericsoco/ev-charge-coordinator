# EV Charge Coordinator — Workplan (living)

> **Current context and forward decisions.** Created 2026-10-18 after Phases 0–5 landed on
> `main` (`6891126`). The full Phase 0–5 execution record was archived to
> [workplan-history.md](./workplan-history.md) — **historical, backup context only**; read
> this file first and consult history only when deeper context is needed. Product
> requirements live in [requirements.md](./requirements.md); the user's backlog lives in
> [TODO.md](./TODO.md) (keep it there — do not mirror backlog items into this file).

## Current state (verified 2026-10-18)

- **Phases 0–5 complete and landed on `main`;** GitHub Actions CI green on Node 24 + 26.
  Gate for every change: `npm run check` (build + lint + typecheck + unit tests; 340 passed /
  2 skipped at last run).
- **Shipped surface:** `start` / `exit` lifecycle, `get-battery-soc`, `get-ev-bsoc`,
  `set-ev-charge-limit`, `start-ev-charging`, `stop-ev-charging`, `charge-from-battery`,
  `get-charging-state`, `config --set-buffer`, `--daemon`, interactive REPL with masked
  credential prompts. Start-charging consent is explicit flags only (`--start` / `--dry-run`
  / `--stop`); `charge-from-battery` prints its consent prompt for approval.
- **Architecture:** FranklinWH via per-session/one-shot token-guarded Flask proxy
  (`python/franklin_proxy.py`); Tesla signed commands via managed `tesla-http-proxy` sidecar
  (TLS :4443, per-spawn token in `~/.ev-charge-coordinator/runtime.json`); OAuth tokens in
  keychain with AES-256-GCM encrypted-file fallback.
- **Live-verified:** both SoC reads; signed limit/start/stop against a real Model Y;
  `charge-from-battery` consent flow and kWh-derived limit (math in `src/utils/energy.ts`);
  asleep-car `get-charging-state` returns a useful 408 wake-gap message; unplugged
  `start-ev-charging` fails loudly.

## Decisions on future work

- **Deferred by explicit decision (2026-10-17):** `CONTRIBUTING.md`, issue/PR templates,
  `CHANGELOG.md` — revisit before any outreach to external contributors.
- **Out of scope by decision (Phase 6 list):** Web GUI, multi-EV / multi-gateway fan-out,
  scheduled charging windows + solar-aware rate timing, Fleet Telemetry WebSocket instead of
  polling, `npx` publishing. (The keytar replacement formerly listed here was done 2026-10-18:
  `@napi-rs/keyring`, see Log.)
- **Battery-buffer product evolution** (`requirements.md` Oct 10 / Oct 14 entries:
  trigger on charger-plug-in event, sub-50% target handling with polling stop) is open
  product work — record design decisions here when it is picked up.

## Log

<!-- Append dated entries below after each Act response, per AGENTS.md. -->

### 2026-10-18 — keytar replaced with `@napi-rs/keyring`

Branch `deps/keytar-to-napi-keyring-v2` (resolves TODO.md item 26; re-run of
`deps/keytar-to-napi-keyring`, which predates the workplan archive and is superseded
by this branch):

- `credentials.ts`: `getKeytar()` → `getKeyChain()`, a small adapter over
  `@napi-rs/keyring`'s `Entry` (`get`/`set`/`delete`), leaving `save()`/`load()`/
  `clearAll()` and all stored formats untouched. Linux pinned to
  `{ linux: { store: 'secret-service' } }` so an unavailable Secret Service throws
  → file fallback, instead of the binding's silent fallback to the kernel keyring,
  which does not persist across reboots. `ECC_DISABLE_KEYCHAIN` semantics unchanged
  (tests still force the file path).
- CI: dropped the `libsecret-1-dev` install step — it existed only because keytar
  compiled from source on Node 24/26 ABIs; the prebuilt platform binaries need no
  headers, and tests never touch the keychain.
- Docs: README Security section + structure tree, AGENTS.md utils line, TODO.md item
  26 ticked, Phase 6 out-of-scope bullet above refreshed.
- Gate: `npm run check` green — **340 passed / 2 skipped** (baseline unchanged).
  Live macOS smoke test against the real keychain: seeded entry → store resolved
  `storageBackend === 'keychain'`, wrote without creating `credentials.enc`,
  round-tripped through a fresh store, `clearAll()` deleted the entry, and the
  real pre-existing keychain value was backed up and restored afterwards.
- Migration: same `ev-charge-coordinator`/`credentials` service+account as keytar
  used on macOS, so existing login-keychain entries read transparently; on other
  platforms a miss falls through to the encrypted file (or a one-time re-auth if
  neither store has data).
