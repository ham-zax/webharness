#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
TESTS=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
run_test() {
  local name="$1"
  shift
  TESTS=$((TESTS + 1))
  if "$@"; then pass "$name"; else fail "$name"; fi
}
contains() { grep -Eq "$2" "$1"; }

# ---------- Source-level contracts ----------

test_scripts_are_executable() {
  local script
  for script in setup.sh install-bridge-runtime.sh bootstrap-personal.sh start.sh stop.sh status.sh tunnel-up.sh tunnel-down.sh; do
    [ -x "$ROOT/scripts/$script" ] || return 1
  done
  [ -x "$ROOT/bin/start" ] && [ -x "$ROOT/bin/status" ] && [ -x "$ROOT/bin/stop" ] && \
    [ -x "$ROOT/lib/bridge/watchdog.sh" ] && [ -x "$ROOT/tests/lifecycle.sh" ]
}

test_no_global_process_matching() {
  ! grep -R -nE '\b(pkill|pgrep)\b' "$ROOT/bin" "$ROOT/lib/bridge" "$ROOT/scripts" >/dev/null
}

test_dependencies_are_pinned() {
  contains "$ROOT/scripts/install-bridge-runtime.sh" 'ONE_MCP_VERSION="0\.36\.0"' && \
  contains "$ROOT/providers/pi-dev/package.json" '"@earendil-works/pi-coding-agent"[[:space:]]*:[[:space:]]*"0\.84\.1"' && \
  contains "$ROOT/config/templates/mcp.json" 'mcp-shell-server==1\.1\.8'
}

test_native_1mcp_rotation_capability_is_guarded() {
  local helper="$ROOT/scripts/install-bridge-runtime.sh"
  contains "$helper" 'logger/loggingConfig\.js' &&
  contains "$helper" 'logger/logger\.js' &&
  contains "$helper" 'maxSize' &&
  contains "$helper" 'maxFiles' &&
  contains "$helper" 'tailable: options\.maxFiles > 1' &&
  contains "$helper" 'restart-stable native size/file-count rotation'
}

test_stale_incrementing_1mcp_logs_are_pruned_before_restart() {
  local sandbox="$TMP/log-prune"
  local state="$sandbox/state"
  mkdir -p "$state/1mcp" "$state/logs" "$sandbox/run"
  cat > "$state/1mcp/config.toml" <<EOF
[logging]
file = "$state/logs/one-mcp.log"
maxSize = 10485760
maxFiles = 3
EOF
  : > "$state/logs/one-mcp.log"
  : > "$state/logs/one-mcp1.log"
  : > "$state/logs/one-mcp2.log"
  : > "$state/logs/one-mcp3.log"
  : > "$state/logs/one-mcp9.log"
  BRIDGE_STATE_DIR="$state" BRIDGE_CONFIG_DIR="$state/1mcp" BRIDGE_RUN_DIR="$sandbox/run" \
    BRIDGE_ONE_MCP_LOG_FILE="$state/logs/one-mcp.log" bash -c '
      source "$1/lib/bridge/common.sh"
      bridge_prune_stale_1mcp_logs
    ' _ "$ROOT" || return 1
  [ -f "$state/logs/one-mcp.log" ] &&
    [ -f "$state/logs/one-mcp1.log" ] &&
    [ -f "$state/logs/one-mcp2.log" ] &&
    [ ! -e "$state/logs/one-mcp3.log" ] &&
    [ ! -e "$state/logs/one-mcp9.log" ]
}

test_1mcp_https_callback_csp_compatibility_is_guarded() {
  local helper="$ROOT/scripts/install-bridge-runtime.sh"
  contains "$helper" 'auth/sdkOAuthServerProvider\.js' &&
  contains "$helper" "requested\.protocol === 'https:'" &&
  contains "$helper" 'registeredRedirectUris\.includes\(requestedRedirectUri\)' &&
  contains "$helper" 'refusing an unsafe patch'
}

test_shared_bridge_runtime_installer_is_used() {
  local helper="$ROOT/scripts/install-bridge-runtime.sh"
  [ -x "$helper" ] && \
  contains "$ROOT/scripts/setup.sh" 'install-bridge-runtime\.sh' && \
  contains "$ROOT/scripts/bootstrap-personal.sh" 'install-bridge-runtime\.sh' && \
  contains "$helper" 'npm install -g "@1mcp/agent@\$ONE_MCP_VERSION"' && \
  contains "$helper" 'for cmd in node npm npx uv uvx cloudflared curl flock'
}

test_cloudflare_oauth_is_canonical() {
  ! grep -R -nE 'Route A|Route B|route-a|route-b|tunnel-client' \
    "$ROOT/bin" "$ROOT/lib/bridge" "$ROOT/scripts" "$ROOT/README.md" "$ROOT/docs/architecture.md" "$ROOT/docs/operations.md" >/dev/null && \
  [ ! -e "$ROOT/profiles/hamza-local-dev.yaml" ]
}

