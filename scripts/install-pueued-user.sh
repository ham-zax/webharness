#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="pueued.service"
SOURCE_UNIT="$ROOT/systemd/pueued.service.in"
USER_HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
[ -n "$USER_HOME" ] || { echo "unable to determine user home directory" >&2; exit 1; }
TARGET_DIR="${PUEUED_SYSTEMD_TARGET_DIR:-$USER_HOME/.config/systemd/user}"
TARGET_UNIT="$TARGET_DIR/$UNIT_NAME"
PATH_VALUE="${PUEUED_SYSTEMD_PATH:-$USER_HOME/.local/bin:$PATH}"
PUEUED_BIN="${PUEUED_BIN:-$(PATH="$PATH_VALUE" command -v pueued 2>/dev/null || true)}"
PUEUE_BIN="${PUEUE_BIN:-$(PATH="$PATH_VALUE" command -v pueue 2>/dev/null || true)}"
PARALLEL_LIMIT="${PUEUE_PARALLEL_LIMIT:-1}"

[ -f "$SOURCE_UNIT" ] || { echo "missing unit template: $SOURCE_UNIT" >&2; exit 1; }
if [ -z "$PUEUED_BIN" ]; then
  if [ "${PUEUED_SYSTEMD_DRY_RUN:-0}" = "1" ]; then
    PUEUED_BIN="$USER_HOME/.local/bin/pueued"
  else
    echo "pueued executable not found on PATH" >&2
    exit 1
  fi
fi

mkdir -p "$TARGET_DIR"
template="$(cat "$SOURCE_UNIT")"
template="${template//@USER_HOME@/$USER_HOME}"
template="${template//@PATH@/$PATH_VALUE}"
template="${template//@PUEUED_BIN@/$PUEUED_BIN}"
if grep -q '@[A-Z_][A-Z_]*@' <<<"$template"; then
  echo "unresolved placeholder in rendered systemd unit" >&2
  exit 1
fi

tmp="$TARGET_UNIT.tmp.$$"
printf '%s\n' "$template" > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$TARGET_UNIT"

if [ "${PUEUED_SYSTEMD_DRY_RUN:-0}" = "1" ]; then
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
systemctl --user enable --now "$UNIT_NAME"

if [ -n "$PUEUE_BIN" ] && [ -x "$PUEUE_BIN" ]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if "$PUEUE_BIN" parallel "$PARALLEL_LIMIT" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
  "$PUEUE_BIN" status --json >/dev/null 2>&1 || true
fi

echo "enabled and started $UNIT_NAME (parallel=$PARALLEL_LIMIT)"
