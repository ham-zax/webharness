import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWakeProxy, runBackendControl } from '../wake-proxy.mjs';
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
