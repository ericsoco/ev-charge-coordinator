#!/usr/bin/env python3
"""
Spike: FranklinWH cloud history endpoints — auth + response shapes.

Design.md §5 spike 1 (P1c). The charts in the app are backed by undocumented
cloud history endpoints (mapped by david2069/franklinwh-cloud); backfilling
day-of-week/seasonal baselines (§3.6.3) means adding 1–2 of them to
franklin_proxy.py. This script verifies auth and captures response shapes
against the real account BEFORE any proxy change.

Read-only: GET requests only, ~10 total. Never prints the password or the
login token.

Usage:
  node scripts/spike-franklin-history.mjs            # credentials from the store
  .venv/bin/python scripts/spike-franklin-history.py # FRANKLIN_* env or --email/--gateway-id
  .venv/bin/python scripts/spike-franklin-history.py --email you@example.com
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
from datetime import date, timedelta
from urllib.parse import urlencode


def load_dependencies() -> bool:
    """Import the proxy dependencies so a missing package is named, not a stack trace."""
    try:
        import httpx  # noqa: F401
        import franklinwh  # noqa: F401
    except ImportError as exc:
        print(f"✗ Missing dependency: {exc.name}")
        print("  Fix: python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt")
        return False
    return True


def clip(obj, limit: int = 200) -> str:
    """One-line JSON rendering, truncated for terminal readability."""
    try:
        text = json.dumps(obj, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(obj)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def summarize(value) -> str:
    if isinstance(value, list):
        head = f" first={clip(value[0], 80)}" if value else ""
        return f"list[{len(value)}]{head}"
    if isinstance(value, dict):
        return f"dict[{len(value)} keys]"
    return clip(value, 100)


def describe(result, indent: str = "    ") -> list[str]:
    """Key-by-key shape of a payload; lists show length + first element."""
    lines: list[str] = []
    if isinstance(result, dict):
        for index, (key, value) in enumerate(result.items()):
            if index >= 40:
                lines.append(f"{indent}… ({len(result) - 40} more keys)")
                break
            lines.append(f"{indent}{key}: {summarize(value)}")
            if isinstance(value, dict):
                for nested_key, nested in list(value.items())[:10]:
                    lines.append(f"{indent}  {nested_key}: {summarize(nested)}")
                if len(value) > 10:
                    lines.append(f"{indent}  … ({len(value) - 10} more keys)")
    elif isinstance(result, list):
        tail = f" last={clip(result[-1], 80)}" if result else ""
        lines.append(f"{indent}{summarize(result)}{tail}")
    else:
        lines.append(f"{indent}{clip(result)}")
    return lines


def monday_of(day: date) -> date:
    return day - timedelta(days=day.weekday())


def build_probes(today: date) -> list[dict]:
    """The history surface behind day-of-week/seasonal baselines, plus depth."""
    electric = "api-energy/electric/getFhpElectricData"
    return [
        {"name": "electric day (type=1, dayTime)", "path": electric,
         "params": {"type": "1", "dayTime": today.isoformat()}},
        {"name": "electric week (type=2, startDate=Monday)", "path": electric,
         "params": {"type": "2", "startDate": monday_of(today).isoformat()}},
        {"name": "electric month (type=3, startDate=1st)", "path": electric,
         "params": {"type": "3", "startDate": date(today.year, today.month, 1).isoformat()}},
        {"name": "electric year (type=4, startDate=Jan 1)", "path": electric,
         "params": {"type": "4", "startDate": date(today.year, 1, 1).isoformat()}},
        {"name": "electric lifetime (type=5)", "path": electric,
         "params": {"type": "5", "startDate": today.isoformat()}},
        {"name": "depth: month, same month last year (type=3)", "path": electric,
         "params": {"type": "3", "startDate": date(today.year - 1, today.month, 1).isoformat()}},
        {"name": "depth: month, two years ago (type=3)", "path": electric,
         "params": {"type": "3", "startDate": date(today.year - 2, today.month, 1).isoformat()}},
        {"name": "power by day (5-min samples, yesterday)",
         "path": "api-energy/power/getFhpPowerByDay",
         "params": {"dayTime": (today - timedelta(days=1)).isoformat()}},
        {"name": "charge history (page 1)", "path": "hes-gateway/terminal/iotChargePowers",
         "params": {"pageNum": "1", "pageSize": "5"}},
        {"name": "backup history (summary)", "path": "hes-gateway/terminal/backupHistorySummary",
         "params": {}},
    ]


async def run_probe(client, probe: dict) -> bool:
    name = probe["name"]
    url = client.url_base + probe["path"]
    shown = dict(probe["params"])
    shown.update({"gatewayId": client.gateway, "lang": "en_US"})
    print()
    print(f"── {name}")
    print(f"   GET {url}?{urlencode(shown)}")
    # _get is private by name; used deliberately so the spike rides the exact
    # transport production uses (loginToken header, gatewayId/lang injection,
    # 401 refresh).
    try:
        data = await client._get(url, params=probe["params"])
    except Exception as exc:  # noqa: BLE001 - the failure IS the spike finding
        print(f"   ✗ {type(exc).__name__}: {exc}")
        return False
    if not isinstance(data, dict):
        print(f"   ✗ unexpected body: {clip(data)}")
        return False

    code = data.get("code")
    message = data.get("message")
    print(f"   code={code!r} message={clip(message, 120)}")
    extras = {k: v for k, v in data.items() if k not in ("code", "message", "result")}
    if extras:
        print(f"   envelope: {clip(extras, 240)}")

    result = data.get("result")
    if result is None:
        print("   result: None")
        return code == 200
    print("   result:")
    for line in describe(result):
        print(line)
    if isinstance(result, dict):
        empties = [k for k, v in result.items() if isinstance(v, list) and not v]
        if empties:
            print("   empty arrays: " + ", ".join(empties))
    return code == 200


async def run_spike(email: str, password: str, gateway_id: str) -> int:
    import franklinwh

    print("FranklinWH cloud history spike (design.md §5 spike 1)")
    print("=" * 52)
    fetcher = franklinwh.TokenFetcher(email, password)
    client = franklinwh.Client(fetcher, gateway_id)
    try:
        await client.refresh_token()
    except Exception as exc:  # noqa: BLE001 - classify like check-franklin-auth
        print(f"✗ Login failed: {type(exc).__name__}: {exc}")
        return 1
    print(f"✓ loginToken acquired (account {email}); gateway={gateway_id}")

    probes = build_probes(date.today())
    passed = 0
    for probe in probes:
        passed += int(await run_probe(client, probe))
    print()
    print(f"{passed}/{len(probes)} probes answered code 200.")
    return 0 if passed == len(probes) else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Probe FranklinWH cloud history endpoints (read-only)."
    )
    parser.add_argument(
        "--email",
        default=os.environ.get("FRANKLIN_USERNAME") or os.environ.get("FRANKLIN_EMAIL"),
    )
    parser.add_argument("--gateway-id", default=os.environ.get("FRANKLIN_GATEWAY_ID"))
    args = parser.parse_args()

    if not load_dependencies():
        return 1
    if not args.email:
        print("✗ No email supplied. Pass --email or set FRANKLIN_USERNAME (or FRANKLIN_EMAIL).")
        return 1
    if not args.gateway_id:
        print("✗ No gateway id supplied. Pass --gateway-id or set FRANKLIN_GATEWAY_ID.")
        return 1

    password = os.environ.get("FRANKLIN_PASSWORD")
    if not password:
        # No echo: the password must not land in shell history or scrollback.
        if sys.stdin.isatty():
            password = getpass.getpass("Password (not echoed): ")
        else:
            print("✗ No password supplied and stdin is not a terminal. Set FRANKLIN_PASSWORD.")
            return 1
    if not password:
        print("✗ Empty password.")
        return 1

    return asyncio.run(run_spike(args.email, password, args.gateway_id))


if __name__ == "__main__":
    sys.exit(main())
