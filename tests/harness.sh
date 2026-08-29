#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
TESTS=0
pass() { printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
run_test() { local name="$1"; shift; TESTS=$((TESTS + 1)); if "$@"; then pass "$name"; else fail "$name"; fi; }

test_raw_codedb_surface_removed() {
  [ -f "$ROOT/scripts/install-codedb.sh" ] &&
  [ ! -e "$ROOT/scripts/codedb-mcp.sh" ] &&
  node - "$ROOT/config/templates/mcp.json" "$ROOT/config/templates/mcp-personal.json" <<'NODE'
const fs = require('fs');
for (const file of process.argv.slice(2)) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (cfg.mcpServers?.codedb) process.exit(1);
}
NODE
}

test_final_rendered_composition() {
  local tmp profile
  tmp="$(mktemp -d)" || return 1
  cat > "$tmp/deployment.env" <<'ENV'
MCP_WORKSPACE_ROOT=/tmp/example-workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
MCP_DEV_MAX_SPOOL_BYTES=2048
MCP_DEV_SPOOL_TTL_SECONDS=3600
MCP_DEV_SPOOL_MAX_TOTAL_BYTES=8192
MCP_ONE_MCP_LOG_MAX_SIZE_BYTES=1048576
MCP_ONE_MCP_LOG_MAX_FILES=3
ENV
  mkdir -p "$tmp/runtime" "$tmp/home"
  for profile in restricted trusted-dev personal; do
    env -u MCP_DEV_MAX_SPOOL_BYTES -u MCP_DEV_SPOOL_TTL_SECONDS -u MCP_DEV_SPOOL_MAX_TOTAL_BYTES -u MCP_TERMINAL_FRONTEND \
      HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
      --profile "$profile" \
      --env-file "$tmp/deployment.env" \
      --state-dir "$tmp/$profile" \
      --repo-root "$ROOT" >/dev/null || { rm -rf "$tmp"; return 1; }
  done
  node - "$tmp/restricted/1mcp/mcp.json" "$tmp/trusted-dev/1mcp/mcp.json" "$tmp/personal/1mcp/mcp.json" "$tmp/personal/local-1mcp/mcp.json" "$tmp/personal/bridge.env" "$ROOT" "$tmp/runtime" "$tmp/home" <<'NODE2'
const fs = require('fs');
const [restrictedFile, trustedFile, personalFile, personalLocalFile, personalEnvFile, root, runtimeDir, personalHome] = process.argv.slice(2);
const restricted = JSON.parse(fs.readFileSync(restrictedFile, 'utf8'));
const trusted = JSON.parse(fs.readFileSync(trustedFile, 'utf8'));
const personal = JSON.parse(fs.readFileSync(personalFile, 'utf8'));
const personalLocal = JSON.parse(fs.readFileSync(personalLocalFile, 'utf8'));
const personalEnv = fs.readFileSync(personalEnvFile, 'utf8');
const keys = cfg => Object.keys(cfg.mcpServers ?? {}).sort();
if (JSON.stringify(keys(restricted)) !== JSON.stringify(['dev', 'shell'])) process.exit(1);
if (JSON.stringify(keys(trusted)) !== JSON.stringify(['dev'])) process.exit(1);
if (JSON.stringify(keys(personal)) !== JSON.stringify(['code', 'dev', 'local', 'terminal'])) process.exit(1);
if (JSON.stringify(keys(personalLocal)) !== JSON.stringify(['browser-devtools', 'browser-fast'])) process.exit(1);
if (restricted.mcpServers?.code || trusted.mcpServers?.code) process.exit(1);
if (restricted.mcpServers?.terminal || trusted.mcpServers?.terminal) process.exit(1);
if (restricted.mcpServers?.local || trusted.mcpServers?.local) process.exit(1);
if (restricted.mcpServers?.browser || trusted.mcpServers?.browser || personal.mcpServers?.browser) process.exit(1);
if (restricted.mcpServers?.codedb || trusted.mcpServers?.codedb || personal.mcpServers?.codedb) process.exit(1);
if (restricted.mcpServers?.filesystem || trusted.mcpServers?.filesystem || personal.mcpServers?.filesystem) process.exit(1);
if (restricted.mcpServers.dev.env.MCP_DEV_SHELL_MODE !== 'allowlist') process.exit(1);
if (trusted.mcpServers.dev.env.MCP_DEV_SHELL_MODE !== 'unrestricted') process.exit(1);
if (restricted.mcpServers.dev.env.MCP_DEV_MAX_SPOOL_BYTES !== '2048') process.exit(1);
if (trusted.mcpServers.dev.env.MCP_DEV_MAX_SPOOL_BYTES !== '2048') process.exit(1);
if (personal.mcpServers.dev.env.MCP_DEV_MAX_SPOOL_BYTES !== '2048') process.exit(1);
if (restricted.mcpServers.dev.env.MCP_DEV_SPOOL_TTL_SECONDS !== '3600') process.exit(1);
if (trusted.mcpServers.dev.env.MCP_DEV_SPOOL_TTL_SECONDS !== '3600') process.exit(1);
if (personal.mcpServers.dev.env.MCP_DEV_SPOOL_TTL_SECONDS !== '3600') process.exit(1);
if (restricted.mcpServers.dev.env.MCP_DEV_SPOOL_MAX_TOTAL_BYTES !== '8192') process.exit(1);
if (trusted.mcpServers.dev.env.MCP_DEV_SPOOL_MAX_TOTAL_BYTES !== '8192') process.exit(1);
if (personal.mcpServers.dev.env.MCP_DEV_SPOOL_MAX_TOTAL_BYTES !== '8192') process.exit(1);
if (restricted.mcpServers.dev.env.MCP_DEV_PATH_MODE !== 'workspace') process.exit(1);
if (trusted.mcpServers.dev.env.MCP_DEV_PATH_MODE !== 'workspace') process.exit(1);
if (restricted.mcpServers.dev.env.MCP_DEV_TERMINAL_SOCKET !== undefined) process.exit(1);
if (trusted.mcpServers.dev.env.MCP_DEV_TERMINAL_SOCKET !== undefined) process.exit(1);
if (personal.mcpServers.dev.env.MCP_DEV_SHELL_MODE !== 'unrestricted') process.exit(1);
if (personal.mcpServers.dev.env.MCP_DEV_PATH_MODE !== 'user') process.exit(1);
if (personal.mcpServers.dev.env.MCP_DEV_DEFAULT_CWD !== personalHome) process.exit(1);
if (personal.mcpServers.dev.env.MCP_DEV_WORKSPACE_ROOT !== undefined) process.exit(1);
if (personal.mcpServers.dev.env.MCP_DEV_TERMINAL_SOCKET !== runtimeDir + '/wsl-agent-terminal.sock') process.exit(1);
if (personal.mcpServers.code.command !== 'node') process.exit(1);
if (!personal.mcpServers.code.args.includes(root + '/providers/code-router/server.mjs')) process.exit(1);
if (personal.mcpServers.code.env.MCP_CODE_DEFAULT_CWD !== personalHome) process.exit(1);
if (personal.mcpServers.terminal.command !== 'node') process.exit(1);
if (!personal.mcpServers.terminal.args.includes(root + '/providers/terminal/mcp-server.mjs')) process.exit(1);
if (personal.mcpServers.terminal.env.MCP_TERMINAL_SOCKET !== runtimeDir + '/wsl-agent-terminal.sock') process.exit(1);
if (personal.mcpServers.terminal.env.MCP_TERMINAL_FRONTEND !== 'kitty') process.exit(1);
if (personal.mcpServers.terminal.env.MCP_TERMINAL_READ_MAX_BYTES !== '65536') process.exit(1);
if (personal.mcpServers.local.command !== 'node') process.exit(1);
if (!personal.mcpServers.local.args.includes(root + '/providers/local-tools/server.mjs')) process.exit(1);
if (personal.mcpServers.local.env.MCP_LOCAL_INNER_CONFIG !== personalLocalFile) process.exit(1);
if (!personal.mcpServers.local.env.MCP_LOCAL_ONE_MCP_ENTRY.endsWith('/@1mcp/agent/build/index.js')) process.exit(1);
if (JSON.stringify(personal.mcpServers.local.tags) !== JSON.stringify(['local'])) process.exit(1);
if (personalLocal.mcpServers['browser-devtools'].command !== 'node') process.exit(1);
if (!personalLocal.mcpServers['browser-devtools'].args.includes(root + '/providers/browser/server.mjs')) process.exit(1);
if (personalLocal.mcpServers['browser-devtools'].env.XDG_RUNTIME_DIR !== runtimeDir) process.exit(1);
if (personalLocal.mcpServers['browser-devtools'].env.WAYLAND_DISPLAY !== 'wayland-0') process.exit(1);
if (personalLocal.mcpServers['browser-devtools'].env.DISPLAY !== ':0') process.exit(1);
if (personalLocal.mcpServers['browser-devtools'].env.PULSE_SERVER !== 'unix:/mnt/wslg/PulseServer') process.exit(1);
if (personalLocal.mcpServers['browser-devtools'].tags !== undefined) process.exit(1);
if (personalLocal.mcpServers['browser-fast'].command !== 'node') process.exit(1);
if (!personalLocal.mcpServers['browser-fast'].args.includes(root + '/providers/browser-fast/server.mjs')) process.exit(1);
if (personalLocal.mcpServers['browser-fast'].env.XDG_RUNTIME_DIR !== runtimeDir) process.exit(1);
if (personalLocal.mcpServers['browser-fast'].env.WAYLAND_DISPLAY !== 'wayland-0') process.exit(1);
if (personalLocal.mcpServers['browser-fast'].env.DISPLAY !== ':0') process.exit(1);
if (personalLocal.mcpServers['browser-fast'].env.PULSE_SERVER !== 'unix:/mnt/wslg/PulseServer') process.exit(1);
if (personalLocal.mcpServers['browser-fast'].tags !== undefined) process.exit(1);
if (!personalEnv.includes("MCP_BRIDGE_PROFILE='personal'")) process.exit(1);
NODE2
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    for profile in restricted trusted-dev personal; do
      log_cfg="$tmp/$profile/1mcp/config.toml"
      grep -Fq '[auth]' "$log_cfg" || rc=1
      grep -Fq 'sessionTtl = 43200' "$log_cfg" || rc=1
      grep -Fq '[logging]' "$log_cfg" || rc=1
      grep -Fq "file = \"$tmp/$profile/logs/one-mcp.log\"" "$log_cfg" || rc=1
      grep -Fq 'maxSize = 1048576' "$log_cfg" || rc=1
      grep -Fq 'maxFiles = 3' "$log_cfg" || rc=1
    done
  fi
  rm -rf "$tmp"
  return "$rc"
}

