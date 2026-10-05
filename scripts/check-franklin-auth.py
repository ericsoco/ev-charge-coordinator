#!/usr/bin/env python3
"""
Diagnose the FranklinWH login path without the CLI in the way.

The two things that go wrong look identical from the terminal: wrong credentials
and FranklinWH's own service being down. The failure arrives as an opaque
`Internal error` from the local proxy, because every exception type in
franklin_proxy.py's decorator is flattened to HTTP 500.

This calls the real library and reports what actually happened:

  * an authentication-specific exception  -> your credentials (or gateway id)
  * a 5xx / gateway error                 -> FranklinWH's service is unavailable
  * success                                -> login works; the problem is elsewhere

Exits 0 when the login succeeds, 1 otherwise, so it can be used as a check.

Usage:
  .venv/bin/python scripts/check-franklin-auth.py --email you@example.com
  .venv/bin/python scripts/check-franklin-auth.py --email ... --gateway-id GW12345
  FRANKLIN_EMAIL=... FRANKLIN_PASSWORD=... .venv/bin/python scripts/check-franklin-auth.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys


def load_dependencies():
    """Import the proxy's dependencies so a missing package is named, not a stack trace."""
    try:
        import httpx  # noqa: F401
        import franklinwh  # noqa: F401
    except ImportError as exc:
        print(f"✗ Missing dependency: {exc.name}")
        print()
        print("  Fix: python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt")
        return None
    return True


async def attempt_login(email: str, password: str, gateway_id: str | None) -> int:
    """
    Exercise the real library and classify what came back.

    Verified against the installed franklinwh (2026.2.1): `login` is a static
    method on TokenFetcher, not on Client, and the exceptions live in
    franklinwh.client rather than a submodule.
    """
    import franklinwh

    try:
        if gateway_id:
            # Login, then talk to the gateway: this is the whole path the CLI takes.
            fetcher = franklinwh.TokenFetcher(email, password)
            client = franklinwh.Client(fetcher, gateway_id)
            await client.refresh_token()
        else:
            # Login only: isolates the step that failed from the gateway.
            await franklinwh.TokenFetcher(email, password).get_token()
    except Exception as exc:  # noqa: BLE001 - the exception type is the whole point
        return classify(exc)
    return 0


def classify(exc: Exception) -> int:
    """Turn an exception into advice. Returns the process exit code."""
    name = type(exc).__name__
    message = str(exc)

    # Credentials-specific: these are the library's own exceptions.
    if name == "InvalidCredentialsException":
        print("✗ Invalid credentials.")
        print("  Check the email and password. Gateway id is not involved at this step.")
        return 1

    if name == "AccountLockedException":
        print("✗ This account is locked. FranklinWH must unlock it.")
        return 1

    # Gateway-specific: only reachable when a gateway id was supplied.
    if name == "GatewayOfflineException":
        print("✗ The gateway is offline. Check the aPower unit and its network.")
        return 1

    if name == "DeviceTimeoutException":
        print("✗ The gateway did not respond in time.")
        return 1

    # Everything else is transport or upstream. The distinction the user cannot
    # otherwise make: these say nothing about whether the password was right.
    print("✗ Could not reach FranklinWH's authentication service.")
    print(f"  Exception: {name}")
    print(f"  Detail:    {message}")
    print()
    if _looks_like_upstream(message):
        print("  This looks like an outage on FranklinWH's side, not a credentials problem.")
        print("  Their gateway answers, but the user service behind it is returning errors.")
        print("  Retry later; nothing local will change it.")
    else:
        print("  Check network connectivity to energy.franklinwh.com.")
    return 1


def _looks_like_upstream(message: str) -> bool:
    markers = ("502", "503", "500", "bad gateway", "judgeAccountExist", "Internal Server Error")
    lowered = message.lower()
    return any(m.lower() in lowered for m in markers)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check whether FranklinWH authentication works, and why not if it does not."
    )
    parser.add_argument("--email", default=os.environ.get("FRANKLIN_EMAIL"))
    parser.add_argument("--gateway-id", default=os.environ.get("FRANKLIN_GATEWAY_ID"))
    args = parser.parse_args()

    print("FranklinWH authentication check")
    print("=" * 34)

    if load_dependencies() is None:
        return 1

    email = args.email
    if not email:
        print("\n✗ No email supplied.")
        print("  Pass --email, or set FRANKLIN_EMAIL.")
        return 1

    password = os.environ.get("FRANKLIN_PASSWORD")
    if not password:
        # Read without echo so the password does not land in shell history or the
        # scrollback. getpass falls back to a visible prompt when stdin is not a TTY.
        import getpass

        if sys.stdin.isatty():
            password = getpass.getpass("Password (not echoed): ")
        else:
            print("\n✗ No password supplied and stdin is not a terminal.")
            print("  Set FRANKLIN_PASSWORD in the environment instead.")
            return 1

    if not password:
        print("\n✗ Empty password.")
        return 1

    mode = "login + gateway" if args.gateway_id else "login only"
    print(f"  Account:  {email}")
    print(f"  Checking: {mode}")
    print()

    code = asyncio.run(attempt_login(email, password, args.gateway_id))
    if code == 0:
        print("✓ FranklinWH authentication works.")
        if not args.gateway_id:
            print("  (Login only. Pass --gateway-id to also exercise the gateway.)")
    return code


if __name__ == "__main__":
    sys.exit(main())