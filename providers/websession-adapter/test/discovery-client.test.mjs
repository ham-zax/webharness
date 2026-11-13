import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HTTP_INSTRUCTIONS, webSessionInstructions, parseRequest, parseToolName, toolListSnapshot, toolSignature } from '../protocol.mjs';

const client = new URL('../client.sh', import.meta.url);
const clientPython = new URL('../client.py', import.meta.url);
const capability = 'c'.repeat(43);

test('discovery tool names share request validation and snapshots expose names and optional instructions', () => {
  for (const name of ['dev_read', 'tool.with-dashes', 'x'.repeat(128)]) {
    assert.equal(parseToolName(name), name);
    assert.equal(parseRequest({ version: 1, tool: name, arguments: {} }).normalized.tool, name);
  }
  for (const name of ['', 'x'.repeat(129), 'tool/name', 'tool name', 'é', undefined]) {
    assert.throws(() => parseToolName(name), /invalid tool name/);
    assert.throws(() => parseRequest({ version: 1, tool: name, arguments: {} }), /invalid tool name/);
  }
  const tools = [{ name: 'echo', inputSchema: {} }, { name: 'sleep', inputSchema: {} }];
  const expected = { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'ready', tool_count: 2, tools: ['echo', 'sleep'], instructions: HTTP_INSTRUCTIONS };
  assert.deepEqual(toolListSnapshot(tools), expected);
  assert.deepEqual(toolListSnapshot(tools, 'Use carefully'), { ...expected, instructions: webSessionInstructions('Use carefully') });
  assert.deepEqual(toolListSnapshot([], ''), { ...expected, tool_count: 0, tools: [] });
});

test('the public client exists with a bash shebang', () => {
  assert.match(readFileSync(client, 'utf8'), /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
});

test('the public Python client exists with a python shebang and compiles', () => {
  assert.match(readFileSync(clientPython, 'utf8'), /^#!\/usr\/bin\/env python3\n/);
  const compiled = spawnSync(
    'python3',
    ['-c', 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', clientPython.pathname],
    { encoding: 'utf8' },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
});

// A local curl shim tests shell parsing and arguments without an HTTP/MCP server.
function clientFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'websession-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const curl = join(directory, 'curl');
  writeFileSync(curl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$FIXTURE/argv"
out=''
while (( $# )); do
  case $1 in
    --output) out=$2; shift 2 ;;
    --header)
      if [[ $2 == @* ]]; then cat "\${2#@}" >> "$FIXTURE/headers"; fi
      shift 2 ;;
    --data-binary) cat "\${2#@}" > "$FIXTURE/request"; shift 2 ;;
    *) shift ;;
  esac
done
count=0
if [[ -f $FIXTURE/count ]]; then read -r count < "$FIXTURE/count"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FIXTURE/count"
if [[ $count == \${CURL_TIMEOUT_AT:-0} ]]; then exit 28; fi
cat "$FIXTURE/response-$count" > "$out"
printf '%s' "\${HTTP_CODE:-200}"
`);
  chmodSync(curl, 0o700);
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, WH_HOME: join(directory, 'home'), FIXTURE: directory };
  function run(args, responses, input = '', extraEnv = {}) {
    rmSync(join(directory, 'count'), { force: true });
    responses.forEach((body, index) => writeFileSync(join(directory, `response-${index + 1}`), body));
    return spawnSync('bash', [client.pathname, ...args], { env: { ...env, ...extraEnv }, input, encoding: 'utf8' });
  }
  const capability = 's'.repeat(43);
  const login = run(['login', 'https://bridge.example/'], ['echo\nsleep\n'], capability);
  assert.equal(login.status, 0, login.stderr);
  assert.equal(login.stdout, 'ok: 2 tools\n');
  assert.equal(statSync(join(env.WH_HOME, 'cap')).mode & 0o777, 0o600);
  assert.equal(statSync(join(env.WH_HOME, 'base')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(directory, 'argv'), 'utf8').includes(capability), false);
  assert.match(readFileSync(join(directory, 'headers'), 'utf8'), new RegExp(`Authorization: Bearer ${capability}`));
  return { directory, run, capability };
}

function response(state, result = '', extra = '') {
  return `WEBSESSION-MCP-BRIDGE/1\nstate: ${state}\noperation_id: op\nstatus_url: https://bridge.example/v1/operations/token/op\n${extra}${state === 'completed' ? `chunk_count: 1\nresult:\n${result}` : ''}`;
}

// The Python tests use a real local HTTP fixture so query strings, long polls,
// chunk reads, and output byte counts are exercised end to end.
function pythonFixture(t, handler) {
  const requests = [];
  let base = '';
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, base);
      const entry = {
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        at: Date.now(),
      };
      requests.push(entry);
      const body = handler(entry, base, req, res);
      if (req.destroyed || res.headersSent) return;
      if (body === undefined) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': raw.length });
      res.end(raw);
    });
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, requests });
    });
  });
}

function runPython(args, env, setup = '') {
  return new Promise((resolve, reject) => {
    const invocation = setup
      ? ['-c', `${setup}\nimport runpy, sys\nscript = sys.argv.pop(1)\nrunpy.run_path(script, run_name="__main__")`, clientPython.pathname, ...args]
      : [clientPython.pathname, ...args];
    const child = spawn('python3', invocation, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', WS_CAP: capability, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => resolve({
      status: code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function completed(result, base) {
  return {
    protocol: 'WEBSESSION-MCP-BRIDGE/1',
    state: 'completed',
    operation_id: 'op',
    status_url: `${base}/v1/operations/token/op`,
    chunk_count: 1,
    result,
  };
}

const OMISSION = /^([\s\S]*?)\n\[ws: ([0-9]+) of ([0-9]+) bytes shown, middle omitted; saved in local sandbox: (\/\S+); WS_MAX_OUTPUT=0 prints everything\]\n([\s\S]*)\n$/;

test('python client generates a fresh valid runtime idempotency key for each call', async (t) => {
  const { base, requests } = await pythonFixture(t, () => completed('ok', base));
  for (let index = 0; index < 2; index += 1) {
    const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'ok\n');
  }
  assert.equal(requests.length, 2);
  const keys = requests.map(entry => entry.headers['idempotency-key']);
  for (const key of keys) {
    assert.equal(typeof key, 'string');
    assert.match(key, /^[A-Za-z0-9._-]{1,64}$/);
  }
  assert.notEqual(keys[0], keys[1]);
});

test('python client preserves an opaque status URL and stops on not_found without resubmitting', async (t) => {
  const statusPath = '/v1/operations/opaque-continuation/opaque-operation';
  const { base, requests } = await pythonFixture(t, (entry, base, req, res) => {
    if (entry.method === 'POST') {
      return { state: 'running', status_url: `${base}${statusPath}?source=original` };
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: 'rejected', code: 'not_found' }));
  });
  const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /HTTP 404.*not_found/);
  assert.deepEqual(requests.map(entry => [entry.method, entry.path]), [
    ['POST', '/v1/calls'], ['GET', statusPath],
  ]);
  assert.equal(requests[1].query.get('source'), 'original');
});

