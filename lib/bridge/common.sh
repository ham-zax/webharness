#!/usr/bin/env bash
# Shared lifecycle primitives for the Cloudflare OAuth Bridge.
# This file is sourced by start/stop/status/watchdog scripts.

BRIDGE_ROOT="${BRIDGE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BRIDGE_PROC_ROOT="${BRIDGE_PROC_ROOT:-/proc}"

BRIDGE_USER_HOME="${HOME:-}"
if [ -z "$BRIDGE_USER_HOME" ] && [ -z "${XDG_STATE_HOME:-}" ] && command -v getent >/dev/null 2>&1; then
  BRIDGE_USER_HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
fi

if [ -n "${XDG_STATE_HOME:-}" ]; then
  BRIDGE_STATE_BASE="$XDG_STATE_HOME"
elif [ -n "$BRIDGE_USER_HOME" ]; then
  BRIDGE_STATE_BASE="$BRIDGE_USER_HOME/.local/state"
else
  BRIDGE_STATE_BASE="/tmp"
fi
BRIDGE_STATE_DIR="${BRIDGE_STATE_DIR:-$BRIDGE_STATE_BASE/mcp-dev-bridge}"
BRIDGE_ENV_FILE="${BRIDGE_ENV_FILE:-$BRIDGE_STATE_DIR/bridge.env}"

if [ -r "$BRIDGE_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$BRIDGE_ENV_FILE"
  set +a
fi

BRIDGE_EXTERNAL_CONFIG_DIR="$BRIDGE_STATE_DIR/1mcp"
BRIDGE_LEGACY_CONFIG_DIR="$BRIDGE_ROOT/config"
BRIDGE_LEGACY_RUN_DIR="$BRIDGE_ROOT/run"

if [ -z "${BRIDGE_CONFIG_DIR:-}" ]; then
  if [ -f "$BRIDGE_EXTERNAL_CONFIG_DIR/mcp.json" ]; then
    BRIDGE_CONFIG_DIR="$BRIDGE_EXTERNAL_CONFIG_DIR"
  elif [ -f "$BRIDGE_LEGACY_CONFIG_DIR/mcp.json" ]; then
    BRIDGE_CONFIG_DIR="$BRIDGE_LEGACY_CONFIG_DIR"
  else
    BRIDGE_CONFIG_DIR="$BRIDGE_EXTERNAL_CONFIG_DIR"
  fi
fi

BRIDGE_RUNTIME_BASE="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [ -z "${BRIDGE_RUN_DIR:-}" ]; then
  if [ -f "$BRIDGE_ENV_FILE" ] || [ -f "$BRIDGE_EXTERNAL_CONFIG_DIR/mcp.json" ]; then
    BRIDGE_RUN_DIR="$BRIDGE_RUNTIME_BASE/mcp-dev-bridge"
  elif [ -d "$BRIDGE_LEGACY_RUN_DIR" ] || [ "$BRIDGE_CONFIG_DIR" = "$BRIDGE_LEGACY_CONFIG_DIR" ]; then
    BRIDGE_RUN_DIR="$BRIDGE_LEGACY_RUN_DIR"
  else
    BRIDGE_RUN_DIR="$BRIDGE_RUNTIME_BASE/mcp-dev-bridge"
  fi
fi

BRIDGE_WORKSPACE_ROOT="${BRIDGE_WORKSPACE_ROOT:-${MCP_WORKSPACE_ROOT:-}}"
TUNNEL_URL="${TUNNEL_URL:-${MCP_PUBLIC_URL:-}}"
TUNNEL_NAME="${TUNNEL_NAME:-${MCP_TUNNEL_NAME:-}}"

BRIDGE_ENABLED_FILE="$BRIDGE_RUN_DIR/cloudflare-oauth.enabled"
BRIDGE_LOCK_FILE="$BRIDGE_RUN_DIR/lifecycle.lock"
BRIDGE_ONE_MCP_PID_FILE="$BRIDGE_RUN_DIR/one-mcp.pid"
BRIDGE_ONE_MCP_LOG_FILE="${BRIDGE_ONE_MCP_LOG_FILE:-$BRIDGE_STATE_DIR/logs/one-mcp.log}"
BRIDGE_CLOUDFLARED_PID_FILE="$BRIDGE_RUN_DIR/cloudflared.pid"
BRIDGE_WATCHDOG_PID_FILE="$BRIDGE_RUN_DIR/watchdog.pid"
BRIDGE_TUNNEL_URL_FILE="$BRIDGE_RUN_DIR/tunnel.url"
BRIDGE_LOCK_HELD=0

mkdir -p "$BRIDGE_RUN_DIR"

bridge_enabled() {
  [ -f "$BRIDGE_ENABLED_FILE" ]
}

bridge_enable() {
  printf 'cloudflare-oauth\n' > "$BRIDGE_ENABLED_FILE"
}

bridge_disable() {
  rm -f "$BRIDGE_ENABLED_FILE"
}

bridge_lock_acquire() {
  local timeout="${1:-30}"
  command -v flock >/dev/null 2>&1 || {
    echo "flock is required for lifecycle serialization" >&2
    return 1
  }
  exec 9>"$BRIDGE_LOCK_FILE"
  if ! flock -w "$timeout" 9; then
    exec 9>&-
    return 1
  fi
  BRIDGE_LOCK_HELD=1
}

bridge_lock_release() {
  if [ "${BRIDGE_LOCK_HELD:-0}" = "1" ]; then
    flock -u 9 2>/dev/null || true
    exec 9>&-
    BRIDGE_LOCK_HELD=0
  fi
}

bridge_pid_cmdline() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 1
  [ -r "$BRIDGE_PROC_ROOT/$pid/cmdline" ] || return 1
  cat "$BRIDGE_PROC_ROOT/$pid/cmdline" 2>/dev/null | tr '\0' ' '
}

