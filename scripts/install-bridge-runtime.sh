#!/usr/bin/env bash
set -euo pipefail

ONE_MCP_VERSION="0.39.8"

if [ "${1:-}" = "--headless" ]; then
  shift
fi
if [ "$#" -gt 0 ]; then
  echo "unknown argument: $1 (usage: install-bridge-runtime.sh [--headless])" >&2
  exit 2
fi

echo "== installing pinned 1MCP aggregator =="
npm install -g "@1mcp/agent@$ONE_MCP_VERSION"

echo "== applying pinned 1MCP OAuth callback compatibility =="
SDK_PROVIDER="$(npm root -g)/@1mcp/agent/build/sdk/legacy/auth/sdkOAuthServerProvider.js"
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

echo "== applying pinned 1MCP consent redirect compatibility =="
OAUTH_ROUTES="$(npm root -g)/@1mcp/agent/build/transport/http/routes/oauthRoutes.js"
node --input-type=module - "$OAUTH_ROUTES" <<'NODE'
import fs from 'node:fs';
const [routesPath] = process.argv.slice(2);
const upstream = `            if (result.status === 'approved_redirect' || result.status === 'denied_redirect') {
                res.redirect(result.redirectUrl);
                return;
            }`;
const patched = `            if (result.status === 'approved_redirect' || result.status === 'denied_redirect') {
                const target = result.redirectUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Referrer-Policy', 'no-referrer');
                res.type('html').send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' + target + '"><title>Returning to the application</title></head><body><a href="' + target + '">Continue</a></body></html>');
                return;
            }`;

let source = fs.readFileSync(routesPath, 'utf8');
if (source.includes(upstream)) {
  source = source.replace(upstream, patched);
  fs.writeFileSync(routesPath, source);
} else if (!source.includes(patched)) {
  throw new Error('pinned 1MCP consent handler source shape changed; refusing an unsafe redirect patch');
}
NODE
echo "  patched consent completion to navigate outside form-action"

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

echo "== applying pinned 1MCP legacy capacity error passthrough =="
ERROR_HANDLING="$(npm root -g)/@1mcp/agent/build/utils/core/errorHandling.js"
node --input-type=module - "$ERROR_HANDLING" <<'NODE'
import fs from 'node:fs';
const [errorHandlingPath] = process.argv.slice(2);
const upstream = `            // Rethrow MCPErrors as is
            if (error instanceof MCPError) {
                throw error;
            }`;
const patched = `            // Rethrow MCPErrors and 1MCP's own legacy admission capacity errors as is
            if (error instanceof MCPError ||
                (error?.name === 'McpError' && error?.code === -32000 && error?.message === 'MCP error -32000: interaction_capacity_exceeded')) {
                throw error;
            }`;

let source = fs.readFileSync(errorHandlingPath, 'utf8');
if (source.includes(upstream)) {
  source = source.replace(upstream, patched);
  fs.writeFileSync(errorHandlingPath, source);
} else if (!source.includes(patched)) {
  throw new Error('pinned 1MCP errorHandling.js source shape changed; refusing an unsafe capacity error patch');
}
NODE
echo "  patched pre-dispatch interaction_capacity_exceeded error passthrough"

echo "== verifying pinned 1MCP supervised-restart capability preservation =="
SUPERVISOR_IMPL="$(npm root -g)/@1mcp/agent/build/core/server/backendStdioSupervisor.js"
node --input-type=module - "$SUPERVISOR_IMPL" <<'NODE'
import fs from 'node:fs';
const [supervisorPath] = process.argv.slice(2);
const source = fs.readFileSync(supervisorPath, 'utf8');
const stateIdx = source.indexOf("this.state = 'connected';");
const activateIdx = source.indexOf('result.activate?.();');
if (stateIdx === -1 || activateIdx === -1 || stateIdx >= activateIdx) {
  throw new Error('pinned 1MCP stdio supervisor does not set connected state before activate()');
}
NODE
echo "  verified upstream supervised restart capability preservation (#547)"

echo "== applying pinned 1MCP clean tool namespacing =="
MCP_CONSTANTS="$(npm root -g)/@1mcp/agent/build/constants/mcp.js"
node --input-type=module - "$MCP_CONSTANTS" <<'NODE'
import fs from 'node:fs';
const [constantsPath] = process.argv.slice(2);

const upstreamSep = "export const MCP_URI_SEPARATOR = '_1mcp_';";
const legacyPatchedSep = "export const MCP_URI_SEPARATOR = process.env.ONE_MCP_URI_SEPARATOR || '_';";
const patchedSep = "export const MCP_URI_SEPARATOR = process.env.WEBHARNESS_MCP_URI_SEPARATOR || '_';";
let constantsSrc = fs.readFileSync(constantsPath, 'utf8');
if (constantsSrc.includes(upstreamSep)) {
  constantsSrc = constantsSrc.replace(upstreamSep, patchedSep);
  fs.writeFileSync(constantsPath, constantsSrc);
} else if (constantsSrc.includes(legacyPatchedSep)) {
  constantsSrc = constantsSrc.replace(legacyPatchedSep, patchedSep);
  fs.writeFileSync(constantsPath, constantsSrc);
} else if (!constantsSrc.includes(patchedSep)) {
  throw new Error('pinned 1MCP constants/mcp.js source shape changed; refusing an unsafe separator patch');
}


NODE
echo "  patched clean {server}_{tool} namespacing"

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
REQUIRED_CMDS=(node npm npx cloudflared curl flock)
for cmd in "${REQUIRED_CMDS[@]}"; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd missing" >&2; exit 1; }
done

echo "  1MCP:           @1mcp/agent@$ONE_MCP_VERSION"
echo "  cloudflared:    $(cloudflared --version 2>/dev/null | head -n1)"
echo "  node:           $(node -v)"