test('python client bounds multi-byte output and saves the exact result at 0600', async (t) => {
  const full = `HEAD${'🌍✓'.repeat(4000)}TAIL`;
  const { base, requests } = await pythonFixture(t, entry => {
    assert.equal(entry.method, 'POST');
    return completed(full, base);
  });
  const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(run.status, 0, run.stderr);
  const match = run.stdout.match(OMISSION);
  assert.ok(match, run.stdout);
  const [, prefix, shown, total, path, suffix] = match;
  t.after(() => rmSync(path, { force: true }));
  assert.match(path, /\/webharness-result-[^/]+\.txt$/);
  assert.equal(Number(total), Buffer.byteLength(full, 'utf8'));
  assert.ok(Number(shown) <= 4096, 'default display limit is 4096 bytes, matching DEFAULT_MAX_OUTPUT in client.py');
  assert.equal(Number(shown), Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(suffix, 'utf8'));
  assert.ok(prefix.length > 0);
  assert.ok(suffix.length > 0);
  assert.ok(full.startsWith(prefix));
  assert.ok(full.endsWith(suffix));
  assert.equal(run.stdout.includes('\uFFFD'), false);
  assert.equal(readFileSync(path, 'utf8'), full);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8').includes(capability), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].query.get('wait'), '2');
  assert.equal(requests[0].headers.authorization, `Bearer ${capability}`);
});

test('python client keeps small and empty output and WS_MAX_OUTPUT=0 prints everything', async (t) => {
  const full = `HEAD${'🌍'.repeat(5000)}TAIL`;
  let current = full;
  const { base } = await pythonFixture(t, () => completed(current, base));
  const env = { WS_BASE: base };
  const zero = await runPython(['call', 'echo', '{}'], { ...env, WS_MAX_OUTPUT: '0' });
  assert.equal(zero.status, 0, zero.stderr);
  assert.equal(zero.stdout, `${full}\n`);
  assert.equal(zero.stdout.includes('[ws:'), false);

  current = 'small ✓';
  const small = await runPython(['call', 'echo', '{}'], env);
  assert.equal(small.status, 0, small.stderr);
  assert.equal(small.stdout, 'small ✓\n');

  current = '';
  const empty = await runPython(['call', 'echo', '{}'], env);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, '\n');

  current = 'x'.repeat(100);
  const custom = await runPython(['call', 'echo', '{}'], { ...env, WS_MAX_OUTPUT: '40' });
  assert.equal(custom.status, 0, custom.stderr);
  const match = custom.stdout.match(OMISSION);
  assert.ok(match, custom.stdout);
  const [, prefix, shown, total, path, suffix] = match;
  t.after(() => rmSync(path, { force: true }));
  assert.equal(Number(total), 100);
  assert.equal(Number(shown), 40);
  assert.equal(prefix.length, 30);
  assert.equal(suffix.length, 10);
  assert.equal(readFileSync(path, 'utf8'), current);
});

test('python client rejects invalid output limits before any request', async (t) => {
  const { base, requests } = await pythonFixture(t, () => completed('ok', base));
  for (const value of ['x', '-1', '1.5', '', ' 8', '8 ', '+8', '0x10']) {
    const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base, WS_MAX_OUTPUT: value });
    assert.equal(run.status, 1, `${JSON.stringify(value)}: ${run.stderr}`);
    assert.match(run.stderr, /WS_MAX_OUTPUT/);
    assert.equal(requests.length, 0);
  }
});

test('python client reconstructs inline and chunked completions', async (t) => {
  let chunked = false;
  const { base, requests } = await pythonFixture(t, (entry) => {
    if (entry.path.endsWith('/chunk/1')) return { content: 'first ✓ ' };
    if (entry.path.endsWith('/chunk/2')) return { content: 'second 🌍' };
    if (!chunked) return completed('inline ✓', base);
    return {
      protocol: 'WEBSESSION-MCP-BRIDGE/1',
      state: 'completed',
      operation_id: 'op',
      status_url: `${base}/v1/operations/token/op`,
      chunk_count: 2,
      chunk_base_url: `${base}/v1/operations/token/op/chunk/`,
    };
  });
  const inline = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(inline.status, 0, inline.stderr);
  assert.equal(inline.stdout, 'inline ✓\n');
  chunked = true;
  const split = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(split.status, 0, split.stderr);
  assert.equal(split.stdout, 'first ✓ second 🌍\n');
  assert.equal(requests.filter(entry => entry.method === 'POST').length, 2);
  assert.deepEqual(requests.filter(entry => entry.method === 'GET').map(entry => entry.path),
    ['/v1/operations/token/op/chunk/1', '/v1/operations/token/op/chunk/2']);
});

test('python client reuses HTTP keep-alive sockets across submit/poll/chunks and retries transient GET 502/503 without resubmitting POST', async (t) => {
  const sockets = new Set();
  let server;
  let base = '';
  const requests = [];
  let transientMode = false;
  let pollFails = 0;
  let chunk1Fails = 0;

  await new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url, base);
        requests.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers });
        const sendJson = (status, obj, close = false) => {
          const raw = Buffer.from(JSON.stringify(obj), 'utf8');
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Content-Length': raw.length,
            ...(close ? { Connection: 'close' } : {}),
          });
          res.end(raw);
        };
        if (req.method === 'POST' && url.pathname === '/v1/calls') {
          return sendJson(200, {
            protocol: 'WEBSESSION-MCP-BRIDGE/1',
            state: 'running',
            operation_id: 'op-ka',
            status_url: `${base}/v1/operations/token/op-ka`,
          });
        }
        if (req.method === 'GET' && url.pathname === '/v1/operations/token/op-ka') {
          if (transientMode && pollFails === 0) {
            pollFails += 1;
            return sendJson(502, { error: 'bad_gateway' }, true);
          }
          return sendJson(200, {
            protocol: 'WEBSESSION-MCP-BRIDGE/1',
            state: 'completed',
            operation_id: 'op-ka',
            status_url: `${base}/v1/operations/token/op-ka`,
            chunk_count: 2,
            chunk_base_url: `${base}/v1/operations/token/op-ka/chunk/`,
          });
        }
        if (req.method === 'GET' && url.pathname.endsWith('/chunk/1')) {
          if (transientMode && chunk1Fails === 0) {
            chunk1Fails += 1;
            return sendJson(503, { error: 'service_unavailable' }, true);
          }
          return sendJson(200, { content: 'keepalive-' });
        }
        if (req.method === 'GET' && url.pathname.endsWith('/chunk/2')) {
          return sendJson(200, { content: 'verified' });
        }
        res.statusCode = 404;
        res.end();
      });
    });
    server.on('connection', sock => sockets.add(sock));
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  // 1) Clean run: POST + GET status + GET chunk/1 + GET chunk/2 all share 1 TCP connection.
  const cleanRun = await runPythonInput(['call', 'echo', '{}'], { WS_BASE: base, WS_CAP: capability });
  assert.equal(cleanRun.status, 0, cleanRun.stderr);
  assert.equal(cleanRun.stdout, 'keepalive-verified\n');
  assert.equal(requests.length, 4);
  assert.equal(sockets.size, 1, 'submit, poll, and chunk reads must reuse one keep-alive TCP connection');

  // 2) Transient gateway 502/503 on GET status/chunk retries cleanly without resubmitting POST.
  requests.length = 0;
  transientMode = true;
  const retryRun = await runPythonInput(['call', 'echo', '{}'], { WS_BASE: base, WS_CAP: capability });
  assert.equal(retryRun.status, 0, retryRun.stderr);
  assert.equal(retryRun.stdout, 'keepalive-verified\n');
  assert.equal(requests.filter(r => r.method === 'POST').length, 1, 'POST submission must never be replayed');
  assert.equal(pollFails, 1);
  assert.equal(chunk1Fails, 1);
  assert.equal(requests.filter(r => r.method === 'GET').length, 5);
});


