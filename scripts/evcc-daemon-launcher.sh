#!/usr/bin/env bash
# Launch shim for the ev-charge-coordinator daemon.
#
# The plist's ProgramArguments[0] is this file, so macOS Background Task
# Management names the Login Item after it — a bare node binary shows as its
# code-signer identity ("Node.js Foundation") instead of our name. It also
# resolves node at each launch (nvm lives in the login shell's rc, which
# launchd does not source), so a node upgrade does not strand the agent.
#
# NOTE: the installer renders this template to
# "~/.ev-charge-coordinator/EV Charge Coordinator" — the file name is the
# Login Items title, so keep them in sync.
set -euo pipefail

REPO_DIR="__REPO_DIR__"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  \. "$NVM_DIR/nvm.sh" || echo "evcc launcher: nvm.sh failed to source" >&2
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "evcc launcher: node not found on PATH (nvm?)" >&2
  exit 1
fi

# Hold PreventSystemSleep while the daemon runs — meaningful on AC power
# (macOS ignores the assertion on battery, so a laptop still sleeps there).
# Without it a lid-closed Mac naps in Maintenance-Sleep cycles and any
# vehicle wake between polls is invisible (see README: keeping the Mac awake).
if [ -x /usr/bin/caffeinate ]; then
  exec /usr/bin/caffeinate -s "$NODE_BIN" "$REPO_DIR/dist/index.js" daemon
fi
exec "$NODE_BIN" "$REPO_DIR/dist/index.js" daemon
