#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node --input-type=module - "$ROOT" "${1:-}" <<'NODE'
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [root, mode] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'webharness-smoke-test-'));
const state = join(dir, 'state');
const home = join(dir, 'home');
const runtime = join(dir, 'runtime');
const auth = join(dir, 'auth');
for (const path of [home, runtime, auth]) mkdirSync(path, { recursive: true });
const token = 'fixture-secret-token';
const contents = 'private fixture contents';
const file = join(dir, 'fixture.txt');
writeFileSync(file, contents);
writeFileSync(join(auth, 'oauth.json'), JSON.stringify({ version: 1, tokens: { access_token: token, token_type: 'Bearer' } }));
writeFileSync(join(dir, 'deployment.env'), 'MCP_PUBLIC_URL=https://mcp.example.test\nMCP_TUNNEL_NAME=\n');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MCP|BRIDGE)_/.test(key)));
const env = { ...cleanEnv, HOME: home, XDG_RUNTIME_DIR: runtime, BRIDGE_STATE_DIR: state };
const rendered = spawnSync(process.execPath, [join(root, 'scripts/render-config.mjs'), '--profile', 'personal', '--env-file', join(dir, 'deployment.env'), '--state-dir', state, '--repo-root', root], { env, encoding: 'utf8' });
assert.equal(rendered.status, 0, rendered.stderr);
let behavior = 'ok';
let calls = 0;
const server = createServer(async (req, res) => {
  if (req.url === '/health/ready') {
    res.writeHead(behavior === 'not-ready' ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: behavior === 'not-ready' ? 'not_ready' : 'ready' }));
    return;
  }
  if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
  if (req.headers.authorization !== `Bearer ${token}` || behavior === 'reject') {
    const status = behavior === 'unexpected-success' ? 200 : 401;
    const headers = behavior === 'no-challenge' ? {} : { 'www-authenticate': 'Bearer realm="fixture"' };
    res.writeHead(status, headers).end();
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const message = JSON.parse(body);
  if (message.id === undefined) { res.writeHead(202).end(); return; }
  let result;
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'dev_read', inputSchema: { type: 'object' } }] };
  else if (message.method === 'tools/call') {
    calls += 1;
    assert.deepEqual(message.params.arguments, { path: file, offset: 1, limit: 1 });
    result = { isError: behavior === 'tool-error', content: [{ type: 'text', text: contents }] };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(root, 'scripts/smoke-local.sh'), ...args], { env });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}
try {
  async function check(label, args, expected) {
    const result = await run(args);
    assert.equal(result.code, expected, `${label}: ${result.output}`);
    assert.ok(!result.output.includes(token) && !result.output.includes(contents), `${label}: secret leaked`);
    console.log(`ok - ${label}`);
  }
  await check('personal configuration and positional URL', [url], 0);
  if (mode !== '--personal-only') {
    behavior = 'not-ready'; await check('readiness failure', [url], 1);
    behavior = 'no-challenge'; await check('missing challenge', [url], 1);
    behavior = 'unexpected-success'; await check('unexpected unauthenticated success', [url], 1);
    behavior = 'ok'; await check('missing paired argument', [url, '--auth-state-dir', auth], 2);
    await check('missing prerequisite', [url, '--auth-state-dir', join(dir, 'missing'), '--read-path', file], 2);
    await check('authenticated read', [url, '--auth-state-dir', auth, '--read-path', file], 0);
    assert.equal(calls, 1);
    behavior = 'reject'; await check('rejected credentials', [url, '--auth-state-dir', auth, '--read-path', file], 1);
    behavior = 'tool-error'; await check('tool isError', [url, '--auth-state-dir', auth, '--read-path', file], 1);
    assert.equal(calls, 2);
    assert.equal(JSON.parse(readFileSync(join(auth, 'oauth.json'), 'utf8')).tokens.access_token, token);
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
NODE
