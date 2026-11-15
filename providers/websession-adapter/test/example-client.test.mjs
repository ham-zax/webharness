import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

const clientPath = new URL('../../../examples/websession_client.py', import.meta.url).pathname;

async function fixture(t, handle) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const entry = { method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined };
    requests.push(entry);
    const value = handle(entry, req, res);
    if (res.destroyed) return;
    res.writeHead(res.statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function run(args) {
    const child = spawn('uv', ['run', '--no-project', '--no-managed-python', '--no-python-downloads', '--python', 'python3', 'python', clientPath, ...args], {
      env: { ...process.env, WS_BASE_URL: base, WS_TOKEN: 'fixture-only', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  }
  return { base, requests, run };
}

test('example batch uses valid defaults, polls, assembles chunks, and reports item failures', async t => {
  const f = await fixture(t, entry => {
    if (entry.method === 'POST') return {
      state: 'ready', results: [
        { state: 'running', status_url: `${f.base}/status/first` },
        { state: 'tool_failed', error: 'targeted test failed' },
      ],
    };
    if (entry.url.startsWith('/status/first')) return { state: 'completed', chunk_count: 2, chunk_base_url: `${f.base}/chunks/` };
    return { content: entry.url.endsWith('/1') ? 'hello ' : '🌍' };
  });
  const result = await f.run(['batch', JSON.stringify([{ tool: 'dev_read' }, { tool: 'dev_exec' }])]);
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(f.requests[0].body, { version: 1, calls: [{ tool: 'dev_read' }, { tool: 'dev_exec' }] });
  assert.deepEqual(f.requests.map(x => x.method), ['POST', 'GET', 'GET', 'GET']);
  const outputs = JSON.parse(result.stdout);
  assert.equal(outputs[0].result, 'hello 🌍');
  assert.match(outputs[1].error, /targeted test failed/);
});

test('example sequential batches stop by default and continue only on request', async t => {
  const f = await fixture(t, () => ({ state: 'ready', results: [{ state: 'completed', result: 'done' }] }));
  const calls = JSON.stringify([{ tool: 'dev_read' }]);
  assert.equal((await f.run(['batch', calls, '--seq'])).code, 0);
  assert.equal(f.requests[0].body.sequential, true);
  assert.equal(f.requests[0].body.stop_on_error, true);
  assert.equal((await f.run(['batch', calls, '--seq', '--continue'])).code, 0);
  assert.equal(f.requests[1].body.stop_on_error, false);
});

test('example exits 2 without resubmitting when a POST response is lost or returns 5xx', async t => {
  let drop = true;
  const f = await fixture(t, (_entry, req, res) => {
    if (drop) req.socket.destroy();
    else res.statusCode = 503;
    return { error: 'backend unavailable' };
  });
  const lost = await f.run(['call', 'dev_read', '{}']);
  assert.equal(lost.code, 2, lost.stderr);
  assert.match(lost.stderr, /Do not automatically retry/);
  assert.equal(f.requests.length, 1);
  drop = false;
  const outage = await f.run(['call', 'dev_read', '{}']);
  assert.equal(outage.code, 2, outage.stderr);
  assert.equal(f.requests.length, 2);
});
