#!/usr/bin/env python3
"""
FranklinWH API Proxy Server

A Flask server that proxies requests to the FranklinWH API using the franklinwh Python library.
This allows the Node.js application to communicate with FranklinWH systems through HTTP.
"""

import asyncio
import hmac
import json
import os
import signal
import sys
import threading
import time
import traceback
from functools import wraps

from flask import Flask, jsonify, request
from flask_cors import CORS

try:
    from franklinwh.client import (
        Client,
        TokenFetcher,
        Mode,
        InvalidCredentialsException,
        AccountLockedException,
        DeviceTimeoutException,
        GatewayOfflineException,
    )
except ImportError:
    print("Error: franklinwh package not installed. Run: pip install franklinwh", file=sys.stderr)
    sys.exit(1)

# Shared secret (Phase 3): Node mints a random token per spawn and passes it
# here; every route except /health then demands it as X-Proxy-Token. Refusing
# to start without it means a manually launched proxy can never come up open --
# previously any process on the host could POST /mode and rewrite the battery's
# operating mode.
_PROXY_TOKEN = os.environ.get("FRANKLIN_PROXY_TOKEN")
if not _PROXY_TOKEN:
    print(
        "Error: FRANKLIN_PROXY_TOKEN is not set.\n"
        "  Start the proxy through the CLI (npm start), or pass one explicitly:\n"
        "    FRANKLIN_PROXY_TOKEN=$(openssl rand -hex 32) python3 python/franklin_proxy.py",
        file=sys.stderr,
    )
    sys.exit(1)

app = Flask(__name__)
CORS(app)

# Global client instance
_client: Client | None = None
_gateway_id: str | None = None


# One event loop for the proxy's lifetime.
#
# run_async used to create and close a fresh loop per request. franklinwh's
# Client holds an httpx.AsyncClient whose pooled connections and anyio state
# are bound to the loop that created them, so once a connection was warmed up
# on one loop, the next request under a *new* loop raised
# `RuntimeError: Event loop is closed` -- the proxy answered HTTP 500 even
# though nothing was wrong upstream (seen live: first get-battery-soc ok,
# second 500). Keeping one loop, never closed while the process lives, keeps
# that state valid. The lock serializes access because Flask's dev server
# handles requests on different threads and a loop must not run concurrently.
_loop: asyncio.AbstractEventLoop | None = None
_loop_lock = threading.Lock()


def run_async(coro):
    """Run an async coroutine in a synchronous context."""
    global _loop
    with _loop_lock:
        if _loop is None or _loop.is_closed():
            _loop = asyncio.new_event_loop()
        return _loop.run_until_complete(coro)


# Mapped exceptions: they already translate to honest HTTP statuses below, and
# they answer the same way every time -- retrying a wrong password or a locked
# account only delays the truth (and counts toward Franklin's lockout).
_DETERMINISTIC_ERRORS = (
    InvalidCredentialsException,
    AccountLockedException,
    DeviceTimeoutException,
    GatewayOfflineException,
)


def run_read(factory, attempts=3, delays=(0.5, 1.5)):
    """Run a read-only FranklinWH call, retrying transient upstream failures.

    Franklin's cloud answers HTTP 200 with `result: null` when the gateway has
    no data ready; franklinwh then raises TypeError('NoneType' object is not
    subscriptable) and the request surfaces as a 500. Seen live: consecutive
    /soc calls alternating 200/500 against the same proxy -- and reproduced
    with a bare franklinwh client, so it is upstream, not this proxy. Reads are
    idempotent, so a couple of short retries turn most of those into successes;
    anything deterministic (the four mapped exceptions) and any final failure
    are raised unchanged for handle_franklin_errors to report.
    """
    for index in range(attempts):
        if index:
            time.sleep(delays[index - 1])
        try:
            return run_async(factory())
        except _DETERMINISTIC_ERRORS:
            raise
        except Exception as error:
            if index == attempts - 1:
                raise
            print(
                f"franklinwh read failed (attempt {index + 1}/{attempts}): "
                f"{type(error).__name__}: {str(error) or 'no message'}; retrying",
                file=sys.stderr,
            )


