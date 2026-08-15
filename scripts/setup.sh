#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

ONE_MCP_VERSION="0.34.4"

usage() {
  cat <<'EOF'
Usage: scripts/setup.sh --profile <restricted|trusted-dev> [options]

Required:
  --profile restricted   Workspace-confined Read/Edit/Write only
  --profile trusted-dev  Read/Edit/Write plus unrestricted Bash as the Linux service user

Options:
  --env-file PATH        Deployment env file (default: .env)
  --state-dir PATH       Persistent state root override
  --help                 Show this help
EOF
}

PROFILE=""
ENV_FILE="$DIR/.env"
STATE_DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
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
  echo "== installing pinned 1MCP aggregator =="
  npm install -g "@1mcp/agent@$ONE_MCP_VERSION"

  echo "== applying verified upstream 1MCP patch =="
  SDK_PROVIDER="$(npm root -g)/@1mcp/agent/build/auth/sdkOAuthServerProvider.js"
  if [ ! -f "$SDK_PROVIDER" ]; then
    echo "expected 1MCP OAuth provider missing: $SDK_PROVIDER" >&2
    exit 1
  fi
  if grep -Fq "form-action 'self' https:" "$SDK_PROVIDER"; then
    echo "  OAuth consent CSP patch already applied"
  elif grep -Fq "form-action 'self'" "$SDK_PROVIDER"; then
    sed -i "s/form-action 'self'/form-action 'self' https:/g" "$SDK_PROVIDER"
    grep -Fq "form-action 'self' https:" "$SDK_PROVIDER" || {
      echo "failed to verify OAuth consent CSP patch" >&2
      exit 1
    }
    echo "  patched OAuth consent CSP (form-action https:) in $SDK_PROVIDER"
  else
    echo "unexpected 1MCP $ONE_MCP_VERSION OAuth provider contents; refusing blind patch" >&2
    exit 1
  fi

  echo "== verifying WebHarness prerequisites =="
  for cmd in node npm npx cloudflared curl flock; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd missing" >&2; exit 1; }
  done
  echo "  1MCP:          @1mcp/agent@$ONE_MCP_VERSION"
  echo "  cloudflared:     $(cloudflared --version 2>/dev/null | head -n1)"
  echo "  node:            $(node -v)"

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

echo "== next steps =="
echo "  autostart: scripts/install-systemd-user.sh"
echo "  start:     bin/start"
echo "  inspect:   bin/status"
echo "  stop:      bin/stop"
