import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { BrowserJevRunManager } from '../run-manager.mjs';
import { JevWorkerClient } from '../worker-client.mjs';

const startArgs = (overrides = {}) => ({
  url: 'https://example.com',
  goal: 'Confirm the page and stop',
  scenario: {
    browser_target: 'linux',
    browser_backend: 'clearcote',
    browser_profile: 'x-main',
    success: { title_contains: ['Example'] },
    ...overrides
  }
});

const snapshot = (overrides = {}) => ({
  goal: 'Confirm the page and stop',
  status: 'ready',
  elapsed_ms: 0,
  page: { url: 'https://example.com/', title: 'Example Domain', text: 'Example Domain', scroll: { y: 0, height: 780 } },
  elements: [],
  decision: null,
  history: [],
  ...overrides
});

class FakeWorker {
  constructor(responses = {}) {
    this.responses = responses;
    this.requests = [];
    this.closeCount = 0;
  }

  async request(command, args) {
    this.requests.push({ command, arguments: args });
    const response = this.responses[command];
    if (typeof response === 'function') return await response(args);
    if (response instanceof Error) throw response;
    return response ?? snapshot();
  }

  async close() { this.closeCount += 1; }
}

function managerFixture({ worker, workerFactory, resolver, idFactory } = {}) {
  const created = [];
  const selectedWorker = worker ?? new FakeWorker();
  const manager = new BrowserJevRunManager({
    backendResolver: resolver ?? {
      resolve: async selection => ({
        browserTarget: selection.browser_target,
        browserBackend: selection.browser_backend,
        browserProfile: selection.browser_profile,
        browserUrl: 'http://127.0.0.1:9222',
        queueKey: `${selection.browser_target}:${selection.browser_backend}:${selection.browser_profile}`
      })
    },
    credentialLoader: async () => ({ TYPESAFE_API_KEY: 'server-secret' }),
    workerFactory: workerFactory ?? (async options => {
      created.push(options);
      return selectedWorker;
    }),
    idFactory: idFactory ?? (() => 'abc123')
  });
  return { manager, worker: selectedWorker, created };
}

test('start creates a namespaced worker and returns only sanitized state', async () => {
  const worker = new FakeWorker({
    start: snapshot({ request: { secret: true }, browser: { endpoint: 'secret' }, raw_answers: ['secret'] })
  });
  const { manager, created } = managerFixture({ worker });
  const result = await manager.start(startArgs());
  assert.equal(result.run_id, 'abc123');
  assert.equal(result.status, 'ready');
  assert.equal(JSON.stringify(result).includes('server-secret'), false);
  assert.equal(JSON.stringify(result).includes('9222'), false);
  assert.equal(Object.hasOwn(manager.runs.get('abc123').backend, 'browserUrl'), false);
  assert.deepEqual(created[0].env, {
    TYPESAFE_API_KEY: 'server-secret',
    BU_CDP_URL: 'http://127.0.0.1:9222',
    BU_NAME: 'jev-abc123',
    PYTHONUNBUFFERED: '1'
  });
  assert.deepEqual(worker.requests, [{ command: 'start', arguments: { url: 'https://example.com/', goal: 'Confirm the page and stop' } }]);
});

test('DONE becomes done only when every deterministic check passes', async () => {
  const passing = new FakeWorker({ tick: snapshot({ status: 'done' }) });
  const { manager } = managerFixture({ worker: passing });
  const started = await manager.start(startArgs());
  const done = await manager.tick(started.run_id);
  assert.equal(done.status, 'done');
  assert.equal(done.verification.passed, true);

  const missingFill = new FakeWorker({
    tick: snapshot({ status: 'done', history: [{ kind: 'click' }] })
  });
  const second = managerFixture({ worker: missingFill, idFactory: () => 'second' }).manager;
  const run = await second.start(startArgs({
    success: { title_contains: ['Example'], required_operations: ['TYPE_TEXT'] }
  }));
  const blocked = await second.tick(run.run_id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason.code, 'DONE_VERIFICATION_FAILED');
  assert.equal(blocked.verification.checks.required_operations.TYPE_TEXT.passed, false);
  await assert.rejects(second.tick(run.run_id), /terminal/);
});

test('runToTerminal advances internally to terminal state and cleans the owned run', async () => {
  let tickCount = 0;
  const worker = new FakeWorker({
    tick: () => {
      tickCount += 1;
      if (tickCount === 1) {
        return snapshot({
          history: [{ kind: 'click', action: 'Mystery', operation: 'CLICK' }],
          elapsed_ms: 900
        });
      }
      return snapshot({
        status: 'done',
        history: [
          { kind: 'click', action: 'Mystery', operation: 'CLICK' },
          { kind: 'click', action: 'Sharp Objects', operation: 'CLICK' }
        ],
        elapsed_ms: 1500
      });
    },
    stop: { status: 'stopped' }
  });
  const { manager } = managerFixture({ worker });
  const result = await manager.runToTerminal(startArgs());
  assert.equal(result.status, 'done');
  assert.equal(result.verification.passed, true);
  assert.deepEqual(worker.requests.map(item => item.command), ['start', 'tick', 'tick', 'stop']);
  assert.equal(worker.closeCount, 1);
  assert.equal(manager.runs.size, 0);
});

