#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
[ -n "$USER_HOME" ] || { echo "unable to determine user home directory" >&2; exit 1; }

NODE_BIN="${AGENTS_NODE_BIN:-$(command -v node || true)}"
[ -x "$NODE_BIN" ] || { echo "node is required" >&2; exit 1; }

STATE_BASE="${XDG_STATE_HOME:-$USER_HOME/.local/state}"
STATE_ROOT="${AGENTS_STATE_ROOT:-$STATE_BASE/mcp-dev-bridge/agents}"
TARGET_DIR="${AGENTS_SYSTEMD_TARGET_DIR:-$USER_HOME/.config/systemd/user}"
PATH_VALUE="${AGENTS_SYSTEMD_PATH:-$PATH}"
UNIT="wsl-agent-agents.service"
SOURCE="$ROOT/systemd/$UNIT.in"
TARGET="$TARGET_DIR/$UNIT"

[ -f "$SOURCE" ] || { echo "missing unit template: $SOURCE" >&2; exit 1; }
mkdir -p "$TARGET_DIR" "$STATE_ROOT"
chmod 0700 "$STATE_ROOT"

template="$(cat "$SOURCE")"
template="${template//@REPO_ROOT@/$ROOT}"
template="${template//@USER_HOME@/$USER_HOME}"
template="${template//@STATE_ROOT@/$STATE_ROOT}"
template="${template//@NODE_BIN@/$NODE_BIN}"
template="${template//@PATH@/$PATH_VALUE}"
if grep -q '@[A-Z_][A-Z_]*@' <<<"$template"; then
  echo "unresolved placeholder while rendering $SOURCE" >&2
  exit 1
fi

tmp="$TARGET.tmp.$$"
printf '%s\n' "$template" > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$TARGET"
echo "rendered $TARGET"

if [ "${AGENTS_SYSTEMD_DRY_RUN:-0}" = "1" ]; then
  exit 0
fi

NPM_BIN="${AGENTS_NPM_BIN:-$(command -v npm || true)}"
[ -x "$NPM_BIN" ] || { echo "npm is required to install the Agents provider dependencies" >&2; exit 1; }
"$NPM_BIN" --prefix "$ROOT/providers/agents" ci --omit=dev

command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required" >&2; exit 1; }
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if [ ! -S "$XDG_RUNTIME_DIR/bus" ]; then
  echo "systemd user bus is unavailable at $XDG_RUNTIME_DIR/bus" >&2
  exit 1
fi

systemctl --user daemon-reload

echo "installed WebHarness Agent Broker user service"
echo "  enable/start: systemctl --user enable --now $UNIT"
echo "  start once:   systemctl --user start $UNIT"
echo "  status:       systemctl --user status $UNIT"
echo "  stop:         systemctl --user stop $UNIT"
echo
echo "This installer does not start, stop, restart, or reconfigure mcp-dev-bridge.service, 1MCP, Cloudflare, Chrome, or OAuth state."