test_start_is_canonical_entrypoint() {
  contains "$ROOT/bin/start" 'WebHarness' && \
  ! contains "$ROOT/bin/start" 'mcp\.hamza\.my\.id' && \
  contains "$ROOT/bin/start" 'bridge_reconcile_1mcp' && \
  contains "$ROOT/bin/start" 'bridge_start_cloudflared' && \
  contains "$ROOT/bin/start" 'bridge_start_watchdog'
}

test_no_internal_1mcp_background_supervisor() {
  ! grep -R -nE 'serve --background' "$ROOT/bin" "$ROOT/lib/bridge" "$ROOT/scripts" >/dev/null
}

test_1mcp_runtime_does_not_append_an_unbounded_console_log() {
  local common="$ROOT/lib/bridge/common.sh"
  ! grep -Eq '>>[^[:space:]]*one-mcp\.log|one-mcp\.log[^[:space:]]*2>&1' "$common" &&
  grep -Fq 'rm -f "$BRIDGE_RUN_DIR/one-mcp.log"' "$common"
}

test_start_orders_origin_before_watchdog() {
  local origin_line watchdog_line
  origin_line="$(grep -n 'bridge_reconcile_1mcp' "$ROOT/bin/start" | head -n1 | cut -d: -f1)"
  watchdog_line="$(grep -n 'bridge_start_watchdog' "$ROOT/bin/start" | head -n1 | cut -d: -f1)"
  [ -n "$origin_line" ] && [ -n "$watchdog_line" ] && [ "$origin_line" -lt "$watchdog_line" ]
}

test_watchdog_starts_only_after_public_health() {
  local health_line watchdog_line
  health_line="$(grep -n 'bridge_wait_url .*health/ready' "$ROOT/bin/start" | head -n1 | cut -d: -f1)"
  watchdog_line="$(grep -n 'bridge_start_watchdog' "$ROOT/bin/start" | head -n1 | cut -d: -f1)"
  [ -n "$health_line" ] && [ -n "$watchdog_line" ] && [ "$health_line" -lt "$watchdog_line" ]
}

test_compatibility_wrappers_are_thin() {
  contains "$ROOT/scripts/start.sh" 'exec .*bin/start' && \
  contains "$ROOT/scripts/status.sh" 'exec .*bin/status' && \
  contains "$ROOT/scripts/stop.sh" 'exec .*bin/stop' && \
  contains "$ROOT/scripts/tunnel-up.sh" 'exec .*scripts/start\.sh' && \
  contains "$ROOT/scripts/tunnel-down.sh" 'exec .*scripts/stop\.sh'
}

test_status_has_core_diagnostics() {
  contains "$ROOT/bin/status" 'WebHarness' && \
  contains "$ROOT/bin/status" 'duplicate 1MCP' && \
  contains "$ROOT/bin/status" 'PID/listener mismatch' && \
  contains "$ROOT/bin/status" 'retained diagnostics' && \
  contains "$ROOT/bin/status" 'Terminal broker' && \
  contains "$ROOT/bin/status" 'NRestarts'
}

test_systemd_user_autostart_contract() {
  local unit="$ROOT/systemd/mcp-dev-bridge.service.in"
  [ -f "$unit" ] && [ -x "$ROOT/scripts/install-systemd-user.sh" ] && \
  contains "$unit" 'ExecStart=@REPO_ROOT@/bin/start' && \
  contains "$unit" 'ExecStop=@REPO_ROOT@/bin/stop' && \
  contains "$unit" 'EnvironmentFile=-@STATE_DIR@/bridge\.env' && \
  contains "$unit" 'WantedBy=default\.target' && \
  contains "$ROOT/scripts/install-systemd-user.sh" 'UNIT_NAME="mcp-dev-bridge\.service"' && \
  contains "$ROOT/scripts/install-systemd-user.sh" 'systemctl --user enable "\$UNIT_NAME"'
}

test_systemd_installer_handles_missing_home() {
  contains "$ROOT/scripts/install-systemd-user.sh" 'USER_HOME=.*HOME:-' && \
  contains "$ROOT/scripts/install-systemd-user.sh" 'getent passwd'
}

test_terminal_systemd_owner_env_handoff() {
  local sandbox="$TMP/terminal-owner-env"
  local target="$sandbox/systemd"
  local owner_env="$sandbox/owner.env"
  mkdir -p "$sandbox/home" "$target"
  : > "$owner_env"
  HOME="$sandbox/home" TERMINAL_SYSTEMD_TARGET_DIR="$target" TERMINAL_OWNER_ENV_FILE="$owner_env" \
    TERMINAL_SYSTEMD_DRY_RUN=1 "$ROOT/scripts/install-terminal-broker-user.sh" >/dev/null || return 1
  grep -Fq "EnvironmentFile=-$owner_env" "$target/wsl-agent-tmux.service" && \
    grep -Fq "EnvironmentFile=-$owner_env" "$target/wsl-agent-terminal-broker.service"
}