test('python client honors a port-specific NO_PROXY entry', async t => {
  let proxyRequests = 0;
  const proxy = createServer((req, res) => { proxyRequests += 1; res.writeHead(502).end(); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const { base, requests } = await pythonFixture(t, () => ({ state: 'completed', result: 'bypassed' }));
  const authority = new URL(base).host;
  const run = await runPython(['call', 'echo', '{}'], {
    WS_BASE: base,
    http_proxy: `http://127.0.0.1:${proxy.address().port}`,
    no_proxy: authority,
    NO_PROXY: authority,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'bypassed\n');
  assert.equal(requests.length, 1);
  assert.equal(proxyRequests, 0);
});

test('python client long-polls queued status with one initiator and no 1.5s sleep', async (t) => {
  let polls = 0;
  const { base, requests } = await pythonFixture(t, (entry) => {
    if (entry.method === 'POST') {
      return {
        protocol: 'WEBSESSION-MCP-BRIDGE/1',
        state: 'running',
        operation_id: 'op',
        status_url: `${base}/v1/operations/token/op?source=test`,
      };
    }
    polls += 1;
    return {
      protocol: 'WEBSESSION-MCP-BRIDGE/1',
      state: polls === 1 ? 'running' : 'completed',
      operation_id: 'op',
      status_url: `${base}/v1/operations/token/op?source=test`,
      ...(polls === 1 ? {} : { chunk_count: 1, result: 'delayed ✓' }),
    };
  });
  const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'delayed ✓\n');
  const posts = requests.filter(entry => entry.method === 'POST');
  const gets = requests.filter(entry => entry.method === 'GET');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].query.get('wait'), '2');
  assert.equal(gets.length, 2);
  assert.ok(Number(gets[0].query.get('wait')) <= 89);
  assert.ok(Number(gets[0].query.get('wait')) >= 0);
  assert.equal(gets[0].query.get('source'), 'test');
  const secondWait = Number(gets[1].query.get('wait'));
  assert.ok(Number.isInteger(secondWait) && secondWait >= 0 && secondWait <= 90);
  assert.equal(gets[1].query.get('source'), 'test');
  assert.ok(gets[0].at - posts[0].at < 1000, `status poll waited ${gets[0].at - posts[0].at}ms`);
});

test('python client keeps a bounded completed result when saving the full output fails', async (t) => {
  const full = `HEAD${'🌍'.repeat(5000)}TAIL`;
  const { base, requests } = await pythonFixture(t, () => completed(full, base));
  const setup = 'import tempfile\ndef unavailable(*args, **kwargs):\n    raise OSError("fixture disk full")\ntempfile.NamedTemporaryFile = unavailable';
  const run = await runPython(['sh', 'pwd'], { WS_BASE: base }, setup);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.startsWith('HEAD'));
  assert.ok(run.stdout.endsWith('TAIL\n'));
  assert.match(run.stdout, /local sandbox file not saved: fixture disk full; do not rerun the tool/);
  assert.ok(Buffer.byteLength(run.stdout) < 9000);
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].body).tool, 'dev_bash');
});

test('python client reports lost creation responses as unknown without resubmitting', async (t) => {
  const { base, requests } = await pythonFixture(t, (_entry, _base, req) => {
    req.socket.destroy();
  });
  const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /submission outcome unknown; do not retry/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].query.get('wait'), '2');
});

test('python client treats post-persist server errors as unknown and keeps client errors definite', async (t) => {
  let status = 500;
  let persisted = 0;
  const { base, requests } = await pythonFixture(t, (_entry, _base, _req, res) => {
    if (status >= 500) persisted += 1;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'fixture response after submission' }));
  });
  for (status of [500, 502, 503, 504, 400, 401, 413]) {
    const before = requests.length;
    const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
    assert.equal(run.status, status >= 500 ? 2 : 1, run.stderr);
    assert.equal(requests.length, before + 1);
    if (status >= 500) assert.match(run.stderr, /submission outcome unknown; do not retry/);
    else assert.doesNotMatch(run.stderr, /outcome unknown/);
  }
  assert.equal(persisted, 4);
});

test('python client warns on truncated submissions and handles unreadable client-error bodies', async (t) => {
  let status = 200;
  const { base, requests } = await pythonFixture(t, (_entry, _base, _req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': '1000', Connection: 'close' });
    res.end('{}');
  });
  const truncated = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(truncated.status, 2, truncated.stderr);
  assert.match(truncated.stderr, /submission outcome unknown; do not retry/);
  assert.doesNotMatch(truncated.stderr, /Traceback/);
  assert.equal(requests.length, 1);
  status = 400;
  const definite = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(definite.status, 1, definite.stderr);
  assert.match(definite.stderr, /HTTP 400.*unreadable error response/);
  assert.doesNotMatch(definite.stderr, /Traceback|outcome unknown/);
  assert.equal(requests.length, 2);
});

test('python client rejects malformed submission snapshots without resubmitting', async (t) => {
  let body;
  const { base, requests } = await pythonFixture(t, () => body);
  for (body of [null, [], 42, 'running', {}, { state: 'running' }, { state: 'queued', status_url: 42 },
    { state: 'completed' }, { state: 'completed', chunk_count: 'bad' },
    { state: 'completed', chunk_count: 2, chunk_base_url: '' }]) {
    const before = requests.length;
    const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /invalid operation snapshot; submission outcome unknown; do not retry/);
    assert.equal(requests.length, before + 1);
  }
});

test('python client rejects malformed status and chunk responses without a new submission', async (t) => {
  let chunked = false;
  const { base, requests } = await pythonFixture(t, entry => {
    if (entry.method === 'GET') return null;
    return chunked
      ? { state: 'completed', chunk_count: 2, chunk_base_url: `${base}/chunk/` }
      : { state: 'running', status_url: `${base}/status` };
  });
  const status = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(status.status, 1, status.stderr);
  assert.match(status.stderr, /invalid operation snapshot; do not resubmit/);
  chunked = true;
  const chunk = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(chunk.status, 1, chunk.stderr);
  assert.match(chunk.stderr, /invalid result chunk; do not resubmit/);
  assert.equal(requests.filter(entry => entry.method === 'POST').length, 2);
});

test('python client stops on unsupported states and warns about unknown outcomes', async (t) => {
  let state = 'confirmation_required';
  const { base, requests } = await pythonFixture(t, () => ({ state }));
  const unsupported = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /unsupported operation state confirmation_required/);
  assert.equal(requests.length, 1);
  state = 'unknown_outcome';
  const unknown = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /do not retry; check whether the tool ran/);
  assert.equal(requests.length, 2);
});

test('python client includes submission time in its polling budget and retains the recovery URL', async (t) => {
  const { base, requests } = await pythonFixture(t, () => ({
    state: 'running', status_url: `${base}/v1/operations/token/op`,
  }));
  const setup = 'import time\nclock = iter([0.0, 91.0])\ntime.monotonic = lambda: next(clock)';
  const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base }, setup);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /operation still running; poll http:\/\/127\.0\.0\.1:/);
  assert.equal(requests.length, 1);
});

test('python client stops after a zero-second final status hold without resubmitting', async (t) => {
  const { base, requests } = await pythonFixture(t, () => ({
    state: 'running', status_url: `${base}/v1/operations/token/op`,
  }));
  const setup = 'import time\nclock = iter([0.0, 89.5])\ntime.monotonic = lambda: next(clock)';
  const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base, WS_WAIT: '0' }, setup);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /operation still running/);
  assert.deepEqual(requests.map(entry => [entry.method, entry.query.get('wait')]), [['POST', '0'], ['GET', '0']]);
});

