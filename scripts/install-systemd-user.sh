#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="mcp-dev-bridge.service"
SOURCE_UNIT="$ROOT/systemd/mcp-dev-bridge.service.in"
USER_HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
[ -n "$USER_HOME" ] || { echo "unable to determine user home directory" >&2; exit 1; }
STATE_BASE="${XDG_STATE_HOME:-$USER_HOME/.local/state}"
STATE_DIR="${BRIDGE_STATE_DIR:-$STATE_BASE/mcp-dev-bridge}"
TARGET_DIR="${BRIDGE_SYSTEMD_TARGET_DIR:-$USER_HOME/.config/systemd/user}"
TARGET_UNIT="$TARGET_DIR/$UNIT_NAME"
PATH_VALUE="${BRIDGE_SYSTEMD_PATH:-$PATH}"

[ -f "$SOURCE_UNIT" ] || { echo "missing unit template: $SOURCE_UNIT" >&2; exit 1; }
mkdir -p "$TARGET_DIR"

template="$(cat "$SOURCE_UNIT")"
template="${template//@REPO_ROOT@/$ROOT}"
template="${template//@USER_HOME@/$USER_HOME}"
template="${template//@STATE_DIR@/$STATE_DIR}"
template="${template//@PATH@/$PATH_VALUE}"
if grep -q '@[A-Z_][A-Z_]*@' <<<"$template"; then
  echo "unresolved placeholder in rendered systemd unit" >&2
  exit 1
fi

tmp="$TARGET_UNIT.tmp.$$"
printf '%s\n' "$template" > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$TARGET_UNIT"

if [ "${BRIDGE_SYSTEMD_DRY_RUN:-0}" = "1" ]; then
  echo "rendered $TARGET_UNIT"
  exit 0
fi

command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required" >&2; exit 1; }
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if [ ! -S "$XDG_RUNTIME_DIR/bus" ]; then
  echo "systemd user bus is unavailable at $XDG_RUNTIME_DIR/bus" >&2
  exit 1
fi

systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME"

echo "enabled $UNIT_NAME for user-session startup"
echo "  start now: systemctl --user start $UNIT_NAME"
echo "  status:    systemctl --user status $UNIT_NAME"
echo "  disable:   systemctl --user disable $UNIT_NAME"
echo
echo "This installer does not disable or remove any legacy bridge service."