test_dev_spool_limit_validation() {
  local tmp value output rc
  tmp="$(mktemp -d)" || return 1
  mkdir -p "$tmp/workspace" "$tmp/runtime" "$tmp/home"
  for value in 0 -1 nope 268435457; do
    cat > "$tmp/deployment.env" <<EOF
MCP_WORKSPACE_ROOT=$tmp/workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
MCP_DEV_MAX_SPOOL_BYTES=$value
EOF
    output="$(env -u MCP_DEV_MAX_SPOOL_BYTES -u MCP_DEV_SPOOL_TTL_SECONDS -u MCP_DEV_SPOOL_MAX_TOTAL_BYTES \
      HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
      --profile trusted-dev \
      --env-file "$tmp/deployment.env" \
      --state-dir "$tmp/state-$value" \
      --repo-root "$ROOT" 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ] || ! grep -Fq 'MCP_DEV_MAX_SPOOL_BYTES must be an integer from 1 to 268435456' <<<"$output"; then
      rm -rf "$tmp"
      return 1
    fi
  done

  cat > "$tmp/deployment.env" <<EOF
MCP_WORKSPACE_ROOT=$tmp/workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
MCP_DEV_SPOOL_TTL_SECONDS=0
EOF
  output="$(env -u MCP_DEV_MAX_SPOOL_BYTES -u MCP_DEV_SPOOL_TTL_SECONDS -u MCP_DEV_SPOOL_MAX_TOTAL_BYTES \
    HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
    --profile trusted-dev \
    --env-file "$tmp/deployment.env" \
    --state-dir "$tmp/state-invalid-ttl" \
    --repo-root "$ROOT" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] || ! grep -Fq 'MCP_DEV_SPOOL_TTL_SECONDS must be an integer from 1 to 31536000' <<<"$output"; then
    rm -rf "$tmp"
    return 1
  fi

  cat > "$tmp/deployment.env" <<EOF
