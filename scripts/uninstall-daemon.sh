#!/usr/bin/env bash
# Remove the evcc collect daemon LaunchAgent. Keeps the store, logs, and
# credentials; stops nothing it does not own.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: uninstall-daemon.sh [--dry-run]

Boots the collect daemon out of your gui domain and removes its plist.

  --dry-run   Print the actions; change nothing.
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
TEMPLATE="$SCRIPT_DIR/evcc-daemon.plist"
if [ ! -f "$TEMPLATE" ]; then
  echo "template not found: $TEMPLATE" >&2
  exit 1
fi

CONFIG_DIR="$HOME/.ev-charge-coordinator"

# Same single source of truth as install-daemon.sh: the template's Label entry.
LABEL="$(sed -n 's|.*<string>\(com\.[^<]*\)</string>.*|\1|p' "$TEMPLATE" | head -1)"
if [ -z "$LABEL" ]; then
  echo "could not derive Label from $TEMPLATE" >&2
  exit 1
fi
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would: launchctl bootout $DOMAIN/$LABEL 2>/dev/null || true"
  echo "[dry-run] would: rm -f $TARGET"
  echo "[dry-run] no changes were made."
  exit 0
fi

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
rm -f "$TARGET"

echo "Removed $TARGET"
echo "Kept: $CONFIG_DIR (store, logs, credentials)."
echo "Proxies (if any still run): node dist/index.js exit"