def require_client(f):
    """Decorator to ensure client is initialized before handling request."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if _client is None:
            return jsonify({"error": "Not authenticated. Call /auth first."}), 401
        return f(*args, **kwargs)
    return decorated


def require_token(f):
    """Reject any request that does not carry this proxy's shared token.

    Checked before require_client, so an unauthenticated local process learns
    "missing token" rather than anything about the FranklinWH auth state.
    /health is deliberately excluded: the CLI's attach flow probes it before
    it knows which token the running proxy holds. Byte comparison on both
    sides because hmac.compare_digest rejects non-ASCII str.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        supplied = request.headers.get("X-Proxy-Token", "").encode("utf-8", "replace")
        expected = (_PROXY_TOKEN or "").encode("utf-8")
        if not hmac.compare_digest(supplied, expected):
            return jsonify({
                "error": "Unauthorized: missing or invalid X-Proxy-Token",
                "detail": "This proxy only accepts requests from the CLI that started it.",
            }), 401
        return f(*args, **kwargs)
    return decorated


def handle_franklin_errors(f):
    """Decorator to handle FranklinWH API errors."""
    @wraps(f)
    def decorated(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        except InvalidCredentialsException as e:
            return jsonify({"error": "Invalid credentials", "details": str(e)}), 401
        except AccountLockedException as e:
            return jsonify({"error": "Account locked", "details": str(e)}), 403
        except DeviceTimeoutException as e:
            return jsonify({"error": "Device timeout", "details": str(e)}), 504
        except GatewayOfflineException as e:
            return jsonify({"error": "Gateway offline", "details": str(e)}), 503
        except Exception as e:
            # This catch runs before Flask would log anything, so without this
            # the traceback -- which line of franklinwh actually failed -- never
            # reaches stderr and a 500 is undiagnosable after the fact. Node
            # forwards stderr live as [proxy] lines, so this is what makes the
            # failure visible from the CLI. `details` in the body only has str(e).
            traceback.print_exc(file=sys.stderr)
            # httpx timeouts carry no message; `details: ""` would reach the
            # CLI as a bare 'HTTP 500 - Internal error' with nothing saying
            # which class of call failed. Fall back to the exception type.
            details = str(e) or type(e).__name__
            return jsonify({"error": "Internal error", "details": details}), 500
    return decorated


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint.

    No token required (the attach flow needs it before knowing the token),
    and no gateway_id: the route answered on loopback, but the site id is
    still account data that no caller here uses -- Node reads only `status`.
    """
    return jsonify({
        "status": "ok",
        "authenticated": _client is not None,
    })


@app.route("/auth", methods=["POST"])
@require_token
@handle_franklin_errors
def authenticate():
    """
    Authenticate with FranklinWH API.
    
    Body:
        {
            "username": "email@example.com",
            "password": "your_password",
            "gateway_id": "your_gateway_id"
        }
    """
    global _client, _gateway_id
    
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400
    
    username = data.get("username")
    password = data.get("password")
    gateway_id = data.get("gateway_id")
    
    if not all([username, password, gateway_id]):
        return jsonify({"error": "username, password, and gateway_id are required"}), 400
    
    # Local, not a module global: the proxy keeps no copy of the password of
    # its own. One copy unavoidably survives inside franklinwh's Client
    # (self.fetcher), because Client.refresh_token() re-runs the full login on
    # every refresh -- fetch_token posts an MD5 of the password and the library
    # has no refresh-token path. See workplan Phase 3 item 3.
    token_fetcher = TokenFetcher(username, password)
    _client = Client(token_fetcher, gateway_id)
    _gateway_id = gateway_id
    
    # Test authentication by refreshing token
    run_async(_client.refresh_token())
    
    return jsonify({
        "success": True,
        "message": "Authentication successful",
        "gateway_id": gateway_id
    })


@app.route("/stats", methods=["GET"])
@require_token
@require_client
@handle_franklin_errors
def get_stats():
    """
    Get current statistics from the FranklinWH gateway.
    
    Returns current power values and daily totals.
    """
    stats = run_read(_client.get_stats)

    return jsonify({
        "current": {
            "solar_production": stats.current.solar_production,
            "generator_production": stats.current.generator_production,
            "generator_enabled": stats.current.generator_enabled,
            "battery_use": stats.current.battery_use,
            "grid_use": stats.current.grid_use,
            "home_load": stats.current.home_load,
            "battery_soc": stats.current.battery_soc,
            "switch_1_load": stats.current.switch_1_load,
            "switch_2_load": stats.current.switch_2_load,
            "v2l_use": stats.current.v2l_use,
            "grid_status": stats.current.grid_status.name
        },
        "totals": {
            "battery_charge": stats.totals.battery_charge,
            "battery_discharge": stats.totals.battery_discharge,
            "grid_import": stats.totals.grid_import,
            "grid_export": stats.totals.grid_export,
            "solar": stats.totals.solar,
            "generator": stats.totals.generator,
            "home_use": stats.totals.home_use,
            "switch_1_use": stats.totals.switch_1_use,
            "switch_2_use": stats.totals.switch_2_use,
            "v2l_export": stats.totals.v2l_export,
            "v2l_import": stats.totals.v2l_import
        }
    })


@app.route("/soc", methods=["GET"])
@require_token
@require_client
@handle_franklin_errors
def get_soc():
    """Get the current battery state of charge."""
    stats = run_read(_client.get_stats)
    
    return jsonify({
        "battery_soc": stats.current.battery_soc
    })


@app.route("/mode", methods=["GET"])
@require_token
@require_client
@handle_franklin_errors
def get_mode():
    """Get the current operating mode."""
    mode_name, soc = run_read(_client.get_mode)
    
    return jsonify({
        "mode": mode_name,
        "soc": soc
    })


@app.route("/mode", methods=["POST"])
@require_token
@require_client
@handle_franklin_errors
def set_mode():
    """
    Set the operating mode.
    
    Body:
        {
            "mode": "time_of_use" | "self_consumption" | "emergency_backup",
            "soc": 20  # Optional, defaults vary by mode
        }
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400
    
    mode_name = data.get("mode")
    soc = data.get("soc")
    
    if mode_name == "time_of_use":
        mode = Mode.time_of_use(soc if soc is not None else 20)
    elif mode_name == "self_consumption":
        mode = Mode.self_consumption(soc if soc is not None else 20)
    elif mode_name == "emergency_backup":
        mode = Mode.emergency_backup(soc if soc is not None else 100)
    else:
        return jsonify({"error": "Invalid mode. Use: time_of_use, self_consumption, or emergency_backup"}), 400
    
    run_async(_client.set_mode(mode))
    
    return jsonify({
        "success": True,
        "mode": mode_name,
        "soc": soc
    })


@app.route("/composite-info", methods=["GET"])
@require_token
@require_client
@handle_franklin_errors
def get_composite_info():
    """Get composite information about the gateway."""
    info = run_read(_client.get_composite_info)
    return jsonify(info)


@app.route("/gateways", methods=["GET"])
@require_token
@require_client
@handle_franklin_errors
def get_gateways():
    """Get list of home gateways associated with the account."""
    gateways = run_read(_client.get_home_gateway_list)
    return jsonify({"gateways": gateways})


@app.route("/shutdown", methods=["POST"])
@require_token
def shutdown():
    """Shut the proxy down cleanly, after this response has been sent.

    Flask >= 2.1 removed werkzeug.server.shutdown, and the old fallback,
    os._exit(0), hard-killed the process mid-request with no cleanup. Instead
    the reply goes out first, then a short-lived thread SIGTERMs the process;
    the handler installed in __main__ turns that signal into SystemExit on the
    main thread, which is parked in serve_forever -- so app.run() unwinds and
    the interpreter exits normally. The caller still verifies the process is
    actually gone; a response lost to the 0.2s race is not an error.
    """
    def fire_sigterm():
        time.sleep(0.2)
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=fire_sigterm, daemon=True).start()
    return jsonify({"message": "Server shutting down..."})


def _exit_on_sigterm(signum, frame):
    """Main-thread SIGTERM: unwind serve_forever instead of hard-killing."""
    raise SystemExit(0)


if __name__ == "__main__":
    port = int(os.environ.get("FRANKLIN_PROXY_PORT", 3001))
    host = os.environ.get("FRANKLIN_PROXY_HOST", "127.0.0.1")
    # The routes include battery writes (POST /mode); a non-loopback bind would
    # expose them to the network. The CLI never sets this -- it exists so a
    # manual override fails loudly instead of quietly.
    if host not in ("127.0.0.1", "localhost", "::1"):
        print(
            f"Refusing to bind {host!r}: this proxy exposes battery-write routes\n"
            "  and must stay on loopback. Unset FRANKLIN_PROXY_HOST to use 127.0.0.1.",
            file=sys.stderr,
        )
        sys.exit(1)
    signal.signal(signal.SIGTERM, _exit_on_sigterm)
    debug = os.environ.get("FRANKLIN_PROXY_DEBUG", "false").lower() == "true"

    print(f"Starting FranklinWH API Proxy on port {port}")
    app.run(host=host, port=port, debug=debug)