test_personal_bootstrap_startup_consent_contract() {
  local script="$ROOT/scripts/bootstrap-personal.sh"
  [ -x "$script" ] && \
  contains "$script" '\-\-enable-startup' && \
  contains "$script" 'startup services were not installed' && \
  contains "$script" 'loginctl enable-linger' && \
  contains "$script" 'systemctl --user enable --now' && \
  ! contains "$script" 'wsl\.exe|schtasks|Task Scheduler'
}

test_lifecycle_lock_is_used_everywhere() {
  contains "$ROOT/lib/bridge/common.sh" 'bridge_lock_acquire' && \
  contains "$ROOT/bin/start" 'bridge_lock_acquire' && \
  contains "$ROOT/bin/stop" 'bridge_lock_acquire' && \
  contains "$ROOT/lib/bridge/watchdog.sh" 'bridge_lock_acquire'
}

run_test 'lifecycle entrypoint scripts remain executable' test_scripts_are_executable
run_test 'no global pkill/pgrep lifecycle management' test_no_global_process_matching
run_test 'privileged MCP dependencies are pinned' test_dependencies_are_pinned
run_test 'pinned 1MCP native rotation capability is guarded' test_native_1mcp_rotation_capability_is_guarded
run_test 'stale incrementing 1MCP logs are pruned before restart' test_stale_incrementing_1mcp_logs_are_pruned_before_restart
run_test 'pinned 1MCP permits its exact registered HTTPS OAuth callback' test_1mcp_https_callback_csp_compatibility_is_guarded
run_test 'public and personal setup share the pinned bridge runtime installer' test_shared_bridge_runtime_installer_is_used
run_test 'Cloudflare OAuth Bridge is the only canonical stack' test_cloudflare_oauth_is_canonical
run_test 'start.sh is the canonical Cloudflare OAuth entrypoint' test_start_is_canonical_entrypoint
run_test 'direct 1MCP startup is used without serve --background' test_no_internal_1mcp_background_supervisor
run_test '1MCP runtime avoids an unbounded console append log' test_1mcp_runtime_does_not_append_an_unbounded_console_log
run_test '1MCP origin is reconciled before watchdog startup' test_start_orders_origin_before_watchdog
run_test 'watchdog starts only after public health succeeds' test_watchdog_starts_only_after_public_health
run_test 'legacy tunnel scripts are thin start/stop aliases' test_compatibility_wrappers_are_thin
run_test 'status keeps duplicate and PID/listener diagnostics' test_status_has_core_diagnostics
run_test 'systemd user unit autostarts the canonical bridge' test_systemd_user_autostart_contract
run_test 'systemd installer derives user home when HOME is missing' test_systemd_installer_handles_missing_home
run_test 'Terminal systemd units consume the rendered owner environment' test_terminal_systemd_owner_env_handoff
run_test 'personal bootstrap keeps startup behind explicit consent' test_personal_bootstrap_startup_consent_contract
run_test 'manual lifecycle and watchdog share an exclusive lock' test_lifecycle_lock_is_used_everywhere

test_status_reports_bounded_diagnostic_storage() {
  local sandbox="$TMP/status-storage"
  local state="$sandbox/state"
  local run="$sandbox/run"
  local fakebin="$sandbox/fakebin"
  local fakeproc="$sandbox/proc"
  mkdir -p "$state/1mcp" "$state/logs" "$state/dev" "$run" "$fakebin" "$fakeproc"
  cat > "$state/bridge.env" <<EOF
MCP_BRIDGE_PROFILE='personal'
MCP_WORKSPACE_ROOT='$sandbox/workspace'
MCP_PUBLIC_URL=''
MCP_TUNNEL_NAME=''
MCP_BRIDGE_ROOT='$ROOT'
BRIDGE_STATE_DIR='$state'
EOF
  cat > "$state/1mcp/mcp.json" <<'JSON'
{"mcpServers":{"dev":{"env":{"MCP_DEV_SPOOL_MAX_TOTAL_BYTES":"4096"}}}}
JSON
  cat > "$state/1mcp/config.toml" <<EOF
[logging]
file = "$state/logs/one-mcp.log"
level = "info"
maxSize = 1024
maxFiles = 3
EOF
  printf '%01024d' 0 > "$state/logs/one-mcp.log"
  printf '%01024d' 0 > "$state/logs/one-mcp1.log"
  printf '%02048d' 0 > "$state/dev/bash-old.log"
  printf '%01024d' 0 > "$state/dev/bash-new.log"
  printf '%00512d' 0 > "$state/dev/bash-live.log.active"
  cat > "$fakebin/curl" <<'SH'
#!/usr/bin/env bash
exit 1
SH
  cat > "$fakebin/ss" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$fakebin/curl" "$fakebin/ss"

  local output
  output="$(BRIDGE_STATE_DIR="$state" BRIDGE_RUN_DIR="$run" BRIDGE_CONFIG_DIR="$state/1mcp" \
    BRIDGE_PROC_ROOT="$fakeproc" PATH="$fakebin:$PATH" bash "$ROOT/bin/status" 2>&1 || true)"
  grep -Fq '== retained diagnostics ==' <<<"$output" &&
  grep -Fq '1MCP rotated logs: files=2 bytes=2048 policy_bytes=3072' <<<"$output" &&
  grep -Fq 'Bash finalized spools: files=2 bytes=3072 budget_bytes=4096' <<<"$output" &&
  grep -Fq 'Bash active spools: files=1 bytes=512' <<<"$output"
}

