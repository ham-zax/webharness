#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib/bridge/common.sh"

CONFIG="$BRIDGE_CONFIG_DIR/mcp.json"
if [ -f "$CONFIG" ]; then
  node - "$CONFIG" "$DIR" "${MCP_BRIDGE_PROFILE:-}" <<'NODE'
const fs = require('fs');
const path = require('path');
const [configFile, repoRoot, profile] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const dev = cfg.mcpServers?.dev;
const code = cfg.mcpServers?.code;
const terminal = cfg.mcpServers?.terminal;
const local = cfg.mcpServers?.local;
if (cfg.mcpServers?.filesystem) throw new Error('filesystem provider must be absent after Pi cutover');
if (cfg.mcpServers?.codedb) throw new Error('raw codedb provider must remain hidden behind the Code facade');
if (cfg.mcpServers?.['browser-devtools'] || cfg.mcpServers?.['browser-fast']) throw new Error('Browser providers must remain behind the Local broker');
if (profile) {
  const actual = Object.keys(cfg.mcpServers ?? {}).sort();
  const expected = profile === 'trusted-dev' ? ['dev'] : profile === 'restricted' ? ['dev', 'shell'] : profile === 'personal' ? ['code', 'dev', 'local', 'terminal'] : null;
  if (!expected || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected final provider set for ${profile || 'unknown'}: ${actual.join(',')}`);
  }
}
if (local) {
  if (profile !== 'personal') throw new Error('Local broker is private to the personal profile');
  if (local.command !== 'node') throw new Error('Local broker must run with node');
  const expectedServer = path.join(repoRoot, 'providers', 'local-tools', 'server.mjs');
  if (JSON.stringify(local.args ?? []) !== JSON.stringify([expectedServer])) throw new Error('unexpected Local broker server path');
  const env = local.env ?? {};
  if (!path.isAbsolute(env.MCP_LOCAL_INNER_CONFIG ?? '')) throw new Error('Local inner config path must be absolute');
  if (!path.isAbsolute(env.MCP_LOCAL_ONE_MCP_ENTRY ?? '')) throw new Error('Local inner 1MCP entry path must be absolute');
  if (!env.MCP_LOCAL_ONE_MCP_ENTRY.endsWith('/@1mcp/agent/build/index.js')) throw new Error('unexpected Local inner 1MCP entry path');
  if (JSON.stringify(local.tags ?? []) !== JSON.stringify(['local'])) throw new Error('Local broker must use only the local tag');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'providers', 'local-tools', 'package.json'), 'utf8'));
  if (pkg.dependencies?.['@modelcontextprotocol/sdk'] !== '1.30.0') throw new Error('unexpected Local broker MCP SDK pin');
  const installedSdk = JSON.parse(fs.readFileSync(path.join(repoRoot, 'providers', 'local-tools', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8'));
  if (installedSdk.version !== '1.30.0') throw new Error(`unexpected installed Local broker MCP SDK version: ${installedSdk.version}`);

  const inner = JSON.parse(fs.readFileSync(env.MCP_LOCAL_INNER_CONFIG, 'utf8'));
  const innerNames = Object.keys(inner.mcpServers ?? {}).sort();
  if (JSON.stringify(innerNames) !== JSON.stringify(['browser-devtools', 'browser-fast'])) throw new Error(`unexpected Local inner provider set: ${innerNames.join(',')}`);
  const browser = inner.mcpServers['browser-devtools'];
  if (browser.command !== 'node') throw new Error('inner Browser facade must run with node');
  const expectedBrowserServer = path.join(repoRoot, 'providers', 'browser', 'server.mjs');
  if (JSON.stringify(browser.args ?? []) !== JSON.stringify([expectedBrowserServer])) throw new Error('unexpected inner Browser facade server path');
  const browserEnv = browser.env ?? {};
  if (!path.isAbsolute(browserEnv.XDG_RUNTIME_DIR ?? '')) throw new Error('Browser XDG_RUNTIME_DIR must be absolute');
  if (browserEnv.WAYLAND_DISPLAY !== 'wayland-0' || browserEnv.DISPLAY !== ':0' || browserEnv.PULSE_SERVER !== 'unix:/mnt/wslg/PulseServer') throw new Error('unexpected Browser WSLg environment');
  if (browser.tags !== undefined) throw new Error('inner Browser provider must not carry an outer OAuth tag');
  const browserPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'providers', 'browser', 'package.json'), 'utf8'));
  if (browserPkg.dependencies?.['@modelcontextprotocol/sdk'] !== '1.30.0') throw new Error('unexpected Browser MCP SDK pin');
  if (browserPkg.dependencies?.zod !== '4.4.3') throw new Error('unexpected Browser zod pin');

  const fast = inner.mcpServers['browser-fast'];
  if (fast.command !== 'node') throw new Error('inner Browser Fast provider must run with node');
  const expectedFastServer = path.join(repoRoot, 'providers', 'browser-fast', 'server.mjs');
  if (JSON.stringify(fast.args ?? []) !== JSON.stringify([expectedFastServer])) throw new Error('unexpected inner Browser Fast server path');
  const fastEnv = fast.env ?? {};
  if (!path.isAbsolute(fastEnv.XDG_RUNTIME_DIR ?? '')) throw new Error('Browser Fast XDG_RUNTIME_DIR must be absolute');
  if (fastEnv.WAYLAND_DISPLAY !== 'wayland-0' || fastEnv.DISPLAY !== ':0' || fastEnv.PULSE_SERVER !== 'unix:/mnt/wslg/PulseServer') throw new Error('unexpected Browser Fast WSLg environment');
  if (fast.tags !== undefined) throw new Error('inner Browser Fast provider must not carry an outer OAuth tag');
  const fastPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'providers', 'browser-fast', 'package.json'), 'utf8'));
  if (fastPkg.dependencies?.['@modelcontextprotocol/sdk'] !== '1.30.0') throw new Error('unexpected Browser Fast MCP SDK pin');
  if (fastPkg.dependencies?.['agent-browser'] !== '0.35.0') throw new Error('unexpected Browser Fast Agent Browser pin');
  if (fastPkg.dependencies?.zod !== '4.4.3') throw new Error('unexpected Browser Fast zod pin');
}
if (terminal) {
  if (profile !== 'personal') throw new Error('Terminal provider is available only in the personal profile');
  if (terminal.command !== 'node') throw new Error('Terminal provider must run with node');
  const expectedServer = path.join(repoRoot, 'providers', 'terminal', 'mcp-server.mjs');
  if (JSON.stringify(terminal.args ?? []) !== JSON.stringify([expectedServer])) throw new Error('unexpected Terminal provider server path');
  const env = terminal.env ?? {};
  if (!path.isAbsolute(env.MCP_TERMINAL_SOCKET ?? '')) throw new Error('MCP_TERMINAL_SOCKET must be absolute');
  if (path.basename(env.MCP_TERMINAL_SOCKET) !== 'wsl-agent-terminal.sock') throw new Error('unexpected Terminal broker socket name');
  if (env.MCP_TERMINAL_READ_MAX_BYTES !== '65536') throw new Error('unexpected Terminal read limit');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'providers', 'terminal', 'package.json'), 'utf8'));
  if (pkg.dependencies?.['@modelcontextprotocol/sdk'] !== '1.30.0') throw new Error('unexpected Terminal MCP SDK pin');
  if (pkg.dependencies?.zod !== '4.4.3') throw new Error('unexpected Terminal zod pin');
  const installedSdk = JSON.parse(fs.readFileSync(path.join(repoRoot, 'providers', 'terminal', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8'));
  if (installedSdk.version !== '1.30.0') throw new Error(`unexpected installed Terminal MCP SDK version: ${installedSdk.version}`);
  const installedZod = JSON.parse(fs.readFileSync(path.join(repoRoot, 'providers', 'terminal', 'node_modules', 'zod', 'package.json'), 'utf8'));
  if (installedZod.version !== '4.4.3') throw new Error(`unexpected installed Terminal zod version: ${installedZod.version}`);
}
if (code) {
  if (profile !== 'personal') throw new Error('Code facade is private to the personal profile');
  if (code.command !== 'node') throw new Error('Code facade must run with node');
  const expectedServer = path.join(repoRoot, 'providers', 'code-router', 'server.mjs');
  if (JSON.stringify(code.args ?? []) !== JSON.stringify([expectedServer])) throw new Error('unexpected Code facade server path');
  const env = code.env ?? {};
  if (!path.isAbsolute(env.MCP_CODE_DEFAULT_CWD ?? '')) throw new Error('personal MCP_CODE_DEFAULT_CWD must be absolute');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'providers', 'code-router', 'package.json'), 'utf8'));
  if (pkg.dependencies?.['@modelcontextprotocol/sdk'] !== '1.30.0') throw new Error('unexpected Code facade MCP SDK pin');
  if (pkg.dependencies?.zod !== '4.4.3') throw new Error('unexpected Code facade zod pin');
  const installedSdk = JSON.parse(fs.readFileSync(path.join(repoRoot, 'providers', 'code-router', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8'));
  if (installedSdk.version !== '1.30.0') throw new Error(`unexpected installed Code facade MCP SDK version: ${installedSdk.version}`);
}
if (dev) {
  const pkgFile = path.join(repoRoot, 'providers', 'pi-dev', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  if (pkg.version !== '0.84.1') throw new Error(`unexpected Pi version: ${pkg.version}`);
  const env = dev.env ?? {};
  if (!path.isAbsolute(env.MCP_DEV_STATE_DIR ?? '')) throw new Error('MCP_DEV_STATE_DIR must be absolute');
  if (!/^[1-9][0-9]*$/.test(env.MCP_DEV_MAX_OUTPUT_BYTES ?? '')) throw new Error('MCP_DEV_MAX_OUTPUT_BYTES must be a positive integer');
  if (!/^[1-9][0-9]*$/.test(env.MCP_DEV_MAX_SPOOL_BYTES ?? '')) throw new Error('MCP_DEV_MAX_SPOOL_BYTES must be a positive integer');
  if (!/^[1-9][0-9]*$/.test(env.MCP_DEV_SPOOL_TTL_SECONDS ?? '')) throw new Error('MCP_DEV_SPOOL_TTL_SECONDS must be a positive integer');
  if (!/^[1-9][0-9]*$/.test(env.MCP_DEV_SPOOL_MAX_TOTAL_BYTES ?? '')) throw new Error('MCP_DEV_SPOOL_MAX_TOTAL_BYTES must be a positive integer');
  if (Number(env.MCP_DEV_SPOOL_MAX_TOTAL_BYTES) < Number(env.MCP_DEV_MAX_SPOOL_BYTES)) throw new Error('MCP_DEV_SPOOL_MAX_TOTAL_BYTES must be >= MCP_DEV_MAX_SPOOL_BYTES');
  if (!['allowlist', 'unrestricted'].includes(env.MCP_DEV_SHELL_MODE)) throw new Error('MCP_DEV_SHELL_MODE must be allowlist or unrestricted');
  if (profile === 'personal') {
    if (env.MCP_DEV_PATH_MODE !== 'user') throw new Error('personal MCP_DEV_PATH_MODE must be user');
    if (!path.isAbsolute(env.MCP_DEV_DEFAULT_CWD ?? '')) throw new Error('personal MCP_DEV_DEFAULT_CWD must be absolute');
    if (env.MCP_DEV_WORKSPACE_ROOT !== undefined) throw new Error('personal dev provider must not use MCP_DEV_WORKSPACE_ROOT');
    if (!path.isAbsolute(env.MCP_DEV_TERMINAL_SOCKET ?? '')) throw new Error('personal MCP_DEV_TERMINAL_SOCKET must be absolute');
    if (path.basename(env.MCP_DEV_TERMINAL_SOCKET) !== 'wsl-agent-terminal.sock') throw new Error('unexpected personal dev Terminal broker socket name');
  } else {
    if (env.MCP_DEV_PATH_MODE !== 'workspace') throw new Error('public MCP_DEV_PATH_MODE must be workspace');
    if (!path.isAbsolute(env.MCP_DEV_WORKSPACE_ROOT ?? '')) throw new Error('MCP_DEV_WORKSPACE_ROOT must be absolute');
    if (env.MCP_DEV_DEFAULT_CWD !== undefined) throw new Error('public dev provider must not set MCP_DEV_DEFAULT_CWD');
    if (env.MCP_DEV_TERMINAL_SOCKET !== undefined) throw new Error('public dev provider must not set MCP_DEV_TERMINAL_SOCKET');
  }
}
NODE
fi

APP_CONFIG="$BRIDGE_CONFIG_DIR/config.toml"
if [ ! -f "$APP_CONFIG" ]; then
  echo "missing 1MCP app config: $APP_CONFIG (re-render the deployment before starting the bridge)" >&2
  exit 1
fi
node - "$APP_CONFIG" "$BRIDGE_ONE_MCP_LOG_FILE" <<'NODE'
const fs = require('fs');
const [configFile, expectedLogFile] = process.argv.slice(2);
const text = fs.readFileSync(configFile, 'utf8');
if (!text.includes('[auth]')) throw new Error('1MCP config.toml must contain [auth]');
const sessionTtl = Number(text.match(/^sessionTtl\s*=\s*(\d+)$/m)?.[1]);
if (sessionTtl !== 43200) throw new Error('1MCP auth.sessionTtl must be 43200 minutes');
if (!text.includes('[logging]')) throw new Error('1MCP config.toml must contain [logging]');
if (!text.includes(`file = ${JSON.stringify(expectedLogFile)}`)) throw new Error('1MCP logging.file must target the bridge state log path');
const size = Number(text.match(/^maxSize\s*=\s*(\d+)$/m)?.[1]);
const files = Number(text.match(/^maxFiles\s*=\s*(\d+)$/m)?.[1]);
if (!Number.isInteger(size) || size < 1048576 || size > 67108864) throw new Error('1MCP logging.maxSize is outside bridge policy');
if (!Number.isInteger(files) || files < 1 || files > 10) throw new Error('1MCP logging.maxFiles is outside bridge policy');
NODE

URL="${1:-http://127.0.0.1:3050/mcp}"
echo "== MCP initialize against $URL =="
curl -sf -m 5 -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}'
echo
echo
echo "(connectivity check only; inspect dev plus restricted-only shell for public profiles, or Dev/Code/Terminal plus the three-tool Local broker for personal composition)"