test('client streams results exactly, builds file/stdin arguments, and polls running operations', (t) => {
  const { directory, run, capability } = clientFixture(t);
  const text = '🌍\nstate: unknown_outcome\nresult:\nstatus_url: fake\n\n';
  const completed = run(['call', 'echo', '-'], [response('running'), response('completed', text)], '{"text":"hello"}\n');
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.stdout, text);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'request'), 'utf8')), { version: 1, tool: 'echo', arguments: { text: 'hello' } });
  assert.equal(readFileSync(join(directory, 'argv'), 'utf8').includes(capability), false);
  const path = join(directory, 'arguments.json');
  writeFileSync(path, '{"n":2}\n');
  const file = run(['call', 'echo', `@${path}`], [response('completed', 'no trailing newline')]);
  assert.equal(file.status, 0, file.stderr);
  assert.equal(file.stdout, 'no trailing newline');
  assert.equal(JSON.parse(readFileSync(join(directory, 'request'), 'utf8')).arguments.n, 2);
  const empty = run(['call', 'echo'], [response('completed')]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, '');
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'request'), 'utf8')).arguments, {});
});

test('client handles instructions, schemas, failure states, and single status fetches', (t) => {
  const { run } = clientFixture(t);
  for (const [args, body] of [[['tools'], 'echo\n'], [['instructions'], ''], [['instructions'], 'instructions\n'], [['schema', 'echo'], '{"name":"echo"}']]) {
    const result = run(args, [body]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, body);
  }
  for (const state of ['tool_failed', 'rejected', 'expired', 'confirmation_required', 'unexpected']) {
    const result = run(['call', 'echo'], [response(state, '', 'error: bad\n')]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(state));
  }
  const unknown = run(['call', 'echo'], [response('unknown_outcome')]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /do not retry/);
  const status = run(['status', 'https://bridge.example/v1/operations/token/op'], [response('completed', 'done')]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, 'done');
  const running = run(['status', 'https://bridge.example/v1/operations/token/op'], [response('running')]);
  assert.equal(running.status, 3);
  assert.match(running.stderr, /status_url: https:\/\/bridge.example\/v1\/operations/);
  const invalid = run(['call', 'bad/tool'], []);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /invalid tool name/);
});


test('client reports polling timeouts without retrying the call and rejects HTTP errors', (t) => {
  const { directory, run, capability } = clientFixture(t);
  const timed = run(['call', 'echo'], [response('running'), ''], '', { CURL_TIMEOUT_AT: '2', WH_MAX_SECONDS: '1', WH_WAIT: '0' });
  assert.equal(timed.status, 3, timed.stderr);
  assert.equal(timed.stdout, '');
  assert.match(timed.stderr, /status_url: https:\/\/bridge.example\/v1\/operations\/token\/op/);
  assert.match(readFileSync(join(directory, 'argv'), 'utf8'), /--max-time\n1\n/);
  const rejected = run(['login', 'https://bridge.example'], ['{}'], capability, { HTTP_CODE: '401' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /HTTP 401/);
  assert.equal(rejected.stdout.includes(capability), false);
  assert.equal(rejected.stderr.includes(capability), false);
  const invalidWait = run(['tools'], [], '', { WH_WAIT: '91' });
  assert.equal(invalidWait.status, 1);
  assert.match(invalidWait.stderr, /WH_WAIT/);
});

test('tool signatures put required parameters first and keep one summary sentence', () => {
  assert.equal(toolSignature({
    name: 'run',
    description: 'Run a  program; prefer exec. More text.',
    inputSchema: { type: 'object', required: ['command'], properties: {
      cwd: { type: 'string' }, command: { type: 'string' }, argv: { type: 'array', items: { type: 'string' } },
      mode: { enum: ['a', 'b'] }, count: { type: 'integer' },
    } },
  }), 'run(command: string, cwd?: string, argv?: string[], mode?: "a"|"b", count?: number)  Run a program;');
  assert.equal(toolSignature({ name: 'bare' }), 'bare()');
});

test('client sh sends a script without JSON quoting and reports errors that lack a final newline', (t) => {
  const { directory, run } = clientFixture(t);
  const script = 'x="it\'s \\"q\\" $HOME"\n\tprintf \'%s\\\\n\' "$x" \u0001é';
  for (const [args, input] of [[['sh'], script], [['sh', '-'], script], [['sh', script], '']]) {
    const result = run(args, [response('completed', 'ok')], input);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'request'), 'utf8')),
      { version: 1, tool: 'dev_bash', arguments: { command: script } });
  }
  assert.equal(run(['sh', 'echo', 'a b'], [response('completed')], '', { WH_SH_TOOL: 'other' }).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'request'), 'utf8')),
    { version: 1, tool: 'other', arguments: { command: 'echo a b' } });
  assert.equal(run(['sh'], [], '').status, 1);
  const failed = run(['call', 'echo'], ['WEBSESSION-MCP-BRIDGE/1\nstate: tool_failed\nerror: first line\nsecond line']);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, 'tool_failed: first line\nsecond line\n');
  const rejected = run(['call', 'echo', '{'], ['{"code":"invalid_request","message":"bad JSON"}\n'], '', { HTTP_CODE: '400' });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stderr, 'HTTP 400: {"code":"invalid_request","message":"bad JSON"}\n');
});

test('client caps large results, keeps head and tail, and saves the full output', (t) => {
  const { directory, run } = clientFixture(t);
  const big = `${'a'.repeat(60)}${'m'.repeat(200)}${'z'.repeat(20)}`;
  const capped = run(['call', 'echo'], [response('completed', big)], '', { WH_MAX_OUTPUT: '80' });
  assert.equal(capped.status, 0, capped.stderr);
  const last = join(directory, 'home', 'last');
  assert.equal(capped.stdout,
    `${'a'.repeat(60)}\n[wh: 80 of 280 bytes shown, middle omitted; full output: ${last}; WH_MAX_OUTPUT=0 prints everything]\n${'z'.repeat(20)}`);
  assert.equal(readFileSync(last, 'utf8'), big);
  assert.equal(statSync(last).mode & 0o777, 0o600);
  assert.equal(run(['call', 'echo'], [response('completed', big)], '', { WH_MAX_OUTPUT: '0' }).stdout, big);
  assert.equal(run(['call', 'echo'], [response('completed', big)], '', { WH_MAX_OUTPUT: '280' }).stdout, big);
  assert.equal(run(['tools'], [], '', { WH_MAX_OUTPUT: 'x' }).status, 1);
});