MCP_WORKSPACE_ROOT=$tmp/workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
MCP_DEV_MAX_SPOOL_BYTES=2048
MCP_DEV_SPOOL_MAX_TOTAL_BYTES=1024
EOF
  output="$(env -u MCP_DEV_MAX_SPOOL_BYTES -u MCP_DEV_SPOOL_TTL_SECONDS -u MCP_DEV_SPOOL_MAX_TOTAL_BYTES \
    HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
    --profile trusted-dev \
    --env-file "$tmp/deployment.env" \
    --state-dir "$tmp/state-invalid-budget" \
    --repo-root "$ROOT" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] || ! grep -Fq 'MCP_DEV_SPOOL_MAX_TOTAL_BYTES must be >= MCP_DEV_MAX_SPOOL_BYTES' <<<"$output"; then
    rm -rf "$tmp"
    return 1
  fi

  rm -rf "$tmp"
}

test_one_mcp_log_policy_validation() {
  local tmp value output rc
  tmp="$(mktemp -d)" || return 1
  mkdir -p "$tmp/workspace" "$tmp/runtime" "$tmp/home"
  for value in 0 1048575 nope 67108865; do
    cat > "$tmp/deployment.env" <<EOF
MCP_WORKSPACE_ROOT=$tmp/workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_ONE_MCP_LOG_MAX_SIZE_BYTES=$value
EOF
    output="$(HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
      --profile trusted-dev --env-file "$tmp/deployment.env" --state-dir "$tmp/log-size-$value" --repo-root "$ROOT" 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ] || ! grep -Fq 'MCP_ONE_MCP_LOG_MAX_SIZE_BYTES must be an integer from 1048576 to 67108864' <<<"$output"; then
      rm -rf "$tmp"
      return 1
    fi
  done
  for value in 0 nope 11; do
    cat > "$tmp/deployment.env" <<EOF
