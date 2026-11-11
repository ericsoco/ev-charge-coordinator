FEATURES
[X] Trigger charging math + session on vehicle plugged in (at home) event. Does Tesla provide a way to push this event?
    [X] Need to (re?) design application as a long-running process
    [-] Maybe better to start with a GUI to manually trigger when plugged in?
    [-] Switch to Fleet Telemetry to receive pushes?
[ ] Auto-start charging refinements
    [ ] Add analytics to ensure the poll-while-awake algo does not regress and cause
        unintended vehicle wake (watch for lack of poll requests returning 'asleep')
    [X] enable long-running process during sleep via /usr/bin/caffeinate (in plist, with `-is` flags)
[ ] Base charge amount on:
    [ ] Solar battery historical usage (average / seasonal / day of week) -- build local record over time and/or try to find an API?
    [ ] weather forecast (solar irradiation)
        [ ] start with simple threshold: if irradiance is < threshold, raise home battery buffer a fixed amount
        [ ] refine logic to map various amounts of (forecast) irradiance to various buffer adjustments (may not be linear)
    [ ] projected amount of battery storage accrued during EV charging session (based on both of the above)
    [ ] TOU pricing (should be irrelevant if only pulling from battery, but give it some thought)
    [ ] Related -- Franklin poller needs to observe not just battery level but also
        how much energy the house consumes, in order to dynamically set battery buffer
[ ] Create dashboard to display time series of the various stores
    [X] Research charting libs (done -- see docs/charts-research.md)
        Use eCharts: licensing, bundle size (tree-shaking), some advanced func.
    [X] review stores and decide on included data sources + functionality
    [ ] design layout
        [ ] Now page big number charts: start with this:
            https://codefronts.com/motion/css-number-counter-animations/svg-stroke-dash-progress-ring-counter/
            but slow down counter tick animation, since numbers will change infrequently
    [ ] automate execution:
        [ ] switch cline (> settings) to smarter model for Plan mode (Act can stay medium)
        [ ] create new branch to use as base ref for cline kanban worktrees
        [ ] write prompt for agent team
        [ ] feed to cline prompt to break into smaller tasks and add to kanban board -- set all tasks to auto-commit
        [ ] hit play on kanban board
[ ] 

SCALING
[ ] Host application online somewhere
    Ideally this is part of the install + build process, and can leverage publicly available tooling for hosting (GH pages?)
    Need to think about what other functionality we'll need in the future,
    e.g. limited data storage for historical battery usage, past charging sessions, etc
    [ ] Host ntfy on ntfy.transmote.com -- plan written to workplan.md (2026-11-01)
    [ ] If I host on dreamhost / transmote.com, will need to upgrade to VPS
        https://panel.dreamhost.com/index.cgi?tree=server.dashboard#/marketing/selfmanaged-vps
        (DH admin panel > Serves & Usage > Add Service)
[ ] Evaluate other similar apps:
    - evcc.io
    - HACS: https://github.com/antbald/ha-ev-smart-charger
    - Home Assistant integrations (for both, for my app)

TASKS / BUGS
[X] Recreate ev-charge-coordinator application on Tesla dev portal to expire the client secret that was leaked into LLM logs. Will require rerunning `pair-tesla-key` and `authenticate`.
[X] Rename `npm start config --clear-all` to `--clear-credentials`
[X] Tab completion for flags
[X] Replace `keytar` (deprecated) with...? Need to clarify specific needed functionality.
[X] Replace messy Franklin error logs/tracebacks in daemon log
[X] Daemon logging
    [X] should show charging progress on every poll during a session
    [X] should start every log with a timestamp first, formatted the same for all logs[ ] Rename ambiguous battery-related commands like `get-battery-soc`, `charge-from-battery`, and `set-battery-buffer`