function runPythonInput(args, env = {}, input = '') {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', ...env };
    const child = spawn('python3', [clientPython.pathname, ...args], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => resolve({
      status: code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(input, 'utf8');
  });
}

test('python client connect exchanges pair code, writes 0600 session file without leaking secret, and uses wait=2 fast path', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-py-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'nested', 'session.json');
  const issuedSecret = 'p'.repeat(43);
  const { base, requests } = await pythonFixture(t, (entry, fixtureBase, _req, res) => {
    if (entry.method === 'POST' && entry.path === '/v1/pair') {
      const parsed = JSON.parse(entry.body);
      if (parsed.code !== 'cedar-4821-k9xm') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'not_found' }));
        return undefined;
      }
      return {
        protocol: 'WEBSESSION-MCP-BRIDGE/1',
        state: 'ready',
        capability: issuedSecret,
        scope: 'main',
        expires_at: '2026-12-01T00:00:00.000Z',
        default_cwd: '/home/ubuntu/repo/webharness',
      };
    }
    if (entry.method === 'GET' && entry.path === '/v1/signatures') {
      return {
        protocol: 'WEBSESSION-MCP-BRIDGE/1',
        state: 'ready',
        signatures: ['dev_read(path?: string)  Read UTF-8 text.', 'dev_bash(command: string)  Run Bash.'],
      };
    }
    if (entry.method === 'GET' && entry.path === '/v1/instructions') {
      return { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'ready', instructions: '<dev>\nSafe policy\n</dev>' };
    }
    if (entry.method === 'POST' && entry.path === '/v1/calls') {
      return completed('ok-fast', fixtureBase);
    }
    return undefined;
  });

  const env = { WH_SESSION_FILE: sessionFile, WS_BASE: '', WS_CAP: '' };
  const badPair = await runPythonInput(['connect', base, 'wrong-0000-code'], env);
  assert.equal(badPair.status, 1, badPair.stderr);
  assert.doesNotMatch(badPair.stderr, /submission outcome unknown/);

  const connected = await runPythonInput(['connect', base, 'cedar-4821-k9xm'], env);
  assert.equal(connected.status, 0, connected.stderr);
  assert.equal(connected.stdout.includes(issuedSecret), false);
  assert.equal(connected.stderr.includes(issuedSecret), false);
  assert.match(connected.stdout, /^CONNECTED\nbase: http:\/\/127\.0\.0\.1:[0-9]+\ncwd: \/home\/ubuntu\/repo\/webharness\ntools: 2\ndev_read/);
  assert.match(connected.stdout, /<dev>\nSafe policy\n<\/dev>/, 'legacy discovery includes guidance as well as signatures');
  const legacyGuidance = requests.find(r => r.path === '/v1/instructions');
  assert.equal(legacyGuidance.headers.authorization, `Bearer ${issuedSecret}`);
  assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(sessionFile, 'utf8'));
  assert.equal(saved.cap, issuedSecret);
  assert.equal(saved.cwd, '/home/ubuntu/repo/webharness');
  assert.equal(saved.wait, 2);

  // Pair POST must not carry Authorization or Idempotency-Key, and all requests carry User-Agent.
  const pairReq = requests.find(r => r.path === '/v1/pair' && r.body.includes('cedar-4821-k9xm'));
  assert.ok(pairReq);
  assert.equal(pairReq.headers.authorization, undefined);
  assert.equal(pairReq.headers['idempotency-key'], undefined);
  assert.equal(pairReq.headers['user-agent'], 'websession-client/1.0');

  const sigs = await runPythonInput(['sigs'], env);
  assert.equal(sigs.status, 0, sigs.stderr);
  assert.match(sigs.stdout, /dev_bash\(command: string\)/);

  const toolsCompact = await runPythonInput(['tools'], env);
  assert.equal(toolsCompact.status, 0, toolsCompact.stderr);
  assert.equal(toolsCompact.stdout, sigs.stdout);

  const inst = await runPythonInput(['instructions'], env);
  assert.equal(inst.status, 0, inst.stderr);
  assert.equal(inst.stdout, '<dev>\nSafe policy\n</dev>\n');

  const fastCall = await runPythonInput(['sh', 'echo hi'], env);
  assert.equal(fastCall.status, 0, fastCall.stderr);
  assert.equal(fastCall.stdout, 'ok-fast\n');
  const callPost = requests.find(r => r.path === '/v1/calls');
  assert.equal(callPost.query.get('wait'), '2');
  assert.equal(callPost.headers.authorization, `Bearer ${issuedSecret}`);
  assert.deepEqual(JSON.parse(callPost.body), {
    version: 1,
    tool: 'dev_bash',
    arguments: { command: 'echo hi', cwd: '/home/ubuntu/repo/webharness' },
  });
});

test('python client harness subcommands resolve sticky cwd, accept stdin payloads, unwrap structuredContent, and batch calls', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-py-cmds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'session.json');
  const calls = [];
  const batches = [];
  const { base } = await pythonFixture(t, (entry, fixtureBase) => {
    if (entry.method === 'GET' && entry.path === '/v1/tools') {
      return { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'ready', tool_count: 2, tools: ['dev_read', 'dev_search'] };
    }
    if (entry.method === 'POST' && entry.path === '/v1/calls') {
      const parsed = JSON.parse(entry.body);
      calls.push(parsed);
      if (parsed.tool === 'dev_review_changes') {
        return completed(JSON.stringify({
          content: [{ type: 'text', text: '1 changed file\n--- patch ---\n+clean' }],
          structuredContent: { files: 1, patch: '+clean' },
        }), fixtureBase);
      }
      return completed(`${parsed.tool}:ok`, fixtureBase);
    }
    if (entry.method === 'POST' && entry.path === '/v1/batch') {
      const parsed = JSON.parse(entry.body);
      batches.push(parsed);
      return {
        protocol: 'WEBSESSION-MCP-BRIDGE/1',
        state: 'ready',
        results: parsed.calls.map((item, idx) => ({
          protocol: 'WEBSESSION-MCP-BRIDGE/1',
          state: 'completed',
          operation_id: `op-${idx}`,
          status_url: `${fixtureBase}/v1/operations/token/op-${idx}`,
          chunk_count: 1,
          result: `${item.tool}:batch-ok`,
        })),
      };
    }
    return undefined;
  });
  writeFileSync(sessionFile, JSON.stringify({ base, cap: capability, cwd: '/workspace/app', wait: 2 }), { mode: 0o600 });
  const env = { WH_SESSION_FILE: sessionFile, WS_BASE: '', WS_CAP: '' };

  const pwd1 = await runPythonInput(['pwd'], env);
  assert.equal(pwd1.stdout, '/workspace/app\n');

  const cdSub = await runPythonInput(['cd', 'packages/core'], env);
  assert.equal(cdSub.status, 0, cdSub.stderr);
  assert.equal(cdSub.stdout, 'cwd: /workspace/app/packages/core\n');

  assert.equal((await runPythonInput(['ls', 'src', '--limit', '25'], env)).status, 0);
  assert.deepEqual(calls.at(-1), {
    version: 1,
    tool: 'dev_list_directory',
    arguments: { path: '/workspace/app/packages/core/src', limit: 25 },
  });

  assert.equal((await runPythonInput(['read', 'index.mjs', '10', '40', '--outline'], env)).status, 0);
  assert.deepEqual(calls.at(-1), {
    version: 1,
    tool: 'dev_read',
    arguments: { path: '/workspace/app/packages/core/index.mjs', offset: 10, limit: 40, mode: 'outline' },
  });

  assert.equal((await runPythonInput(['read', '--targets'], env, '[{"path":"a.js","mode":"outline"},{"path":"/abs/b.js","limit":20}]')).status, 0);
  assert.deepEqual(calls.at(-1), {
    version: 1,
    tool: 'dev_read',
    arguments: {
      targets: [
        { path: '/workspace/app/packages/core/a.js', mode: 'outline' },
        { path: '/abs/b.js', limit: 20 },
      ],
    },
  });

  // Home paths must reach the remote provider unchanged, even with a sticky cwd.
  for (const homePath of ['~', '~/notes.txt']) {
    assert.equal((await runPythonInput(['read', homePath], env)).status, 0);
    assert.equal(calls.at(-1).arguments.path, homePath);
    assert.equal((await runPythonInput(['write', homePath], env, 'home content')).status, 0);
    assert.equal(calls.at(-1).arguments.path, homePath);
    assert.equal((await runPythonInput(['edit'], env, JSON.stringify({ path: homePath, oldText: 'a', newText: 'b' }))).status, 0);
    assert.equal(calls.at(-1).arguments.targets[0].path, homePath);
  }

  const bareNames = await runPythonInput(['tools', '--names'], env);
  assert.equal(bareNames.status, 0, bareNames.stderr);
  assert.equal(bareNames.stdout, 'tool_count: 2\ndev_read\ndev_search\n');

  assert.equal((await runPythonInput(['rg', 'needle', 'src', '-g', '*.mjs', '-m', '15', '-F', '-s', '--all'], env)).status, 0);
  assert.deepEqual(calls.at(-1), {
    version: 1,
    tool: 'dev_search',
    arguments: {
      pattern: 'needle',
      path: '/workspace/app/packages/core/src',
      globs: ['*.mjs'],
      max_results: 15,
      literal: true,
      case_sensitive: true,
      include_vendor: true,
    },
  });

  assert.equal((await runPythonInput(['edit'], env, JSON.stringify({ path: 'index.mjs', oldText: 'a', newText: 'b', diff: true }))).status, 0);
  assert.deepEqual(calls.at(-1), {
    version: 1,
    tool: 'dev_edit',
    arguments: {
      diff: true,
      targets: [{ path: '/workspace/app/packages/core/index.mjs', edits: [{ oldText: 'a', newText: 'b' }] }],
    },
  });

  assert.equal((await runPythonInput(['write', 'notes/out.txt', '--overwrite', '--mkdir', '--mode', '644'], env, 'hello world\n')).status, 0);
  assert.deepEqual(calls.at(-1), {
    version: 1,
    tool: 'dev_write',
    arguments: {
      path: '/workspace/app/packages/core/notes/out.txt',
      content: 'hello world\n',
      overwrite: true,
      mkdir_parents: true,
      mode: '644',
    },
  });

  const rev = await runPythonInput(['review', 'index.mjs'], env);
  assert.equal(rev.status, 0, rev.stderr);
  assert.equal(rev.stdout, '1 changed file\n--- patch ---\n+clean\n');
  assert.equal(rev.stdout.includes('structuredContent'), false);

  const shStdin = await runPythonInput(['sh'], env, 'git status -sb\n');
  assert.equal(shStdin.status, 0, shStdin.stderr);
  assert.deepEqual(calls.at(-1), {
    version: 1,
    tool: 'dev_bash',
    arguments: { command: 'git status -sb\n', cwd: '/workspace/app/packages/core' },
  });

  const callsBeforeBatch = calls.length;
  const batchOut = await runPythonInput(['batch'], env, JSON.stringify([
    { tool: 'dev_read', arguments: { path: 'x.mjs', limit: 10 } },
    { tool: 'dev_search', arguments: { pattern: 'foo' } },
    { tool: 'dev_bash', arguments: { command: 'true' } },
  ]));
  assert.equal(batchOut.status, 0, batchOut.stderr);
  assert.equal(calls.length, callsBeforeBatch, 'batch must use /v1/batch rather than sequential /v1/calls');
  assert.equal(batches.length, 1);
  assert.match(batchOut.stdout, /=== \[1\/3\] dev_read ===\ndev_read:batch-ok[\s\S]*=== \[2\/3\] dev_search ===\ndev_search:batch-ok[\s\S]*=== \[3\/3\] dev_bash ===\ndev_bash:batch-ok/);
  assert.deepEqual(batches[0], {
    version: 1,
    calls: [
      { tool: 'dev_read', arguments: { path: '/workspace/app/packages/core/x.mjs', limit: 10 } },
      { tool: 'dev_search', arguments: { pattern: 'foo', path: '/workspace/app/packages/core' } },
      { tool: 'dev_bash', arguments: { command: 'true', cwd: '/workspace/app/packages/core' } },
    ],
  });

  const cleared = await runPythonInput(['cd', '--clear'], env);
  assert.equal(cleared.stdout, 'cwd: (default)\n');
});

