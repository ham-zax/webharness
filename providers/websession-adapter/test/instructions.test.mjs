import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HTTP_INSTRUCTIONS, compactInstructions, webSessionInstructions } from '../protocol.mjs';
import { AdapterStore } from '../store.mjs';

test('authenticated WebSession discovery preserves initialization guidance without exposing it anonymously', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'websession-instructions-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let instructions = 'Owner guidance\nUse the configured canonical workflow.\nRead only selected references.';
  const toolResult = { content: [{ type: 'text', text: 'summary' }], structuredContent: { answer: 42 } };
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'guidance-fixture', version: '1' }, ...(instructions ? { instructions } : {}) }
      : message.method === 'tools/call'
        ? toolResult
        : { tools: [{ name: 'fixture_read', inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const store = new AdapterStore(stateDir);
  const { token } = store.issueMainCapability(60);
  store.close();
  const child = spawn(process.execPath, [new URL('../server.mjs', import.meta.url).pathname], {
    env: { ...process.env, WEBSESSION_ADAPTER_STATE_DIR: stateDir,
      WEBSESSION_ADAPTER_HOST: '127.0.0.1', WEBSESSION_ADAPTER_PORT: String(port),
      WEBSESSION_ADAPTER_MCP_URL: `http://127.0.0.1:${upstream.address().port}/mcp` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } });
  child.stderr.resume();
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
  const base = `http://127.0.0.1:${port}/v1/s`;
  const response = await fetch(`${base}/${token}/tools`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const line = text.split('\n').find(value => value.startsWith('instructions_json: '));
  assert.equal(JSON.parse(line.slice('instructions_json: '.length)), instructions);
  assert.ok(!text.includes('POST /v1/calls'));
  assert.ok(!text.includes('Authorization: Bearer'));
  assert.match(text, /tool_1: fixture_read/);
  const denied = await fetch(`${base}/${'x'.repeat(48)}/tools`);
  assert.equal(denied.status, 404);
  assert.ok(!(await denied.text()).includes(instructions));
  instructions = undefined;
  const without = await fetch(`${base}/${token}/tools`);
  assert.equal(without.status, 200);
  assert.ok(!(await without.text()).includes('instructions_json:'));
  const headerInstructions = await (await fetch(`http://127.0.0.1:${port}/v1/instructions`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(headerInstructions.instructions, HTTP_INSTRUCTIONS);
  const call = await fetch(`http://127.0.0.1:${port}/v1/calls?wait=1`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'structured-result' },
    body: JSON.stringify({ version: 1, tool: 'fixture_read', arguments: {} }),
  });
  assert.equal(call.status, 200);
  const operation = await call.json();
  assert.equal(operation.state, 'completed');
  assert.equal(operation.result, 'summary');
});

test('authenticated discovery compacts 1MCP guidance and exposes the capability default cwd', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'websession-compact-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const instructions = [
    '# 1MCP - Model Context Protocol Proxy',
    '',
    'This proxy aggregates MCP servers behind one endpoint.',
    'Example tool name: filesystem_1mcp_read_file.',
    '',
    '<dev>',
    'Dev tools for the project.',
    '</dev>',
    '',
    '<local>',
    'Local tools.',
    '</local>',
  ].join('\n');
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'compact-fixture', version: '1' }, instructions }
      : { tools: [{ name: 'fixture_read', description: 'Read a file.', inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const store = new AdapterStore(stateDir);
  const issued = store.issueMainCapability(60, { defaultCwd: '/tmp/web-session-work' });
  store.close();
  const child = spawn(process.execPath, [new URL('../server.mjs', import.meta.url).pathname], {
    env: { ...process.env, WEBSESSION_ADAPTER_STATE_DIR: stateDir,
      WEBSESSION_ADAPTER_HOST: '127.0.0.1', WEBSESSION_ADAPTER_PORT: String(port),
      WEBSESSION_ADAPTER_MCP_URL: `http://127.0.0.1:${upstream.address().port}/mcp` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } });
  child.stderr.resume();
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });

  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${issued.token}` };
  const toolsText = await (await fetch(`${base}/v1/s/${issued.token}/tools`)).text();
  const line = toolsText.split('\n').find(value => value.startsWith('instructions_json: '));
  assert.ok(line, 'tools output includes compacted instructions');
  const compacted = JSON.parse(line.slice('instructions_json: '.length));
  assert.ok(!compacted.includes('filesystem_1mcp_read_file'));
  assert.ok(!compacted.startsWith('# 1MCP'));
  assert.ok(compacted.startsWith('<dev>'));
  assert.match(compacted, /<local>\nLocal tools\.\n<\/local>/);
  assert.equal(compacted, compactInstructions(instructions));
  assert.ok(!compacted.includes(HTTP_INSTRUCTIONS));

  const instructionResponse = await fetch(`${base}/v1/instructions`, { headers: auth });
  assert.equal(instructionResponse.status, 200);
  const httpGuidance = (await instructionResponse.json()).instructions;
  assert.equal(httpGuidance, webSessionInstructions(compacted));
  assert.match(httpGuidance, /POST \/v1\/calls\?wait=2/);
  assert.match(httpGuidance, /Idempotency-Key/);
  assert.match(httpGuidance, /do not probe endpoint names/);

  const snapshot = await (await fetch(`${base}/v1/tools`, { headers: auth })).json();
  assert.equal(snapshot.default_cwd, '/tmp/web-session-work');
  assert.equal(snapshot.instructions, httpGuidance);
  assert.deepEqual(snapshot.tools, ['fixture_read']);

  const signatures = await (await fetch(`${base}/v1/signatures`, { headers: auth })).json();
  assert.equal(signatures.default_cwd, '/tmp/web-session-work');
  assert.equal(signatures.signatures.length, 1);

  const about = await (await fetch(`${base}/v1/about`)).text();
  assert.match(about, new RegExp(`pair_url: http://127\\.0\\.0\\.1:${port}/v1/pair`));
});