bridge_pid_alive() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  if [ "$BRIDGE_PROC_ROOT" = "/proc" ]; then
    kill -0 "$pid" 2>/dev/null
  else
    [ -r "$BRIDGE_PROC_ROOT/$pid/cmdline" ]
  fi
}

bridge_pid_matches() {
  local pid="${1:-}"
  shift || true
  bridge_pid_alive "$pid" || return 1
  local cmdline needle
  cmdline="$(bridge_pid_cmdline "$pid")" || return 1
  for needle in "$@"; do
    [[ "$cmdline" == *"$needle"* ]] || return 1
  done
}

bridge_stop_pid() {
  local pid="${1:-}"
  bridge_pid_alive "$pid" || return 0

  # Every bridge daemon is launched with setsid, so its PID is also its
  # process-group ID. Kill that validated group to avoid orphaning 1MCP child
  # providers. For non-session-leader PIDs (e.g. tests), fall back to PID-only.
  local pgid
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "$pgid" = "$pid" ]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
  else
    kill "$pid" 2>/dev/null || true
  fi

  local i
  for i in $(seq 1 "${BRIDGE_STOP_ATTEMPTS:-30}"); do
    wait "$pid" 2>/dev/null || true
    if ! bridge_pid_alive "$pid"; then
      return 0
    fi
    sleep "${BRIDGE_STOP_INTERVAL:-0.1}"
  done

  if [ "$pgid" = "$pid" ]; then
    kill -KILL -- "-$pid" 2>/dev/null || true
  else
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

bridge_stop_pidfile() {
  local pidfile="${1:-}"
  shift || true
  [ -f "$pidfile" ] || return 0
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if bridge_pid_matches "$pid" "$@"; then
    bridge_stop_pid "$pid"
  fi
  rm -f "$pidfile"
}

bridge_pidfile_alive() {
  local pidfile="${1:-}"
  shift || true
  [ -f "$pidfile" ] || return 1
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  bridge_pid_matches "$pid" "$@"
}

bridge_find_1mcp_pids() {
  local proc pid cmdline
  for proc in "$BRIDGE_PROC_ROOT"/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    pid="${proc##*/}"
    cmdline="$(cat "$proc/cmdline" 2>/dev/null | tr '\0' ' ' || true)"
    [[ "$cmdline" == *"@1mcp/agent/build/index.js"* ]] || continue
    [[ "$cmdline" == *" serve "* ]] || continue
    [[ "$cmdline" == *"--config-dir $BRIDGE_CONFIG_DIR"* ]] || continue
    printf '%s\n' "$pid"
  done
}

bridge_1mcp_count() {
  local count=0 pid
  while IFS= read -r pid; do
    [ -n "$pid" ] && count=$((count + 1))
  done < <(bridge_find_1mcp_pids)
  printf '%s\n' "$count"
}

