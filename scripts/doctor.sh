#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE=""
ENV_FILE="$ROOT/.env"
STATE_BASE="${XDG_STATE_HOME:-${HOME:?HOME is required}/.local/state}"
STATE_DIR="${MCP_BRIDGE_STATE_DIR:-$STATE_BASE/mcp-dev-bridge}"
FAILURES=0
WARNINGS=0

usage() {
  cat <<'EOF'
Usage: scripts/doctor.sh [--profile restricted|trusted-dev|personal] [--env-file PATH] [--state-dir PATH]

Run non-mutating WebHarness reference-environment and rendered-state checks.
If --profile is omitted, doctor uses MCP_BRIDGE_PROFILE from existing rendered
state. Without rendered state an explicit profile is required.
EOF
}

ok() { printf 'OK   %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf 'FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

bridge_value() {
  local key="$1" file="$STATE_DIR/bridge.env"
  [ -f "$file" ] || return 1
  sed -n "s/^${key}='\([^']*\)'$/\1/p" "$file" | tail -n1
}

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

STATE_DIR="$(realpath -m "$STATE_DIR")"
ENV_FILE="$(realpath -m "$ENV_FILE")"

if [ -z "$PROFILE" ]; then
  PROFILE="$(bridge_value MCP_BRIDGE_PROFILE 2>/dev/null || true)"
  if [ -z "$PROFILE" ]; then
    echo "doctor requires --profile when rendered state does not select one" >&2
    usage >&2
    exit 2
  fi
fi
case "$PROFILE" in
  restricted|trusted-dev|personal) ;;
  *) echo "unknown profile: $PROFILE" >&2; usage >&2; exit 2 ;;
esac

