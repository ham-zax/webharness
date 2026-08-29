#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
[ -n "$USER_HOME" ] || { echo "unable to determine user home directory" >&2; exit 1; }
USER_NAME="$(id -un)"
ENV_FILE="$ROOT/.env"
STATE_DIR=""
ENABLE_STARTUP=0

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-personal.sh [options]

Prepare the WebHarness Personal Workstation reference deployment. Persistent
user-systemd startup is installed only when --enable-startup is passed explicitly.

Options:
  --enable-startup   Explicitly install, enable, and start persistent user services
  --env-file PATH    Deployment env file (default: .env)
  --state-dir PATH   Persistent bridge state root override
  --help             Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --enable-startup)
      ENABLE_STARTUP=1
      shift
      ;;
    --env-file)
      [ "$#" -ge 2 ] || { echo "missing value for --env-file" >&2; usage >&2; exit 2; }
      ENV_FILE="$2"
      shift 2
      ;;
    --state-dir)
      [ "$#" -ge 2 ] || { echo "missing value for --state-dir" >&2; usage >&2; exit 2; }
      STATE_DIR="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

STATE_BASE="${XDG_STATE_HOME:-$USER_HOME/.local/state}"
STATE_DIR="${STATE_DIR:-${MCP_BRIDGE_STATE_DIR:-$STATE_BASE/mcp-dev-bridge}}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
USER_BIN_DIR="${PERSONAL_USER_BIN_DIR:-$USER_HOME/.local/bin}"

if [ -n "${BRIDGE_SYSTEMD_TARGET_DIR:-}" ] && [ -n "${TERMINAL_SYSTEMD_TARGET_DIR:-}" ] && \
   [ "$BRIDGE_SYSTEMD_TARGET_DIR" != "$TERMINAL_SYSTEMD_TARGET_DIR" ]; then
  echo "BRIDGE_SYSTEMD_TARGET_DIR and TERMINAL_SYSTEMD_TARGET_DIR must match for personal bootstrap" >&2
  exit 1
fi
SYSTEMD_TARGET_DIR="${PERSONAL_SYSTEMD_TARGET_DIR:-${BRIDGE_SYSTEMD_TARGET_DIR:-${TERMINAL_SYSTEMD_TARGET_DIR:-$USER_HOME/.config/systemd/user}}}"

if [ "${PERSONAL_BOOTSTRAP_SKIP_INSTALL:-0}" != "1" ]; then
  echo "== qualifying Personal Workstation CLI toolbox =="
  "$ROOT/scripts/setup-personal-toolbox.sh"

  "$ROOT/scripts/install-bridge-runtime.sh"

  echo "== installing pinned Personal Workstation provider dependencies =="
  npm --prefix "$ROOT/providers/pi-dev" ci --omit=dev
  npm --prefix "$ROOT/providers/code-router" ci --omit=dev
  npm --prefix "$ROOT/providers/terminal" ci --omit=dev
  npm --prefix "$ROOT/providers/browser" ci --omit=dev
  npm --prefix "$ROOT/providers/browser-fast" ci --omit=dev
  npm --prefix "$ROOT/providers/local-tools" ci --omit=dev

  echo "== installing pinned Personal Workstation native runtimes =="
  "$ROOT/scripts/install-codedb.sh"
  "$ROOT/scripts/setup-clearcote-wsl.sh"
else
  echo "== skipping toolbox/provider installation by PERSONAL_BOOTSTRAP_SKIP_INSTALL =="
fi

RENDER_ARGS=(--profile personal --env-file "$ENV_FILE" --state-dir "$STATE_DIR" --repo-root "$ROOT")
echo "== rendering Personal Workstation MCP composition =="
HOME="$USER_HOME" XDG_RUNTIME_DIR="$RUNTIME_DIR" node "$ROOT/scripts/render-config.mjs" "${RENDER_ARGS[@]}"

mkdir -p "$USER_BIN_DIR"
WSL_TERM_LINK="$USER_BIN_DIR/wsl-term"
if [ -e "$WSL_TERM_LINK" ] && [ ! -L "$WSL_TERM_LINK" ]; then
  echo "refusing to replace non-symlink $WSL_TERM_LINK" >&2
  exit 1
