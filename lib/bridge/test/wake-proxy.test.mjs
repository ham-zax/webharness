import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createWakeProxy, runBackendControl } from '../wake-proxy.mjs';
import { createConnectorPolicyLoader } from '../connector-policy.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (port, path = '/mcp', options = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path, ...options }, res => {
    let body = ''; res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject); req.end(options.body);
});
async function fixture(t, { idleMs = 80, startupMs = 1000, handler, ...options } = {}) {
  const backend = http.createServer(handler || ((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { res.writeHead(201, { 'x-test': req.headers['x-test'] || 'yes' }); res.end(body || 'ok'); });
  }));
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const backendPort = backend.address().port;
  await new Promise(resolve => backend.close(resolve));
  let starts = 0, stops = 0;
  const proxy = createWakeProxy({ port: 0, backendPort, idleMs, startupMs,
    startBackend: async () => { starts++; await sleep(30); await new Promise(resolve => backend.listen(backendPort, '127.0.0.1', resolve)); },
    stopBackend: async () => { stops++; await new Promise(resolve => backend.close(resolve)); }, ...options });
  await proxy.listen();
  t.after(async () => { await proxy.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); });
  return { proxy, backend, port: proxy.server.address().port, starts: () => starts, stops: () => stops };
}
test('health stays asleep; concurrent first requests coalesce and preserve bodies/status/headers', async t => {
  const f = await fixture(t);
  assert.equal((await request(f.port, '/health/ready')).status, 200);
  assert.equal(f.starts(), 0);
  const results = await Promise.all([1, 2, 3].map(i => request(f.port, '/oauth?x=1', { method: 'POST', body: `body${i}`, headers: { 'x-test': 'forwarded' } })));
  assert.equal(f.starts(), 1);
  results.forEach((result, i) => { assert.equal(result.status, 201); assert.equal(result.body, `body${i + 1}`); assert.equal(result.headers['x-test'], 'forwarded'); });
  await sleep(130); assert.equal(f.stops(), 1);
  assert.equal((await request(f.port, '/health/ready')).status, 200); assert.equal(f.starts(), 1);
  await request(f.port); assert.equal(f.starts(), 2);
});

