**2026-11-13 12:56 PST**

# Hosting options: mobile access to the EV Charge Coordinator web app off-LAN

## Context I'm working from (verified in the repo + live sources)

- **The daemon already serves both things you need.** The express read API (`127.0.0.1:3002`, bearer-auth, [docs/api.md](/Users/ericsoco/Documents/lab/code/ev-charge-coordinator/docs/api.md)) also serves `web/dist` — so API + webapp are **one origin already**. "Hosting both" really means: *expose that one origin to the internet (or to your devices)*.
- **The brain must stay put for now.** The daemon is wired into the Mac: launchd KeepAlive + caffeinate, `@napi-rs/keyring` keychain, the `tesla-http-proxy` sidecar (TLS :4443), the Flask Franklin proxy, and SQLite on local disk. Moving it is possible but is essentially Phase 3 ("multi-user, cloud-hosted" per [design.md](/Users/ericsoco/Documents/lab/code/ev-charge-coordinator/docs/design.md) §1).
- **A hosting decision was already made in P2**: *Cloudflare Tunnel* (workplan "Decided" block, 2026-11-10; [docs/api.md](/Users/ericsoco/Documents/lab/code/ev-charge-coordinator/docs/api.md) even says "production is same-origin behind the Cloudflare Tunnel"). So this analysis is effectively a re-litigation of that decision in light of DreamHost — fair, since the tunnel was never actually stood up.
- **Your DreamHost Shared Unlimited plan cannot run this workload.** DreamHost's own docs are unambiguous: *"DreamHost does not allow persistent processes to run on any Shared Hosting plan"* and they reserve the right to kill them without warning ([Persistent processes](https://help.dreamhost.com/hc/en-us/articles/214869648-Persistent-processes)). Node.js is installable **only on VPS/Dedicated** ([Node.js overview](https://help.dreamhost.com/hc/en-us/articles/217185397-Node-js-overview)). No long-lived Node daemon, no reverse proxy, no ntfy server on shared — static files only.

---

## Option A — Cloudflare Tunnel to the Mac *(plan of record; zero new hosting)*

**Stack:** `cloudflared` on the Mac (launchd, like the daemon) → named tunnel → `app.transmote.com` (CNAME → cfargotunnel) → origin is the daemon's express server on loopback. DNS for `transmote.com` moves to Cloudflare's free plan (registrar can stay DreamHost). Web Push/VAPID, PWA service worker, and bearer auth all work unchanged — same origin, HTTPS everywhere.

| | |
|---|---|
| **Cost** | **$0** (tunnel + DNS free; you keep paying shared hosting for whatever else it does) |
| **Complexity** | Low. ~1 hour: install cloudflared, login, create tunnel, one route, launchd plist, DNS records |
| **Human maintenance** | Near zero after setup; occasional `cloudflared` update |
| **Agent maintenance** | Easy — all config is files in the repo/home dir; agents can write the launchd plist + tunnel config and verify with `curl` |
| **Manual effort** | One-time setup; nothing per-deploy (daemon already serves `web/dist`) |

**Pros**
- Phone reaches home from anywhere with no new server, no code changes, no second origin (avoids CORS work — production currently assumes same-origin).
- Free HTTPS = secure context → service worker + Web Push + installable PWA all work.
- ntfy can ride the **same tunnel** as a second hostname (`ntfy.transmote.com`), collapsing the pending "VPS vs tunnel" ntfy decision into "tunnel" at $0.
- Cloudflare **Access** (free up to 50 users) can sit in front later as a real multi-user login layer — zero app changes.

**Cons / caveats / pitfalls**
- **Availability = your MacBook.** Lid closed on battery → Mac sleeps → tunnel down → phone sees an error. (Daemon already uses `caffeinate -is`, which covers idle sleep but not clamshell sleep.) The daemon's auto-start decisions have the same dependency today, so nothing new — but the web app will be as available as the laptop.
- **DNS must move to Cloudflare** for a named tunnel. If `transmote.com` email (MX/TXT) lives at DreamHost, those records must be re-created on Cloudflare or **email breaks** — the classic pitfall of this move. (A throwaway `trycloudflare.com` quick tunnel avoids this for a spike, but the URL is random each run.)
- Cloudflare free-plan ToS §2.8 (non-HTML content) is a gray area; JSON APIs behind free proxy are common and low-risk, but it's nonzero-risk. Their 100 s proxy timeout is a non-issue for polling-based apps.
- Public hostname + bearer token = internet-facing attack surface. Acceptable (every route 401s without the token), but you should consider Access or at least a long random token; keep the token out of logs/URLs (already the design).
- Multi-user = "hand the same token to more devices" — no per-user identity/audit until Access or Phase 3.

