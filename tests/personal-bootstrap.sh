#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP="$ROOT/scripts/bootstrap-personal.sh"
ORIGINAL_PATH="$PATH"
FAILURES=0
TESTS=0
TMP="$(mktemp -d)"
BUS_PIDS=()

cleanup() {
  local pid
  for pid in "${BUS_PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
run_test() {
  local name="$1"
  shift
  TESTS=$((TESTS + 1))
  if "$@"; then pass "$name"; else fail "$name"; fi
}

start_bus_socket() {
  local runtime="$1" pid
  mkdir -p "$runtime"
  python3 - "$runtime/bus" <<'PY' &
import signal
import socket
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    path.unlink()
except FileNotFoundError:
    pass
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(str(path))
sock.listen(1)
signal.pause()
PY
  pid=$!
  BUS_PIDS+=("$pid")
  for _ in $(seq 1 100); do
    [ -S "$runtime/bus" ] && return 0
    sleep 0.01
  done
  return 1
}

make_fake_control_commands() {
  local fakebin="$1"
  mkdir -p "$fakebin"
  cat > "$fakebin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${SYSTEMCTL_LOG:?}"
case "$*" in
  "--user daemon-reload") exit 0 ;;
  "--user enable --now "*) exit 0 ;;
  "--user is-enabled "*) printf 'enabled\n'; exit 0 ;;
  "--user is-active "*) printf 'active\n'; exit 0 ;;
  *) printf 'unexpected fake systemctl call: %s\n' "$*" >&2; exit 64 ;;
esac
SH
  cat > "$fakebin/loginctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${LOGINCTL_LOG:?}"
case "${1:-}" in
  show-user)
    cat "${LINGER_STATE_FILE:?}"
    ;;
  enable-linger)
    printf 'yes\n' > "${LINGER_STATE_FILE:?}"
    ;;
  *)
    printf 'unexpected fake loginctl call: %s\n' "$*" >&2
    exit 64
    ;;
esac
SH
  cat > "$fakebin/sudo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${SUDO_LOG:?}"
exec "$@"
SH
  chmod +x "$fakebin/systemctl" "$fakebin/loginctl" "$fakebin/sudo"
}

write_env() {
  local file="$1"
  cat > "$file" <<'ENV'
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
ENV
}

run_bootstrap_fixture() {
  local home="$1" runtime="$2" state="$3" systemd_dir="$4" fakebin="$5" env_file="$6"
  shift 6
  HOME="$home" \
  XDG_RUNTIME_DIR="$runtime" \
  PERSONAL_BOOTSTRAP_SKIP_INSTALL=1 \
  PERSONAL_BOOTSTRAP_SKIP_HEALTH=1 \
  BRIDGE_SYSTEMD_TARGET_DIR="$systemd_dir" \
  TERMINAL_SYSTEMD_TARGET_DIR="$systemd_dir" \
  SYSTEMCTL_LOG="$home/systemctl.log" \
  LOGINCTL_LOG="$home/loginctl.log" \
  LINGER_STATE_FILE="$home/linger.state" \
  SUDO_LOG="$home/sudo.log" \
  PATH="$fakebin:$ORIGINAL_PATH" \
    "$BOOTSTRAP" --env-file "$env_file" --state-dir "$state" "$@"
}

test_prepare_without_startup_consent() {
  local root="$TMP/no-startup" home="$TMP/no-startup/home" runtime="$TMP/no-startup/runtime"
  local state="$TMP/no-startup/state" systemd_dir="$TMP/no-startup/systemd" fakebin="$TMP/no-startup/fakebin"
  local env_file="$TMP/no-startup/deployment.env" output rc
  mkdir -p "$root" "$home" "$runtime"
  make_fake_control_commands "$fakebin"
  write_env "$env_file"
  printf 'no\n' > "$home/linger.state"

  output="$(run_bootstrap_fixture "$home" "$runtime" "$state" "$systemd_dir" "$fakebin" "$env_file" 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] || { printf '%s\n' "$output" >&2; return 1; }

  [ -f "$state/1mcp/mcp.json" ] || return 1
  [ -L "$home/.local/bin/wsl-term" ] || return 1
  [ "$(readlink "$home/.local/bin/wsl-term")" = "$ROOT/bin/wsl-term" ] || return 1
  [ ! -e "$systemd_dir/mcp-dev-bridge.service" ] || return 1
  [ ! -e "$systemd_dir/wsl-agent-tmux.service" ] || return 1
  [ ! -e "$systemd_dir/wsl-agent-terminal-broker.service" ] || return 1
  [ ! -s "$home/systemctl.log" ] || return 1
  [ ! -s "$home/loginctl.log" ] || return 1
  [ "$(cat "$home/linger.state")" = no ] || return 1
  grep -q 'startup services were not installed' <<<"$output"
}