run_test 'status reports bounded log and Bash spool storage' test_status_reports_bounded_diagnostic_storage
test_status_matches_watchdog_against_rendered_live_source_root() {
  local sandbox="$TMP/status-source-root"
  local state="$sandbox/state"
  local run="$sandbox/run"
  local fakebin="$sandbox/fakebin"
  local fakeproc="$sandbox/proc"
  local live_root="$sandbox/live-root"
  mkdir -p "$state/1mcp" "$state/logs" "$state/dev" "$run" "$fakebin" "$fakeproc/101" "$live_root/lib/bridge"
  cat > "$state/bridge.env" <<EOF
MCP_BRIDGE_PROFILE='trusted-dev'
MCP_WORKSPACE_ROOT='$sandbox/workspace'
MCP_PUBLIC_URL='https://example.test'
MCP_TUNNEL_NAME=''
MCP_BRIDGE_ROOT='$live_root'
BRIDGE_STATE_DIR='$state'
EOF
  printf '{}\n' > "$state/1mcp/mcp.json"
  cat > "$state/1mcp/config.toml" <<EOF
[logging]
file = "$state/logs/one-mcp.log"
maxSize = 1048576
maxFiles = 2
EOF
  : > "$run/cloudflare-oauth.enabled"
  printf '101\n' > "$run/watchdog.pid"
  printf '%s\0' bash "$live_root/lib/bridge/watchdog.sh" > "$fakeproc/101/cmdline"
  cat > "$fakebin/curl" <<'SH'
#!/usr/bin/env bash
exit 1
SH
  cat > "$fakebin/ss" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$fakebin/curl" "$fakebin/ss"

  local output
  output="$(BRIDGE_STATE_DIR="$state" BRIDGE_RUN_DIR="$run" BRIDGE_CONFIG_DIR="$state/1mcp" \
    BRIDGE_PROC_ROOT="$fakeproc" PATH="$fakebin:$PATH" bash "$ROOT/bin/status" 2>&1 || true)"
  grep -Fq 'watchdog:    running' <<<"$output" &&
  grep -Fq "rendered source root: $live_root" <<<"$output"
}

run_test 'status matches watchdog ownership against the rendered live source root' test_status_matches_watchdog_against_rendered_live_source_root

# ---------- Runtime/state selection ----------

test_generated_deployment_uses_external_state() {
  local sandbox="$TMP/external-state"
  local fake_root="$sandbox/repo"
  local state="$sandbox/state/mcp-dev-bridge"
  local runtime="$sandbox/runtime"
  mkdir -p "$fake_root" "$state/1mcp" "$runtime"
  printf '{}\n' > "$state/1mcp/mcp.json"
  cat > "$state/bridge.env" <<EOF
MCP_BRIDGE_PROFILE='trusted-dev'
MCP_WORKSPACE_ROOT='/tmp/workspace'
MCP_PUBLIC_URL='https://example.test'
MCP_TUNNEL_NAME=''
MCP_BRIDGE_ROOT='$fake_root'
BRIDGE_STATE_DIR='$state'
EOF
  env -u BRIDGE_RUN_DIR -u BRIDGE_CONFIG_DIR \
    BRIDGE_ROOT="$fake_root" HOME="$sandbox/home" XDG_STATE_HOME="$sandbox/state" XDG_RUNTIME_DIR="$runtime" \
    bash -c '
      source "$1/lib/bridge/common.sh"
      [ "$BRIDGE_STATE_DIR" = "$3" ] &&
      [ "$BRIDGE_CONFIG_DIR" = "$3/1mcp" ] &&
      [ "$BRIDGE_RUN_DIR" = "$4/mcp-dev-bridge" ] &&
      [ "$TUNNEL_URL" = "https://example.test" ] &&
      [ "$BRIDGE_WORKSPACE_ROOT" = "/tmp/workspace" ]
    ' _ "$ROOT" "$fake_root" "$state" "$runtime"
}