MCP_WORKSPACE_ROOT=$tmp/workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_ONE_MCP_LOG_MAX_FILES=$value
EOF
    output="$(HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
      --profile trusted-dev --env-file "$tmp/deployment.env" --state-dir "$tmp/log-files-$value" --repo-root "$ROOT" 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ] || ! grep -Fq 'MCP_ONE_MCP_LOG_MAX_FILES must be an integer from 1 to 10' <<<"$output"; then
      rm -rf "$tmp"
      return 1
    fi
  done
  rm -rf "$tmp"
}

test_terminal_frontend_selector() {
  local tmp value output rc profile
  tmp="$(mktemp -d)" || return 1
  mkdir -p "$tmp/workspace" "$tmp/runtime" "$tmp/home"

  for value in kitty windows-terminal; do
    cat > "$tmp/deployment.env" <<EOF
MCP_WORKSPACE_ROOT=$tmp/workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TERMINAL_FRONTEND=$value
EOF
    env -u MCP_TERMINAL_FRONTEND HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
      --profile personal --env-file "$tmp/deployment.env" --state-dir "$tmp/personal-$value" --repo-root "$ROOT" >/dev/null || {
        rm -rf "$tmp"
        return 1
      }
    node - "$tmp/personal-$value/1mcp/mcp.json" "$value" <<'NODE'
const fs = require('fs');
const [configFile, expected] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
if (config.mcpServers.terminal.env.MCP_TERMINAL_FRONTEND !== expected) process.exit(1);
NODE
    rc=$?
    [ "$rc" -eq 0 ] || { rm -rf "$tmp"; return "$rc"; }
  done

  cat > "$tmp/empty.env" <<EOF
MCP_WORKSPACE_ROOT=$tmp/workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TERMINAL_FRONTEND=
EOF
  env -u MCP_TERMINAL_FRONTEND HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
    --profile personal --env-file "$tmp/empty.env" --state-dir "$tmp/personal-empty" --repo-root "$ROOT" >/dev/null || {
      rm -rf "$tmp"
      return 1
    }
  node - "$tmp/personal-empty/1mcp/mcp.json" <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (config.mcpServers.terminal.env.MCP_TERMINAL_FRONTEND !== 'kitty') process.exit(1);
NODE
  rc=$?
  [ "$rc" -eq 0 ] || { rm -rf "$tmp"; return "$rc"; }

  cat > "$tmp/deployment.env" <<EOF
MCP_WORKSPACE_ROOT=$tmp/workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TERMINAL_FRONTEND=kitty
EOF
  MCP_TERMINAL_FRONTEND=windows-terminal HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
    --profile personal --env-file "$tmp/deployment.env" --state-dir "$tmp/process-override" --repo-root "$ROOT" >/dev/null || {
      rm -rf "$tmp"
      return 1
    }
  node - "$tmp/process-override/1mcp/mcp.json" <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (config.mcpServers.terminal.env.MCP_TERMINAL_FRONTEND !== 'windows-terminal') process.exit(1);
NODE
  rc=$?
  [ "$rc" -eq 0 ] || { rm -rf "$tmp"; return "$rc"; }

  cat > "$tmp/invalid.env" <<EOF
MCP_WORKSPACE_ROOT=$tmp/workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TERMINAL_FRONTEND=invalid
EOF
  output="$(env -u MCP_TERMINAL_FRONTEND HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
    --profile personal --env-file "$tmp/invalid.env" --state-dir "$tmp/personal-invalid" --repo-root "$ROOT" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] || ! grep -Fq 'MCP_TERMINAL_FRONTEND must be one of: kitty, windows-terminal' <<<"$output"; then
    rm -rf "$tmp"
    return 1
  fi

  for profile in restricted trusted-dev; do
    env -u MCP_TERMINAL_FRONTEND HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
      --profile "$profile" --env-file "$tmp/invalid.env" --state-dir "$tmp/$profile-invalid" --repo-root "$ROOT" >/dev/null || {
        rm -rf "$tmp"
        return 1
      }
  done

  rm -rf "$tmp"
}