test('Python connect uses one bundled request and preserves a session when discovery is unavailable', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-bundled-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'session.json');
  const secret = 'b'.repeat(43);
  const { base, requests } = await pythonFixture(t, entry => {
    assert.equal(entry.method, 'POST');
    assert.equal(entry.path, '/v1/pair');
    assert.equal(entry.query.get('discover'), '1');
    const unavailable = JSON.parse(entry.body).code === 'offline';
    return {
      state: 'ready', capability: secret, default_cwd: '/project',
      discovery_state: unavailable ? 'unavailable' : 'ready',
      instructions: 'Use POST /v1/calls; do not probe routes.',
      ...(unavailable ? { discovery_error: 'discovery_unavailable' } : { signatures: ['dev_read(path: string)'] }),
    };
  });
  const env = { WH_SESSION_FILE: sessionFile, WS_BASE: '', WS_CAP: '' };
  const connected = await runPythonInput(['connect', base, 'ready'], env);
  assert.equal(connected.status, 0, connected.stderr);
  assert.equal(requests.length, 1, 'bundled setup requires just one HTTP request');
  assert.match(connected.stdout, /CONNECTED[\s\S]*tools: 1[\s\S]*POST \/v1\/calls/);
  assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8')).cap, secret);
  const compactPair = await runPythonInput(['pair', 'compact', '--base', base, '--cd', '/project/compact'], env);
  assert.equal(compactPair.status, 0, compactPair.stderr);
  assert.match(compactPair.stdout, /^CONNECTED\n/);
  assert.match(compactPair.stdout, /metadata: .*metadata\.json/);
  assert.doesNotMatch(compactPair.stdout, /dev_read\(path|POST \/v1\/calls/);
  assert.equal(requests.length, 2, 'compact pairing uses one request without extra discovery');
  const cached = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'));
  assert.deepEqual(cached.signatures, ['dev_read(path: string)']);
  assert.equal(cached.cwd, '/project/compact');
  assert.equal(statSync(join(dir, 'metadata.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8')).cwd, '/project/compact');
  const offline = await runPythonInput(['connect', base, 'offline'], env);
  assert.equal(offline.status, 0, offline.stderr);
  assert.equal(requests.length, 3, 'failed discovery must not trigger another pairing or lookup');
  assert.match(offline.stdout, /CONNECTED[\s\S]*tools: unavailable/);
  assert.match(offline.stderr, /Session saved.*do not pair again/);
  assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8')).cap, secret);
  for (const result of [connected, offline]) assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test('Python import-session privately adopts redeemed access without a network request', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-import-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'session.json');
  writeFileSync(sessionFile, '{}', { mode: 0o644 });
  const { base, requests } = await pythonFixture(t, (_entry, fixtureBase) => completed('project-ready', fixtureBase));
  const env = { WH_SESSION_FILE: sessionFile, WS_BASE: '', WS_CAP: '' };
  const secret = 'i'.repeat(43);
  const imported = await runPythonInput(['import-session', base], env, JSON.stringify({ capability: secret, default_cwd: '/project', instructions: 'not session data' }));
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /SESSION_IMPORTED/);
  assert.ok(!(imported.stdout + imported.stderr).includes(secret));
  assert.equal(requests.length, 0);
  assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')), { base, cap: secret, cwd: '/project', wait: 2 });
  const called = await runPythonInput(['sh', 'pwd'], env);
  assert.equal(called.status, 0, called.stderr);
  assert.equal(called.stdout, 'project-ready\n');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, `Bearer ${secret}`);
  assert.equal(JSON.parse(requests[0].body).arguments.cwd, '/project');

  const inputs = [[], { base, cap: 'invalid' }, { base: 'https://secret@example.com', cap: secret }, { base: 'https://@example.com', cap: secret }, { base: 'https://example.com:bad', cap: secret }, { base: 'https://example.com:99999', cap: secret }, { base, cap: secret, cwd: '' }, { base, cap: secret, wait: true }];
  for (const input of inputs) {
    const rejected = await runPythonInput(['import-session'], env, JSON.stringify(input));
    assert.equal(rejected.status, 1);
    assert.ok(!(rejected.stdout + rejected.stderr).includes(secret));
    assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8')).cap, secret);
  }
  const overridden = await runPythonInput(['import-session', '--cwd', '/other'], env, JSON.stringify({ base, cap: secret }));
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8')).cwd, '/other');
  assert.equal(requests.length, 1);
});

