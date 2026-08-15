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

public_candidate_files() {
  printf '%s\n' \
    .env.example .gitignore CONTRIBUTING.md LICENSE README.md SECURITY.md \
    scripts/install-systemd-user.sh scripts/render-config.mjs scripts/setup.sh scripts/smoke-local.sh \
    tests/harness.sh tests/lifecycle.sh tests/publication.sh \
    docs/acceptance.md docs/architecture.md docs/configuration.md docs/development.md \
    docs/installation.md docs/operations.md docs/security.md
  for dir in bin config/profiles config/templates examples lib providers/pi-dev systemd .github; do
    [ -d "$ROOT/$dir" ] || continue
    find "$ROOT/$dir" -type f -not -path '*/node_modules/*' -printf "$dir/%P\n"
  done | sort -u
}

test_public_candidate_inventory_covers_runtime() {
  local inventory
  inventory="$(public_candidate_files)"
  grep -Fxq 'bin/start' <<<"$inventory" &&
  grep -Fxq 'providers/pi-dev/server.mjs' <<<"$inventory" &&
  grep -Fxq 'config/templates/mcp.json' <<<"$inventory"
}

test_public_entrypoints() {
  [ -x "$ROOT/bin/start" ] && [ -x "$ROOT/bin/status" ] && [ -x "$ROOT/bin/stop" ]
}

test_public_structure() {
  [ -f "$ROOT/config/templates/mcp.json" ] && \
  [ -f "$ROOT/config/profiles/restricted.env" ] && \
  [ -f "$ROOT/config/profiles/trusted-dev.env" ] && \
  [ -f "$ROOT/systemd/mcp-dev-bridge.service.in" ] && \
  [ -f "$ROOT/providers/pi-dev/server.mjs" ] && \
  [ -f "$ROOT/providers/pi-dev/package.json" ] && \
  [ -f "$ROOT/providers/pi-dev/package-lock.json" ] && \
  [ -f "$ROOT/scripts/render-config.mjs" ]
}

test_explicit_profile_contract() {
  grep -Fq -- '--profile' "$ROOT/scripts/setup.sh" || return 1
  contains "$ROOT/scripts/setup.sh" 'restricted' || return 1
  contains "$ROOT/scripts/setup.sh" 'trusted-dev' || return 1
  if contains "$ROOT/scripts/setup.sh" 'BRIDGE_SETUP_SKIP_INSTALL'; then
    local out rc
    out="$(BRIDGE_SETUP_SKIP_INSTALL=1 "$ROOT/scripts/setup.sh" 2>&1)"
    rc=$?
    [ "$rc" -ne 0 ] || return 1
    grep -q 'restricted' <<<"$out" && grep -q 'trusted-dev' <<<"$out"
  else
    return 1
  fi
}

test_profiles_are_distinct() {
  grep -Fqx 'MCP_SHELL_MODE=disabled' "$ROOT/config/profiles/restricted.env" || return 1
  grep -Fqx 'MCP_SHELL_MODE=unrestricted' "$ROOT/config/profiles/trusted-dev.env" || return 1
  ! grep -Rq '^MCP_SHELL_ALLOW_' "$ROOT/config/profiles"
}

test_renderer_generates_both_profiles() {
  local tmp env_file state profile
  tmp="$(mktemp -d)" || return 1
  env_file="$tmp/deployment.env"
  cat > "$env_file" <<'EOF'
MCP_WORKSPACE_ROOT=/tmp/example-workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
EOF
  for profile in restricted trusted-dev; do
    state="$tmp/$profile"
    node "$ROOT/scripts/render-config.mjs" --profile "$profile" --env-file "$env_file" --state-dir "$state" --repo-root "$ROOT" >/dev/null || { rm -rf "$tmp"; return 1; }
    grep -Fq "MCP_BRIDGE_PROFILE='$profile'" "$state/bridge.env" || { rm -rf "$tmp"; return 1; }
  done
  node - "$tmp/restricted/1mcp/mcp.json" "$tmp/trusted-dev/1mcp/mcp.json" "$ROOT" <<'NODE2'
const fs = require('fs');
const [restrictedFile, trustedFile, root] = process.argv.slice(2);
const restricted = JSON.parse(fs.readFileSync(restrictedFile, 'utf8'));
const trusted = JSON.parse(fs.readFileSync(trustedFile, 'utf8'));
const keys = cfg => Object.keys(cfg.mcpServers ?? {}).sort();
if (JSON.stringify(keys(restricted)) !== JSON.stringify(['dev'])) process.exit(1);
if (JSON.stringify(keys(trusted)) !== JSON.stringify(['dev'])) process.exit(1);
for (const cfg of [restricted, trusted]) {
  const env = cfg.mcpServers.dev.env;
  if (env.MCP_DEV_WORKSPACE_ROOT !== '/tmp/example-workspace') process.exit(1);
  if (env.MCP_DEV_MAX_OUTPUT_BYTES !== '1048576') process.exit(1);
  if (!env.MCP_DEV_STATE_DIR.endsWith('/dev')) process.exit(1);
  if (cfg.mcpServers.filesystem) process.exit(1);
}
if (restricted.mcpServers.dev.env.MCP_DEV_SHELL_MODE !== 'disabled') process.exit(1);
if (trusted.mcpServers.dev.env.MCP_DEV_SHELL_MODE !== 'unrestricted') process.exit(1);
if (restricted.mcpServers.shell || trusted.mcpServers.shell) process.exit(1);
NODE2
  local rc=$?
  rm -rf "$tmp"
  return "$rc"
}