bridge_1mcp_matches() {
  local pid="$1" external="$2" cmdline
  cmdline="$(bridge_pid_cmdline "$pid")" || return 1
  [[ "$cmdline" == *"--enable-auth"* ]] || return 1
  [[ "$cmdline" == *"--external-url $external"* ]] || return 1
}

bridge_server_pid() {
  local state="$BRIDGE_CONFIG_DIR/server.pid"
  [ -r "$state" ] || return 1
  sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$state" | head -n1
}

bridge_listener_pid() {
  command -v ss >/dev/null 2>&1 || return 1
  local output
  output="$(ss -ltnp '( sport = :3050 )' 2>/dev/null || true)"
  sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' <<<"$output" | head -n1
}

bridge_local_health() {
  curl -sf -m 3 http://127.0.0.1:3050/health/ready -o /dev/null
}

bridge_wait_url() {
  local url="$1" attempts="${2:-30}" interval="${3:-1}" timeout="${4:-3}"
  local i
  for i in $(seq 1 "$attempts"); do
    if curl -sf -m "$timeout" "$url" -o /dev/null; then
      return 0
    fi
    sleep "$interval"
  done
  return 1
}

bridge_one_mcp_entry() {
  if [ -n "${BRIDGE_ONE_MCP_ENTRY:-}" ]; then
    printf '%s\n' "$BRIDGE_ONE_MCP_ENTRY"
  else
    printf '%s/@1mcp/agent/build/index.js\n' "$(npm root -g)"
  fi
}

bridge_stop_1mcp() {
  bridge_stop_pidfile "$BRIDGE_ONE_MCP_PID_FILE" '@1mcp/agent/build/index.js' "--config-dir $BRIDGE_CONFIG_DIR"
  local pid
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    bridge_stop_pid "$pid"
  done < <(bridge_find_1mcp_pids)
  rm -f "$BRIDGE_ONE_MCP_PID_FILE" "$BRIDGE_CONFIG_DIR/server.pid"
}

bridge_prune_stale_1mcp_logs() {
  local max_files log_dir log_name stem path name suffix
  [ -r "$BRIDGE_CONFIG_DIR/config.toml" ] || return 0
  max_files="$(sed -n 's/^maxFiles[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$BRIDGE_CONFIG_DIR/config.toml" | head -n1)"
  [[ "$max_files" =~ ^[1-9][0-9]*$ ]] || return 0

  log_dir="$(dirname "$BRIDGE_ONE_MCP_LOG_FILE")"
  log_name="$(basename "$BRIDGE_ONE_MCP_LOG_FILE")"
  [[ "$log_name" == *.log ]] || return 0
  [ -d "$log_dir" ] || return 0
  stem="${log_name%.log}"

  while IFS= read -r -d '' path; do
    name="${path##*/}"
    suffix="${name#"$stem"}"
    suffix="${suffix%.log}"
    [[ "$suffix" =~ ^[0-9]+$ ]] || continue
    if [ "$suffix" -ge "$max_files" ]; then
      rm -f -- "$path"
    fi
  done < <(find "$log_dir" -maxdepth 1 -type f -name "${stem}[0-9]*.log" -print0 2>/dev/null)
}

