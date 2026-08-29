#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
TESTS=0

pass() { printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
run_test() {
  local name="$1"
  shift
  TESTS=$((TESTS + 1))
  if "$@"; then pass "$name"; else fail "$name"; fi
}
contains() { grep -Eq "$2" "$1"; }
# shellcheck source=../scripts/public-paths.sh
source "$ROOT/scripts/public-paths.sh"

test_public_entrypoints() {
  [ -x "$ROOT/bin/webharness" ] && \
  [ -x "$ROOT/bin/start" ] && [ -x "$ROOT/bin/status" ] && [ -x "$ROOT/bin/stop" ] && \
  [ -x "$ROOT/bin/extension" ] && [ -x "$ROOT/bin/wsl-term" ]
}

test_public_structure() {
  [ -f "$ROOT/config/templates/mcp.json" ] && \
  [ -f "$ROOT/config/templates/mcp-personal.json" ] && \
  [ -f "$ROOT/config/templates/mcp-local.json" ] && \
  [ -f "$ROOT/config/profiles/restricted.env" ] && \
  [ -f "$ROOT/config/profiles/trusted-dev.env" ] && \
  [ -f "$ROOT/config/profiles/personal.env" ] && \
  [ -f "$ROOT/systemd/mcp-dev-bridge.service.in" ] && \
  [ -f "$ROOT/systemd/wsl-agent-tmux.service.in" ] && \
  [ -f "$ROOT/systemd/wsl-agent-terminal-broker.service.in" ] && \
  [ -f "$ROOT/providers/legacy-shell/server.py" ] && \
  [ -f "$ROOT/providers/pi-dev/server.mjs" ] && \
  [ -f "$ROOT/providers/code-router/server.mjs" ] && \
  [ -f "$ROOT/providers/terminal/mcp-server.mjs" ] && \
  [ -f "$ROOT/providers/local-tools/server.mjs" ] && \
  [ -f "$ROOT/providers/browser/server.mjs" ] && \
  [ -f "$ROOT/providers/browser-fast/server.mjs" ] && \
  [ -f "$ROOT/scripts/render-config.mjs" ] && \
  [ -f "$ROOT/scripts/bootstrap-personal.sh" ] && \
  [ -f "$ROOT/scripts/manage-extension.mjs" ] && \
  [ -f "$ROOT/scripts/doctor.sh" ] && \
  [ -f "$ROOT/scripts/public-paths.sh" ] && \
  [ -f "$ROOT/scripts/stage-public.sh" ]
}

test_explicit_profile_contract() {
  grep -Fq -- '--profile' "$ROOT/bin/webharness" || return 1
  grep -Fq 'restricted|trusted-dev|personal' "$ROOT/bin/webharness" || return 1
  contains "$ROOT/scripts/setup.sh" 'restricted' || return 1
  contains "$ROOT/scripts/setup.sh" 'trusted-dev' || return 1
  contains "$ROOT/scripts/bootstrap-personal.sh" 'Personal Workstation' || return 1
  grep -Fq -- '--enable-startup' "$ROOT/scripts/setup.sh" || return 1
  grep -Fq -- '--enable-startup' "$ROOT/scripts/bootstrap-personal.sh" || return 1
  local out rc
  out="$("$ROOT/bin/webharness" setup 2>&1)"
  rc=$?
  [ "$rc" -ne 0 ] || return 1
  grep -q 'restricted' <<<"$out" && grep -q 'trusted-dev' <<<"$out" && grep -q 'personal' <<<"$out"
}

test_profiles_are_distinct() {
  grep -Fqx 'MCP_SHELL_MODE=allowlist' "$ROOT/config/profiles/restricted.env" || return 1
  grep -Fqx 'MCP_SHELL_MODE=unrestricted' "$ROOT/config/profiles/trusted-dev.env" || return 1
  grep -Fq 'MCP_SHELL_ALLOW_COMMANDS=' "$ROOT/config/profiles/restricted.env" || return 1
  grep -Fq 'MCP_SHELL_ALLOW_PATTERNS=' "$ROOT/config/profiles/restricted.env" || return 1
  grep -Fqx 'MCP_SHELL_ALLOW_DANGEROUS=' "$ROOT/config/profiles/restricted.env" || return 1
  ! grep -Eq '^MCP_SHELL_ALLOW_(COMMANDS|PATTERNS|DANGEROUS)=' "$ROOT/config/profiles/trusted-dev.env"
}

test_public_classifier_matches_reference_boundary() {
  local path
  declare -F is_public_path >/dev/null || return 1
  for path in \
    config/profiles/personal.env \
    config/templates/mcp-personal.json \
    config/templates/mcp-local.json \
    docs/personal/harness.md \
    providers/terminal/example \
    scripts/install-terminal-broker-user.sh \
    systemd/wsl-agent-tmux.service.in \
    systemd/wsl-agent-terminal-broker.service.in \
    providers/code-router/example \
    providers/browser/example \
    providers/browser-fast/example \
    providers/local-tools/example \
    scripts/bootstrap-personal.sh \
    scripts/manage-extension.mjs \
    bin/extension \
    bin/wsl-term \
    third_party/chat-on-steroids-extension/manifest.json \
    docs/superpowers/plans/2026-08-29-webharness-agents-implementation.md; do
    is_public_path "$path" || { echo "reference path classified as non-public: $path" >&2; return 1; }
  done
  for path in \
    docs/history/example \
    docs/benchmarks/example.md \
    experiments/example \
    extensions/job-application/extension.json \
    skills/example/SKILL.md \
    providers/websession-adapter/server.mjs \
    bin/adapter \
    bin/websession-call \
    docs/websession-clients.md \
    docs/migration-from-local-bridge.md \
    scripts/export-personal-wsl-state.sh \
    timer-ping-test.log; do
    if is_public_path "$path"; then
      echo "excluded path classified as public: $path" >&2
      return 1
    fi
  done
  grep -Fq 'source "$ROOT/scripts/public-paths.sh"' "$ROOT/scripts/stage-public.sh"
}

test_renderer_generates_reference_profiles() {
  local tmp env_file state profile
  tmp="$(mktemp -d)" || return 1
  env_file="$tmp/deployment.env"
  mkdir -p "$tmp/home" "$tmp/runtime"
  cat > "$env_file" <<'EOF'
MCP_WORKSPACE_ROOT=/tmp/example-workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
EOF
  for profile in restricted trusted-dev personal; do
    state="$tmp/$profile"
    HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" --profile "$profile" --env-file "$env_file" --state-dir "$state" --repo-root "$ROOT" >/dev/null || { rm -rf "$tmp"; return 1; }
    grep -Fq "MCP_BRIDGE_PROFILE='$profile'" "$state/bridge.env" || { rm -rf "$tmp"; return 1; }
    grep -Fq '[auth]' "$state/1mcp/config.toml" || { rm -rf "$tmp"; return 1; }
    grep -Fq 'sessionTtl = 43200' "$state/1mcp/config.toml" || { rm -rf "$tmp"; return 1; }
  done
  node - "$tmp/restricted/1mcp/mcp.json" "$tmp/trusted-dev/1mcp/mcp.json" "$tmp/personal/1mcp/mcp.json" "$tmp/personal/local-1mcp/mcp.json" "$ROOT" <<'NODE2'
const fs = require('fs');
const [restrictedFile, trustedFile, personalFile, localFile, root] = process.argv.slice(2);
const restricted = JSON.parse(fs.readFileSync(restrictedFile, 'utf8'));
const trusted = JSON.parse(fs.readFileSync(trustedFile, 'utf8'));
const personal = JSON.parse(fs.readFileSync(personalFile, 'utf8'));
const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
const keys = cfg => Object.keys(cfg.mcpServers ?? {}).sort();
if (JSON.stringify(keys(restricted)) !== JSON.stringify(['dev', 'shell'])) process.exit(1);
if (JSON.stringify(keys(trusted)) !== JSON.stringify(['dev'])) process.exit(1);
if (JSON.stringify(keys(personal)) !== JSON.stringify(['code', 'dev', 'local', 'terminal'])) process.exit(1);
if (JSON.stringify(keys(local)) !== JSON.stringify(['browser-devtools', 'browser-fast'])) process.exit(1);
if (!local.mcpServers['browser-devtools'].args.includes(root + '/providers/browser/server.mjs')) process.exit(1);
if (!local.mcpServers['browser-fast'].args.includes(root + '/providers/browser-fast/server.mjs')) process.exit(1);
NODE2
  local rc=$?
  rm -rf "$tmp"
  return "$rc"
}

test_render_check_is_non_mutating() {
  local tmp env_file state
  tmp="$(mktemp -d)" || return 1
  env_file="$tmp/deployment.env"
  state="$tmp/state"
  cat > "$env_file" <<'EOF'
MCP_WORKSPACE_ROOT=/tmp/example-workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
EOF
  node "$ROOT/scripts/render-config.mjs" --check --profile trusted-dev --env-file "$env_file" --state-dir "$state" --repo-root "$ROOT" >/dev/null || { rm -rf "$tmp"; return 1; }
  [ ! -e "$state" ]
  local rc=$?
  rm -rf "$tmp"
  return "$rc"
}

test_pi_install_and_smoke_contract() {
  grep -Fq 'npm --prefix "$DIR/providers/pi-dev" ci --omit=dev' "$ROOT/scripts/setup.sh" || return 1
  grep -Fq 'unexpected Pi version' "$ROOT/scripts/setup.sh" || return 1
  grep -Fq 'MCP_DEV_WORKSPACE_ROOT' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'MCP_DEV_STATE_DIR' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'MCP_DEV_MAX_OUTPUT_BYTES' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'MCP_DEV_MAX_SPOOL_BYTES' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'MCP_DEV_SPOOL_TTL_SECONDS' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'MCP_DEV_SPOOL_MAX_TOTAL_BYTES' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'config.toml' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'sessionTtl' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'MCP_DEV_SHELL_MODE' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'unexpected final provider set' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'filesystem provider must be absent after Pi cutover' "$ROOT/scripts/smoke-local.sh" || return 1
}

test_env_is_ignored() {
  git -C "$ROOT" check-ignore -q .env
}

test_state_defaults_are_external() {
  local common="$ROOT/lib/bridge/common.sh"
  [ -f "$common" ] || common="$ROOT/scripts/bridge-common.sh"
  contains "$common" 'XDG_RUNTIME_DIR' && \
  contains "$common" 'XDG_STATE_HOME' && \
  ! contains "$common" 'BRIDGE_RUN_DIR=.*BRIDGE_ROOT/run' && \
  ! contains "$common" 'BRIDGE_CONFIG_DIR=.*BRIDGE_ROOT/config'
}

test_rendered_deployment_is_selected_by_lifecycle() {
  local tmp state env_file
  tmp="$(mktemp -d)" || return 1
  state="$tmp/state/mcp-dev-bridge"
  env_file="$tmp/deployment.env"
  mkdir -p "$tmp/runtime"
  cat > "$env_file" <<'EOF'
MCP_WORKSPACE_ROOT=/tmp/example-workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
EOF
  HOME="$tmp/home" XDG_STATE_HOME="$tmp/state" XDG_RUNTIME_DIR="$tmp/runtime" \
    node "$ROOT/scripts/render-config.mjs" --profile trusted-dev --env-file "$env_file" --state-dir "$state" --repo-root "$ROOT" >/dev/null || { rm -rf "$tmp"; return 1; }
  HOME="$tmp/home" XDG_STATE_HOME="$tmp/state" XDG_RUNTIME_DIR="$tmp/runtime" BRIDGE_STATE_DIR="$state" BRIDGE_ROOT="$ROOT" \
    bash -c '
      source "$1/lib/bridge/common.sh"
      [ "$BRIDGE_CONFIG_DIR" = "$2/1mcp" ] &&
      [ "$BRIDGE_RUN_DIR" = "$3/mcp-dev-bridge" ] &&
      [ "$TUNNEL_URL" = "https://mcp.example.test" ] &&
      [ "$BRIDGE_WORKSPACE_ROOT" = "/tmp/example-workspace" ]
    ' _ "$ROOT" "$state" "$tmp/runtime" || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_no_personal_identity_in_public_files() {
  local path private_user private_home private_domain private_host private_service private_title pattern
  private_user="ham""za"
  private_home="/home/$private_user"
  private_domain="mcp.$private_user.my.id"
  private_host="DESKTOP-""HQOUFCO"
  private_service="$private_user-cloudflare-oauth-bridge"
  private_title="Ham""za WSL"
  pattern="${private_home}|${private_domain//./\\.}|${private_host}|${private_service}|${private_title}"
  while IFS= read -r path; do
    [ -f "$ROOT/$path" ] || continue
    if grep -I -nE "$pattern" "$ROOT/$path" >/dev/null 2>&1; then
      echo "personal deployment identity found in $path" >&2
      return 1
    fi
  done < <(public_tracked_files "$ROOT")
}

test_generic_systemd_template() {
  local unit="$ROOT/systemd/mcp-dev-bridge.service.in"
  [ -f "$unit" ] && \
  contains "$unit" 'ExecStart=@REPO_ROOT@/bin/start' && \
  contains "$unit" 'ExecStop=@REPO_ROOT@/bin/stop' && \
  contains "$unit" 'EnvironmentFile=-@STATE_DIR@/bridge\.env'
}

test_systemd_installer_renders_without_live_manager() {
  local tmp target unit
  tmp="$(mktemp -d)" || return 1
  target="$tmp/systemd"
  mkdir -p "$tmp/home" "$target"
  HOME="$tmp/home" BRIDGE_STATE_DIR="$tmp/state" BRIDGE_SYSTEMD_TARGET_DIR="$target" \
    BRIDGE_SYSTEMD_DRY_RUN=1 "$ROOT/scripts/install-systemd-user.sh" >/dev/null || { rm -rf "$tmp"; return 1; }
  unit="$target/mcp-dev-bridge.service"
  [ -f "$unit" ] || { rm -rf "$tmp"; return 1; }
  ! grep -q '@[A-Z_][A-Z_]*@' "$unit" || { rm -rf "$tmp"; return 1; }
  grep -Fq "ExecStart=$ROOT/bin/start" "$unit" || { rm -rf "$tmp"; return 1; }
  grep -Fq "EnvironmentFile=-$tmp/state/bridge.env" "$unit" || { rm -rf "$tmp"; return 1; }
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "$unit" >/dev/null 2>&1 || { rm -rf "$tmp"; return 1; }
  fi
  rm -rf "$tmp"
}


test_legacy_oauth_state_migration() {
  local tmp legacy state src_server dest_server now future expired cli session transport code request
  tmp="$(mktemp -d)" || return 1
  legacy="$tmp/legacy/config"
  state="$tmp/state/mcp-dev-bridge"
  src_server="$legacy/sessions/sessions/server"
  dest_server="$state/1mcp/sessions/sessions/server"
  mkdir -p "$src_server" "$legacy/sessions/sessions/transport" "$legacy/sessions/sessions/client"
  printf '{}\n' > "$legacy/mcp.json"

  now="$(date +%s000)"
  future="$((now + 3600000))"
  expired="$((now - 1000))"
  cli='session_cli_11111111-1111-4111-8111-111111111111.json'
  session='session_sess-22222222-2222-4222-8222-222222222222.json'
  transport='streamable_session_stream-33333333-3333-4333-8333-333333333333.json'
  code='auth_code_code-44444444-4444-4444-8444-444444444444.json'
  request='auth_request_code-55555555-5555-4555-8555-555555555555.json'

  printf '{"client_id":"keep","expires":%s}\n' "$future" > "$src_server/$cli"
  printf '{"clientId":"keep","scopes":["tag:filesystem"],"expires":%s}\n' "$future" > "$src_server/$session"
  printf '{"client_id":"expired","expires":%s}\n' "$expired" > "$src_server/session_cli_66666666-6666-4666-8666-666666666666.json"
  printf '{"expires":%s}\n' "$future" > "$src_server/$code"
  printf '{"expires":%s}\n' "$future" > "$src_server/$request"
  printf '{"expires":%s}\n' "$future" > "$legacy/sessions/sessions/transport/$transport"
  printf '{"serverName":"upstream","expires":%s}\n' "$future" > "$legacy/sessions/sessions/client/oauth_upstream.json"

  "$ROOT/scripts/migrate-legacy-oauth-state.sh" --from-config-dir "$legacy" --state-dir "$state" >/dev/null || { rm -rf "$tmp"; return 1; }

  [ -f "$dest_server/$cli" ] && \
  [ -f "$dest_server/$session" ] && \
  [ ! -e "$dest_server/session_cli_66666666-6666-4666-8666-666666666666.json" ] && \
  [ ! -e "$dest_server/$code" ] && \
  [ ! -e "$dest_server/$request" ] && \
  [ ! -e "$state/1mcp/sessions/sessions/transport/$transport" ] && \
  [ ! -e "$state/1mcp/sessions/sessions/client/oauth_upstream.json" ] && \
  [ "$(stat -c '%a' "$dest_server")" = 700 ] && \
  [ "$(stat -c '%a' "$dest_server/$cli")" = 600 ] && \
  [ "$(stat -c '%a' "$dest_server/$session")" = 600 ] || { rm -rf "$tmp"; return 1; }

  # Idempotent when destination records are byte-identical.
  "$ROOT/scripts/migrate-legacy-oauth-state.sh" --from-config-dir "$legacy" --state-dir "$state" >/dev/null || { rm -rf "$tmp"; return 1; }

  # Refuse conflicting destination auth state rather than overwriting it.
  printf '{"client_id":"different","expires":%s}\n' "$future" > "$dest_server/$cli"
  if "$ROOT/scripts/migrate-legacy-oauth-state.sh" --from-config-dir "$legacy" --state-dir "$state" >/dev/null 2>&1; then
    rm -rf "$tmp"
    return 1
  fi
  grep -Fq 'different' "$dest_server/$cli" || { rm -rf "$tmp"; return 1; }

  rm -rf "$tmp"
}


test_legacy_oauth_migration_noop_and_repo_guard() {
  local tmp legacy state
  tmp="$(mktemp -d)" || return 1
  legacy="$tmp/legacy/config"
  state="$tmp/state/mcp-dev-bridge"
  mkdir -p "$legacy"
  printf '{}\n' > "$legacy/mcp.json"

  # A legitimate legacy config with no OAuth state is a clean no-op.
  "$ROOT/scripts/migrate-legacy-oauth-state.sh" --from-config-dir "$legacy" --state-dir "$state" >/dev/null || { rm -rf "$tmp"; return 1; }
  [ ! -e "$state/1mcp/sessions/sessions/server" ] || { rm -rf "$tmp"; return 1; }

  # Credential state must never be redirected into the source checkout.
  if "$ROOT/scripts/migrate-legacy-oauth-state.sh" --from-config-dir "$legacy" --state-dir "$ROOT/.migration-fixture" >/dev/null 2>&1; then
    rm -rf "$tmp"
    return 1
  fi
  [ ! -e "$ROOT/.migration-fixture" ] || { rm -rf "$tmp"; return 1; }

  rm -rf "$tmp"
}

test_documentation_links_resolve() {
  node "$ROOT/scripts/check-doc-links.mjs"
}

run_test 'public bin entrypoints exist and are executable' test_public_entrypoints
run_test 'publication directory structure exists' test_public_structure
run_test 'setup requires explicit trust profile' test_explicit_profile_contract
run_test 'trusted-dev is unrestricted while restricted is not' test_profiles_are_distinct
run_test 'public classifier matches the reference distribution boundary' test_public_classifier_matches_reference_boundary
run_test 'renderer generates all reference profiles and Local browser composition' test_renderer_generates_reference_profiles
run_test 'renderer check mode validates without writing state' test_render_check_is_non_mutating
run_test 'setup and smoke preserve pinned Pi deployment contract' test_pi_install_and_smoke_contract
run_test '.env remains ignored' test_env_is_ignored
run_test 'runtime and 1MCP state default outside the repository' test_state_defaults_are_external
run_test 'lifecycle selects an actually rendered external deployment' test_rendered_deployment_is_selected_by_lifecycle
run_test 'public tracked files contain no personal deployment identity' test_no_personal_identity_in_public_files
run_test 'generic systemd template targets public bin entrypoints' test_generic_systemd_template
run_test 'systemd installer renders a valid fixture without live manager' test_systemd_installer_renders_without_live_manager
run_test 'legacy OAuth continuity migrates without transient transport state' test_legacy_oauth_state_migration
run_test 'legacy OAuth migration is a clean no-op and never targets Git state' test_legacy_oauth_migration_noop_and_repo_guard
run_test 'repository-relative documentation links resolve' test_documentation_links_resolve

printf '\n%s tests, %s failures\n' "$TESTS" "$FAILURES"
[ "$FAILURES" -eq 0 ]
