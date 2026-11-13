import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AdapterStore } from '../store.mjs';

const MASTER = 'M'.repeat(43);
const ROTATED = 'N'.repeat(43);

function freshState(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-master-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test('the master bearer resolves to one stable non-expiring service principal', t => {
  const stateDir = freshState(t);
  const store = new AdapterStore(stateDir);
  t.after(() => store.close());

  store.setMasterBearer(MASTER);
  const first = store.resolveCapability(MASTER);
  const second = store.resolveCapability(MASTER);
  assert.ok(first);
  assert.equal(first.id, second.id);
  assert.equal(first.scope, 'main');
  assert.equal(first.expiresMs, null);
  assert.equal(store.masterPrincipalId(), first.id);

  // The service principal is not reachable through the ordinary capability lookup.
  const ordinary = store.issueMainCapability(60);
  assert.notEqual(store.resolveCapability(ordinary.token).id, first.id);
  assert.equal(store.resolveCapability('Z'.repeat(43)), undefined);
});

test('rotating the master retires the previous generation instead of inheriting it', t => {
  const stateDir = freshState(t);
  const store = new AdapterStore(stateDir);
  t.after(() => store.close());

  store.setMasterBearer(MASTER);
  const previous = store.resolveCapability(MASTER);
  const requestJson = JSON.stringify({ version: 1, tool: 'dev_read', arguments: { path: '/tmp/x' } });
  const submitted = store.submitOperation(previous.id, 'nonce-rotation', requestJson, 'hash');

  store.setMasterBearer(ROTATED);
  const current = store.resolveCapability(ROTATED);
  assert.ok(current);
  assert.notEqual(current.id, previous.id);
  assert.equal(store.resolveCapability(MASTER), undefined);
  assert.equal(store.activeCapabilityById(previous.id), undefined);
  // The retired generation's operation is no longer dispatchable.
  assert.equal(store.activeCapabilityById(submitted.operation.principal_id), undefined);
});

test('service-principal revocation survives reopen and an explicit re-set revives it', t => {
  const stateDir = freshState(t);
  const store = new AdapterStore(stateDir);
  store.setMasterBearer(MASTER);
  const principal = store.resolveCapability(MASTER);
  assert.equal(store.revokeCapability(principal.id), true);
  assert.equal(store.resolveCapability(MASTER), undefined);
  store.close();

  const reopened = new AdapterStore(stateDir);
  t.after(() => reopened.close());
  assert.equal(reopened.resolveCapability(MASTER), undefined);
  reopened.setMasterBearer(MASTER);
  assert.ok(reopened.resolveCapability(MASTER));
});

test('ordinary capability revocation and expiry are unchanged by the service principal', t => {
  const stateDir = freshState(t);
  const store = new AdapterStore(stateDir);
  t.after(() => store.close());

  store.setMasterBearer(MASTER);
  const issued = store.issueMainCapability(60);
  assert.ok(store.resolveCapability(issued.token));
  assert.equal(store.revokeCapability(issued.id), true);
  assert.equal(store.resolveCapability(issued.token), undefined);
  // Revoking an ordinary capability never touches the service principal.
  assert.ok(store.resolveCapability(MASTER));
});

async function reservePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function startToolFixture(t) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'master-fixture', version: '1' },
      };
    } else if (message.method === 'tools/list') {
      result = {
        tools: [{ name: 'fixture_read', description: 'Read.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
      };
    } else if (message.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'fixture result' }] };
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server;
}

async function startAdapterServer(t, stateDir, port, mcpUrl) {
  const child = spawn(process.execPath, [new URL('../server.mjs', import.meta.url).pathname], {
    env: {
      ...process.env,
      WEBSESSION_ADAPTER_STATE_DIR: stateDir,
      WEBSESSION_ADAPTER_HOST: '127.0.0.1',
      WEBSESSION_ADAPTER_PORT: String(port),
      WEBSESSION_ADAPTER_MCP_URL: mcpUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const ended = once(child, 'exit');
      child.kill();
      await ended;
    }
  });
  child.stderr.resume();
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
  return child;
}

