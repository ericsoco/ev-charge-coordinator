#!/usr/bin/env bash
# Install the evcc collect daemon as a per-user LaunchAgent (gui domain).
#
# Why an agent, not a LaunchDaemon: agents run inside the login session, which
# login-keychain access (@napi-rs/keyring) requires; a LaunchDaemon runs as
# root at boot with no keychain session.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-daemon.sh [--dry-run]

Builds dist/, renders scripts/evcc-daemon.plist with this machine's paths, and
(missing --dry-run) installs and bootstraps it as a per-user LaunchAgent.

  --dry-run   Print the rendered plist and the actions; change nothing.
EOF
}

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$SCRIPT_DIR/evcc-daemon.plist"
if [ ! -f "$TEMPLATE" ]; then
  echo "template not found: $TEMPLATE" >&2
  exit 1
fi

CONFIG_DIR="$HOME/.ev-charge-coordinator"
AGENT_DIR="$HOME/Library/LaunchAgents"

# Single source of truth for the label: the template's Label entry.
LABEL="$(sed -n 's|.*<string>\(com\.[^<]*\)</string>.*|\1|p' "$TEMPLATE" | head -1)"
if [ -z "$LABEL" ]; then
  echo "could not derive Label from $TEMPLATE" >&2
  exit 1
fi
TARGET="$AGENT_DIR/$LABEL.plist"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not on PATH (nvm login-shell only?); re-run from a shell where node resolves" >&2
  exit 1
fi
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

render() {
  sed \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
    -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__CONFIG_DIR__|$CONFIG_DIR|g" \
    "$TEMPLATE"
}

DOMAIN="gui/$(id -u)"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would: npm run build (in $REPO_DIR)"
  echo "[dry-run] would: mkdir -p $CONFIG_DIR/logs $AGENT_DIR"
  echo "[dry-run] would: write rendered plist to $TARGET (below)"
  echo "[dry-run] would: plutil -lint $TARGET"
  echo "[dry-run] would: launchctl bootout $DOMAIN/$LABEL 2>/dev/null || true"
  echo "[dry-run] would: launchctl bootstrap $DOMAIN $TARGET"
  echo "--- rendered plist <<<"
  render
  echo ">>> --- end rendered plist"
  echo "[dry-run] no changes were made."
  exit 0
fi

echo "Building dist/ ..."
(cd "$REPO_DIR" && npm run build)

mkdir -p "$CONFIG_DIR/logs" "$AGENT_DIR"
render > "$TARGET"
plutil -lint "$TARGET"

# Idempotent upgrade: bootout errors when the label was never loaded.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$TARGET"

echo "Installed $LABEL"
echo "Verify:"
echo "  launchctl print $DOMAIN/$LABEL | grep -E 'state =|pid ='"
echo "  tail -f $CONFIG_DIR/logs/daemon.log"
echo "  node dist/index.js status"
echo "First run: choose 'Always Allow' if macOS asks about keychain access."
