#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=common.sh
source "$DIR/lib/bridge/common.sh"

LOG="$BRIDGE_RUN_DIR/watchdog.log"
TUNNEL_NAME="${TUNNEL_NAME:-}"
TUNNEL_URL="${TUNNEL_URL:-}"
export TUNNEL_NAME TUNNEL_URL

[ -n "$TUNNEL_URL" ] || {
  echo "$(date -Is) watchdog exiting: public URL is not configured" >> "$LOG"
  exit 2
}

while true; do
  if ! bridge_enabled; then
    echo "$(date -Is) watchdog exiting: Cloudflare OAuth Bridge is disabled" >> "$LOG"
    exit 0
  fi

  if ! bridge_lock_acquire "${BRIDGE_WATCHDOG_LOCK_TIMEOUT:-30}"; then
    echo "$(date -Is) watchdog skipped cycle: lifecycle lock busy" >> "$LOG"
  else
    if ! bridge_enabled; then
      bridge_lock_release
      exit 0
    fi

    if ! bridge_reconcile_1mcp "$TUNNEL_URL" >>"$LOG" 2>&1; then
      echo "$(date -Is) 1MCP reconciliation failed" >> "$LOG"
    fi

    if ! bridge_start_cloudflared >>"$LOG" 2>&1; then
      echo "$(date -Is) cloudflared reconciliation failed" >> "$LOG"
    fi

    bridge_lock_release
  fi

  if [ "${BRIDGE_WATCHDOG_ONCE:-0}" = "1" ]; then
    break
  fi
  sleep "${BRIDGE_WATCHDOG_INTERVAL:-20}"
done