test('the master bearer authenticates /v1/calls directly and keeps the exchange working', async t => {
  const stateDir = freshState(t);
  const store = new AdapterStore(stateDir);
  store.setMasterBearer(MASTER);
  store.close();

  const fixture = await startToolFixture(t);
  const mcpUrl = `http://127.0.0.1:${fixture.address().port}/mcp`;
  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, mcpUrl);
  const base = `http://127.0.0.1:${port}`;

  const call = await fetch(`${base}/v1/calls?wait=10`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${MASTER}`,
      'content-type': 'application/json',
      'idempotency-key': 'master-direct-1',
    },
    body: JSON.stringify({ version: 1, tool: 'fixture_read', arguments: { path: '/tmp/x' } }),
  });
  assert.equal(call.status, 200);
  const operation = await call.json();
  assert.equal(operation.state, 'completed');
  assert.match(operation.result, /fixture result/);

  // The same principal is reused: a second call under the same bearer is not a new identity.
  const second = await fetch(`${base}/v1/calls?wait=10`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${MASTER}`,
      'content-type': 'application/json',
      'idempotency-key': 'master-direct-2',
    },
    body: JSON.stringify({ version: 1, tool: 'fixture_read', arguments: { path: '/tmp/y' } }),
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).state, 'completed');

  // The documented exchange still issues an ordinary six-hour capability.
  const exchange = await fetch(`${base}/v1/access`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MASTER}` },
  });
  assert.equal(exchange.status, 200);
  const issued = await exchange.json();
  assert.match(issued.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.ttl_seconds, 21600);

  const viaCapability = await fetch(`${base}/v1/calls?wait=10`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issued.capability}`,
      'content-type': 'application/json',
      'idempotency-key': 'master-direct-3',
    },
    body: JSON.stringify({ version: 1, tool: 'fixture_read', arguments: { path: '/tmp/z' } }),
  });
  assert.equal(viaCapability.status, 200);
  assert.equal((await viaCapability.json()).state, 'completed');
});

test('a revoked service principal is refused on data routes and on the exchange', async t => {
  const stateDir = freshState(t);
  const store = new AdapterStore(stateDir);
  store.setMasterBearer(MASTER);
  const principal = store.resolveCapability(MASTER);
  store.revokeCapability(principal.id);
  store.close();

  const fixture = await startToolFixture(t);
  const mcpUrl = `http://127.0.0.1:${fixture.address().port}/mcp`;
  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, mcpUrl);
  const base = `http://127.0.0.1:${port}`;

  const call = await fetch(`${base}/v1/calls?wait=2`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${MASTER}`,
      'content-type': 'application/json',
      'idempotency-key': 'revoked-1',
    },
    body: JSON.stringify({ version: 1, tool: 'fixture_read', arguments: { path: '/tmp/x' } }),
  });
  assert.equal(call.status, 401);
  assert.equal((await call.json()).code, 'authorization_required');

  const exchange = await fetch(`${base}/v1/access`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MASTER}` },
  });
  assert.equal(exchange.status, 401);
});

test('the master exchange admission is master-only and revocation-aware', t => {
  const stateDir = freshState(t);
  const store = new AdapterStore(stateDir);
  t.after(() => store.close());

  store.setMasterBearer(MASTER);
  const ordinary = store.issueMainCapability(60);
  assert.equal(store.masterBearerMatches(ordinary.token), false, 'an ordinary capability is not the master credential');
  assert.ok(store.activeMasterPrincipal());

  assert.equal(store.revokeCapability(store.masterPrincipalId()), true);
  assert.equal(store.activeMasterPrincipal(), undefined, 'a revoked service principal must not admit the exchange');
  assert.equal(store.masterBearerMatches(MASTER), true, 'the bearer still matches; only the principal is revoked');
});