test('reference clients accept custom master bearers and reject unsafe token shapes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-custom-bearer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shell = clientFixture(t);
  const sessionFile = join(dir, 'session.json');
  const { base, requests } = await pythonFixture(t, (_entry, fixtureBase) => completed('custom-bearer-ok', fixtureBase));
  const env = { WH_SESSION_FILE: sessionFile, WS_BASE: '', WS_CAP: '' };
  for (const secret of ['a'.repeat(32), 'custom.master-' + 'x'.repeat(114)]) {
    const imported = await runPythonInput(['import-session', base], env, JSON.stringify({ capability: secret }));
    assert.equal(imported.status, 0, imported.stderr);
    assert.ok(!(imported.stdout + imported.stderr).includes(secret));
    const call = await runPythonInput(['sh', 'pwd'], env);
    assert.equal(call.status, 0, call.stderr);
    assert.equal(requests.at(-1).headers.authorization, `Bearer ${secret}`);
    const login = shell.run(['login', 'https://bridge.example'], ['echo\n'], secret);
    assert.equal(login.status, 0, login.stderr);
    const tools = shell.run(['tools'], ['echo\n']);
    assert.equal(tools.status, 0, tools.stderr);
    assert.ok(!(login.stdout + login.stderr + tools.stdout + tools.stderr).includes(secret));
  }
  for (const secret of ['a'.repeat(31), 'a'.repeat(129), 'a'.repeat(32) + ' bad', 'a'.repeat(32) + '\r\nInjected: yes']) {
    const imported = await runPythonInput(['import-session', base], env, JSON.stringify({ capability: secret }));
    assert.equal(imported.status, 1);
    const login = shell.run(['login', 'https://bridge.example'], [], secret);
    assert.notEqual(login.status, 0);
  }
});

test('Python client supports pipe/sequential batch, local shortcuts, pull (/v1/raw), ls --depth, and --save spooling', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-power-features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'session.json');
  const calls = [];
  const batches = [];
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
  const { base, requests } = await pythonFixture(t, (entry, fixtureBase, _req, res) => {
    if (entry.method === 'GET' && entry.path === '/v1/raw') {
      if (entry.query.get('path') !== '/tmp/shot.png') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'file_not_found' }));
        return undefined;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(pngBytes);
      return undefined;
    }
    if (entry.method === 'POST' && entry.path === '/v1/calls') {
      const parsed = JSON.parse(entry.body);
      calls.push({ parsed, wait: entry.query.get('wait') });
      if (parsed.tool === 'local_tool_call') {
        return completed(JSON.stringify({
          content: [{ type: 'text', text: `${parsed.arguments.server}.${parsed.arguments.tool}:${JSON.stringify(parsed.arguments.arguments)}` }],
          structuredContent: { ok: true },
        }), fixtureBase);
      }
      if (parsed.tool === 'dev_search') {
        return completed(Array.from({ length: 40 }, (_, i) => `src/file-${i}.mjs:${i + 1}:export const line${i} = ${i};`).join('\n'), fixtureBase);
      }
      return completed(`${parsed.tool}:${JSON.stringify(parsed.arguments)}`, fixtureBase);
    }
    if (entry.method === 'POST' && entry.path === '/v1/batch') {
      const parsed = JSON.parse(entry.body);
      batches.push({ parsed, wait: entry.query.get('wait') });
      if (parsed.calls.some(c => c.arguments?.fail)) {
        return {
          protocol: 'WEBSESSION-MCP-BRIDGE/1',
          state: 'ready',
          results: [
            completed('M a.js (+1 -1)', fixtureBase),
            { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'tool_failed', operation_id: 'op-fail', status_url: `${fixtureBase}/v1/operations/t/op-fail`, error: '1 test failed' },
            { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', operation_id: 'op-skip', status_url: `${fixtureBase}/v1/operations/t/op-skip`, error: 'skipped_after_prior_failure' },
          ],
        };
      }
      if (parsed.calls.some(c => c.arguments?.exit1)) {
        return {
          protocol: 'WEBSESSION-MCP-BRIDGE/1',
          state: 'ready',
          results: parsed.calls.map((_call, index) => completed(
            index === 0 ? 'M a.js (+1 -1)' : index === 1 ? 'assertion failed\n[exit 1 · 0.2s]' : 'continued after failure',
            fixtureBase,
          )),
        };
      }
      return {
        protocol: 'WEBSESSION-MCP-BRIDGE/1',
        state: 'ready',
        results: parsed.calls.map((c, idx) => completed(`step-${idx}:${c.tool}`, fixtureBase)),
      };
    }
    return undefined;
  });
  writeFileSync(sessionFile, JSON.stringify({ base, cap: capability, cwd: '/workspace/app', wait: 2 }), { mode: 0o600 });
  const env = { WH_SESSION_FILE: sessionFile, WS_BASE: '', WS_CAP: '' };

  // ls --depth --all forwards tree arguments.
  const treeOut = await runPythonInput(['ls', 'src', '--depth', '3', '--all'], env);
  assert.equal(treeOut.status, 0, treeOut.stderr);
  assert.deepEqual(calls.at(-1).parsed.arguments, { path: '/workspace/app/src', depth: 3, include_vendor: true });

  // lcall auto-unwraps local_tool_call and uses wait=10 floor when WS_WAIT is unset.
  const lcallOut = await runPythonInput(['lcall', 'browser-fast/observe', '{"scope":"compact"}'], env);
  assert.equal(lcallOut.status, 0, lcallOut.stderr);
  assert.equal(lcallOut.stdout, 'browser-fast.observe:{"scope":"compact"}\n');
  assert.equal(calls.at(-1).wait, '10');

  // lbatch normalizes plain argument objects into {arguments: ...}.
  const lbatchOut = await runPythonInput(['lbatch', 'browser-fast', 'observe', '[{"tab":"t1"},{"id":"b","arguments":{"tab":"t2"}}]', '--concurrency', '2'], env);
  assert.equal(lbatchOut.status, 0, lbatchOut.stderr);
  assert.deepEqual(calls.at(-1).parsed.arguments, {
    server: 'browser-fast',
    tool: 'observe',
    concurrency: 2,
    calls: [{ arguments: { tab: 't1' } }, { id: 'b', arguments: { tab: 't2' } }],
  });

  // pipe sets sequential:true with wait=10.
  const pipeOk = await runPythonInput(['pipe'], env, JSON.stringify([
    { tool: 'dev_edit', arguments: { targets: [{ path: 'a.js', edits: [{ oldText: 'x', newText: 'y' }] }] } },
    { tool: 'dev_review_changes', arguments: {} },
  ]));
  assert.equal(pipeOk.status, 0, pipeOk.stderr);
  assert.equal(batches.at(-1).parsed.sequential, true);
  assert.equal(batches.at(-1).wait, '10');

  // Failed sequential pipeline still prints earlier completed mutations before exiting 1.
  const pipeFail = await runPythonInput(['pipe'], env, JSON.stringify([
    { tool: 'dev_edit', arguments: { targets: [] } },
    { tool: 'dev_exec', arguments: { fail: true } },
    { tool: 'dev_review_changes', arguments: {} },
  ]));
  assert.equal(pipeFail.status, 1);
  assert.match(pipeFail.stdout, /=== \[1\/3\] dev_edit ===\nM a\.js \(\+1 -1\)/);
  assert.match(pipeFail.stdout, /=== \[2\/3\] dev_exec \[FAILED\] ===\n1 test failed/);
  assert.match(pipeFail.stdout, /=== \[3\/3\] dev_review_changes \[SKIPPED\] ===/);

  // pull downloads binary /tmp/... files at 0600.
  const pulledPath = join(dir, 'shot.png');
  const pulled = await runPythonInput(['pull', '/tmp/shot.png', pulledPath], env);
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.match(pulled.stdout, /PULLED 10B/);
  assert.deepEqual(readFileSync(pulledPath), pngBytes);
  assert.equal(statSync(pulledPath).mode & 0o777, 0o600);
  const rawReq = requests.find(r => r.path === '/v1/raw');
  assert.equal(rawReq.headers.accept, 'application/octet-stream');

  // --save writes full output privately while keeping stdout preview compact.
  const savedTxt = join(dir, 'rg-out.txt');
  const savedRun = await runPythonInput(['--save', savedTxt, 'rg', 'export'], env);
  assert.equal(savedRun.status, 0, savedRun.stderr);
  assert.match(savedRun.stdout, /\[ws: saved [0-9]+ bytes \(40 lines\)/);
  assert.match(savedRun.stdout, /previewing /);
  assert.equal(readFileSync(savedTxt, 'utf8').split('\n').length, 40);
  assert.equal(statSync(savedTxt).mode & 0o777, 0o600);

  // --save with multi-item batch preserves every item's output instead of overwriting per item.
  const savedBatchTxt = join(dir, 'batch-out.txt');
  const savedBatch = await runPythonInput(['--save', savedBatchTxt, 'batch'], env, JSON.stringify([
    { tool: 'dev_read', arguments: { path: 'a.js' } },
    { tool: 'dev_search', arguments: { pattern: 'foo' } },
  ]));
  assert.equal(savedBatch.status, 0, savedBatch.stderr);
  const savedBatchContent = readFileSync(savedBatchTxt, 'utf8');
  assert.match(savedBatchContent, /=== \[1\/2\] dev_read ===\nstep-0:dev_read/);
  assert.match(savedBatchContent, /=== \[2\/2\] dev_search ===\nstep-1:dev_search/);
  assert.equal(statSync(savedBatchTxt).mode & 0o777, 0o600);

  // Argument-free lcall in non-TTY subprocesses defaults to {} without consuming stdin.
  const lcallNoArgs = await runPythonInput(['lcall', 'terminal/terminal_list'], env, '');
  assert.equal(lcallNoArgs.status, 0, lcallNoArgs.stderr);
  assert.equal(lcallNoArgs.stdout, 'terminal.terminal_list:{}\n');
  assert.deepEqual(calls.at(-1).parsed.arguments, { server: 'terminal', tool: 'terminal_list', arguments: {} });

  const lcallInheritedStdin = await runPythonInput(['lcall', 'terminal/terminal_list'], env, 'echo parent-heredoc-line\n');
  assert.equal(lcallInheritedStdin.status, 0, lcallInheritedStdin.stderr);
  assert.deepEqual(calls.at(-1).parsed.arguments, { server: 'terminal', tool: 'terminal_list', arguments: {} });

  // Explicit '-' reads JSON arguments from stdin.
  const lcallStdin = await runPythonInput(['lcall', 'browser-fast/observe', '-'], env, '{"scope":"compact"}');
  assert.equal(lcallStdin.status, 0, lcallStdin.stderr);
  assert.deepEqual(calls.at(-1).parsed.arguments, {
    server: 'browser-fast',
    tool: 'observe',
    arguments: { scope: 'compact' },
  });

  // Sequential pipe exits 1 when a dev_exec step returns [exit 1 · ...] even as the final step.
  const pipeCmdExit1 = await runPythonInput(['pipe'], env, JSON.stringify([
    { tool: 'dev_edit', arguments: { targets: [] } },
    { tool: 'dev_exec', arguments: { exit1: true } },
  ]));
  assert.equal(pipeCmdExit1.status, 1);
  assert.match(pipeCmdExit1.stdout, /assertion failed\n\[exit 1 · 0\.2s\]/);

  const pipeContinue = await runPythonInput(['pipe', '--continue'], env, JSON.stringify([
    { tool: 'dev_edit', arguments: { targets: [] } },
    { tool: 'dev_exec', arguments: { exit1: true } },
    { tool: 'dev_review_changes', arguments: {} },
  ]));
  assert.equal(batches.at(-1).parsed.stop_on_error, false);
  assert.equal(pipeContinue.status, 1, 'continuing execution must not suppress command failures');
  assert.match(pipeContinue.stdout, /=== \[3\/3\] dev_review_changes ===\ncontinued after failure/);

});

