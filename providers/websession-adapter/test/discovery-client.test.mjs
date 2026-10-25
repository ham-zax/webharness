import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseRequest, parseToolName, toolListSnapshot, toolSignature } from '../protocol.mjs';

const client = new URL('../client.sh', import.meta.url);
const clientPython = new URL('../client.py', import.meta.url);
const capability = 'c'.repeat(43);

test('discovery tool names share request validation and snapshots expose names and optional instructions', () => {
  for (const name of ['dev_1mcp_read', 'tool.with-dashes', 'x'.repeat(128)]) {
    assert.equal(parseToolName(name), name);
    assert.equal(parseRequest({ version: 1, tool: name, arguments: {} }).normalized.tool, name);
  }
  for (const name of ['', 'x'.repeat(129), 'tool/name', 'tool name', 'é', undefined]) {
    assert.throws(() => parseToolName(name), /invalid tool name/);
    assert.throws(() => parseRequest({ version: 1, tool: name, arguments: {} }), /invalid tool name/);
  }
  const tools = [{ name: 'echo', inputSchema: {} }, { name: 'sleep', inputSchema: {} }];
  const expected = { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'ready', tool_count: 2, tools: ['echo', 'sleep'] };
  assert.deepEqual(toolListSnapshot(tools), expected);
  assert.deepEqual(toolListSnapshot(tools, 'Use carefully'), { ...expected, instructions: 'Use carefully' });
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

const OMISSION = /^([\s\S]*?)\n\[ws: ([0-9]+) of ([0-9]+) bytes shown, middle omitted; full output: (\/\S+); WS_MAX_OUTPUT=0 prints everything\]\n([\s\S]*)\n$/;

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
  assert.ok(Number(shown) <= 8192);
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
  assert.equal(requests[0].query.get('wait'), '0');
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
  assert.equal(posts[0].query.get('wait'), '0');
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
  assert.match(run.stdout, /full output not saved: fixture disk full; do not rerun the tool/);
  assert.ok(Buffer.byteLength(run.stdout) < 9000);
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].body).tool, 'dev_1mcp_bash');
});

test('python client reports lost creation responses as unknown without resubmitting', async (t) => {
  const { base, requests } = await pythonFixture(t, (_entry, _base, req) => {
    req.socket.destroy();
  });
  const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /submission outcome unknown; do not retry/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].query.get('wait'), '0');
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
  const run = await runPython(['call', 'echo', '{}'], { WS_BASE: base }, setup);
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
      { version: 1, tool: 'dev_1mcp_bash', arguments: { command: script } });
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