test_startup_consent_installs_and_converges() {
  local home="$TMP/startup/home" runtime="$TMP/startup/runtime" state="$TMP/startup/state"
  local systemd_dir="$TMP/startup/systemd" fakebin="$TMP/startup/fakebin" env_file="$TMP/startup/deployment.env"
  local dropin="$TMP/startup/systemd/mcp-dev-bridge.service.d/personal.conf" hash_before hash_after output rc
  mkdir -p "$home"
  make_fake_control_commands "$fakebin"
  write_env "$env_file"
  printf 'no\n' > "$home/linger.state"
  : > "$home/systemctl.log"
  : > "$home/loginctl.log"
  : > "$home/sudo.log"
  start_bus_socket "$runtime" || return 1

  output="$(run_bootstrap_fixture "$home" "$runtime" "$state" "$systemd_dir" "$fakebin" "$env_file" --enable-startup 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] || { printf '%s\n' "$output" >&2; return 1; }

  for unit in mcp-dev-bridge.service wsl-agent-tmux.service wsl-agent-terminal-broker.service; do
    [ -f "$systemd_dir/$unit" ] || return 1
  done
  [ -f "$dropin" ] || return 1
  diff -u <(cat <<'EOF'
[Unit]
Wants=wsl-agent-terminal-broker.service
After=wsl-agent-terminal-broker.service
EOF
) "$dropin" || return 1
  grep -Fq "Environment=MCP_TERMINAL_DEFAULT_CWD=$home" "$systemd_dir/wsl-agent-terminal-broker.service" || return 1
  grep -Fq "$ROOT/bin/start" "$systemd_dir/mcp-dev-bridge.service" || return 1
  grep -Fxq -- '--user daemon-reload' "$home/systemctl.log" || return 1
  grep -Fxq -- '--user enable --now wsl-agent-tmux.service wsl-agent-terminal-broker.service mcp-dev-bridge.service' "$home/systemctl.log" || return 1
  grep -Fxq -- "enable-linger $(id -un)" "$home/loginctl.log" || return 1
  [ "$(cat "$home/linger.state")" = yes ] || return 1
  [ ! -s "$home/sudo.log" ] || return 1

  [ -L "$home/.local/bin/wsl-term" ] || return 1
  [ "$(readlink "$home/.local/bin/wsl-term")" = "$ROOT/bin/wsl-term" ] || return 1
  local cli_output
  cli_output="$(HOME="$home" PATH="$home/.local/bin:$ORIGINAL_PATH" wsl-term invalid-command 2>&1)"
  rc=$?
  [ "$rc" -ne 0 ] || return 1
  grep -Fq 'usage: wsl-term list' <<<"$cli_output" || { printf '%s\n' "$cli_output" >&2; return 1; }
  ! grep -Fqi 'module not found' <<<"$cli_output" || return 1

  hash_before="$(sha256sum "$dropin" "$systemd_dir/mcp-dev-bridge.service" "$systemd_dir/wsl-agent-tmux.service" "$systemd_dir/wsl-agent-terminal-broker.service")"
  : > "$home/systemctl.log"
  : > "$home/loginctl.log"
  output="$(run_bootstrap_fixture "$home" "$runtime" "$state" "$systemd_dir" "$fakebin" "$env_file" --enable-startup 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] || { printf '%s\n' "$output" >&2; return 1; }
  hash_after="$(sha256sum "$dropin" "$systemd_dir/mcp-dev-bridge.service" "$systemd_dir/wsl-agent-tmux.service" "$systemd_dir/wsl-agent-terminal-broker.service")"
  [ "$hash_before" = "$hash_after" ] || return 1
  ! grep -q '^enable-linger ' "$home/loginctl.log" || return 1
  grep -Fxq -- '--user enable --now wsl-agent-tmux.service wsl-agent-terminal-broker.service mcp-dev-bridge.service' "$home/systemctl.log" || return 1
}

run_test 'personal bootstrap prepares state and wsl-term without installing startup services' test_prepare_without_startup_consent
run_test 'personal bootstrap explicit startup consent installs and converges user services' test_startup_consent_installs_and_converges

printf '\n%d tests, %d failures\n' "$TESTS" "$FAILURES"
[ "$FAILURES" -eq 0 ]
