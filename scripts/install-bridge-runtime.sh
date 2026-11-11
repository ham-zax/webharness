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

echo "== applying pinned 1MCP clean tool namespacing and instructions =="
MCP_CONSTANTS="$(npm root -g)/@1mcp/agent/build/constants/mcp.js"
TEMPLATE_TYPES="$(npm root -g)/@1mcp/agent/build/core/instructions/templateTypes.js"
TEMPLATE_VALIDATOR="$(npm root -g)/@1mcp/agent/build/core/instructions/templateValidator.js"
node --input-type=module - "$MCP_CONSTANTS" "$TEMPLATE_TYPES" "$TEMPLATE_VALIDATOR" <<'NODE'
import fs from 'node:fs';
const [constantsPath, templateTypesPath, validatorPath] = process.argv.slice(2);

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

const patchedTemplateBlock = `export const DEFAULT_TEMPLATE_EXAMPLES = [
    {
        name: 'dev_read',
        description: 'Read files through the dev server',
    },
    {
        name: 'dev_search',
        description: 'Search text across files through the dev server',
    },
    {
        name: 'local_tool_call',
        description: 'Invoke a downstream workstation tool through the local broker',
    },
];
/**
 * Default template configuration values
 */
export const DEFAULT_TEMPLATE_CONFIG = {
    title: 'WebHarness MCP Gateway',
    toolPattern: '{server}_{tool}',
    examples: DEFAULT_TEMPLATE_EXAMPLES,
    templateSizeLimit: 1024 * 1024, // 1MB default
};
/**
 * Default instruction template using Handlebars syntax
 * This template is used when no custom template is provided
 */
export const DEFAULT_INSTRUCTION_TEMPLATE = \`{{#each servers}}{{#if hasInstructions}}<{{name}}>
{{instructions}}
</{{name}}>

{{/if}}{{/each}}Tools are namespaced by server as \\\`{server}_{tool}\\\`.\`;`;

let typesSrc = fs.readFileSync(templateTypesPath, 'utf8');
if (!typesSrc.includes("title: 'WebHarness MCP Gateway'")) {
  const startMarker = 'export const DEFAULT_TEMPLATE_EXAMPLES = [';
  const endMarker = '/** Built-in direct CLI variant matching the established `1mcp instructions` layout. */';
  const startIdx = typesSrc.indexOf(startMarker);
  const endIdx = typesSrc.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('pinned 1MCP templateTypes.js source shape changed; refusing an unsafe template patch');
  }
  typesSrc = `${typesSrc.slice(0, startIdx)}${patchedTemplateBlock}\n${typesSrc.slice(endIdx)}`;
  fs.writeFileSync(templateTypesPath, typesSrc);
}

let validatorSrc = fs.readFileSync(validatorPath, 'utf8');
if (validatorSrc.includes("toolPattern: '{server}_1mcp_{tool}',")) {
  validatorSrc = validatorSrc.replace("toolPattern: '{server}_1mcp_{tool}',", "toolPattern: '{server}_{tool}',");
  fs.writeFileSync(validatorPath, validatorSrc);
} else if (!validatorSrc.includes("toolPattern: '{server}_{tool}',")) {
  throw new Error('pinned 1MCP templateValidator.js source shape changed; refusing an unsafe validator patch');
}
NODE
echo "  patched clean {server}_{tool} namespacing and compact server instructions"

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
