#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
[ -n "$USER_HOME" ] || { echo "unable to determine user home directory" >&2; exit 1; }

TMUX_BIN="${TERMINAL_TMUX_BIN:-$(command -v tmux || true)}"
NODE_BIN="${TERMINAL_NODE_BIN:-$(command -v node || true)}"
[ -x "$TMUX_BIN" ] || { echo "tmux is required" >&2; exit 1; }
[ -x "$NODE_BIN" ] || { echo "node is required" >&2; exit 1; }

STATE_BASE="${XDG_STATE_HOME:-$USER_HOME/.local/state}"
STATE_ROOT="${TERMINAL_STATE_ROOT:-$STATE_BASE/wsl-agent-terminal}"
TARGET_DIR="${TERMINAL_SYSTEMD_TARGET_DIR:-$USER_HOME/.config/systemd/user}"
PATH_VALUE="${TERMINAL_SYSTEMD_PATH:-$PATH}"
OWNER_ENV_FILE="${TERMINAL_OWNER_ENV_FILE:-$STATE_BASE/mcp-dev-bridge/owner.env}"
[[ "$OWNER_ENV_FILE" = /* ]] || { echo "TERMINAL_OWNER_ENV_FILE must be absolute" >&2; exit 1; }

TMUX_UNIT="wsl-agent-tmux.service"
BROKER_UNIT="wsl-agent-terminal-broker.service"
TMUX_SOURCE="$ROOT/systemd/$TMUX_UNIT.in"
BROKER_SOURCE="$ROOT/systemd/$BROKER_UNIT.in"

for source in "$TMUX_SOURCE" "$BROKER_SOURCE"; do
  [ -f "$source" ] || { echo "missing unit template: $source" >&2; exit 1; }
done

mkdir -p "$TARGET_DIR" "$STATE_ROOT"
chmod 0700 "$STATE_ROOT"

render_unit() {
  local source="$1"
  local target="$2"
  local template tmp
  template="$(cat "$source")"
  template="${template//@REPO_ROOT@/$ROOT}"
  template="${template//@USER_HOME@/$USER_HOME}"
  template="${template//@STATE_ROOT@/$STATE_ROOT}"
  template="${template//@TMUX_BIN@/$TMUX_BIN}"
  template="${template//@NODE_BIN@/$NODE_BIN}"
  template="${template//@PATH@/$PATH_VALUE}"
  template="${template//@OWNER_ENV_FILE@/$OWNER_ENV_FILE}"
  if grep -q '@[A-Z_][A-Z_]*@' <<<"$template"; then
    echo "unresolved placeholder while rendering $source" >&2
    exit 1
  fi
  tmp="$target.tmp.$$"
  printf '%s\n' "$template" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$target"
}

render_unit "$TMUX_SOURCE" "$TARGET_DIR/$TMUX_UNIT"
render_unit "$BROKER_SOURCE" "$TARGET_DIR/$BROKER_UNIT"

echo "rendered $TARGET_DIR/$TMUX_UNIT"
echo "rendered $TARGET_DIR/$BROKER_UNIT"

if [ "${TERMINAL_SYSTEMD_DRY_RUN:-0}" = "1" ]; then
  exit 0
fi

NPM_BIN="${TERMINAL_NPM_BIN:-$(command -v npm || true)}"
[ -x "$NPM_BIN" ] || { echo "npm is required to install the Terminal provider dependencies" >&2; exit 1; }
"$NPM_BIN" --prefix "$ROOT/providers/terminal" ci --omit=dev

command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required" >&2; exit 1; }
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if [ ! -S "$XDG_RUNTIME_DIR/bus" ]; then
  echo "systemd user bus is unavailable at $XDG_RUNTIME_DIR/bus" >&2
  exit 1
fi

systemctl --user daemon-reload
systemctl --user enable "$TMUX_UNIT" "$BROKER_UNIT"

echo "enabled Terminal core user services"
echo "  start now: systemctl --user start $TMUX_UNIT $BROKER_UNIT"
echo "  status:    systemctl --user status $TMUX_UNIT $BROKER_UNIT"
echo "  stop:      systemctl --user stop $BROKER_UNIT $TMUX_UNIT"
echo

echo "This installer does not start, stop, restart, or reconfigure mcp-dev-bridge.service, 1MCP, Cloudflare, or OAuth state."