## Option B — DreamHost Shared Unlimited as the host *(static web only)*

**Stack:** rsync/git-deploy `web/dist` to shared hosting at `app.transmote.com`; API still on the Mac → **still needs a tunnel anyway** (Option A) for the data.

| | |
|---|---|
| **Cost** | $0 incremental (already paying) |
| **Complexity** | Medium — *higher than A*, because you now have two origins |
| **Maintenance** | A deploy step every time `web/dist` changes; agents can script it, but it's a second pipeline to keep green |

**Pros:** page shell/assets could load from a CDN-ish host even when the Mac sleeps (cosmetic only — the app is API-bound after load, so a dead API means a dead app regardless); free SSL via Let's Encrypt.

**Cons / pitfalls:** the API *must* be reachable anyway, so this adds a deploy pipeline and **cross-origin work** (the API's CORS is deliberately dev-only; enabling cross-origin production means code changes and a token story that works cross-origin) for zero functional gain. You cannot reverse-proxy to the Mac from shared (no persistent processes). **Verdict: not worth doing on its own** — shared is only useful as "the static half" if you've already decided you want a split, and you shouldn't.

## Option C — Upgrade to a DreamHost VPS *(the consolidation play)*

Two sub-variants:

**C1 — VPS as infrastructure only (app stays on Mac):** VPS runs ntfy (+ optionally Caddy) via Docker Compose — this is *exactly* the already-written ntfy plan in workplan.md; the app reaches the world via Option A's tunnel. DreamHost VPS "Stack 4" = **$15.99/mo** (2 vCPU / 4 GB / 75 GB NVMe, root, Docker, unmetered bandwidth — [dreamhost.com/hosting/vps](https://www.dreamhost.com/hosting/vps/), pricing checked by [itechguides Sep 2026](https://www.itechguides.com/products/dreamhost-vps/pricing/)). ntfy is always-on and independent of the Mac — better push reliability than tunneling ntfy to a laptop.

**C2 — Full migration (daemon + web + ntfy on the VPS):** the Phase-3-shaped endgame.

| | C1 | C2 |
|---|---|---|
| **Cost** | ~$16/mo (+$0 app) | ~$16/mo |
| **Complexity** | Low-medium (Docker compose for ntfy; app unchanged) | **High** — multi-day, multi-PR project |
| **Human maintenance** | OS patching, `docker compose pull`, backups of `user.db` | + daemon supervision (launchd → systemd), SQLite backups, cert renewal (Caddy auto) |
| **Agent maintenance** | Good — compose files are declarative | Good in theory, but live-verification is harder: agents can't touch the car/keychain without you |
| **Manual effort** | One provisioning session | Secrets migration (keychain → `ECC_DISABLE_KEYCHAIN` encrypted files — the headless path already exists), Franklin venv on Linux, Tesla virtual-key re-registration (see domain pitfall below), `set-home-location` re-entry?, cutover + rollback plan |

**Pros:** C1 gives always-on ntfy under your existing billing (your TODO already flags this upgrade path). C2 gives an always-on brain — **auto-start decisions no longer depend on laptop sleep** — one origin, one box for app+ntfy, the natural home for Phase 3 multi-user (accounts, Postgres, per-home collectors per design.md §7 seams).

**Cons / pitfalls:** you pay for a server you might not need yet; DreamHost VPS is self-managed (support covers hardware/network, not your stack); C2 is a big-bang-ish migration of *working, live-verified* infrastructure — risky to rush. Also: **DreamHost's Node.js article says Node runs on "Managed VPS and Dedicated"** — the new self-managed Stack plans do run Node/Docker per the VPS page, but confirm the panel's Node/Proxy Server support for the exact plan before buying.

## Option D — Tailscale (private mesh, no public exposure at all)

**Stack:** Tailscale on Mac + phone; browse to `https://mac.tailnet-name.ts.net` (TLS certs via MagicDNS/Let's Encrypt). No public hostname, no DNS move.

| | |
|---|---|
| **Cost** | **$0** — Personal plan now covers **up to 6 users**, unlimited devices ([tailscale.com/pricing](https://tailscale.com/pricing)) |
| **Complexity** | Very low; ~20 min |
| **Human/agent maintenance** | Near zero; app updates |
| **Manual effort** | Install app + log in on **every** device that ever needs access |

**Pros:** strongest security posture (nothing on the public internet; bearer token becomes defense-in-depth rather than the only wall); per-device identity via tailnet login is a decent multi-user story for a trusted circle; no Cloudflare ToS/DNS-move questions.

**Cons / pitfalls:** every device — including any future guest/family phone — must run the Tailscale app and be logged into your tailnet (friction you don't have with a URL); iOS requires the VPN profile (on-demand scheduling is battery-cheap but it *is* a VPN); if the Mac sleeps, same availability issue as Option A; no CDN/edge benefits; sharing with non-technical users is clunkier than a link. (Tailscale Funnel could publish it publicly, which just reinvents Option A with more moving parts — not recommended.)

## Option E — Different cheap VPS (Hetzner/DO/etc.) + Docker Compose

Same as C1/C2 but a new account elsewhere: ~$4–6/mo, more modern/cheaper hardware, matches the cost estimate already in workplan.md ("~$4–6/mo VPS"). **Pros:** cheapest always-on; best fit for the ntfy compose plan as written. **Cons:** new vendor relationship/billing; abandons your existing DreamHost consolidation; Hetzner signup can be a hassle for US customers. Worth listing only because it's the cost floor for "always-on."

---

## Cross-cutting pitfalls that apply to *any* choice

1. **Tesla virtual key ↔ domain.** `pair-tesla-key` uploads the public key to `https://tesla.com/_ak/<domain>`; README documents that changing the hosting domain means re-uploading + **re-approving on every vehicle** (and the `Public key hash has already been taken` trap). **Pick the final public domain now** (`app.transmote.com` vs apex vs whatever) and keep it stable across future migrations — e.g., if the eventual Phase-3 domain will be `evcc.transmote.com`, start there.
2. **iOS PWA push** has documented constraints (must be added to home screen; no push for plain Safari tabs) — the workplan already flags "verify before promising parity." Same for ntfy iOS instant-push on self-hosted servers (workplan caveat). ntfy's Android app falls back to polling without Firebase — delivery delays on self-hosted servers.
3. **Mac-sleep reality:** Options A/B/D all inherit "the laptop must be on and awake." The daemon's own spotty-uptime analysis (P1c step 4) already accepted this for *decisions*; for *viewing*, it means occasional "tunnel down" errors.
4. **Multi-user:** none of the options give per-user identity today (shared bearer token). The realistic paths are Cloudflare Access (free ≤50 users, no app change) in front of Option A, or full Phase-3 accounts on Option C2/E.

## Recommendation

| Horizon | Choice |
|---|---|
| **Now (mobile access, ~0 effort/cost)** | **Option A — Cloudflare Tunnel** (already the decided plan of record). Move DNS to Cloudflare, copy MX/TXT if email is on DreamHost, run `cloudflared` under launchd, one hostname → daemon. Serve ntfy off the same tunnel initially if you want it at $0. |
| **ntfy (queued decision)** | If you want always-on push independent of the laptop → **C1 or E** (VPS + the compose plan already written). If $0 matters more → same tunnel. |
| **DreamHost shared** | Keep for whatever it hosts today; **it cannot host this** (persistent processes forbidden). Don't split the static app onto it. |
| **When multi-user / always-on decisions become real (Phase 3)** | **C2** — DreamHost VPS Stack 4 if you value one bill, else Option E. The migration is a planned project (secrets, Tesla key domain, systemd), not a config tweak. |

If you confirm a direction, switch to Act mode and I'll (a) record the decision in workplan.md's pending-decisions block, and (b) for Option A, write the concrete setup plan (cloudflared launchd plist, tunnel config, DNS record list including the MX/TXT copy warning, and a verification matrix — public 200, anonymous API 401, push delivery) as a new workplan section, per the existing ntfy-plan pattern. No files were changed in this response (plan mode).