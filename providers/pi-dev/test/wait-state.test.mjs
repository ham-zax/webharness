import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WaitStore } from '../wait-state.mjs';

const LOCK_WORKER = fileURLToPath(new URL('./wait-lock-worker.mjs', import.meta.url));

async function fixtureStore(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-store-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  return new WaitStore({ stateDir, ...options });
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      const error = new Error('pre-commit delay aborted');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      finish(reject, error);
    };
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function assertNoTempFiles(store) {
  await store.ensureRoot();
  const entries = await readdir(store.rootDir);
  assert.deepEqual(entries.filter((entry) => entry.endsWith('.tmp')), []);
}

function pendingRecord(name = 'build-ready') {
  return {
    name,
    definition: {
      condition: { kind: 'tcp_listen', host: '127.0.0.1', port: 43210 },
      timeoutSeconds: 300,
    },
    condition: { kind: 'tcp_listen', host: '127.0.0.1', port: 43210 },
    timeoutSeconds: 300,
    armedAtMs: 1000,
    deadlineAtMs: 301000,
    status: 'pending',
    sourceArmed: true,
    baseline: { host: '127.0.0.1', port: 43210 },
    lastCheckedAtMs: 1000,
  };
}

function startLockWorker(t, {
  stateDir,
  name,
  holdMs = 0,
  maxWaitMs = 1000,
  abortAfterMs = 0,
  onMessage,
}) {
  const child = fork(LOCK_WORKER, [
    stateDir,
    name,
    String(holdMs),
    String(maxWaitMs),
    String(abortAfterMs),
  ], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const messages = [];
  child.on('message', (message) => {
    messages.push(message);
    onMessage?.(message);
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return { child, messages };
}

async function waitForWorkerMessage(worker, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = worker.messages.find(predicate);
    if (found) return found;
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(`lock worker exited before expected message: ${JSON.stringify(worker.messages)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for lock worker message: ${JSON.stringify(worker.messages)}`);
}

async function waitForWorkerExit(worker) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  await once(worker.child, 'exit');
}

test('wait store writes versioned private state atomically', async (t) => {
  const store = await fixtureStore(t);
  await store.create(pendingRecord());
  const saved = await store.read('build-ready');
  assert.equal(saved.version, 1);
  assert.equal(saved.status, 'pending');
  assert.equal((await stat(store.rootDir)).mode & 0o777, 0o700);
  assert.equal((await stat(store.fileFor('build-ready'))).mode & 0o777, 0o600);
});

test('first create aborts before atomic commit without installing or leaking temp state', async (t) => {
  let hookEntered = false;
  const store = await fixtureStore(t, {
    beforeCreateCommit: async ({ signal }) => {
      hookEntered = true;
      await abortableDelay(1500, signal);
    },
  });
  const controller = new AbortController();
  const started = Date.now();
  const pending = store.create(pendingRecord('abort-before-commit'), { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error) => error?.code === 'WAIT_ABORTED');
  assert.equal(hookEntered, true);
  assert.ok(Date.now() - started < 350, 'pre-commit abort did not interrupt persistence promptly');
  assert.equal(await store.read('abort-before-commit'), null);
  await assertNoTempFiles(store);
  await new Promise((resolve) => setTimeout(resolve, 1550));
  assert.equal(await store.read('abort-before-commit'), null);
  await assertNoTempFiles(store);
});

test('wait store rejects invalid names and corrupt state', async (t) => {
  const store = await fixtureStore(t);
  assert.throws(() => store.fileFor('../escape'), (error) => error.code === 'INVALID_WAIT_NAME');
  await store.ensureRoot();
  await writeFile(path.join(store.rootDir, 'broken.json'), '{not json', { mode: 0o600 });
  await assert.rejects(() => store.read('broken'), (error) => error.code === 'WAIT_STATE_CORRUPT');
});

test('wait store rejects semantically corrupt version-1 records instead of allowing immortal or re-armable state', async (t) => {
  const store = await fixtureStore(t);
  await store.ensureRoot();
  const valid = {
    version: 1,
    name: 'semantic-corrupt',
    definition: {
      condition: { kind: 'tcp_listen', host: '127.0.0.1', port: 43210 },
      timeoutSeconds: 30,
    },
    condition: { kind: 'tcp_listen', host: '127.0.0.1', port: 43210 },
    timeoutSeconds: 30,
    armedAtMs: 1000,
    deadlineAtMs: 31000,
    status: 'pending',
    sourceArmed: true,
    baseline: { host: '127.0.0.1', port: 43210 },
    lastCheckedAtMs: 1000,
  };
  const corruptions = [
    ['missing deadline', ({ deadlineAtMs: _omit, ...rest }) => rest],
    ['unknown status', (record) => ({ ...record, status: 'forever' })],
    ['unarmed pending', (record) => ({ ...record, sourceArmed: false, baseline: null })],
    ['definition mismatch', (record) => ({ ...record, condition: { kind: 'tcp_listen', host: '127.0.0.1', port: 43211 } })],
    ['terminal without completion time', (record) => ({ ...record, status: 'matched' })],
    ['matched after deadline', (record) => ({ ...record, status: 'matched', completedAtMs: 31000 })],
  ];

  for (const [label, mutate] of corruptions) {
    const candidate = mutate(structuredClone(valid));
    await writeFile(store.fileFor('semantic-corrupt'), `${JSON.stringify(candidate)}\n`, { mode: 0o600 });
    await assert.rejects(
      () => store.read('semantic-corrupt'),
      (error) => error?.code === 'WAIT_STATE_CORRUPT',
      label,
    );
  }
});

test('same-name kernel lock serializes concurrent writers', async (t) => {
  const store = await fixtureStore(t);
  let releaseHolder;
  const holderGate = new Promise((resolve) => { releaseHolder = resolve; });
  const order = [];
  const holder = store.withLock('serial', async () => {
    order.push('holder-enter');
    await holderGate;
    order.push('holder-exit');
  }, { maxWaitMs: 1000 });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const waiter = store.withLock('serial', async () => {
    order.push('waiter-enter');
  }, { maxWaitMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ['holder-enter']);
  releaseHolder();
  await Promise.all([holder, waiter]);
  assert.deepEqual(order, ['holder-enter', 'holder-exit', 'waiter-enter']);
});

test('canceled queued waiter never enters after the holder releases', async (t) => {
  const store = await fixtureStore(t);
  let releaseHolder;
  const holderGate = new Promise((resolve) => { releaseHolder = resolve; });
  const holder = store.withLock('cancel-queue', () => holderGate, { maxWaitMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  let canceledEntered = false;
  const controller = new AbortController();
  const canceled = store.withLock('cancel-queue', async () => {
    canceledEntered = true;
  }, { signal: controller.signal, maxWaitMs: 1000 });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(canceled, (error) => error.code === 'WAIT_ABORTED');
  releaseHolder();
  await holder;
  assert.equal(canceledEntered, false);

  let liveEntered = false;
  await store.withLock('cancel-queue', async () => { liveEntered = true; }, { maxWaitMs: 250 });
  assert.equal(liveEntered, true);
});

test('same-name contention fast-fails with WAIT_BUSY instead of joining a long hold', async (t) => {
  const store = await fixtureStore(t);
  let releaseHolder;
  const holderGate = new Promise((resolve) => { releaseHolder = resolve; });
  const holder = store.withLock('busy', () => holderGate, { maxWaitMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const started = Date.now();
  await assert.rejects(
    () => store.withLock('busy', async () => {}, { maxWaitMs: 80 }),
    (error) => error.code === 'WAIT_BUSY',
  );
  assert.ok(Date.now() - started < 250);
  releaseHolder();
  await holder;
});

test('separate processes get WAIT_BUSY while a live owner holds the same wait and acquire after owner death', async (t) => {
  const store = await fixtureStore(t);
  const owner = startLockWorker(t, { stateDir: store.stateDir, name: 'process-death', holdMs: -1 });
  await waitForWorkerMessage(owner, (message) => message.type === 'entered');

  const blocked = startLockWorker(t, {
    stateDir: store.stateDir,
    name: 'process-death',
    holdMs: 0,
    maxWaitMs: 80,
  });
  const blockedResult = await waitForWorkerMessage(blocked, (message) => message.type === 'error');
  assert.equal(blockedResult.code, 'WAIT_BUSY');
  assert.equal(blocked.messages.some((message) => message.type === 'entered'), false);
  await waitForWorkerExit(blocked);

  owner.child.kill('SIGKILL');
  await waitForWorkerExit(owner);

  const successor = startLockWorker(t, { stateDir: store.stateDir, name: 'process-death', holdMs: 0 });
  await waitForWorkerMessage(successor, (message) => message.type === 'entered');
  const successorResult = await waitForWorkerMessage(successor, (message) => message.type === 'result');
  assert.equal(successorResult.status, 'ok');
  await waitForWorkerExit(successor);
});

test('two separate recovery contenders never execute the same-name callback concurrently after owner death', async (t) => {
  const store = await fixtureStore(t);
  for (let round = 0; round < 5; round += 1) {
    const name = `recovery-${round}`;
    const owner = startLockWorker(t, { stateDir: store.stateDir, name, holdMs: -1 });
    await waitForWorkerMessage(owner, (message) => message.type === 'entered');
    owner.child.kill('SIGKILL');
    await waitForWorkerExit(owner);

    let active = 0;
    let maxActive = 0;
    const observe = (message) => {
      if (message.type === 'entered') {
        active += 1;
        maxActive = Math.max(maxActive, active);
      } else if (message.type === 'leaving') {
        active -= 1;
      }
    };
    const a = startLockWorker(t, {
      stateDir: store.stateDir, name, holdMs: 80, maxWaitMs: 1000, onMessage: observe,
    });
    const b = startLockWorker(t, {
      stateDir: store.stateDir, name, holdMs: 80, maxWaitMs: 1000, onMessage: observe,
    });
    const [aResult, bResult] = await Promise.all([
      waitForWorkerMessage(a, (message) => message.type === 'result' || message.type === 'error'),
      waitForWorkerMessage(b, (message) => message.type === 'result' || message.type === 'error'),
    ]);
    assert.equal(aResult.type, 'result', JSON.stringify(a.messages));
    assert.equal(bResult.type, 'result', JSON.stringify(b.messages));
    assert.equal(maxActive, 1, `same-name callbacks overlapped in round ${round}`);
    assert.equal(active, 0);
    await Promise.all([waitForWorkerExit(a), waitForWorkerExit(b)]);
  }
});

test('different wait names remain concurrent across separate processes', async (t) => {
  const store = await fixtureStore(t);
  const a = startLockWorker(t, { stateDir: store.stateDir, name: 'parallel-a', holdMs: -1 });
  const b = startLockWorker(t, { stateDir: store.stateDir, name: 'parallel-b', holdMs: -1 });
  await Promise.all([
    waitForWorkerMessage(a, (message) => message.type === 'entered'),
    waitForWorkerMessage(b, (message) => message.type === 'entered'),
  ]);
  assert.equal(a.messages.some((message) => message.type === 'leaving'), false);
  assert.equal(b.messages.some((message) => message.type === 'leaving'), false);
  a.child.send({ type: 'release' });
  b.child.send({ type: 'release' });
  await Promise.all([waitForWorkerExit(a), waitForWorkerExit(b)]);
});

test('separate-process cancellation while waiting never enters after the holder releases', async (t) => {
  const store = await fixtureStore(t);
  const owner = startLockWorker(t, { stateDir: store.stateDir, name: 'process-cancel', holdMs: -1 });
  await waitForWorkerMessage(owner, (message) => message.type === 'entered');

  const canceled = startLockWorker(t, {
    stateDir: store.stateDir,
    name: 'process-cancel',
    holdMs: 0,
    maxWaitMs: 1000,
    abortAfterMs: 60,
  });
  const canceledResult = await waitForWorkerMessage(canceled, (message) => message.type === 'error');
  assert.equal(canceledResult.code, 'WAIT_ABORTED');
  await waitForWorkerExit(canceled);
  owner.child.send({ type: 'release' });
  await waitForWorkerExit(owner);
  assert.equal(canceled.messages.some((message) => message.type === 'entered'), false);
});

test('legacy stale lock metadata naming an unrelated live PID cannot block ownership forever', async (t) => {
  const store = await fixtureStore(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill('SIGKILL');
  });

  const legacyLockDir = path.join(store.rootDir, '.locks');
  await mkdir(legacyLockDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(legacyLockDir, 'pid-ambiguity.lock'),
    `${JSON.stringify({ pid: unrelated.pid, createdAtMs: Date.now() - 60000 })}\n`,
    { mode: 0o600 },
  );

  const contender = startLockWorker(t, {
    stateDir: store.stateDir,
    name: 'pid-ambiguity',
    holdMs: 0,
    maxWaitMs: 100,
  });
  const result = await waitForWorkerMessage(
    contender,
    (message) => message.type === 'entered' || message.type === 'error',
  );
  assert.equal(result.type, 'entered', JSON.stringify(contender.messages));
  await waitForWorkerMessage(contender, (message) => message.type === 'result');
  await waitForWorkerExit(contender);
});
