#!/usr/bin/env python3
"""
FranklinWH API Proxy Server

A Flask server that proxies requests to the FranklinWH API using the franklinwh Python library.
This allows the Node.js application to communicate with FranklinWH systems through HTTP.
"""

import asyncio
import json
import os
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

app = Flask(__name__)
CORS(app)

# Global client instance
_client: Client | None = None
_token_fetcher: TokenFetcher | None = None
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
                f"{type(error).__name__}: {error}; retrying",
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
            return jsonify({"error": "Internal error", "details": str(e)}), 500
    return decorated


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({
        "status": "ok",
        "authenticated": _client is not None,
        "gateway_id": _gateway_id
    })


@app.route("/auth", methods=["POST"])
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
    global _client, _token_fetcher, _gateway_id
    
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400
    
    username = data.get("username")
    password = data.get("password")
    gateway_id = data.get("gateway_id")
    
    if not all([username, password, gateway_id]):
        return jsonify({"error": "username, password, and gateway_id are required"}), 400
    
    _token_fetcher = TokenFetcher(username, password)
    _client = Client(_token_fetcher, gateway_id)
    _gateway_id = gateway_id
    
    # Test authentication by refreshing token
    run_async(_client.refresh_token())
    
    return jsonify({
        "success": True,
        "message": "Authentication successful",
        "gateway_id": gateway_id
    })


@app.route("/stats", methods=["GET"])
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
@require_client
@handle_franklin_errors
def get_soc():
    """Get the current battery state of charge."""
    stats = run_read(_client.get_stats)
    
    return jsonify({
        "battery_soc": stats.current.battery_soc
    })


@app.route("/mode", methods=["GET"])
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
@require_client
@handle_franklin_errors
def get_composite_info():
    """Get composite information about the gateway."""
    info = run_read(_client.get_composite_info)
    return jsonify(info)


@app.route("/gateways", methods=["GET"])
@require_client
@handle_franklin_errors
def get_gateways():
    """Get list of home gateways associated with the account."""
    gateways = run_read(_client.get_home_gateway_list)
    return jsonify({"gateways": gateways})


@app.route("/shutdown", methods=["POST"])
def shutdown():
    """Shutdown the proxy server."""
    func = request.environ.get("werkzeug.server.shutdown")
    if func is None:
        # For production/different servers, just exit
        os._exit(0)
    func()
    return jsonify({"message": "Server shutting down..."})


if __name__ == "__main__":
    port = int(os.environ.get("FRANKLIN_PROXY_PORT", 3001))
    debug = os.environ.get("FRANKLIN_PROXY_DEBUG", "false").lower() == "true"
    
    print(f"Starting FranklinWH API Proxy on port {port}")
    app.run(host="127.0.0.1", port=port, debug=debug)