test('runToTerminal cleans the owned run when a tick fails', async () => {
  const failure = Object.assign(new Error('lost response'), { code: 'JEV_WORKER_EXITED' });
  const worker = new FakeWorker({ tick: failure, stop: { status: 'stopped' } });
  const { manager } = managerFixture({ worker });
  await assert.rejects(manager.runToTerminal(startArgs()), /lost response/);
  assert.deepEqual(worker.requests.map(item => item.command), ['start', 'tick', 'stop']);
  assert.equal(worker.closeCount, 1);
  assert.equal(manager.runs.size, 0);
});

test('a lost response marks failed and never replays a mutation', async () => {
  const failure = Object.assign(new Error('lost response'), { code: 'JEV_WORKER_EXITED' });
  const worker = new FakeWorker({ tick: failure });
  const { manager } = managerFixture({ worker });
  const { run_id: runId } = await manager.start(startArgs());
  await assert.rejects(manager.tick(runId), /lost response/);
  assert.equal(worker.requests.filter(item => item.command === 'tick').length, 1);
  assert.equal(manager.state(runId).status, 'failed');
  await assert.rejects(manager.tick(runId), /terminal/);
});

test('same-profile starts serialize while different profiles proceed concurrently', async () => {
  let active = 0;
  let maximum = 0;
  const releases = [];
  const workerFactory = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => releases.push(resolve));
    active -= 1;
    return new FakeWorker();
  };
  let nextId = 0;
  const { manager } = managerFixture({ workerFactory, idFactory: () => `run${++nextId}` });
  const first = manager.start(startArgs());
  const second = manager.start(startArgs());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 1);
  releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  releases.shift()();
  await Promise.all([first, second]);
  assert.equal(maximum, 1);

  const third = manager.start(startArgs({ browser_profile: 'other' }));
  const fourth = manager.start(startArgs({ browser_profile: 'third' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 2);
  releases.splice(0).forEach(resolve => resolve());
  await Promise.all([third, fourth]);
});

test('stop queues behind an in-flight tick and cleans up exactly once', async () => {
  let releaseTick;
  const worker = new FakeWorker({
    tick: async () => await new Promise(resolve => { releaseTick = () => resolve(snapshot()); }),
    stop: { status: 'stopped' }
  });
  const { manager } = managerFixture({ worker });
  const { run_id: runId } = await manager.start(startArgs());
  const tick = manager.tick(runId);
  await new Promise(resolve => setImmediate(resolve));
  const stop = manager.stop(runId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.requests.some(item => item.command === 'stop'), false);
  releaseTick();
  await tick;
  assert.deepEqual(await stop, { run_id: runId, status: 'stopped' });
  assert.equal(worker.requests.filter(item => item.command === 'stop').length, 1);
  assert.equal(worker.closeCount, 1);
  await assert.rejects(manager.stop(runId), /unknown run/i);
});

test('unknown runs fail closed and close drains live workers', async () => {
  const first = new FakeWorker({ stop: { status: 'stopped' } });
  const second = new FakeWorker({ stop: { status: 'stopped' } });
  const workers = [first, second];
  let index = 0;
  const { manager } = managerFixture({
    workerFactory: async () => workers[index++],
    idFactory: () => `run${index}`
  });
  assert.throws(() => manager.state('missing'), /unknown run/i);
  await assert.rejects(manager.tick('missing'), /unknown run/i);
  await manager.start(startArgs());
  await manager.start(startArgs({ browser_profile: 'other' }));
  await manager.close();
  assert.equal(first.closeCount, 1);
  assert.equal(second.closeCount, 1);
});

function fakeChild(onWrite) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, callback) { onWrite(String(chunk), child); callback(); } });
  child.killCalls = [];
  child.kill = signal => { child.killCalls.push(signal); return true; };
  return child;
}

test('worker client matches response ids and permits only one outstanding request', async () => {
  const child = fakeChild((line, current) => {
    const request = JSON.parse(line);
    setImmediate(() => current.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { status: 'ready' } })}\n`));
  });
  const client = await JevWorkerClient.start({
    python: '/venv/python', script: '/worker.py', env: {}, spawnProcess: () => child
  });
  const pending = client.request('state', {});
  await assert.rejects(client.request('tick', {}), /already has an outstanding/);
  assert.deepEqual(await pending, { status: 'ready' });
  await client.close();
});

test('worker client rejects malformed, mismatched, oversized, exited, and timed-out responses', async () => {
  const cases = [
    [(line, child) => setImmediate(() => child.stdout.write('not-json\n')), /invalid JSON/],
    [(line, child) => setImmediate(() => child.stdout.write('{"id":"wrong","ok":true,"result":{}}\n')), /response id/],
    [(line, child) => setImmediate(() => child.stdout.write('x'.repeat(80))), /output limit/],
    [(line, child) => setImmediate(() => child.emit('exit', 1, null)), /exited/],
    [() => {}, /timed out/]
  ];
  for (const [onWrite, pattern] of cases) {
    const child = fakeChild(onWrite);
    const client = await JevWorkerClient.start({
      python: '/venv/python', script: '/worker.py', env: {}, spawnProcess: () => child,
      timeoutMs: 10, maxOutputBytes: 64
    });
    await assert.rejects(client.request('tick', {}), pattern);
    await client.close();
  }
});