test('raw Dev calls and sh share session cwd while explicit cwd and environment overrides win', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-call-cwd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'session.json');
  const calls = [];
  const { base } = await pythonFixture(t, (entry, fixtureBase) => {
    calls.push(JSON.parse(entry.body));
    return completed('ok', fixtureBase);
  });
  writeFileSync(sessionFile, JSON.stringify({ base, cap: capability, cwd: '/project' }), { mode: 0o600 });
  const env = { WH_SESSION_FILE: sessionFile, WS_BASE: '', WS_CAP: '' };
  for (const command of [
    ['sh', 'pwd'],
    ['call', 'dev_bash', '{"command":"pwd"}'],
    ['call', 'dev_exec', '{"argv":["pwd"]}'],
  ]) {
    const run = await runPythonInput(command, env);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(calls.at(-1).arguments.cwd, '/project');
  }
  assert.equal((await runPythonInput(['call', 'dev_bash', '{"command":"pwd","cwd":"/explicit"}'], env)).status, 0);
  assert.equal(calls.at(-1).arguments.cwd, '/explicit');
  assert.equal((await runPythonInput(['call', 'dev_bash', '{"command":"pwd"}'], { ...env, WS_CWD: '/override' })).status, 0);
  assert.equal(calls.at(-1).arguments.cwd, '/override');
  assert.equal((await runPythonInput(['call', 'dev_bash', '{"command":"pwd"}'], { ...env, WS_CWD: '' })).status, 0);
  assert.equal(Object.hasOwn(calls.at(-1).arguments, 'cwd'), false);
  assert.equal((await runPythonInput(['call', 'dev_bash', '{"command":"pwd"}'], { ...env, WS_CAP: capability })).status, 0);
  assert.equal(Object.hasOwn(calls.at(-1).arguments, 'cwd'), false);
});


test('Python batch limits the combined stdout of many successful items, preserving full result privately', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-aggregate-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'session.json');
  const { base } = await pythonFixture(t, (entry, fixtureBase) => {
    if (entry.method !== 'POST' || entry.path !== '/v1/batch') return undefined;
    const calls = JSON.parse(entry.body).calls;
    return {
      protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'ready',
      results: calls.map((_, i) => completed('payload-' + i + ':' + 'z'.repeat(2500), fixtureBase)),
    };
  });
  writeFileSync(sessionFile, JSON.stringify({ base, cap: capability, wait: 2 }), { mode: 0o600 });
  const env = { WH_SESSION_FILE: sessionFile, WS_BASE: '', WS_CAP: '' };
  const calls = Array.from({ length: 4 }, () => ({ tool: 'dev_read', arguments: { path: 'a.js' } }));
  const result = await runPythonInput(['batch'], env, JSON.stringify(calls));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) < 5000, 'total stdout must stay close to the default 4 KB cap');
  const matched = result.stdout.match(/saved in local sandbox: (\/[^;\s]+); WS_MAX_OUTPUT/);
  assert.ok(matched, 'aggregate overflow must save one combined full result');
  const saved = readFileSync(matched[1], 'utf8');
  assert.match(saved, /=== \[1\/4\] dev_read ===/);
  assert.match(saved, /=== \[4\/4\] dev_read ===/);
  assert.ok(Buffer.byteLength(saved) > 10000);
  rmSync(matched[1]);
});