test_public_product_copy() {
  local readme="$ROOT/README.md" security="$ROOT/docs/security.md" path
  grep -Fq '# WebHarness' "$readme" || return 1
  grep -Fq 'Turn a ChatGPT web session into a native Linux development harness.' "$readme" || return 1
  grep -Fq 'Four native coding primitives' "$readme" || return 1
  grep -Fq '`restricted`' "$readme" || return 1
  grep -Fq '`trusted-dev`' "$readme" || return 1
  grep -Fq 'Public beta' "$readme" || return 1
  grep -Fq 'Linux/WSL' "$readme" || return 1
  grep -Fq 'starting point' "$readme" || return 1
  grep -Fq 'backbone for your particular web-based AI session' "$readme" || return 1
  grep -Fq 'add or remove tools' "$readme" || return 1
  grep -Fqi 'not affiliated with or endorsed by OpenAI' "$readme" || return 1

  grep -Fq 'WebHarness' "$ROOT/SECURITY.md" || return 1
  grep -Fqi 'workspace-confined' "$security" || return 1
  grep -Fqi 'Linux service user' "$security" || return 1
  grep -Fqi 'identity perimeter' "$security" || return 1
  grep -Fqi 'refresh token' "$security" || return 1
  grep -Fqi 'multi-user SaaS' "$security" || return 1

  local old_name='MCP Development'' Bridge'
  while IFS= read -r path; do
    [ -f "$ROOT/$path" ] || continue
    if grep -I -nF "$old_name" "$ROOT/$path" >/dev/null 2>&1; then
      echo "old public product name found in $path" >&2
      return 1
    fi
  done < <(public_candidate_files)

  ! grep -Eq '\buvx?\b' "$ROOT/docs/installation.md"
}

test_ci_contract() {
  local workflow="$ROOT/.github/workflows/ci.yml"
  [ -f "$workflow" ] || return 1
  grep -Fq 'actions/checkout@v7' "$workflow" || return 1
  grep -Fq 'actions/setup-node@v6' "$workflow" || return 1
  grep -Fq "node-version: '24'" "$workflow" || return 1
  grep -Fq 'npm --prefix providers/pi-dev ci' "$workflow" || return 1
  grep -Fq 'npm --prefix providers/pi-dev audit --omit=dev' "$workflow" || return 1
  grep -Fq 'bash tests/harness.sh' "$workflow" || return 1
  grep -Fq 'bash tests/publication.sh' "$workflow" || return 1
  grep -Fq 'bash tests/lifecycle.sh' "$workflow" || return 1
}

test_pi_install_and_smoke_contract() {
  grep -Fq 'npm --prefix "$DIR/providers/pi-dev" ci --omit=dev' "$ROOT/scripts/setup.sh" || return 1
  grep -Fq 'unexpected Pi version' "$ROOT/scripts/setup.sh" || return 1
  grep -Fq 'MCP_DEV_WORKSPACE_ROOT' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'MCP_DEV_STATE_DIR' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'MCP_DEV_MAX_OUTPUT_BYTES' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'MCP_DEV_SHELL_MODE' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'unexpected final provider set' "$ROOT/scripts/smoke-local.sh" || return 1
  grep -Fq 'restricted Read/Edit/Write' "$ROOT/scripts/smoke-local.sh" || return 1
}

test_env_is_ignored() {
  grep -Fqx '.env' "$ROOT/.gitignore"
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
  done < <(public_candidate_files)
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


run_test 'public candidate inventory covers runtime files' test_public_candidate_inventory_covers_runtime
run_test 'public bin entrypoints exist and are executable' test_public_entrypoints
run_test 'publication directory structure exists' test_public_structure
run_test 'setup requires explicit trust profile' test_explicit_profile_contract
run_test 'trusted-dev is unrestricted while restricted is not' test_profiles_are_distinct
run_test 'renderer generates valid external state for both profiles' test_renderer_generates_both_profiles
run_test 'public copy states the product, trust model, and beta limits without internal history' test_public_product_copy
run_test 'portable GitHub CI runs the public release gate' test_ci_contract
run_test 'setup and smoke preserve pinned Pi deployment contract' test_pi_install_and_smoke_contract
run_test '.env remains ignored' test_env_is_ignored
run_test 'runtime and 1MCP state default outside the repository' test_state_defaults_are_external
run_test 'lifecycle selects an actually rendered external deployment' test_rendered_deployment_is_selected_by_lifecycle
run_test 'public tracked files contain no personal deployment identity' test_no_personal_identity_in_public_files
run_test 'generic systemd template targets public bin entrypoints' test_generic_systemd_template
run_test 'systemd installer renders a valid fixture without live manager' test_systemd_installer_renders_without_live_manager

printf '\n%s tests, %s failures\n' "$TESTS" "$FAILURES"
[ "$FAILURES" -eq 0 ]