[X] Every `npm start daemon restart` throws an error the first run, succeeds the second.
    Error: bootstrap of /Users/ericsoco/Library/LaunchAgents/com.transmote.ev-charge-coordinator.daemon.plist failed: Bootstrap failed: 5: Input/output error Try re-running the command as root for richer errors.

[ ] Refine ntfy messaging
    [ ] More human-readable and helpful
    [ ] Remove noisy logs
[ ] Expose common commands in package.json to run via `npm run x`
[ ] Add convenience npm script to open config / daemon-config json files in an editor
[ ] Consider removing `get-ev-bsoc` in favor of `get-charging-state`
[ ] Clean up README (remove slop; make dev setup steps clear and contiguous; same for end-user steps; ensure unified docs across CLI + REPL, as there is some divergence)
    [ ] So far, have cleaned up up to "## CLI Reference". Continue from there.
         [ ] ...but skipped over Tesla and Franklin setup in ## Configuration
[ ] Codebase audit (legibility, organization)
    [ ] Move daemonConfig.ts from utils into src/daemon
    [ ] Move various .md files into /docs: utils/REPLThemes.md, design.md, requirements.md, README.md
        [ ] possible to move root-level agentic files? workplan/-history, AGENTS...
    [ ] Organize /services into one folder per service, with only index + ProcessManager in root folder
        [ ] Franklin gets its own folder
        [ ] TeslaService + TeslaCommandProxy move into /tesla
    [X] Clean up index.ts?
        Very bloated now, can individual commands be moved out?
        How are REPL + one-shot / Commander kept in sync?

MANUAL TESTS post-Phase 1c
**2026-11-06 22:41 PST**

# What's next

Yes — **P1c step 5 ("Live validation + docs") is the remaining P1c step**, with two caveats before you plan your week around it:

1. **One deferred code item rode along into step 5:** step 2's Log explicitly says *"meter-reset-edge detection deferred to step 5."* So step 5 is validation + docs + a small decision: implement meter-reset-edge detection or consciously re-defer it (the clean-session filters already exclude the poisonous rows — eff > 1, house < 0.5 kWh — so this is a "detect and *tell* the user" feature, not a correctness gap).
2. **README coverage is mostly already done** — steps 1–4 each landed their README subsections (session monitor §512, weather reserve §497, re-targeting §544, efficiency fallback §82). Step 5's docs work is therefore a *gap-check-and-reconcile pass* driven by what validation reveals, not a from-scratch section.

Everything else queued is **after** P1c, not part of it: the Franklin backfill follow-up (proxy methods + baseline ingestion — "to be planned as its own step"), self-hosted ntfy (blocked on your VPS-vs-Cloudflare decision), the EV#2/`vehicle` rename refactor (deferred by decision), and your TODO.md items.

---

# How to validate — detailed runbook

**Your live config (read just now):** `bufferPercent: 30`, `chargeEfficiency: 0.9`, `weatherBufferAdjPercent: 0` (off), auto-start **enabled** with 25 m geofence, notifiers log + ntfy, sample cadences 120 s battery / 60 s EV-while-plugged.

## ✅ Phase A — Pre-flight (10 minutes, no charging needed)

1. ✅ **Fresh main + gate:** `git checkout main && git pull && npm run check` → expect 1005/3 green; `npm run build` (dist is what launchd runs).
2. ✅ **Daemon restart + health:** `evcc daemon restart` → `evcc status` (daemon alive, battery/EV sample ages fresh, store attached). Watch `evcc daemon logs` for sampler errors.
3. ✅ **Notifications:** `evcc notify test` → push must arrive on the phone. Every validation below produces an ntfy event; if test fails, fix before trusting "no notification arrived" as evidence of anything.
4. ✅ **Baseline store snapshot** (so you can diff after): `npm run store` and note session/decision counts; optionally `sqlite3 ~/.ev-charge-coordinator/data.sqlite 'SELECT id, reason_detail FROM decisions ORDER BY id DESC LIMIT 3;'`.

## ⭕️ Phase B — Feature validations