test_owner_overlay_rendering() {
  local tmp output rc
  tmp="$(mktemp -d)" || return 1
  mkdir -p "$tmp/home" "$tmp/runtime"
  cat > "$tmp/home/context.md" <<'EOF'
# Owner context

Test owner instructions.
EOF
  cat > "$tmp/home/fake-chrome" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod 0700 "$tmp/home/fake-chrome"
  cat > "$tmp/home/gui.env" <<EOF
GALLIUM_DRIVER=d3d12
MOZ_ENABLE_WAYLAND=1
AGENT_BROWSER_PROFILE=Default
AGENT_BROWSER_EXECUTABLE_PATH=$tmp/home/fake-chrome
EOF
  chmod 0600 "$tmp/home/context.md" "$tmp/home/gui.env"
  cat > "$tmp/deployment.env" <<EOF
MCP_PUBLIC_URL=https://mcp.example.test
MCP_OWNER_CONTEXT_FILE=$tmp/home/context.md
MCP_OWNER_ENV_FILE=$tmp/home/gui.env
EOF

  env -u MCP_OWNER_CONTEXT_FILE -u MCP_OWNER_ENV_FILE HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" \
    node "$ROOT/scripts/render-config.mjs" --profile personal --env-file "$tmp/deployment.env" \
    --state-dir "$tmp/state" --repo-root "$ROOT" >/dev/null || { rm -rf "$tmp"; return 1; }

  node - "$tmp/state/1mcp/mcp.json" "$tmp/state/local-1mcp/mcp.json" "$tmp/state/owner.env" "$tmp/home/context.md" <<'NODE'
const fs = require('fs');
const [outerFile, innerFile, ownerEnvFile, contextFile] = process.argv.slice(2);
const outer = JSON.parse(fs.readFileSync(outerFile, 'utf8'));
const inner = JSON.parse(fs.readFileSync(innerFile, 'utf8'));
const dev = outer.mcpServers.dev.env;
const terminal = outer.mcpServers.terminal.env;
const browser = inner.mcpServers['browser-devtools'].env;
const fast = inner.mcpServers['browser-fast'].env;
if (dev.MCP_OWNER_CONTEXT_FILE !== contextFile) process.exit(1);
for (const env of [dev, terminal]) {
  if (env.GALLIUM_DRIVER !== 'd3d12' || env.MOZ_ENABLE_WAYLAND !== '1') process.exit(1);
}
if (browser.GALLIUM_DRIVER !== 'd3d12') process.exit(1);
if (browser.MOZ_ENABLE_WAYLAND !== undefined) process.exit(1);
if (browser.AGENT_BROWSER_PROFILE !== undefined || browser.AGENT_BROWSER_EXECUTABLE_PATH !== undefined) process.exit(1);
if (fast.GALLIUM_DRIVER !== 'd3d12') process.exit(1);
if (fast.MOZ_ENABLE_WAYLAND !== undefined) process.exit(1);
if (fast.AGENT_BROWSER_PROFILE !== 'Default') process.exit(1);
if (fast.AGENT_BROWSER_EXECUTABLE_PATH !== contextFile.replace(/context\.md$/, 'fake-chrome')) process.exit(1);
if (fs.readFileSync(ownerEnvFile, 'utf8') !== 'GALLIUM_DRIVER=d3d12\nMOZ_ENABLE_WAYLAND=1\n') process.exit(1);
if ((fs.statSync(ownerEnvFile).mode & 0o777) !== 0o600) process.exit(1);
NODE
  rc=$?
  [ "$rc" -eq 0 ] || { rm -rf "$tmp"; return "$rc"; }

  cat > "$tmp/home/gui.env" <<'EOF'
GALLIUM_DRIVER=d3d12
PATH=/tmp
EOF
  output="$(env -u MCP_OWNER_CONTEXT_FILE -u MCP_OWNER_ENV_FILE HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" \
    node "$ROOT/scripts/render-config.mjs" --profile personal --env-file "$tmp/deployment.env" \
    --state-dir "$tmp/invalid-state" --repo-root "$ROOT" 2>&1)"
  rc=$?
  rm -rf "$tmp"
  [ "$rc" -ne 0 ] && grep -Fq 'MCP_OWNER_ENV_FILE permits only: GALLIUM_DRIVER, MOZ_ENABLE_WAYLAND, AGENT_BROWSER_PROFILE, AGENT_BROWSER_EXECUTABLE_PATH' <<<"$output"
}

test_personal_default_cwd_override() {
  local tmp output rc
  tmp="$(mktemp -d)" || return 1
  mkdir -p "$tmp/home" "$tmp/runtime" "$tmp/custom-cwd"
  cat > "$tmp/deployment.env" <<EOF
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
MCP_PERSONAL_DEFAULT_CWD=$tmp/custom-cwd
EOF

  HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
    --profile personal \
    --env-file "$tmp/deployment.env" \
    --state-dir "$tmp/state" \
    --repo-root "$ROOT" >/dev/null || { rm -rf "$tmp"; return 1; }

  node - "$tmp/state/1mcp/mcp.json" "$tmp/custom-cwd" <<'NODE'
const fs = require('fs');
const [configFile, expected] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
if (config.mcpServers.dev.env.MCP_DEV_DEFAULT_CWD !== expected) process.exit(1);
if (config.mcpServers.code.env.MCP_CODE_DEFAULT_CWD !== expected) process.exit(1);
NODE
  rc=$?
  [ "$rc" -eq 0 ] || { rm -rf "$tmp"; return "$rc"; }

  cat > "$tmp/invalid.env" <<'EOF'
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
MCP_PERSONAL_DEFAULT_CWD=relative/path
EOF
  output="$(HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
    --profile personal \
    --env-file "$tmp/invalid.env" \
    --state-dir "$tmp/invalid-state" \
    --repo-root "$ROOT" 2>&1)"
  rc=$?
  rm -rf "$tmp"
  [ "$rc" -ne 0 ] && grep -qi 'absolute' <<<"$output"
}

