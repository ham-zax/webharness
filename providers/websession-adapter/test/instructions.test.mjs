import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
  assert.match(text, /tool_1: fixture_read/);
  const denied = await fetch(`${base}/${'x'.repeat(48)}/tools`);
  assert.equal(denied.status, 404);
  assert.ok(!(await denied.text()).includes(instructions));
  instructions = undefined;
  const without = await fetch(`${base}/${token}/tools`);
  assert.equal(without.status, 200);
  assert.ok(!(await without.text()).includes('instructions_json:'));
  const call = await fetch(`http://127.0.0.1:${port}/v1/calls?wait=1`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'structured-result' },
    body: JSON.stringify({ version: 1, tool: 'fixture_read', arguments: {} }),
  });
  assert.equal(call.status, 200);
  const operation = await call.json();
  assert.equal(operation.state, 'completed');
  assert.deepEqual(JSON.parse(operation.result), toolResult);
});
