#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

usage() {
  cat <<'EOF'
Usage: scripts/setup.sh --profile <restricted|trusted-dev> [options]

Required:
  --profile restricted   Conservative shell policy for general installs
  --profile trusted-dev  Unrestricted agentic shell as the Linux service user

Options:
  --enable-startup       Explicitly install, enable, and start the user service
  --env-file PATH        Deployment env file (default: .env)
  --state-dir PATH       Persistent state root override
  --help                 Show this help
EOF
}

PROFILE=""
ENV_FILE="$DIR/.env"
STATE_DIR=""
ENABLE_STARTUP=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --enable-startup)
      ENABLE_STARTUP=1
      shift
      ;;
    --profile)
      [ "$#" -ge 2 ] || { echo "missing value for --profile" >&2; usage >&2; exit 2; }
      PROFILE="$2"
      shift 2
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

case "$PROFILE" in
  restricted|trusted-dev) ;;
  "")
    echo "A trust profile is required: choose --profile restricted or --profile trusted-dev." >&2
    usage >&2
    exit 2
    ;;
  *)
    echo "unknown trust profile: $PROFILE" >&2
    usage >&2
    exit 2
    ;;
esac

if [ "${BRIDGE_SETUP_SKIP_INSTALL:-0}" != "1" ]; then
  "$DIR/scripts/install-bridge-runtime.sh"

  echo "== installing pinned Pi dev provider dependencies =="
  npm --prefix "$DIR/providers/pi-dev" ci --omit=dev
  PI_PACKAGE="$DIR/providers/pi-dev/node_modules/@earendil-works/pi-coding-agent/package.json"
  PI_VERSION="$(node -p "require(process.argv[1]).version" "$PI_PACKAGE")"
  [ "$PI_VERSION" = "0.84.1" ] || {
    echo "unexpected Pi version: $PI_VERSION" >&2
    exit 1
  }
  echo "  Pi coding primitives: @earendil-works/pi-coding-agent@$PI_VERSION"
fi

RENDER_ARGS=(--profile "$PROFILE" --env-file "$ENV_FILE" --repo-root "$DIR")
if [ -n "$STATE_DIR" ]; then
  RENDER_ARGS+=(--state-dir "$STATE_DIR")
fi

echo "== rendering deployment state =="
node "$DIR/scripts/render-config.mjs" "${RENDER_ARGS[@]}"

if [ "$ENABLE_STARTUP" -eq 1 ]; then
  USER_NAME="$(id -un)"
  RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  EFFECTIVE_STATE_DIR="${STATE_DIR:-${MCP_BRIDGE_STATE_DIR:-${XDG_STATE_HOME:-${HOME:?HOME is required}/.local/state}/mcp-dev-bridge}}"

  echo "== installing WebHarness user service =="
  HOME="$HOME" BRIDGE_STATE_DIR="$EFFECTIVE_STATE_DIR" "$DIR/scripts/install-systemd-user.sh"
  command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required for --enable-startup" >&2; exit 1; }
  command -v loginctl >/dev/null 2>&1 || { echo "loginctl is required for --enable-startup" >&2; exit 1; }
  export XDG_RUNTIME_DIR="$RUNTIME_DIR"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
  [ -S "$XDG_RUNTIME_DIR/bus" ] || { echo "systemd user bus is unavailable at $XDG_RUNTIME_DIR/bus" >&2; exit 1; }

  if [ "$(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null || true)" != yes ]; then
    if ! loginctl enable-linger "$USER_NAME"; then
      command -v sudo >/dev/null 2>&1 || { echo "failed to enable linger for $USER_NAME and sudo is unavailable" >&2; exit 1; }
      sudo loginctl enable-linger "$USER_NAME"
    fi
  fi
  [ "$(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null || true)" = yes ] || { echo "user linger is still disabled for $USER_NAME" >&2; exit 1; }

  systemctl --user daemon-reload
  systemctl --user enable --now mcp-dev-bridge.service
  systemctl --user is-active mcp-dev-bridge.service >/dev/null
  echo "WebHarness startup service is installed and active"
else
  echo "startup service was not installed; rerun with --enable-startup to explicitly consent"
fi

echo "== next steps =="
echo "  doctor: webharness doctor --profile $PROFILE"
echo "  start:  webharness start"
echo "  status: webharness status"
echo "  stop:   webharness stop"