test_personal_runtime_files_have_no_machine_home() {
  local private_user private_home
  private_user="ham""za"
  private_home="/home/$private_user"
  ! grep -R -nF "$private_home" \
    "$ROOT/config/profiles/personal.env" \
    "$ROOT/config/templates/mcp-personal.json" \
    "$ROOT/systemd/wsl-agent-terminal-broker.service.in" \
    "$ROOT/providers/terminal/tmux.mjs" \
    "$ROOT/providers/terminal/broker.mjs" \
    "$ROOT/providers/code-router/server.mjs" \
    "$ROOT/providers/local-tools/server.mjs" \
    "$ROOT/providers/browser/server.mjs" \
    "$ROOT/providers/browser-fast/server.mjs" \
    "$ROOT/config/templates/mcp-local.json" >/dev/null
}


test_personal_smoke_validation() {
  local tmp fakebin
  tmp="$(mktemp -d)" || return 1
  fakebin="$tmp/fakebin"
  mkdir -p "$fakebin" "$tmp/home" "$tmp/runtime"
  cat > "$tmp/deployment.env" <<'ENV'
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
ENV
  HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" node "$ROOT/scripts/render-config.mjs" \
    --profile personal \
    --env-file "$tmp/deployment.env" \
    --state-dir "$tmp/state" \
    --repo-root "$ROOT" >/dev/null || { rm -rf "$tmp"; return 1; }
  cat > "$fakebin/curl" <<'SH'
#!/usr/bin/env bash
printf '{}'
SH
  chmod +x "$fakebin/curl"
  HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/runtime" BRIDGE_STATE_DIR="$tmp/state" PATH="$fakebin:$PATH" \
    bash "$ROOT/scripts/smoke-local.sh" http://127.0.0.1:1/mcp >/dev/null
  local rc=$?
  rm -rf "$tmp"
  return "$rc"
}

test_pi_provider_structure() {
  node - "$ROOT/providers/pi-dev/package.json" <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = {
  '@earendil-works/pi-coding-agent': '0.84.1',
  '@modelcontextprotocol/sdk': '1.30.0',
  zod: '4.4.3',
};
for (const [name, version] of Object.entries(expected)) {
  if (pkg.dependencies?.[name] !== version) process.exit(1);
}
NODE
  for file in boundary.mjs files.mjs shell.mjs render.mjs server.mjs package-lock.json; do
    [ -f "$ROOT/providers/pi-dev/$file" ] || return 1
  done
  for file in boundary.test.mjs files.test.mjs shell.test.mjs render.test.mjs server.test.mjs; do
    [ -f "$ROOT/providers/pi-dev/test/$file" ] || return 1
  done
}

test_legacy_filesystem_dependency_removed() {
  ! grep -Fq '@modelcontextprotocol/server-filesystem' "$ROOT/config/templates/mcp.json" &&
  ! grep -Fq 'FILESYSTEM_MCP_VERSION' "$ROOT/scripts/setup.sh" &&
  ! grep -Fq '@modelcontextprotocol/server-filesystem' "$ROOT/scripts/setup.sh"
}

prepare_generic_extension_fixture() {
  local tmp="$1"
  mkdir -p "$tmp/repo/bin" "$tmp/repo/scripts" "$tmp/repo/extensions/sample-extension/memory" || return 1
  cp "$ROOT/bin/extension" "$tmp/repo/bin/extension" || return 1
  cp "$ROOT/scripts/manage-extension.mjs" "$tmp/repo/scripts/manage-extension.mjs" || return 1
  chmod +x "$tmp/repo/bin/extension" || return 1
  cat > "$tmp/repo/extensions/sample-extension/extension.json" <<'EOF'
{"version":1,"name":"sample-extension","required_artifacts":["sample-extension.input"],"required_sources":["profile","portfolio"],"memory":[{"source":"memory/shared.json","target":"platforms/example.test/match.json","lifetime":"shared"},{"source":"memory/rule.md","target":"sites/example.test/rule.md","lifetime":"extension"}]}
EOF
  printf '{}\n' > "$tmp/repo/extensions/sample-extension/memory/shared.json"
  printf 'sample extension rule\n' > "$tmp/repo/extensions/sample-extension/memory/rule.md"
}