test_common_derives_user_home_when_home_missing() {
  local sandbox="$TMP/missing-home-state"
  local fakebin="$sandbox/fakebin"
  local fake_root="$sandbox/repo"
  local fake_home="$sandbox/home"
  local state="$fake_home/.local/state/mcp-dev-bridge"
  local runtime="$sandbox/runtime"
  mkdir -p "$fakebin" "$fake_root" "$state/1mcp" "$runtime"
  printf '{}\n' > "$state/1mcp/mcp.json"
  cat > "$state/bridge.env" <<EOF
MCP_BRIDGE_PROFILE='trusted-dev'
MCP_WORKSPACE_ROOT='/tmp/workspace'
MCP_PUBLIC_URL='https://example.test'
MCP_TUNNEL_NAME=''
MCP_BRIDGE_ROOT='$fake_root'
BRIDGE_STATE_DIR='$state'
EOF
  cat > "$fakebin/getent" <<'EOF'
#!/usr/bin/env bash
[ "$1" = passwd ] || exit 1
printf 'fixture:x:%s:%s::%s:/bin/bash\n' "$(id -u)" "$(id -g)" "$FAKE_HOME"
EOF
  chmod +x "$fakebin/getent"

  env -u HOME -u XDG_STATE_HOME -u BRIDGE_STATE_DIR -u BRIDGE_CONFIG_DIR -u BRIDGE_RUN_DIR \
    PATH="$fakebin:$PATH" FAKE_HOME="$fake_home" BRIDGE_ROOT="$fake_root" XDG_RUNTIME_DIR="$runtime" \
    bash -c '
      source "$1/lib/bridge/common.sh"
      [ "$BRIDGE_STATE_DIR" = "$2" ] &&
      [ "$BRIDGE_CONFIG_DIR" = "$2/1mcp" ] &&
      [ "$BRIDGE_RUN_DIR" = "$3/mcp-dev-bridge" ] &&
      [ "$TUNNEL_URL" = "https://example.test" ]
    ' _ "$ROOT" "$state" "$runtime"
}

test_legacy_deployment_keeps_repo_state() {
  local sandbox="$TMP/legacy-state"
  local fake_root="$sandbox/repo"
  mkdir -p "$fake_root/config" "$fake_root/run"
  printf '{}\n' > "$fake_root/config/mcp.json"
  : > "$fake_root/run/cloudflare-oauth.enabled"
  env -u BRIDGE_RUN_DIR -u BRIDGE_CONFIG_DIR \
    BRIDGE_ROOT="$fake_root" HOME="$sandbox/home" XDG_STATE_HOME="$sandbox/state" XDG_RUNTIME_DIR="$sandbox/runtime" \
    bash -c '
      source "$1/lib/bridge/common.sh"
      [ "$BRIDGE_CONFIG_DIR" = "$2/config" ] && [ "$BRIDGE_RUN_DIR" = "$2/run" ]
    ' _ "$ROOT" "$fake_root"
}

test_explicit_state_overrides_win() {
  local sandbox="$TMP/override-state"
  mkdir -p "$sandbox/run" "$sandbox/config"
  env BRIDGE_ROOT="$sandbox/root" BRIDGE_RUN_DIR="$sandbox/run" BRIDGE_CONFIG_DIR="$sandbox/config" \
    bash -c '
      source "$1/lib/bridge/common.sh"
      [ "$BRIDGE_RUN_DIR" = "$2" ] && [ "$BRIDGE_CONFIG_DIR" = "$3" ]
    ' _ "$ROOT" "$sandbox/run" "$sandbox/config"
}

run_test 'generated deployment uses external XDG state' test_generated_deployment_uses_external_state
run_test 'lifecycle derives the service user home when HOME is missing' test_common_derives_user_home_when_home_missing
run_test 'legacy deployment keeps repository state paths' test_legacy_deployment_keeps_repo_state
run_test 'explicit runtime/config overrides win' test_explicit_state_overrides_win

# ---------- Shared lifecycle behavior ----------

COMMON="$ROOT/lib/bridge/common.sh"

test_stop_pidfile_is_exact() {
  local sandbox="$TMP/pid"
  mkdir -p "$sandbox/run" "$sandbox/config"
  env BRIDGE_RUN_DIR="$sandbox/run" BRIDGE_CONFIG_DIR="$sandbox/config" bash -c '
    source "$1/lib/bridge/common.sh"
    sleep 30 & owned=$!
    sleep 30 & unrelated=$!
    printf "%s\n" "$owned" > "$BRIDGE_RUN_DIR/owned.pid"
    bridge_stop_pidfile "$BRIDGE_RUN_DIR/owned.pid" "sleep 30"
    rc=0
    kill -0 "$owned" 2>/dev/null && rc=1
    kill -0 "$unrelated" 2>/dev/null || rc=1
    [ ! -e "$BRIDGE_RUN_DIR/owned.pid" ] || rc=1
    kill "$unrelated" 2>/dev/null || true
    wait "$unrelated" 2>/dev/null || true
    exit "$rc"
  ' _ "$ROOT"
}

