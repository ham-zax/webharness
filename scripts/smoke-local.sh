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
if (profile) {
  const actual = Object.keys(cfg.mcpServers ?? {}).sort();
  const expected = profile === 'trusted-dev' || profile === 'restricted' ? ['dev'] : null;
  if (!expected || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected final provider set for ${profile || 'unknown'}: ${actual.join(',')}`);
  }
}
if (dev) {
  const pkgFile = path.join(repoRoot, 'providers', 'pi-dev', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  if (pkg.version !== '0.84.1') throw new Error(`unexpected Pi version: ${pkg.version}`);
  const env = dev.env ?? {};
  if (!path.isAbsolute(env.MCP_DEV_WORKSPACE_ROOT ?? '')) throw new Error('MCP_DEV_WORKSPACE_ROOT must be absolute');
  if (!path.isAbsolute(env.MCP_DEV_STATE_DIR ?? '')) throw new Error('MCP_DEV_STATE_DIR must be absolute');
  if (!/^[1-9][0-9]*$/.test(env.MCP_DEV_MAX_OUTPUT_BYTES ?? '')) throw new Error('MCP_DEV_MAX_OUTPUT_BYTES must be a positive integer');
  if (!['disabled', 'unrestricted'].includes(env.MCP_DEV_SHELL_MODE)) throw new Error('MCP_DEV_SHELL_MODE must be disabled or unrestricted');
}
NODE
fi

URL="${1:-http://127.0.0.1:3050/mcp}"
echo "== MCP initialize against $URL =="
curl -sf -m 5 -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}'
echo
echo
echo "(connectivity check only; final tool surface: restricted Read/Edit/Write, trusted-dev Read/Edit/Write/Bash)"