fi
ln -sfn "$ROOT/bin/wsl-term" "$WSL_TERM_LINK"
echo "installed wsl-term: $WSL_TERM_LINK -> $ROOT/bin/wsl-term"
case ":$PATH:" in
  *":$USER_BIN_DIR:"*) echo "wsl-term user bin is already on PATH" ;;
  *) echo "wsl-term will be available from the standard user-local bin in future login shells: $USER_BIN_DIR" ;;
esac

if [ "$ENABLE_STARTUP" -ne 1 ]; then
  echo "startup services were not installed; rerun with --enable-startup to explicitly consent"
  exit 0
fi

echo "== rendering personal user-systemd units =="
HOME="$USER_HOME" BRIDGE_STATE_DIR="$STATE_DIR" BRIDGE_SYSTEMD_TARGET_DIR="$SYSTEMD_TARGET_DIR" \
  BRIDGE_SYSTEMD_DRY_RUN=1 "$ROOT/scripts/install-systemd-user.sh"
HOME="$USER_HOME" TERMINAL_SYSTEMD_TARGET_DIR="$SYSTEMD_TARGET_DIR" \
  TERMINAL_OWNER_ENV_FILE="$STATE_DIR/owner.env" TERMINAL_SYSTEMD_DRY_RUN=1 \
  "$ROOT/scripts/install-terminal-broker-user.sh"

DROPIN_DIR="$SYSTEMD_TARGET_DIR/mcp-dev-bridge.service.d"
DROPIN="$DROPIN_DIR/personal.conf"
mkdir -p "$DROPIN_DIR"
DROPIN_TMP="$DROPIN.tmp.$$"
cat > "$DROPIN_TMP" <<'EOF'
[Unit]
Wants=wsl-agent-terminal-broker.service
After=wsl-agent-terminal-broker.service
EOF
chmod 0644 "$DROPIN_TMP"
mv -f "$DROPIN_TMP" "$DROPIN"
echo "rendered $DROPIN"

command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required for --enable-startup" >&2; exit 1; }
command -v loginctl >/dev/null 2>&1 || { echo "loginctl is required for --enable-startup" >&2; exit 1; }
export XDG_RUNTIME_DIR="$RUNTIME_DIR"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if [ ! -S "$XDG_RUNTIME_DIR/bus" ]; then
  echo "systemd user bus is unavailable at $XDG_RUNTIME_DIR/bus" >&2
  exit 1
fi

linger_state() {
  loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null || true
}

if [ "$(linger_state)" != "yes" ]; then
  echo "== enabling user linger for WSL startup persistence =="
  if ! loginctl enable-linger "$USER_NAME"; then
    if command -v sudo >/dev/null 2>&1; then
      sudo loginctl enable-linger "$USER_NAME"
    else
      echo "failed to enable linger for $USER_NAME and sudo is unavailable" >&2
      exit 1
    fi
  fi
  if [ "$(linger_state)" != "yes" ]; then
    echo "user linger is still disabled for $USER_NAME" >&2
    exit 1
  fi
else
  echo "user linger already enabled"
fi

echo "== enabling and starting personal WSL services =="
systemctl --user daemon-reload
systemctl --user enable --now \
  wsl-agent-tmux.service \
  wsl-agent-terminal-broker.service \
  mcp-dev-bridge.service

for unit in wsl-agent-tmux.service wsl-agent-terminal-broker.service mcp-dev-bridge.service; do
  systemctl --user is-enabled "$unit" >/dev/null
  systemctl --user is-active "$unit" >/dev/null
done

if [ "${PERSONAL_BOOTSTRAP_SKIP_HEALTH:-0}" != "1" ]; then
  echo "== verifying bridge health =="
  HOME="$USER_HOME" BRIDGE_STATE_DIR="$STATE_DIR" "$ROOT/bin/status"
fi

cat <<EOF

WebHarness Personal Workstation startup is installed and active.
- WSL does not get launched by Windows through this script.
- Once this WSL user manager starts, the enabled harness services start automatically.
- wsl-term: $WSL_TERM_LINK
- ChatGPT still requires the configured MCP URL/OAuth connection and a client refresh when schemas change.
EOF
