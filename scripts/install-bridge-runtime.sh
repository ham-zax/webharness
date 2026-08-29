#!/usr/bin/env bash
set -euo pipefail

ONE_MCP_VERSION="0.36.0"
SHELL_MCP_VERSION="1.1.8"

echo "== installing pinned 1MCP aggregator =="
npm install -g "@1mcp/agent@$ONE_MCP_VERSION"

echo "== applying pinned 1MCP OAuth callback compatibility =="
SDK_PROVIDER="$(npm root -g)/@1mcp/agent/build/auth/sdkOAuthServerProvider.js"
node --input-type=module - "$SDK_PROVIDER" <<'NODE'
import fs from 'node:fs';
const [providerPath] = process.argv.slice(2);
const upstream = `    if (!LOOPBACK_HOSTS.has(requested.hostname)) {
        return null;
    }`;
const patched = `    if (!LOOPBACK_HOSTS.has(requested.hostname)) {
        return requested.protocol === 'https:' && registeredRedirectUris.includes(requestedRedirectUri)
            ? requested.origin
            : null;
    }`;

let source = fs.readFileSync(providerPath, 'utf8');
if (source.includes(upstream)) {
  source = source.replace(upstream, patched);
  fs.writeFileSync(providerPath, source);
} else if (!source.includes(patched)) {
  throw new Error('pinned 1MCP OAuth provider source shape changed; refusing an unsafe patch');
}
NODE
echo "  patched exact registered HTTPS OAuth callbacks"

echo "== applying pinned 1MCP restart-stable log rotation =="
LOGGER_IMPL="$(npm root -g)/@1mcp/agent/build/logger/logger.js"
node --input-type=module - "$LOGGER_IMPL" <<'NODE'
import fs from 'node:fs';
const [loggerPath] = process.argv.slice(2);
const upstream = '            ...(options.maxFiles ? { maxFiles: options.maxFiles } : {}),';
const patched = '            ...(options.maxFiles ? { maxFiles: options.maxFiles, tailable: options.maxFiles > 1 } : {}),';

let source = fs.readFileSync(loggerPath, 'utf8');
if (source.includes(upstream)) {
  source = source.replace(upstream, patched);
  fs.writeFileSync(loggerPath, source);
} else if (!source.includes(patched)) {
  throw new Error('pinned 1MCP logger source shape changed; refusing an unsafe rotation patch');
}
NODE
echo "  patched restart-stable tailable rotation"

echo "== verifying pinned 1MCP native log rotation =="
LOGGING_CONFIG="$(npm root -g)/@1mcp/agent/build/logger/loggingConfig.js"
LOGGER_IMPL="$(npm root -g)/@1mcp/agent/build/logger/logger.js"
node --input-type=module - "$LOGGING_CONFIG" "$LOGGER_IMPL" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [loggingConfigPath, loggerPath] = process.argv.slice(2);
const { resolveLoggingConfig } = await import(pathToFileURL(loggingConfigPath).href);
const { resolved } = resolveLoggingConfig({ structured: { file: '/tmp/one-mcp.log', maxSize: '10m', maxFiles: 5 } });
if (resolved.maxSize !== 10 * 1024 * 1024 || resolved.maxFiles !== 5) {
  throw new Error('pinned 1MCP did not resolve structured maxSize/maxFiles as expected');
}
const loggerSource = fs.readFileSync(loggerPath, 'utf8');
if (!loggerSource.includes('maxsize: options.maxSize') ||
    !loggerSource.includes('maxFiles: options.maxFiles, tailable: options.maxFiles > 1')) {
  throw new Error('pinned 1MCP logger does not expose restart-stable native size/file-count rotation');
}
NODE
echo "  verified native log rotation (structured maxSize/maxFiles)"

echo "== verifying WebHarness prerequisites =="
for cmd in node npm npx uv uvx cloudflared curl flock; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd missing" >&2; exit 1; }
done

echo "  1MCP:           @1mcp/agent@$ONE_MCP_VERSION"
echo "  shell MCP:      mcp-shell-server==$SHELL_MCP_VERSION"
echo "  cloudflared:    $(cloudflared --version 2>/dev/null | head -n1)"
echo "  node:           $(node -v)"