test_stop_pidfile_stops_owned_process_group() {
  local sandbox="$TMP/process-group"
  mkdir -p "$sandbox/run" "$sandbox/config"
  setsid bash -c 'sleep 30 & echo $! > "$1"; wait' _ "$sandbox/child.pid" &
  local leader=$!
  printf '%s\n' "$leader" > "$sandbox/run/group.pid"
  local i
  for i in $(seq 1 20); do [ -s "$sandbox/child.pid" ] && break; sleep 0.05; done
  [ -s "$sandbox/child.pid" ] || { kill -KILL "$leader" 2>/dev/null || true; return 1; }
  local child
  child="$(cat "$sandbox/child.pid")"

  env BRIDGE_RUN_DIR="$sandbox/run" BRIDGE_CONFIG_DIR="$sandbox/config" bash -c '
    source "$1/lib/bridge/common.sh"
    bridge_stop_pidfile "$BRIDGE_RUN_DIR/group.pid" "bash -c sleep 30"
  ' _ "$ROOT" || { kill -KILL "$leader" "$child" 2>/dev/null || true; return 1; }

  local rc=0
  kill -0 "$leader" 2>/dev/null && rc=1
  kill -0 "$child" 2>/dev/null && rc=1
  kill -KILL "$leader" "$child" 2>/dev/null || true
  wait "$leader" 2>/dev/null || true
  return "$rc"
}

test_scoped_1mcp_discovery_and_oauth_match() {
  local sandbox="$TMP/proc"
  local fake_proc="$sandbox/proc"
  local config="$sandbox/config"
  mkdir -p "$fake_proc/101" "$fake_proc/202" "$config"
  printf '%s\0' node /x/@1mcp/agent/build/index.js serve --config-dir "$config" --enable-auth --external-url https://test.example > "$fake_proc/101/cmdline"
  printf '%s\0' node /x/@1mcp/agent/build/index.js serve --config-dir /other/config --enable-auth --external-url https://other.example > "$fake_proc/202/cmdline"
  env BRIDGE_PROC_ROOT="$fake_proc" BRIDGE_CONFIG_DIR="$config" BRIDGE_RUN_DIR="$sandbox/run" bash -c '
    source "$1/lib/bridge/common.sh"
    found="$(bridge_find_1mcp_pids | tr "\n" " " | sed "s/[[:space:]]*$//")"
    [ "$found" = 101 ] && bridge_1mcp_matches 101 https://test.example
  ' _ "$ROOT"
}

test_lifecycle_lock_is_exclusive() {
  command -v flock >/dev/null 2>&1 || return 1
  local sandbox="$TMP/lock"
  mkdir -p "$sandbox/run" "$sandbox/config"
  env BRIDGE_RUN_DIR="$sandbox/run" BRIDGE_CONFIG_DIR="$sandbox/config" bash -c '
    source "$1/lib/bridge/common.sh"
    bridge_lock_acquire 1 || exit 1
    sleep 2
    bridge_lock_release
  ' _ "$ROOT" &
  local holder=$!
  sleep 0.2
  set +e
  env BRIDGE_RUN_DIR="$sandbox/run" BRIDGE_CONFIG_DIR="$sandbox/config" \
    bash -c 'source "$1/lib/bridge/common.sh"; bridge_lock_acquire 0' _ "$ROOT" >/dev/null 2>&1
  local contender_rc=$?
  set -e
  wait "$holder" || return 1
  [ "$contender_rc" -ne 0 ]
}

test_failed_1mcp_start_cleans_runtime() {
  local sandbox="$TMP/failed-1mcp"
  local fakebin="$sandbox/fakebin"
  local entry="$sandbox/global/@1mcp/agent/build/index.js"
  mkdir -p "$fakebin" "$sandbox/run" "$sandbox/config" "$sandbox/workspace" "$(dirname "$entry")"
  : > "$entry"
  cat > "$fakebin/node" <<'EOF'
#!/usr/bin/env bash
while :; do sleep 60; done
EOF
  cat > "$fakebin/curl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
  chmod +x "$fakebin/node" "$fakebin/curl"

  env PATH="$fakebin:$PATH" \
    BRIDGE_RUN_DIR="$sandbox/run" BRIDGE_CONFIG_DIR="$sandbox/config" \
    BRIDGE_WORKSPACE_ROOT="$sandbox/workspace" BRIDGE_ONE_MCP_ENTRY="$entry" \
    BRIDGE_LOCAL_HEALTH_ATTEMPTS=1 BRIDGE_LOCAL_HEALTH_INTERVAL=0 \
    bash -c '
      source "$1/lib/bridge/common.sh"
      set +e
      bridge_start_1mcp https://test.example >/dev/null 2>&1
      rc=$?
      set -e
      [ "$rc" -ne 0 ] && [ "$(bridge_1mcp_count)" -eq 0 ] && \
        [ ! -e "$BRIDGE_ONE_MCP_PID_FILE" ] && [ ! -e "$BRIDGE_CONFIG_DIR/server.pid" ]
    ' _ "$ROOT"
}