### ✅ B1. Observed efficiency (safe, zero-risk, do first)
- `evcc charge-from-battery --dry-run` → the output must print **`Charge efficiency: 0.xxx (measured, N sessions)`** once N ≥ 5 clean sessions (you almost certainly cleared the gate months ago). Sanity-check the value is plausible (roughly 0.85–0.95, not 0.9 exactly — you're checking *measured*, not config).
- Confirm it flows into real decisions: trigger a plug-in decision (arrive home, plug in), then read the newest `decisions.reason_detail` — it must contain the same `efficiency 0.xxx (measured, N sessions)` clause, and the `decision-made` ntfy should carry it too.
- **Pass =** clause present with N ≥ 5 and value ≠ hard-coded 0.9; target math uses it (visible in the computed target on the decision).

### ✅ B2. Session monitor — target stop (`target_reached`)
The sub-50% case is *the normal case* here: your 13.5 kWh battery over a 30% buffer yields ~9.5 kWh max → targets around **SoC + ~11 EV points**, always below Tesla's 50% clamp. So any charge-from-battery / auto-start session exercises it.

- Start a session (`evcc charge-from-battery --start`, or let auto-start fire on plug-in). Note the planned target in `evcc sessions` (`target N% (from M%)` display) and on the decision row.
- Let it charge to N. **Expected within ~1 EV poll (≤ 60 s):** signed `stop-ev-charging` issued, session closes with **`stop_reason = 'target_reached'`**, `charging-stopped` notification with the reason, log line.
- Verify the clamp split: Tesla limit shown ≥ 50 (or whatever was set), yet the stop happened at N < 50 — that's the polling stop working, the whole point of requirements Oct 10 phase 2.
- **Pass =** stop at N (±1 poll), reason recorded, notification arrived.

### ⭕️ B3. Session monitor — buffer stop (`battery_buffer`)
Waiting for a natural evening drain to exactly 30% is slow; use the **controlled trick** (stop-direction is the conservative/safe direction):

1. During an active charging session, raise the buffer to just above current battery SoC: `evcc config --set-buffer <SoC−1>` (e.g. battery at 62 → set 61).
2. **Expected:** within a couple of ticks the monitor stops charging, `stop_reason = 'battery_buffer'`, notification with that reason.
3. Then restore `--set-buffer 30`.
- **Pass =** reason recorded correctly and the stop is attributed to battery, not target (check the session row + notification wording).

### ⭕️ B4. Resume after a monitor stop (step 4)
The B3 test sets up resume for free — monitor-stopped session, then you lower the buffer so battery is now > `buffer + 2%` (your known-constants: resume margin **2 points**, deadband **1 EV point**, `RETARGET_MIN_DELTA_PERCENT = 1`):

- **Expected within a few ticks:** charging restarts (no new limit command needed if unchanged), `charging-started` notification, session continues (same session row — it resumes, not re-creates).
- **Known limitation — do NOT file as a bug:** a session the *car itself* ended (`Complete`, `stop_reason` null) is deliberately never resumed; next plug-in re-decides.

### ⭕️ B5. Solar-surplus re-target (the hardest to catch naturally — monitor a live session)
Needs battery SoC *moving* during EV charging. Realistic windows: daytime charging under sun (battery rising → **raise**), or evening discharge (battery falling → **lower**).

While charging, watch `evcc sessions` and ntfy:
- ✅ **Raise:** new Tesla limit issued → session `target_percent` updated → **📈** `session-retargeted` notification whose text matches `target_change_reason` exactly, phrased **"initial → new current"** (e.g. *"increasing the session target from an initial value of 45% to 55%"*). `initial_target_percent` stays at 45.
- ⭕️ **Lower:** target row updated **only** (no Tesla command) and the monitor enforces it next tick — if EV SoC is already ≥ the new target, the session stops with `target_reached` in the same/next tick (that ordering — re-target evaluation *before* the stop check — is the seam step 4 built).
- ✅ **Hysteresis:** over a 20+ min stretch, no more than ~1 change (deadband 1 EV point vs the **raw** target). Repeated identical evaluations must not re-notify.
- ⭕️ **Stale-data guard:** put the Mac to sleep mid-session ≥ a few sample periods, wake it — the first evaluation must **not** fire a spurious re-target from old samples, and hysteresis is measured from the last actual change (sleep satisfies it). This is the "spotty uptime" analysis from step 4; catch it if your session spans a lid-close.
- ⭕️ **Overlays:** the raise/lower math should reflect observed efficiency + effective buffer (weather, if enabled) rather than raw config — visible via the battery % in the 📈/📉 text and the decision reason.

### ⭕️ B6. Weather reserve (step 3) — two states
⭕️ **Off-path (current config):** with `weatherBufferAdjPercent: 0`, confirm `reason_detail` has **no** weather clause (your live decisions today should show none — that's half the test).

⭕️ **On-path (controlled):**
1. Hand-edit `daemon-config.json`: `"weatherBufferAdjPercent": 10`. To *guarantee* the "low solar" condition regardless of actual forecast, also temporarily set `"weatherSolarThresholdWhM2": 100000` (validated max — any next-24h integral counts as low).
2. `evcc daemon restart` (knobs are read at daemon start).
3. Trigger a decision (plug in). **Expected:** `reason_detail` ends with **` — weather +10%: <detail>`**; effective buffer = 30 + 10 = 40 drives the `below_buffer` interlock wording *(base + weather)* and **shrinks** the computed target (more reserve kept). `evcc charge-from-battery --dry-run` should print **`Reserve: buffer 30% — weather +10%: …`**.
4. Set the threshold back to 2000, decide your real-world `weatherBufferAdjPercent` (0 = stay off, or a modest 5), restart again.
- Stale (>36 h)/missing/thin forecasts → ignored: covered by unit tests; you only need the on-path live.

⭕️ ### B7. Robustness spot-checks
- ⭕️ **Restart mid-session:** `evcc daemon restart` while charging — session target persists (store), monitor re-arms, no double-stop, no lost reason.
- ⭕️ **Dry-run authority:** optionally run a `--dry-run` daemon across a charging window — the monitor must **not** stop anything (monitor authority is live-only: `autoStart.enabled && !dryRun`).
- After any anomaly, `evcc daemon logs` + `sqlite3 … data.sqlite` are the evidence trail.

## Phase C — Docs closeout (the actual step-5 deliverables)

1. **README gap-check:** walk the intelligence sections against your validation notes — stop-reason semantics, resume rules + the not-resumed limitation, weather knob + restart requirement, efficiency clause wording. Fix what diverged from reality.
2. **Meter-reset-edge decision:** implement the deferred detection (flag/mark affected sessions at close) or record an explicit re-deferral with reasoning in the Log.
3. **Workplan Log entry** for step 5: validation matrix (B1–B7 pass/fail + dates), any fixes made, README deltas; flip the P1c status header to *steps 1–5 complete*; refresh the stale "Current state (verified 2026-11-03)" date. Gate `npm run check` on the branch, land per your branch discipline.

## Suggested sequencing

| When | What |
|---|---|
| Tonight | Phase A + B1 + B6-off (read-only) |
| Next plug-in | B1 decision clause + B2 target stop + B6-on if enabled |
| Same/next session | B3 buffer raise → B5 resume via buffer restore (one controlled window) |
| Next sunny charging window | B5 re-target raise/lower + sleep/wake guard |
| After | Phase C closeout |

**Biggest practical risk:** B5 needs a charging session with moving battery SoC — if the car won't charge long enough naturally, do what step 4 planning did: engineer one evening (plug in at low SoC, let battery swing) and watch the logs.

Want me to draft the exact `sqlite3` verification queries per test (expected rows before/after), or turn this into a checklist in the workplan when you switch to Act mode?