bridge_start_1mcp() {
  local external="$1" entry
  [ -n "$external" ] || { echo "external URL is required" >&2; return 2; }
  entry="$(bridge_one_mcp_entry)"
  [ -f "$entry" ] || { echo "1MCP entry not found: $entry" >&2; return 1; }

  rm -f "$BRIDGE_ONE_MCP_PID_FILE"
  # Remove the legacy unbounded console capture and stale pre-tailable rotations before launch.
  rm -f "$BRIDGE_RUN_DIR/one-mcp.log"
  bridge_prune_stale_1mcp_logs
  (
    cd "${BRIDGE_WORKSPACE_ROOT:-$BRIDGE_ROOT}"
    umask 077
    setsid node "$entry" serve \
      --config-dir "$BRIDGE_CONFIG_DIR" \
      --enable-auth \
      --external-url "$external" \
      9>&- >/dev/null 2>&1 </dev/null &
    printf '%s\n' "$!" > "$BRIDGE_ONE_MCP_PID_FILE"
  )

  if ! bridge_wait_url http://127.0.0.1:3050/health/ready \
    "${BRIDGE_LOCAL_HEALTH_ATTEMPTS:-15}" "${BRIDGE_LOCAL_HEALTH_INTERVAL:-1}" 3; then
    echo "1MCP did not become healthy" >&2
    if [ -r "$BRIDGE_ONE_MCP_LOG_FILE" ]; then
      echo "recent 1MCP log output:" >&2
      tail -n 40 "$BRIDGE_ONE_MCP_LOG_FILE" >&2 || true
    fi
    bridge_stop_1mcp
    return 1
  fi

  local count pid
  count="$(bridge_1mcp_count)"
  if [ "$count" -ne 1 ]; then
    echo "expected exactly one 1MCP process for $BRIDGE_CONFIG_DIR, found $count" >&2
    bridge_stop_1mcp
    return 1
  fi
  pid="$(bridge_find_1mcp_pids | head -n1)"
  if ! bridge_1mcp_matches "$pid" "$external"; then
    echo "1MCP process $pid does not match Cloudflare OAuth configuration" >&2
    bridge_stop_1mcp
    return 1
  fi
  printf '%s\n' "$pid" > "$BRIDGE_ONE_MCP_PID_FILE"
}

bridge_reconcile_1mcp() {
  local external="$1"
  mapfile -t MCP_PIDS < <(bridge_find_1mcp_pids)
  if [ "${#MCP_PIDS[@]}" -eq 1 ] && bridge_local_health && \
     bridge_1mcp_matches "${MCP_PIDS[0]}" "$external"; then
    printf '%s\n' "${MCP_PIDS[0]}" > "$BRIDGE_ONE_MCP_PID_FILE"
    return 0
  fi
  bridge_stop_1mcp
  bridge_start_1mcp "$external"
}

bridge_stop_cloudflared() {
  bridge_stop_pidfile "$BRIDGE_CLOUDFLARED_PID_FILE" 'cloudflared tunnel run'
}

bridge_start_cloudflared() {
  if bridge_pidfile_alive "$BRIDGE_CLOUDFLARED_PID_FILE" 'cloudflared tunnel run'; then
    return 0
  fi
  rm -f "$BRIDGE_CLOUDFLARED_PID_FILE"
  if [ -n "${TUNNEL_NAME:-}" ]; then
    setsid cloudflared tunnel run "$TUNNEL_NAME" 9>&- >>"$BRIDGE_RUN_DIR/tunnel-up.log" 2>&1 </dev/null &
  else
    setsid cloudflared tunnel run 9>&- >>"$BRIDGE_RUN_DIR/tunnel-up.log" 2>&1 </dev/null &
  fi
  printf '%s\n' "$!" > "$BRIDGE_CLOUDFLARED_PID_FILE"
  sleep 0.2
  if ! bridge_pidfile_alive "$BRIDGE_CLOUDFLARED_PID_FILE" 'cloudflared tunnel run'; then
    echo "cloudflared exited during startup" >&2
    rm -f "$BRIDGE_CLOUDFLARED_PID_FILE"
    return 1
  fi
}

bridge_stop_watchdog() {
  bridge_stop_pidfile "$BRIDGE_WATCHDOG_PID_FILE" "$BRIDGE_ROOT/lib/bridge/watchdog.sh"
}

bridge_start_watchdog() {
  if bridge_pidfile_alive "$BRIDGE_WATCHDOG_PID_FILE" "$BRIDGE_ROOT/lib/bridge/watchdog.sh"; then
    return 0
  fi
  rm -f "$BRIDGE_WATCHDOG_PID_FILE"
  TUNNEL_NAME="${TUNNEL_NAME:-}" TUNNEL_URL="${TUNNEL_URL:-}" \
    setsid bash "$BRIDGE_ROOT/lib/bridge/watchdog.sh" 9>&- >>"$BRIDGE_RUN_DIR/watchdog.log" 2>&1 </dev/null &
  printf '%s\n' "$!" > "$BRIDGE_WATCHDOG_PID_FILE"
  sleep 0.2
  if ! bridge_pidfile_alive "$BRIDGE_WATCHDOG_PID_FILE" "$BRIDGE_ROOT/lib/bridge/watchdog.sh"; then
    echo "watchdog exited during startup" >&2
    rm -f "$BRIDGE_WATCHDOG_PID_FILE"
    return 1
  fi
}
