#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
bridge_lock_acquire "${BRIDGE_BACKEND_LOCK_TIMEOUT:-5}" || exit 75
trap bridge_lock_release EXIT
case "${1:-}" in
  start)
    # A stopped bridge must not be resurrected by a request already queued.
    bridge_enabled || exit 75
    bridge_reconcile_1mcp_ready "$TUNNEL_URL"
    ;;
  stop) bridge_stop_1mcp ;;
  *) exit 2 ;;
esac