run_test 'PID-file stop kills only the exact owned process' test_stop_pidfile_is_exact
run_test 'PID-file stop terminates descendants of an owned session leader' test_stop_pidfile_stops_owned_process_group
run_test '1MCP discovery is config-scoped and OAuth-aware' test_scoped_1mcp_discovery_and_oauth_match
run_test 'lifecycle reconciliation lock is exclusive across processes' test_lifecycle_lock_is_exclusive
run_test 'failed 1MCP startup cleans launched runtime and PID state' test_failed_1mcp_start_cleans_runtime

# ---------- Isolated full-stack fixtures ----------

make_fake_stack() {
  local sandbox="$1" public_mode="${2:-healthy}" cloudflared_mode="${3:-healthy}"
  local fakebin="$sandbox/fakebin"
  mkdir -p "$fakebin" "$sandbox/run" "$sandbox/config" "$sandbox/workspace" "$sandbox/global/@1mcp/agent/build"
  : > "$sandbox/global/@1mcp/agent/build/index.js"
  printf '{}\n' > "$sandbox/config/mcp.json"

  cat > "$fakebin/node" <<'EOF'
#!/usr/bin/env bash
printf '{"pid": %s}\n' "$$" > "$BRIDGE_CONFIG_DIR/server.pid"
touch "$FAKE_LOCAL_MARKER"
trap 'rm -f "$FAKE_LOCAL_MARKER"; exit 0' TERM INT
while :; do sleep 60; done
EOF

  if [ "$cloudflared_mode" = "healthy" ]; then
    cat > "$fakebin/cloudflared" <<'EOF'
#!/usr/bin/env bash
touch "$FAKE_PUBLIC_MARKER"
trap 'rm -f "$FAKE_PUBLIC_MARKER"; exit 0' TERM INT
while :; do sleep 60; done
EOF
  else
    cat > "$fakebin/cloudflared" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
  fi

  if [ "$public_mode" = "healthy" ]; then
    cat > "$fakebin/curl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"127.0.0.1:3050/health/ready"* ]]; then
  [ -f "$FAKE_LOCAL_MARKER" ]; exit $?
fi
if [[ "$*" == *"https://test.example/health/ready"* ]]; then
  [ -f "$FAKE_PUBLIC_MARKER" ]; exit $?
fi
exit 1
EOF
  else
    cat > "$fakebin/curl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"127.0.0.1:3050/health/ready"* ]]; then
  [ -f "$FAKE_LOCAL_MARKER" ]; exit $?
fi
exit 1
EOF
  fi
  chmod +x "$fakebin/node" "$fakebin/cloudflared" "$fakebin/curl"
}

stack_env_file() {
  local sandbox="$1"
  cat <<EOF
PATH=$sandbox/fakebin:$PATH
BRIDGE_RUN_DIR=$sandbox/run
BRIDGE_CONFIG_DIR=$sandbox/config
BRIDGE_WORKSPACE_ROOT=$sandbox/workspace
BRIDGE_ONE_MCP_ENTRY=$sandbox/global/@1mcp/agent/build/index.js
FAKE_LOCAL_MARKER=$sandbox/local-ready
FAKE_PUBLIC_MARKER=$sandbox/public-ready
TUNNEL_URL=https://test.example
BRIDGE_LOCAL_HEALTH_ATTEMPTS=5
BRIDGE_LOCAL_HEALTH_INTERVAL=0
BRIDGE_PUBLIC_HEALTH_ATTEMPTS=2
BRIDGE_PUBLIC_HEALTH_INTERVAL=0
BRIDGE_WATCHDOG_INTERVAL=999
BRIDGE_STOP_ATTEMPTS=5
BRIDGE_STOP_INTERVAL=0.02
EOF
}

run_stack_env() {
  local sandbox="$1"
  shift
  local -a vars=()
  while IFS= read -r line; do vars+=("$line"); done < <(stack_env_file "$sandbox")
  env "${vars[@]}" "$@"
}

test_full_stack_start_stop() {
  local sandbox="$TMP/full-stack"
  make_fake_stack "$sandbox"
  run_stack_env "$sandbox" "$ROOT/scripts/start.sh" >"$sandbox/start.log" 2>&1 || { cat "$sandbox/start.log" >&2; return 1; }

  [ -f "$sandbox/run/cloudflare-oauth.enabled" ] || return 1
  [ "$(cat "$sandbox/run/tunnel.url")" = 'https://test.example' ] || return 1
  [ -s "$sandbox/run/one-mcp.pid" ] || return 1
  [ -s "$sandbox/run/cloudflared.pid" ] || return 1
  [ -s "$sandbox/run/watchdog.pid" ] || return 1
  local count
  count="$(run_stack_env "$sandbox" bash -c 'source "$1/lib/bridge/common.sh"; bridge_1mcp_count' _ "$ROOT")"
  [ "$count" = 1 ] || return 1

  run_stack_env "$sandbox" "$ROOT/scripts/stop.sh" >"$sandbox/stop.log" 2>&1 || { cat "$sandbox/stop.log" >&2; return 1; }
  [ ! -e "$sandbox/run/cloudflare-oauth.enabled" ] || return 1
  [ ! -e "$sandbox/run/one-mcp.pid" ] || return 1
  [ ! -e "$sandbox/run/cloudflared.pid" ] || return 1
  [ ! -e "$sandbox/run/watchdog.pid" ] || return 1
  count="$(run_stack_env "$sandbox" bash -c 'source "$1/lib/bridge/common.sh"; bridge_1mcp_count' _ "$ROOT")"
  [ "$count" = 0 ]
}