test_optional_extension_lifecycle() {
  local tmp config output rc
  tmp="$(mktemp -d)" || return 1
  config="$tmp/config"
  prepare_generic_extension_fixture "$tmp" || { rm -rf "$tmp"; return 1; }
  mkdir -p "$config/extensions/config" "$tmp/portfolio" || { rm -rf "$tmp"; return 1; }
  printf 'input\n' > "$tmp/input.txt"
  printf '# profile\n' > "$tmp/profile.md"
  printf '{"version":1,"artifacts":{"sample-extension.input":"%s"},"sources":{"profile":"%s","portfolio":"%s"}}\n' \
    "$tmp/input.txt" "$tmp/profile.md" "$tmp/portfolio" > "$config/extensions/config/sample-extension.json"

  output="$(NODE_ENV=test MCP_EXTENSION_TEST_CONFIG_ROOT="$config" MCP_BROWSER_ARTIFACTS_FILE="$tmp/unsupported-artifacts.json" "$tmp/repo/bin/extension" install sample-extension 2>&1)"
  rc=$?
  [ "$rc" -ne 0 ] || { rm -rf "$tmp"; return 1; }
  grep -Fq 'UNSUPPORTED_EXTENSION_OVERRIDE' <<<"$output" || { rm -rf "$tmp"; return 1; }
  [ ! -e "$tmp/unsupported-artifacts.json" ] || { rm -rf "$tmp"; return 1; }

  NODE_ENV=test MCP_EXTENSION_TEST_CONFIG_ROOT="$config" "$tmp/repo/bin/extension" install sample-extension >/dev/null || { rm -rf "$tmp"; return 1; }
  [ -f "$config/browser-memory/platforms/example.test/match.json" ] || { rm -rf "$tmp"; return 1; }
  [ -f "$config/browser-memory/sites/example.test/rule.md" ] || { rm -rf "$tmp"; return 1; }
  node - "$config/browser-artifacts.json" "$config/extensions/enabled/sample-extension.json" <<'NODE' || { rm -rf "$tmp"; return 1; }
const fs = require('fs');
const artifacts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const state = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (!artifacts['sample-extension.input']) process.exit(1);
for (const key of ['profile', 'portfolio']) {
  if (!state.sources?.[key]) process.exit(1);
}
if (!state.memory.every(item => item.owned === true)) process.exit(1);
NODE

  NODE_ENV=test MCP_EXTENSION_TEST_CONFIG_ROOT="$config" "$tmp/repo/bin/extension" remove sample-extension >/dev/null || { rm -rf "$tmp"; return 1; }
  [ -f "$config/browser-memory/platforms/example.test/match.json" ] || { rm -rf "$tmp"; return 1; }
  [ ! -e "$config/browser-memory/sites/example.test/rule.md" ] || { rm -rf "$tmp"; return 1; }
  [ -f "$tmp/profile.md" ] && [ -d "$tmp/portfolio" ] || { rm -rf "$tmp"; return 1; }
  node - "$config/browser-artifacts.json" <<'NODE' || { rm -rf "$tmp"; return 1; }
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value['sample-extension.input'] !== undefined) process.exit(1);
NODE

  NODE_ENV=test MCP_EXTENSION_TEST_CONFIG_ROOT="$config" "$tmp/repo/bin/extension" install sample-extension >/dev/null || { rm -rf "$tmp"; return 1; }
  NODE_ENV=test MCP_EXTENSION_TEST_CONFIG_ROOT="$config" "$tmp/repo/bin/extension" list | grep -Fq '"enabled": true' || { rm -rf "$tmp"; return 1; }

  chmod 0500 "$config/extensions/enabled" || { rm -rf "$tmp"; return 1; }
  output="$(NODE_ENV=test MCP_EXTENSION_TEST_CONFIG_ROOT="$config" "$tmp/repo/bin/extension" remove sample-extension 2>&1)"
  rc=$?
  chmod 0700 "$config/extensions/enabled"
  [ "$rc" -ne 0 ] || { rm -rf "$tmp"; return 1; }
  [ -f "$config/extensions/enabled/sample-extension.json" ] || { rm -rf "$tmp"; return 1; }
  [ -f "$config/browser-memory/sites/example.test/rule.md" ] || { rm -rf "$tmp"; return 1; }
  node - "$config/browser-artifacts.json" <<'NODE' || { rm -rf "$tmp"; return 1; }
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!value['sample-extension.input']) process.exit(1);
NODE
  rm -rf "$tmp"
}