test('HTTP request receipts correlate forwarding without logging query strings or bodies', async t => {
  const records = [];
  const f = await fixture(t, { onDiagnostic: row => records.push(row), handler: (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(201, {
        'x-received-request-id': req.headers['x-webharness-request-id'],
        'x-webharness-request-id': 'backend-must-not-replace-receipt',
      });
      res.end('ok');
    });
  } });
  const id = '12345678-1234-1234-1234-123456789abc';
  const result = await request(f.port, '/mcp?token=private-token', {
    method: 'POST', body: 'private-body', headers: { 'x-webharness-request-id': id },
  });
  assert.equal(result.headers['x-webharness-request-id'], id);
  assert.equal(result.headers['x-received-request-id'], id);
  assert.ok(records.some(row => row.event === 'http_forwarding' && row.request_id === id));
  assert.ok(records.some(row => row.event === 'http_completed' && row.request_id === id && row.forwarded));
  assert.doesNotMatch(JSON.stringify(records), /private-token|private-body/);
});
test('in-flight streams pin the backend until the client disconnects', async t => {
  const f = await fixture(t, { idleMs: 40, handler: (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: alive\n\n'); } });
  const req = http.get(`http://127.0.0.1:${f.port}/mcp`);
  req.on('error', () => {});
  const res = await new Promise(resolve => req.once('response', resolve));
  res.on('error', () => {}); res.resume();
  await sleep(130); assert.equal(f.stops(), 0);
  res.destroy(); req.destroy(); await sleep(100); assert.equal(f.stops(), 1);
});
test('stateful leases defer idle shutdown', async t => {
  let pinned = true;
  const f = await fixture(t, { idleMs: 30, hasActiveLeases: async () => pinned });
  await request(f.port); await sleep(100); assert.equal(f.stops(), 0);
  pinned = false; await sleep(100); assert.equal(f.stops(), 1);
});
test('failed startup is bounded, reports failure on health, and retries only on a new request', async t => {
  let starts = 0;
  const f = await fixture(t, { startBackend: async () => { starts++; throw new Error('failed'); } });
  assert.equal((await request(f.port)).status, 503);
  assert.equal((await request(f.port, '/health/ready')).status, 503);
  assert.equal(starts, 1); await request(f.port); assert.equal(starts, 2);
});
test('backend connection failure returns error without replaying a mutation', async t => {
  let calls = 0;
  const f = await fixture(t, { handler: (req) => { calls++; req.socket.destroy(); } });
  assert.equal((await request(f.port, '/mcp', { method: 'POST', body: 'mutate' })).status, 502);
  assert.equal(calls, 1); assert.equal((await request(f.port, '/health/ready')).status, 503);
});
for (const recoveryPath of ['/health/ready', '/health/live', '/mcp']) {
  test(`healthy backend recovers through ${recoveryPath} while another stream stays active`, async t => {
    let mutations = 0;
    const f = await fixture(t, { idleMs: 10000, handler: (req, res) => {
      if (req.url === '/stream') { res.writeHead(200); res.write('alive'); }
      else if (req.url === '/fail') { mutations++; req.socket.destroy(); }
      else { res.writeHead(200); res.end('ok'); }
    } });
    const stream = http.get(`http://127.0.0.1:${f.port}/stream`);
    stream.on('error', () => {});
    const response = await new Promise(resolve => stream.once('response', resolve));
    response.on('error', () => {}); response.resume();
    t.after(() => { response.destroy(); stream.destroy(); });
    assert.equal((await request(f.port, '/fail', { method: 'POST', body: 'mutate' })).status, 502);
    const recovered = await request(f.port, recoveryPath);
    assert.equal(recovered.status, 200);
    assert.equal((await request(f.port, '/health/ready')).status, 200);
    assert.equal((await request(f.port)).status, 200);
    assert.equal(f.starts(), 1);
    assert.equal(f.stops(), 0);
    assert.equal(mutations, 1);
    assert.equal(response.destroyed, false);
  });
}
test('client cancellation while starting leaves no permanent activity pin', async t => {
  const f = await fixture(t, { idleMs: 30 });
  const req = http.get(`http://127.0.0.1:${f.port}/mcp`); req.on('error', () => {});
  await sleep(10); req.destroy(); await sleep(150);
  assert.equal(f.starts(), 1); assert.equal(f.stops(), 1);
});
test('startup timeouts and queue limits return bounded errors; timed-out backend cannot report ready', async t => {
  let release;
  const started = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { startupMs: 50, maxQueued: 1, startBackend: () => started });
  const first = request(f.port);
  await sleep(10);
  assert.equal((await request(f.port)).status, 503);
  assert.equal((await first).status, 503);
  await sleep(20);
  assert.equal((await request(f.port, '/health/ready')).status, 503);
  release();
});
test('shutdown closes active streams and stops the backend', async t => {
  const f = await fixture(t, { handler: (_req, res) => res.write('streaming') });
  const req = http.get(`http://127.0.0.1:${f.port}/mcp`); req.on('error', () => {});
  const response = await new Promise(resolve => req.once('response', resolve));
  response.on('error', () => {}); response.resume();
  await f.proxy.close();
  assert.equal(f.stops(), 1);
});

test('timeout aborts and settles delayed startup before backend cleanup', async t => {
  const events = [];
  const f = await fixture(t, { startupMs: 30,
    startBackend: signal => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { events.push('late start'); resolve(); }, 150);
      signal.addEventListener('abort', () => {
        clearTimeout(timer); events.push('abort');
        setTimeout(() => { events.push('reaped'); reject(signal.reason); }, 20);
      }, { once: true });
    }),
    stopBackend: async () => { events.push('cleanup'); } });
  assert.equal((await request(f.port)).status, 503);
  await sleep(180);
  assert.deepEqual(events, ['abort', 'reaped', 'cleanup']);
  assert.equal((await request(f.port, '/health/ready')).status, 503);
});
test('shutdown during startup aborts immediately and cleans after startup settles', async t => {
  let began;
  const beginning = new Promise(resolve => { began = resolve; });
  const events = [];
  const f = await fixture(t, { startupMs: 10000,
    startBackend: signal => new Promise((_resolve, reject) => {
      began();
      signal.addEventListener('abort', () => {
        events.push('abort'); setTimeout(() => { events.push('reaped'); reject(signal.reason); }, 10);
      }, { once: true });
    }), stopBackend: async () => { events.push('cleanup'); } });
  const response = request(f.port).catch(() => {});
  await beginning;
  await f.proxy.close(); await response;
  assert.deepEqual(events.slice(0, 3), ['abort', 'reaped', 'cleanup']);
});
test('production controller abort kills its process group before settling', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-controller-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const control = path.join(directory, 'control.sh');
  const late = path.join(directory, 'late');
  const started = path.join(directory, 'started');
  await fs.writeFile(control, `#!/usr/bin/env bash
trap '' TERM
(sleep 1; touch '${late}') &
touch '${started}'
wait
`);
  const controller = new AbortController();
  const launched = runBackendControl(control, 'start', { signal: controller.signal });
  const rejection = assert.rejects(launched, /cancel test/);
  for (let i = 0; i < 40; i++) {
    try { await fs.access(started); break; } catch { await sleep(5); }
  }
  controller.abort(new Error('cancel test'));
  await rejection;
  await assert.rejects(fs.access(late), { code: 'ENOENT' });
});
test('invalid idle and startup timings fail explicitly', () => {
  assert.throws(() => createWakeProxy({ port: 0, backendPort: 1234, startupMs: NaN }), /startupMs must be a positive integer/);
  assert.throws(() => createWakeProxy({ port: 0, backendPort: 1234, idleMs: 0 }), /idleMs must be a positive integer/);
});

