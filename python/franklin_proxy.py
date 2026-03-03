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


def run_async(coro):
    """Run an async coroutine in a synchronous context."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


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
    stats = run_async(_client.get_stats())
    
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
    stats = run_async(_client.get_stats())
    
    return jsonify({
        "battery_soc": stats.current.battery_soc
    })


@app.route("/mode", methods=["GET"])
@require_client
@handle_franklin_errors
def get_mode():
    """Get the current operating mode."""
    mode_name, soc = run_async(_client.get_mode())
    
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
    info = run_async(_client.get_composite_info())
    return jsonify(info)


@app.route("/gateways", methods=["GET"])
@require_client
@handle_franklin_errors
def get_gateways():
    """Get list of home gateways associated with the account."""
    gateways = run_async(_client.get_home_gateway_list())
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
