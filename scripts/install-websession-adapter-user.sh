#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="websession-adapter.service"
SOURCE_UNIT="$ROOT/systemd/$UNIT_NAME.in"
USER_HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
[ -n "$USER_HOME" ] || { echo "unable to determine user home directory" >&2; exit 1; }
STATE_BASE="${XDG_STATE_HOME:-$USER_HOME/.local/state}"
STATE_DIR="${BRIDGE_STATE_DIR:-$STATE_BASE/mcp-dev-bridge}"
TARGET_DIR="${WEBSESSION_ADAPTER_SYSTEMD_TARGET_DIR:-$USER_HOME/.config/systemd/user}"
TARGET_UNIT="$TARGET_DIR/$UNIT_NAME"
PATH_VALUE="${BRIDGE_SYSTEMD_PATH:-$PATH}"
START_NOW=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-start)
      START_NOW=0
      shift
      ;;
    *)
      echo "usage: scripts/install-websession-adapter-user.sh [--no-start]" >&2
      exit 2
      ;;
  esac
done

[ -f "$SOURCE_UNIT" ] || { echo "missing unit template: $SOURCE_UNIT" >&2; exit 1; }
mkdir -p "$TARGET_DIR" "$STATE_DIR/logs"

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

if [ "${WEBSESSION_ADAPTER_SYSTEMD_DRY_RUN:-0}" = "1" ]; then
  mv -f "$tmp" "$TARGET_UNIT"
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

# A manually started adapter, or a transient unit of the same name, holds the port.
# Stop it before the file-based unit takes over the name.
if curl --noproxy '*' -sf -m 2 "http://127.0.0.1:${WEBSESSION_ADAPTER_PORT:-3051}/health/ready" -o /dev/null; then
  echo "stopping the running adapter before enabling $UNIT_NAME"
  "$ROOT/bin/adapter" stop || true
fi
systemctl --user stop "$UNIT_NAME" >/dev/null 2>&1 || true

mv -f "$tmp" "$TARGET_UNIT"
systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME"

if [ "$START_NOW" = 1 ]; then
  systemctl --user start "$UNIT_NAME"
  echo "started $UNIT_NAME"
fi

echo "enabled $UNIT_NAME for user-session startup"
echo "  status:  systemctl --user status $UNIT_NAME"
echo "  logs:    journalctl --user -u $UNIT_NAME -f"
echo "  requests: tail -f $STATE_DIR/logs/websession-adapter.log"
echo "  disable: systemctl --user disable --now $UNIT_NAME"