test('connector-policy.yaml hides write tools from connectors, injects routing instructions, blocks direct write calls, hot-reloads, and leaves websession-adapter unfiltered', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-proxy-policy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const policyPath = path.join(dir, 'connector-policy.yaml');
  await fs.writeFile(policyPath, 'connector_write_tools: false\n', 'utf8');

  const fullTools = [
    { name: 'dev_read', description: 'Read files.', annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'dev_write', description: 'Write files.', annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: 'local_tool_call', description: 'Call local.', annotations: { readOnlyHint: false, destructiveHint: true } },
    {
      name: 'local_fallback_dispatch',
      description: 'Fallback dispatcher.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', minLength: 1 },
          tool: { type: 'string', minLength: 1 },
          arguments: { type: 'object', additionalProperties: true },
          calls: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 128 },
                server: { type: 'string', minLength: 1 },
                tool: { type: 'string', minLength: 1 },
                arguments: { type: 'object', additionalProperties: true },
              },
            },
          },
          concurrency: { type: 'integer', minimum: 1, maximum: 16, default: 4 },
        },
      },
    },
  ];
  let upstreamCalls = 0;
  const f = await fixture(t, {
    idleMs: 10000,
    connectorPolicy: createConnectorPolicyLoader(policyPath),
    handler: (req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        upstreamCalls += 1;
        const msg = JSON.parse(body);
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { serverInfo: { name: '1mcp', version: '1' }, capabilities: { tools: {} }, instructions: 'Base instructions.' },
          }));
          return;
        }
        if (msg.method === 'tools/list') {
          if (req.headers['x-sse'] === '1') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: fullTools } })}\n\n`);
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: fullTools } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `called:${msg.params?.name}` }] } }));
      });
    },
  });

  const postMcp = (payload, headers = {}) => request(f.port, '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

  // 1. Connector initialize gets the write-routing policy banner prepended.
  const initRes = await postMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { 'user-agent': 'gemini-connector/1.0' });
  const initJson = JSON.parse(initRes.body);
  assert.match(initJson.result.instructions, /CONNECTOR WRITE-ROUTING POLICY:/);
  assert.match(initJson.result.instructions, /Base instructions\./);

  // 2. Connector tools/list (JSON and SSE) hides write tools and annotates remaining tools.
  const listRes = await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'user-agent': 'gemini-connector/1.0' });
  const listedTools = JSON.parse(listRes.body).result.tools;
  assert.deepEqual(listedTools.map(x => x.name), ['dev_read', 'local_fallback_dispatch']);
  assert.match(listedTools[0].description, /call local_fallback_dispatch directly/);
  assert.match(listedTools[1].description, /ACTIVE CONNECTOR POLICY:/);
  // Connector-facing fallback_dispatch schema strips heavy validation keywords to avoid host schema timeouts.
  assert.equal(listedTools[1].inputSchema.additionalProperties, undefined);
  assert.equal(listedTools[1].inputSchema.properties.arguments.additionalProperties, undefined);
  assert.equal(listedTools[1].inputSchema.properties.calls.maxItems, undefined);
  assert.equal(listedTools[1].inputSchema.properties.calls.items.additionalProperties, undefined);
  assert.equal(listedTools[1].inputSchema.properties.concurrency.default, undefined);
  assert.deepEqual(Object.keys(listedTools[1].inputSchema.properties), ['server', 'tool', 'arguments', 'calls', 'concurrency']);

  const sseRes = await postMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { 'user-agent': 'gemini-connector/1.0', 'x-sse': '1' });
  const sseDataLine = sseRes.body.split('\n').find(l => l.startsWith('data: '));
  assert.deepEqual(JSON.parse(sseDataLine.slice(6)).result.tools.map(x => x.name), ['dev_read', 'local_fallback_dispatch']);

  // 3. Direct call to a hidden write tool from connector is blocked locally without hitting upstream.
  const callsBeforeBlock = upstreamCalls;
  const blockedRes = await postMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dev_write', arguments: {} } }, { 'user-agent': 'gemini-connector/1.0' });
  assert.equal(upstreamCalls, callsBeforeBlock);
  const blockedJson = JSON.parse(blockedRes.body);
  assert.equal(blockedJson.result.isError, true);
  assert.match(blockedJson.result.content[0].text, /CONNECTOR_WRITE_TOOLS_DISABLED/);
  assert.match(blockedJson.result.content[0].text, /local_fallback_dispatch\(server="dev", tool="write"/);

  // 4. WebSession adapter bypasses the connector policy completely.
  const wsListRes = await postMcp({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { 'user-agent': 'websession-adapter/1' });
  assert.deepEqual(JSON.parse(wsListRes.body).result.tools.map(x => x.name), ['dev_read', 'dev_write', 'local_tool_call', 'local_fallback_dispatch']);
  const wsWriteRes = await postMcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'dev_write', arguments: {} } }, { 'user-agent': 'websession-adapter/1' });
  assert.equal(JSON.parse(wsWriteRes.body).result.content[0].text, 'called:dev_write');

  // 5. Hot-reload: flipping connector_write_tools to true restores all outer tools immediately.
  await fs.writeFile(policyPath, 'connector_write_tools: true\n', 'utf8');
  const restoredRes = await postMcp({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }, { 'user-agent': 'gemini-connector/1.0' });
  assert.deepEqual(JSON.parse(restoredRes.body).result.tools.map(x => x.name), ['dev_read', 'dev_write', 'local_tool_call', 'local_fallback_dispatch']);
});

test('connector-policy handles chunked >256 KiB streams without dropping data, blocks oversized/batch/learned writes, and filters gzip responses', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-proxy-policy-edge-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const policyPath = path.join(dir, 'connector-policy.yaml');
  await fs.writeFile(policyPath, 'connector_write_tools: false\n', 'utf8');

  const fullTools = [
    { name: 'dev_read', description: 'Read files.', annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'dev_write', description: 'Write files.', annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: 'custom_mutate', description: 'Custom mutator.', annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: 'local_fallback_dispatch', description: 'Fallback dispatcher.', annotations: { readOnlyHint: true, destructiveHint: false } },
  ];
  let upstreamCalls = 0;
  let lastEchoedLength = 0;
  const f = await fixture(t, {
    idleMs: 10000,
    connectorPolicy: createConnectorPolicyLoader(policyPath),
    handler: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        upstreamCalls += 1;
        const body = Buffer.concat(chunks).toString('utf8');
        const msg = JSON.parse(body);
        if (msg.method === 'tools/list') {
          const raw = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: fullTools } }), 'utf8');
          if (req.headers['x-gzip'] === '1') {
            res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
            res.end(zlib.gzipSync(raw));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(raw);
          return;
        }
        lastEchoedLength = msg.params?.arguments?.arguments?.content?.length ?? 0;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `ok:${msg.params?.name}:${lastEchoedLength}` }] } }));
      });
    },
  });

  const postMcp = (payload, headers = {}) => request(f.port, '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'gemini-connector/1.0', ...headers },
    body: JSON.stringify(payload),
  });

  // 1. Gzip-encoded tools/list response is decompressed, filtered, and teaches learnedHiddenTools about custom_mutate.
  const gzRes = await postMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'x-gzip': '1' });
  assert.equal(gzRes.status, 200);
  assert.equal(gzRes.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(gzRes.body).result.tools.map(x => x.name), ['dev_read', 'local_fallback_dispatch']);

  // 2. Dynamically learned non-read-only tool (not in static HIDDEN_WRITE_TOOLS) is blocked on direct call.
  const callsBeforeLearned = upstreamCalls;
  const customBlocked = await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'custom_mutate', arguments: {} } });
  assert.equal(upstreamCalls, callsBeforeLearned);
  assert.equal(JSON.parse(customBlocked.body).result.isError, true);
  assert.match(JSON.parse(customBlocked.body).result.content[0].text, /CONNECTOR_WRITE_TOOLS_DISABLED: custom_mutate/);

  // 3. JSON-RPC batch array containing a disabled write tool is blocked locally without hitting upstream.
  const callsBeforeBatch = upstreamCalls;
  const batchBlocked = await postMcp([
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dev_read', arguments: { path: 'a.txt' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dev_write', arguments: { path: 'a.txt', content: 'x' } } },
  ]);
  assert.equal(upstreamCalls, callsBeforeBatch);
  const batchJson = JSON.parse(batchBlocked.body);
  assert.equal(Array.isArray(batchJson), true);
  assert.equal(batchJson.length, 2);
  assert.equal(batchJson[0].id, 3);
  assert.equal(batchJson[0].result.isError, true);
  assert.match(batchJson[0].result.content[0].text, /batch rejected/);
  assert.equal(batchJson[1].id, 4);
  assert.equal(batchJson[1].result.isError, true);
  assert.match(batchJson[1].result.content[0].text, /CONNECTOR_WRITE_TOOLS_DISABLED: dev_write/);

  // 4. Oversized (>256 KiB) chunked allowed local_fallback_dispatch streams prefix + remainder intact,
  //    even when its file content embeds a fake "method":"tools/call","name":"dev_write" string.
  const bigContent = '{"method":"tools/call","params":{"name":"dev_write"}}' + 'A'.repeat(320 * 1024);
  const bigAllowedPayload = JSON.stringify({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'local_fallback_dispatch',
      arguments: { server: 'dev', tool: 'write', arguments: { path: 'big.txt', content: bigContent } },
    },
  });
  const chunkedAllowedRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: f.port,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'gemini-connector/1.0', 'transfer-encoding': 'chunked' },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < bigAllowedPayload.length; offset += chunkSize) {
      req.write(bigAllowedPayload.slice(offset, offset + chunkSize));
    }
    req.end();
  });
  assert.equal(chunkedAllowedRes.status, 200);
  assert.equal(JSON.parse(chunkedAllowedRes.body).result.content[0].text, `ok:local_fallback_dispatch:${bigContent.length}`);
  assert.equal(lastEchoedLength, bigContent.length);

  // 5. Oversized (>256 KiB) direct dev_write call is still blocked locally without reaching upstream.
  const callsBeforeBigBlock = upstreamCalls;
  const bigBlockedRes = await postMcp({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'dev_write', arguments: { path: 'big.txt', content: 'B'.repeat(320 * 1024) } },
  });
  assert.equal(upstreamCalls, callsBeforeBigBlock);
  assert.equal(bigBlockedRes.status, 200);
  const bigBlockedJson = JSON.parse(bigBlockedRes.body);
  assert.equal(bigBlockedJson.id, 6);
  assert.equal(bigBlockedJson.result.isError, true);
  assert.match(bigBlockedJson.result.content[0].text, /CONNECTOR_WRITE_TOOLS_DISABLED: dev_write/);
});

test('connector-policy fast-paths single-call local_fallback_dispatch(server="dev") directly to outer dev_* without touching local-tools', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-proxy-dev-fastpath-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const policyPath = path.join(dir, 'connector-policy.yaml');
  await fs.writeFile(policyPath, 'connector_write_tools: false\n', 'utf8');

  const seen = [];
  const f = await fixture(t, {
    idleMs: 10000,
    connectorPolicy: createConnectorPolicyLoader(policyPath),
    handler: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const mcpNameHeader = req.headers['mcp-name'];
        if (msg.method === 'tools/call' && mcpNameHeader !== undefined && mcpNameHeader !== msg.params?.name) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id ?? null,
            error: { code: -32020, message: `Mcp-Name header (${mcpNameHeader}) does not match body tool (${msg.params?.name})` },
          }));
          return;
        }
        seen.push({ ...msg, mcpNameHeader });
        if (msg.method === 'tools/list') {
          const tools = msg.params?.cursor === 'p2'
            ? [{ name: 'dev_edit', description: 'Edit.', annotations: { readOnlyHint: false } }]
            : [
                { name: 'dev_write', description: 'Write.', annotations: { readOnlyHint: false } },
                { name: 'local_fallback_dispatch', description: 'Fallback.', annotations: { readOnlyHint: true } },
              ];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: { tools } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: { content: [{ type: 'text', text: 'ok' }] } }));
      });
    },
  });

  const postMcp = (payload, headers = {}) => request(f.port, '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'gemini-connector/1.0', authorization: 'Bearer tok-full', ...headers },
    body: JSON.stringify(payload),
  });

  // 0. Before tools/list is observed, fast path fails closed and stays on local_fallback_dispatch.
  await postMcp({
    jsonrpc: '2.0', id: 0, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'write', arguments: { path: 'cold.txt', content: 'hi' } } },
  });
  assert.equal(seen.at(-1).params.name, 'local_fallback_dispatch');

  // Paginated tools/list merges page 1 (dev_write) and page 2 (dev_edit) without clobbering page 1,
  // AND strips write tools on page 2+ even though local_fallback_dispatch was only on page 1.
  const page1Res = await postMcp({ jsonrpc: '2.0', id: 100, method: 'tools/list', params: {} });
  assert.deepEqual(JSON.parse(page1Res.body).result.tools.map(x => x.name), ['local_fallback_dispatch']);
  const page2Res = await postMcp({ jsonrpc: '2.0', id: 101, method: 'tools/list', params: { cursor: 'p2' } });
  assert.deepEqual(JSON.parse(page2Res.body).result.tools.map(x => x.name), [], 'page 2 must inherit hasFallback and strip dev_edit');

  // 1. Single-call dev/write and dev/dev_edit rewrite both body and Mcp-Name header to outer dev_*.
  const writeRes = await postMcp({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'write', arguments: { path: 'a.txt', content: 'hi' } } },
  }, { 'mcp-method': 'tools/call', 'mcp-name': 'local_fallback_dispatch' });
  assert.equal(writeRes.status, 200);
  assert.deepEqual(seen.at(-1).params, { name: 'dev_write', arguments: { path: 'a.txt', content: 'hi' } });
  assert.equal(seen.at(-1).mcpNameHeader, 'dev_write');

  const editRes = await postMcp({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'dev_edit', arguments: { targets: [] } } },
  }, { 'mcp-method': 'tools/call', 'mcp-name': 'local_fallback_dispatch' });
  assert.equal(editRes.status, 200);
  assert.deepEqual(seen.at(-1).params, { name: 'dev_edit', arguments: { targets: [] } });
  assert.equal(seen.at(-1).mcpNameHeader, 'dev_edit');

  // Legacy clients without Mcp-Name do not get a synthetic Mcp-Name header injected.
  const noHeaderRes = await postMcp({
    jsonrpc: '2.0', id: 20, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'write', arguments: { path: 'b.txt', content: 'ok' } } },
  });
  assert.equal(noHeaderRes.status, 200);
  assert.equal(seen.at(-1).mcpNameHeader, undefined);

  // 2. Batch calls[], non-dev routes, and extra unknown keys stay on local_fallback_dispatch.
  await postMcp({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'read', calls: [{ arguments: { path: 'a.txt' } }] } },
  });
  assert.equal(seen.at(-1).params.name, 'local_fallback_dispatch');

  await postMcp({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'terminal', tool: 'terminal_list', arguments: {} } },
  });
  assert.equal(seen.at(-1).params.name, 'local_fallback_dispatch');

  await postMcp({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'write', arguments: {}, extra: true } },
  });
  assert.equal(seen.at(-1).params.name, 'local_fallback_dispatch');

  // 3. Tag-restricted URLs (?tags=local, ?preset=...) do not rewrite to dev_*.
  const postMcpPath = (reqPath, payload, headers = {}) => request(f.port, reqPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'gemini-connector/1.0', ...headers },
    body: JSON.stringify(payload),
  });
  await postMcpPath('/mcp?tags=local', {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'write', arguments: { path: 'a.txt', content: 'hi' } } },
  });
  assert.equal(seen.at(-1).params.name, 'local_fallback_dispatch');

  await postMcpPath('/mcp?preset=local-only', {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'write', arguments: { path: 'a.txt', content: 'hi' } } },
  });
  assert.equal(seen.at(-1).params.name, 'local_fallback_dispatch');
});

test('connector-policy gates dev/* fast path on session tools/list catalog so local-only sessions stay on local_fallback_dispatch', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-proxy-dev-scope-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const policyPath = path.join(dir, 'connector-policy.yaml');
  await fs.writeFile(policyPath, 'connector_write_tools: false\n', 'utf8');

  const seen = [];
  const f = await fixture(t, {
    idleMs: 10000,
    connectorPolicy: createConnectorPolicyLoader(policyPath),
    handler: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        seen.push({ session: req.headers['mcp-session-id'], msg });
        if (msg.method === 'tools/list') {
          const isLocalOnly = req.headers['mcp-session-id'] === 'sess-local-only';
          const tools = isLocalOnly
            ? [{ name: 'local_fallback_dispatch', description: 'Fallback.', annotations: { readOnlyHint: true } }]
            : [
                { name: 'dev_write', description: 'Write.', annotations: { readOnlyHint: false } },
                { name: 'local_fallback_dispatch', description: 'Fallback.', annotations: { readOnlyHint: true } },
              ];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
      });
    },
  });

  const post = (sessionId, payload) => request(f.port, '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'gemini-connector/1.0', 'mcp-session-id': sessionId },
    body: JSON.stringify(payload),
  });

  await post('sess-local-only', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  await post('sess-full', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  await post('sess-local-only', {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'write', arguments: { path: 'x', content: '1' } } },
  });
  assert.equal(seen.at(-1).msg.params.name, 'local_fallback_dispatch');

  await post('sess-full', {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'write', arguments: { path: 'x', content: '1' } } },
  });
  assert.equal(seen.at(-1).msg.params.name, 'dev_write');

  // Stateless clients with distinct Bearer tokens do not share or poison each other's catalogs.
  const postStateless = (token, payload) => request(f.port, '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'gemini-connector/1.0', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  await postStateless('tok-a', { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
  await postStateless('tok-b', {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'write', arguments: { path: 'y', content: '2' } } },
  });
  assert.equal(seen.at(-1).msg.params.name, 'local_fallback_dispatch', 'unobserved bearer token must not inherit another token catalog');
});

test('connector-policy does not brick tag:dev-only sessions lacking local_fallback_dispatch and times out stalled prefixes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-proxy-dev-only-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const policyPath = path.join(dir, 'connector-policy.yaml');
  await fs.writeFile(policyPath, 'connector_write_tools: false\n', 'utf8');

  const f = await fixture(t, {
    idleMs: 10000,
    prefixReadTimeoutMs: 120,
    connectorPolicy: createConnectorPolicyLoader(policyPath),
    handler: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { serverInfo: { name: '1mcp', version: '1' }, capabilities: { tools: {} }, instructions: 'Dev-only instructions.' },
          }));
          return;
        }
        if (msg.method === 'tools/list' || msg.method === 'server/discover') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: {
              instructions: 'Dev-only instructions.',
              tools: [
                { name: 'dev_read', description: 'Read.', annotations: { readOnlyHint: true } },
                { name: 'dev_write', description: 'Write.', annotations: { readOnlyHint: false } },
              ],
            },
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `ok:${msg.params?.name}` }] } }));
      });
    },
  });

  const post = payload => request(f.port, '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'gemini-connector/1.0', 'mcp-session-id': 'dev-only' },
    body: JSON.stringify(payload),
  });

  // 0. Cold-start cached dev-only client calling dev_write before tools/list is not bricked.
  const coldWriteRes = await post({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'dev_write', arguments: {} } });
  assert.equal(JSON.parse(coldWriteRes.body).result.content[0].text, 'ok:dev_write');

  // 1. Catalog without local_fallback_dispatch keeps dev_write visible, skips banner injection, and keeps dev_write callable.
  const discoverRes = await post({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
  const discoverJson = JSON.parse(discoverRes.body);
  assert.deepEqual(discoverJson.result.tools.map(x => x.name), ['dev_read', 'dev_write']);
  assert.doesNotMatch(discoverJson.result.instructions, /CONNECTOR WRITE-ROUTING POLICY:/);

  // Initialize on ?tags=dev (or after observing a dev-only session) also skips banner injection.
  const initRes = await request(f.port, '/mcp?tags=dev', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'gemini-connector/1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} }),
  });
  assert.doesNotMatch(JSON.parse(initRes.body).result.instructions, /CONNECTOR WRITE-ROUTING POLICY:/);

  const writeRes = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dev_write', arguments: {} } });
  assert.equal(JSON.parse(writeRes.body).result.content[0].text, 'ok:dev_write');

  // 2. Stalled partial POST body hits 408 Request Timeout instead of holding pending/active slots.
  const timedOutStatus = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: f.port,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'gemini-connector/1.0', 'transfer-encoding': 'chunked' },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => {});
    req.write('{"jsonrpc":"2.0"');
    setTimeout(() => reject(new Error('expected 408 timeout')), 3000).unref();
  });
  assert.equal(timedOutStatus, 408);
});