test_extension_memory_lifetime_ownership() {
  local tmp config output rc
  tmp="$(mktemp -d)" || return 1
  config="$tmp/config"
  mkdir -p "$tmp/repo/scripts" "$tmp/repo/extensions/ext-a/memory" "$tmp/repo/extensions/ext-b/memory" "$config/extensions/config" || { rm -rf "$tmp"; return 1; }
  cp "$ROOT/scripts/manage-extension.mjs" "$tmp/repo/scripts/manage-extension.mjs" || { rm -rf "$tmp"; return 1; }
  printf 'same extension memory\n' > "$tmp/repo/extensions/ext-a/memory/rule.md"
  cp "$tmp/repo/extensions/ext-a/memory/rule.md" "$tmp/repo/extensions/ext-b/memory/rule.md"
  cat > "$tmp/repo/extensions/ext-a/extension.json" <<'EOF'
{"version":1,"name":"ext-a","required_artifacts":[],"required_sources":[],"memory":[{"source":"memory/rule.md","target":"sites/example.test/rule.md","lifetime":"extension"}]}
EOF
  cat > "$tmp/repo/extensions/ext-b/extension.json" <<'EOF'
{"version":1,"name":"ext-b","required_artifacts":[],"required_sources":[],"memory":[{"source":"memory/rule.md","target":"sites/example.test/rule.md","lifetime":"extension"}]}
EOF

  NODE_ENV=test MCP_EXTENSION_TEST_CONFIG_ROOT="$config" node "$tmp/repo/scripts/manage-extension.mjs" install ext-a >/dev/null || { rm -rf "$tmp"; return 1; }
  output="$(NODE_ENV=test MCP_EXTENSION_TEST_CONFIG_ROOT="$config" node "$tmp/repo/scripts/manage-extension.mjs" install ext-b 2>&1)"
  rc=$?
  [ "$rc" -ne 0 ] || { rm -rf "$tmp"; return 1; }
  grep -Fq 'EXTENSION_MEMORY_CONFLICT' <<<"$output" || { rm -rf "$tmp"; return 1; }
  [ ! -e "$config/extensions/enabled/ext-b.json" ] || { rm -rf "$tmp"; return 1; }
  [ -f "$config/browser-memory/sites/example.test/rule.md" ] || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_extension_install_preflights_required_config() {
  local tmp config output rc
  tmp="$(mktemp -d)" || return 1
  config="$tmp/config"
  prepare_generic_extension_fixture "$tmp" || { rm -rf "$tmp"; return 1; }
  mkdir -p "$config/extensions/config" || { rm -rf "$tmp"; return 1; }
  printf 'input\n' > "$tmp/input.txt"
  printf '# profile\n' > "$tmp/profile.md"
  printf '{"version":1,"artifacts":{"sample-extension.input":"%s"},"sources":{"profile":"%s"}}\n' \
    "$tmp/input.txt" "$tmp/profile.md" > "$config/extensions/config/sample-extension.json"

  output="$(NODE_ENV=test MCP_EXTENSION_TEST_CONFIG_ROOT="$config" "$tmp/repo/bin/extension" install sample-extension 2>&1)"
  rc=$?
  [ "$rc" -ne 0 ] || { rm -rf "$tmp"; return 1; }
  grep -Fq 'EXTENSION_CONFIG_REQUIRED' <<<"$output" || { rm -rf "$tmp"; return 1; }
  [ ! -e "$config/extensions/enabled/sample-extension.json" ] || { rm -rf "$tmp"; return 1; }
  [ ! -e "$config/browser-artifacts.json" ] || { rm -rf "$tmp"; return 1; }
  [ ! -d "$config/browser-memory" ] || [ -z "$(find "$config/browser-memory" -type f -print -quit 2>/dev/null)" ] || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

run_test 'raw CodeDB catalog stays behind the Code facade' test_raw_codedb_surface_removed
run_test 'final rendered composition places Browser behind Local only in personal mode' test_final_rendered_composition
run_test 'Dev spool deployment override rejects invalid values' test_dev_spool_limit_validation
run_test '1MCP rotating log deployment policy rejects invalid values' test_one_mcp_log_policy_validation
run_test 'personal Terminal frontend selector defaults, overrides, and validates in profile scope' test_terminal_frontend_selector
run_test 'personal owner overlay sanitizes and propagates GUI policy' test_owner_overlay_rendering
run_test 'personal default cwd supports an absolute deployment override' test_personal_default_cwd_override
run_test 'personal runtime files carry no machine-specific home path' test_personal_runtime_files_have_no_machine_home
run_test 'personal smoke validation accepts the Personal Workstation provider contract' test_personal_smoke_validation
run_test 'personal toolbox contract passes' bash "$ROOT/tests/personal-toolbox.sh"
run_test 'Pi dev provider pins and structure are complete' test_pi_provider_structure
run_test 'legacy filesystem dependency is removed after Pi cutover' test_legacy_filesystem_dependency_removed
run_test 'optional extensions install and remove without changing Browser core' test_optional_extension_lifecycle
run_test 'extension-lifetime browser memory cannot acquire multiple owners' test_extension_memory_lifetime_ownership
run_test 'extension install preflights required config before mutation' test_extension_install_preflights_required_config

printf '\n%d tests, %d failures\n' "$TESTS" "$FAILURES"
[ "$FAILURES" -eq 0 ]
