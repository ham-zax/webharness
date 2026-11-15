import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHttpWireTrace, readTraceControl, redactTraceValue, startTrace, stopTrace, traceLogPath, TRACE_BODY_LIMIT } from '../http-wire-trace.mjs';

async function fixture(t, clock = Date.now()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'http-wire-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = clock;
  const records = [];
  const logger = { log: record => records.push(record), flush: async () => {} };
  return { root, records, setNow: value => { now = value; }, now: () => now, trace: createHttpWireTrace(root, { now: () => now, logger }) };
}

function streams(url = '/mcp', headers = {}) {
  const req = Object.assign(new EventEmitter(), { url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } });
  const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
  return { req, res };
}

test('trace is off by default, expires, stops without restart, and rejects unsafe controls', async t => {
  const f = await fixture(t);
  const { req, res } = streams();
  assert.equal(f.trace.observe(req, res, 'off'), undefined);
  const control = startTrace(f.root, 1, f.now());
  assert.equal((await fs.stat(path.join(f.root, 'http-trace.json'))).mode & 0o777, 0o600);
  assert.ok(f.trace.observe(req, res, 'active'));
  const before = f.records.length;
  f.setNow(control.expires_ms);
  req.emit('data', Buffer.from('{"secret":"never-record"}'));
  res.emit('close');
  assert.equal(f.records.length, before);
  assert.equal(f.trace.observe(req, res, 'expired'), undefined);
  startTrace(f.root, 1, f.now());
  stopTrace(f.root);
  assert.equal(readTraceControl(f.root, f.now()), null);
  assert.throws(() => startTrace(f.root, 3601), /duration/);
  startTrace(f.root, 1, f.now());
  await fs.chmod(path.join(f.root, 'http-trace.json'), 0o644);
  assert.equal(readTraceControl(f.root, f.now()), null);
});

test('captures MCP envelopes, fingerprints sessions, and redacts credentials without losing RPC error codes', async t => {
  const f = await fixture(t);
  startTrace(f.root, 60, f.now());
  const { req, res } = streams('/mcp?access_token=query-secret', {
    authorization: 'Bearer header-secret', cookie: 'session=cookie-secret', 'x-auth': 'short-auth', 'x-csrf': 'short-csrf', 'mcp-session-id': 'session-identity',
  });
  const capture = f.trace.observe(req, res, 'request-one');
  capture.requestBody();
  req.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { arguments: { password: 'body-secret', command: 'echo ready' } } })));
  req.emit('end');
  const upstream = Object.assign(new EventEmitter(), { headers: { 'content-type': 'application/json', 'set-cookie': 'private-cookie' }, statusCode: 404 });
  capture.response(upstream);
  upstream.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Session missing"}}'));
  upstream.emit('end');
  res.statusCode = 404;
  res.emit('close');
  const text = JSON.stringify(f.records);
  for (const secret of ['query-secret', 'header-secret', 'cookie-secret', 'session-identity', 'body-secret', 'private-cookie', 'short-auth', 'short-csrf']) assert.ok(!text.includes(secret));
  assert.ok(text.includes('echo ready'));
  assert.equal(f.records.find(x => x.event === 'response_body').body.value.error.code, -32001);
  assert.match(f.records[0].headers['mcp-session-id'], /^\[sha256:/);
  assert.match(f.records[0].credential_fingerprint, /^\[sha256:/);
  assert.equal(f.records.at(-1).status, 404);
  assert.equal(req.listenerCount('data'), 0);
});

test('omits OAuth bodies, oversized bodies, and incomplete JSON', async t => {
  const f = await fixture(t);
  startTrace(f.root, 60, f.now());
  for (const [url, body, complete, reason] of [
    ['/token', '{"access_token":"oauth-secret"}', true, 'authentication_or_other_route'],
    ['/mcp', 'x'.repeat(TRACE_BODY_LIMIT + 1), true, 'capture_limit'],
    ['/mcp', '{"password":"partial-secret', false, 'incomplete'],
  ]) {
    const { req, res } = streams(url);
    f.trace.observe(req, res, reason).requestBody();
    req.emit('data', Buffer.from(body));
    req.emit(complete ? 'end' : 'close');
    res.emit('close');
    assert.equal(f.records.filter(x => x.event === 'request_body').at(-1).body.omitted, reason);
  }
  assert.ok(!JSON.stringify(f.records).includes('oauth-secret'));
  assert.ok(!JSON.stringify(f.records).includes('partial-secret'));
});