test('an ordinary capability cannot mint another capability through /v1/access', async t => {
  const stateDir = freshState(t);
  const store = new AdapterStore(stateDir);
  store.setMasterBearer(MASTER);
  store.close();

  const fixture = await startToolFixture(t);
  const mcpUrl = `http://127.0.0.1:${fixture.address().port}/mcp`;
  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, mcpUrl);
  const base = `http://127.0.0.1:${port}`;

  const exchange = await fetch(`${base}/v1/access`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MASTER}` },
  });
  assert.equal(exchange.status, 200);
  const issued = await exchange.json();

  // The capability returned by the exchange is an ordinary six-hour credential. It
  // must never be usable as the exchange credential itself.
  const renewed = await fetch(`${base}/v1/access`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.capability}` },
  });
  assert.equal(renewed.status, 401);
  assert.equal((await renewed.json()).code, 'authorization_required');

  // The same capability still authenticates ordinary data routes.
  const call = await fetch(`${base}/v1/calls?wait=10`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issued.capability}`,
      'content-type': 'application/json',
      'idempotency-key': 'ordinary-capability-1',
    },
    body: JSON.stringify({ version: 1, tool: 'fixture_read', arguments: { path: '/tmp/x' } }),
  });
  assert.equal(call.status, 200);
  assert.equal((await call.json()).state, 'completed');
});

test('the master bearer is header-only while ordinary capability URL routes keep working', async t => {
  const stateDir = freshState(t);
  const store = new AdapterStore(stateDir);
  store.setMasterBearer(MASTER);
  const ordinary = store.issueMainCapability(3600);
  store.close();

  const fixture = await startToolFixture(t);
  const mcpUrl = `http://127.0.0.1:${fixture.address().port}/mcp`;
  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, mcpUrl);
  const base = `http://127.0.0.1:${port}`;
  const encodedTool = Buffer.from('fixture_read', 'utf8').toString('base64url');
  const encodedRequest = Buffer.from(JSON.stringify({ version: 1, tool: 'fixture_read', arguments: {} }), 'utf8').toString('base64url');

  // A 43-character master bearer is indistinguishable by shape from a capability,
  // so every path position must reject it explicitly.
  for (const path of [
    `/v1/s/${MASTER}/tools`,
    `/v1/s/${MASTER}/tool/${encodedTool}`,
    `/v1/s/${MASTER}/call/nonce-1/${encodedRequest}`,
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, `${path} must not accept the master bearer`);
  }

  // The ordinary capability keeps working at the same positions.
  const tools = await fetch(`${base}/v1/s/${ordinary.token}/tools`);
  assert.equal(tools.status, 200);
  assert.match(await tools.text(), /tool_count: 1/);
  const tool = await fetch(`${base}/v1/s/${ordinary.token}/tool/${encodedTool}`);
  assert.equal(tool.status, 200);
  assert.match(await tool.text(), /tool: fixture_read/);
});

test('a non-43-character master bearer is refused in URL paths and accepted in the header', async t => {
  const longMaster = 'K'.repeat(64);
  const stateDir = freshState(t);
  const store = new AdapterStore(stateDir);
  store.setMasterBearer(longMaster);
  store.close();

  const fixture = await startToolFixture(t);
  const mcpUrl = `http://127.0.0.1:${fixture.address().port}/mcp`;
  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, mcpUrl);
  const base = `http://127.0.0.1:${port}`;

  const path = await fetch(`${base}/v1/s/${longMaster}/tools`);
  assert.equal(path.status, 404);

  const call = await fetch(`${base}/v1/calls?wait=10`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${longMaster}`,
      'content-type': 'application/json',
      'idempotency-key': 'long-master-1',
    },
    body: JSON.stringify({ version: 1, tool: 'fixture_read', arguments: { path: '/tmp/x' } }),
  });
  assert.equal(call.status, 200);
  assert.equal((await call.json()).state, 'completed');
});

test('the master bearer is not accepted as a continuation or confirmation credential', async t => {
  const stateDir = freshState(t);
  const store = new AdapterStore(stateDir);
  store.setMasterBearer(MASTER);
  store.close();

  const fixture = await startToolFixture(t);
  const mcpUrl = `http://127.0.0.1:${fixture.address().port}/mcp`;
  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, mcpUrl);
  const base = `http://127.0.0.1:${port}`;

  const status = await fetch(`${base}/v1/operations/${MASTER}/op-1`);
  assert.equal(status.status, 404);
  const chunk = await fetch(`${base}/v1/operations/${MASTER}/op-1/chunk/1`);
  assert.equal(chunk.status, 404);
  const confirm = await fetch(`${base}/v1/confirm/${MASTER}`, { method: 'POST' });
  assert.equal(confirm.status, 401);
});