printf 'WebHarness doctor\nprofile: %s\nstate:   %s\n\n' "$PROFILE" "$STATE_DIR"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)"
  if [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && [ "$NODE_MAJOR" -ge 24 ]; then
    ok "Node.js $(node --version) satisfies the reference minimum (24+)"
  else
    fail "Node.js 24+ is required by the qualified reference environment"
  fi
else
  fail "node is required"
fi
for cmd in npm git bash; do
  if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd is available"; else fail "$cmd is required"; fi
done

if [ "$PROFILE" = personal ]; then
  [ "$(uname -s)" = Linux ] && ok "Linux host detected" || fail "personal reference deployment requires Linux under WSL2"
  [ "$(uname -m)" = x86_64 ] && ok "x86_64 architecture detected" || fail "qualified reference architecture is x86_64"
  if grep -Eqi 'microsoft|wsl' /proc/sys/kernel/osrelease /proc/version 2>/dev/null; then
    ok "WSL environment detected"
  else
    fail "qualified personal reference environment is WSL2"
  fi
  if [ "$(ps -p 1 -o comm= 2>/dev/null | tr -d ' ')" = systemd ]; then
    ok "systemd is PID 1"
  else
    fail "qualified personal reference environment requires WSL systemd"
  fi
  if [ -d /mnt/wslg ]; then
    ok "WSLg runtime is present"
  else
    warn "WSLg is unavailable; Linux headed Browser capability is not qualified"
  fi
  if command -v cloudflared >/dev/null 2>&1; then ok "cloudflared is available"; else warn "cloudflared is not installed yet; public transport cannot start"; fi
  if command -v tmux >/dev/null 2>&1; then ok "tmux is available"; else warn "tmux is not installed yet; durable Terminal cannot start"; fi
  if "$ROOT/scripts/check-personal-toolbox.sh" >/dev/null 2>&1; then
    ok "Personal Workstation CLI toolbox matches the qualified assumptions"
  else
    warn "Personal Workstation CLI toolbox is not fully qualified yet; setup installs/qualifies the pinned toolbox"
  fi
fi

CHECK_ARGS=(--check --profile "$PROFILE" --env-file "$ENV_FILE" --state-dir "$STATE_DIR" --repo-root "$ROOT")
if node "$ROOT/scripts/render-config.mjs" "${CHECK_ARGS[@]}" >/dev/null 2>&1; then
  ok "profile, deployment env, and templates validate without writing state"
else
  fail "configuration validation failed; run render-config --check directly for details"
fi

if [ ! -f "$STATE_DIR/bridge.env" ]; then
  warn "no rendered deployment state exists yet; setup has not populated $STATE_DIR"
else
  RENDERED_PROFILE="$(bridge_value MCP_BRIDGE_PROFILE 2>/dev/null || true)"
  RENDERED_ROOT="$(bridge_value MCP_BRIDGE_ROOT 2>/dev/null || true)"
  [ "$RENDERED_PROFILE" = "$PROFILE" ] && ok "rendered profile matches $PROFILE" || fail "rendered profile is ${RENDERED_PROFILE:-unreadable}, expected $PROFILE"
  [ "$RENDERED_ROOT" = "$ROOT" ] && ok "rendered source root matches this checkout" || warn "rendered source root is ${RENDERED_ROOT:-unreadable}; this checkout is $ROOT"

  if [ "$(stat -c %u "$STATE_DIR" 2>/dev/null)" = "$(id -u)" ] && [ "$(stat -c %a "$STATE_DIR" 2>/dev/null)" = 700 ]; then
    ok "state root is current-user-owned mode 0700"
  else
    fail "state root must be current-user-owned mode 0700"
  fi
  GENERATED_FILES=("$STATE_DIR/bridge.env" "$STATE_DIR/1mcp/mcp.json" "$STATE_DIR/1mcp/config.toml")
  if [ "$PROFILE" = personal ]; then
    GENERATED_FILES+=("$STATE_DIR/owner.env" "$STATE_DIR/local-1mcp/mcp.json")
  fi
  for file in "${GENERATED_FILES[@]}"; do
    if [ -f "$file" ] && [ "$(stat -c %u "$file" 2>/dev/null)" = "$(id -u)" ] && [ "$(stat -c %a "$file" 2>/dev/null)" = 600 ]; then
      ok "generated file ownership/mode: ${file#$STATE_DIR/}"
    else
      fail "generated file must be current-user-owned mode 0600: ${file#$STATE_DIR/}"
    fi
  done

  OUTER="$STATE_DIR/1mcp/mcp.json"
  INNER="$STATE_DIR/local-1mcp/mcp.json"
  if node - "$PROFILE" "$OUTER" "$INNER" <<'NODE' >/dev/null 2>&1
const fs = require('fs');
const [profile, outerFile, innerFile] = process.argv.slice(2);
const keys = value => Object.keys(value?.mcpServers ?? {}).sort();
const outer = JSON.parse(fs.readFileSync(outerFile, 'utf8'));
const expectedOuter = profile === 'restricted' ? ['dev', 'shell'] : profile === 'trusted-dev' ? ['dev'] : ['code', 'dev', 'local', 'terminal'];
if (JSON.stringify(keys(outer)) !== JSON.stringify(expectedOuter)) process.exit(1);
if (profile === 'personal') {
  const inner = JSON.parse(fs.readFileSync(innerFile, 'utf8'));
  if (JSON.stringify(keys(inner)) !== JSON.stringify(['browser-devtools', 'browser-fast'])) process.exit(1);
}
NODE
  then
    ok "rendered provider composition matches the $PROFILE contract"
  else
    fail "rendered provider composition does not match the $PROFILE contract"
  fi

  if BRIDGE_STATE_DIR="$STATE_DIR" "$ROOT/bin/status" >/dev/null 2>&1; then
    ok "current lifecycle/status evidence reports no issues"
  else
    warn "current lifecycle/status evidence reports stopped, unreachable, or unhealthy components"
  fi
fi

printf '\nsummary: failures=%d warnings=%d\n' "$FAILURES" "$WARNINGS"
[ "$FAILURES" -eq 0 ]
