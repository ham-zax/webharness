import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseRequest, parseToolName, toolListSnapshot } from '../protocol.mjs';

const client = new URL('../client.sh', import.meta.url);

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