test('SSE bodies survive chunk boundaries and redact nested credentials', async t => {
  const f = await fixture(t);
  startTrace(f.root, 60, f.now());
  const { req, res } = streams();
  const capture = f.trace.observe(req, res, 'sse');
  const upstream = Object.assign(new EventEmitter(), { headers: { 'content-type': 'text/event-stream' }, statusCode: 200 });
  capture.response(upstream);
  for (const chunk of ['event: message\ndata: {"res', 'ult":{"token":"sse-secret","text":"🌍"}}\n\n']) upstream.emit('data', Buffer.from(chunk));
  upstream.emit('end');
  res.emit('close');
  const body = f.records.find(x => x.event === 'response_body').body;
  assert.equal(body.events[0].data.result.token, '[REDACTED]');
  assert.equal(body.events[0].data.result.text, '🌍');
});

test('wire trace writes private rotating log records larger than the ordinary diagnostic limit', async t => {
  const f = await fixture(t);
  startTrace(f.root, 60, f.now());
  const trace = createHttpWireTrace(f.root);
  const { req, res } = streams();
  trace.observe(req, res, 'large-record').requestBody();
  req.emit('data', Buffer.from(JSON.stringify({ method: 'tools/call', params: { arguments: { text: 'word '.repeat(2000) } } })));
  req.emit('end');
  res.emit('close');
  await trace.flush();
  const file = traceLogPath(f.root);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.find(row => row.event === 'request_body').body.value.method, 'tools/call');
  assert.equal(redactTraceValue({ code: -32603 }).code, -32603);
  assert.ok(!redactTraceValue("password='literal-secret'").includes('literal-secret'));
});

test('client disconnect records incomplete response bytes before detaching trace listeners', async t => {
  const f = await fixture(t);
  startTrace(f.root, 60, f.now());
  const { req, res } = streams();
  res.writableFinished = false;
  const capture = f.trace.observe(req, res, 'disconnect');
  const upstream = Object.assign(new EventEmitter(), { headers: { 'content-type': 'application/json' }, statusCode: 200 });
  capture.response(upstream);
  upstream.emit('data', Buffer.from('{"secret":"partial'));
  res.emit('close');
  assert.equal(f.records.find(row => row.event === 'response_body').body.omitted, 'incomplete');
  assert.equal(f.records.at(-1).outcome, 'disconnected');
  assert.equal(upstream.listenerCount('data'), 0);
});

test('operator CLI arms, reports, and stops a private capture without enabling invalid durations', async t => {
  const f = await fixture(t);
  const cli = new URL('../../../scripts/http-trace.mjs', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, BRIDGE_STATE_DIR: f.root } });
  assert.match(run('status').stdout, /HTTP trace: off/);
  const started = run('start', '60');
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /HTTP trace: armed/);
  assert.equal(readTraceControl(f.root).expires_ms - readTraceControl(f.root).started_ms, 60_000);
  assert.equal(run('stop').status, 0);
  assert.equal(readTraceControl(f.root), null);
  assert.equal(run('start', '3601').status, 1);
  assert.equal(readTraceControl(f.root), null);
});

test('a late upstream response after client close cannot attach new trace listeners', async t => {
  const f = await fixture(t);
  startTrace(f.root, 60, f.now());
  const { req, res } = streams();
  const capture = f.trace.observe(req, res, 'late-response');
  res.emit('close');
  const upstream = Object.assign(new EventEmitter(), { headers: {}, statusCode: 200 });
  capture.requestBody();
  capture.response(upstream);
  assert.equal(upstream.listenerCount('data'), 0);
  assert.equal(req.listenerCount('data'), 0);
});