test_failed_cloudflared_start_rolls_back() {
  local sandbox="$TMP/cloudflared-fail"
  make_fake_stack "$sandbox" healthy fail
  set +e
  run_stack_env "$sandbox" "$ROOT/scripts/start.sh" >"$sandbox/start.log" 2>&1
  local rc=$?
  set -e
  [ "$rc" -ne 0 ] || return 1
  local count
  count="$(run_stack_env "$sandbox" bash -c 'source "$1/lib/bridge/common.sh"; bridge_1mcp_count' _ "$ROOT")"
  [ "$count" = 0 ] && [ ! -e "$sandbox/run/cloudflare-oauth.enabled" ] && \
    [ ! -e "$sandbox/run/one-mcp.pid" ] && [ ! -e "$sandbox/run/cloudflared.pid" ] && \
    [ ! -e "$sandbox/run/watchdog.pid" ] && [ ! -e "$sandbox/run/tunnel.url" ]
}

test_failed_public_health_rolls_back() {
  local sandbox="$TMP/public-fail"
  make_fake_stack "$sandbox" fail healthy
  set +e
  run_stack_env "$sandbox" "$ROOT/scripts/start.sh" >"$sandbox/start.log" 2>&1
  local rc=$?
  set -e
  [ "$rc" -ne 0 ] || return 1
  local count
  count="$(run_stack_env "$sandbox" bash -c 'source "$1/lib/bridge/common.sh"; bridge_1mcp_count' _ "$ROOT")"
  [ "$count" = 0 ] && [ ! -e "$sandbox/run/cloudflare-oauth.enabled" ] && \
    [ ! -e "$sandbox/run/one-mcp.pid" ] && [ ! -e "$sandbox/run/cloudflared.pid" ] && \
    [ ! -e "$sandbox/run/watchdog.pid" ] && [ ! -e "$sandbox/run/tunnel.url" ]
}

test_watchdog_recovers_both_daemons() {
  local sandbox="$TMP/recovery"
  make_fake_stack "$sandbox"
  run_stack_env "$sandbox" "$ROOT/scripts/start.sh" >"$sandbox/start.log" 2>&1 || return 1

  # Stop the long-running watchdog so this test controls exactly one cycle.
  run_stack_env "$sandbox" bash -c 'source "$1/lib/bridge/common.sh"; bridge_lock_acquire 2; bridge_stop_watchdog; bridge_lock_release' _ "$ROOT" || return 1

  local old_mcp old_cf
  old_mcp="$(cat "$sandbox/run/one-mcp.pid")"
  old_cf="$(cat "$sandbox/run/cloudflared.pid")"
  kill -9 "$old_mcp" "$old_cf" 2>/dev/null || true
  rm -f "$sandbox/local-ready" "$sandbox/public-ready" "$sandbox/config/server.pid"
  sleep 0.1

  run_stack_env "$sandbox" env BRIDGE_WATCHDOG_ONCE=1 "$ROOT/lib/bridge/watchdog.sh" >"$sandbox/recovery.log" 2>&1 || { cat "$sandbox/recovery.log" >&2; return 1; }

  local new_mcp new_cf count
  new_mcp="$(cat "$sandbox/run/one-mcp.pid")"
  new_cf="$(cat "$sandbox/run/cloudflared.pid")"
  count="$(run_stack_env "$sandbox" bash -c 'source "$1/lib/bridge/common.sh"; bridge_1mcp_count' _ "$ROOT")"
  local ok=0
  if [ "$new_mcp" != "$old_mcp" ] && [ "$new_cf" != "$old_cf" ] && [ "$count" = 1 ] && \
     [ -f "$sandbox/local-ready" ] && [ -f "$sandbox/public-ready" ]; then
    ok=1
  fi
  run_stack_env "$sandbox" "$ROOT/scripts/stop.sh" >/dev/null 2>&1 || true
  [ "$ok" -eq 1 ]
}

run_test 'canonical Cloudflare OAuth stack starts and stops cleanly' test_full_stack_start_stop
run_test 'cloudflared startup failure rolls the stack back to stopped' test_failed_cloudflared_start_rolls_back
run_test 'public health failure rolls the stack back to stopped' test_failed_public_health_rolls_back
run_test 'watchdog recovers both 1MCP and cloudflared exactly once' test_watchdog_recovers_both_daemons

printf '\n%d tests, %d failures\n' "$TESTS" "$FAILURES"
[ "$FAILURES" -eq 0 ]
