import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WaitEngine } from '../wait-engine.mjs';
import { LocalWaitSources } from '../wait-local.mjs';
import { WaitStore } from '../wait-state.mjs';

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

async function noTempFiles(store) {
  await store.ensureRoot();
  return (await readdir(store.rootDir)).filter((entry) => entry.endsWith('.tmp'));
}

async function linearizationFixture(t, { beforeCreateCommit } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-linearization-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  const store = new WaitStore({ stateDir, beforeCreateCommit });
  let arms = 0;
  const source = {
    pollIntervalMs: 250,
    async arm() {
      arms += 1;
      return { status: 'pending', baseline: { boundary: arms } };
    },
    async check(record) {
      return { status: 'pending', baseline: record.baseline };
    },
  };
  const engine = new WaitEngine({ store, sources: { fake: source } });
  return { store, engine, arms: () => arms };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  const store = new WaitStore({ stateDir });
  let nowMs = 1000;
  let matched = false;
  let checks = 0;
  const source = {
    pollIntervalMs: 10,
    async arm() {
      return { status: 'pending', baseline: { cursor: 1 } };
    },
    async check(record) {
      checks += 1;
      if (matched) return { status: 'matched', baseline: record.baseline, evidence: 'ready' };
      return { status: 'pending', baseline: { cursor: (record.baseline?.cursor ?? 0) + 1 } };
    },
  };
  const engine = new WaitEngine({
    store,
    sources: { fake: source },
    now: () => nowMs,
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  return {
    store,
    engine,
    setNow(value) { nowMs = value; },
    setMatched(value) { matched = value; },
    checks: () => checks,
  };
}

test('named create, resume, timeout, cancellation, and lost-response retry are durable', async (t) => {
  const fx = await fixture(t);
  const condition = { kind: 'fake', value: 'x' };

  const created = await fx.engine.run({ name: 'durable', condition, timeout_seconds: 5, hold_seconds: 0 });
  assert.equal(created.status, 'pending');
  const firstSaved = await fx.store.read('durable');
  const firstDeadline = firstSaved.deadlineAtMs;
  assert.equal(firstDeadline, 6000);

  const identical = await fx.engine.run({ name: 'durable', condition, timeout_seconds: 5, hold_seconds: 0 });
  assert.equal(identical.status, 'pending');
  assert.equal((await fx.store.read('durable')).deadlineAtMs, firstDeadline);

  await assert.rejects(
    () => fx.engine.run({ name: 'durable', condition: { kind: 'fake', value: 'different' }, hold_seconds: 0 }),
    (error) => error.code === 'WAIT_CONFLICT',
  );

  fx.setMatched(true);
  const matched = await fx.engine.run({ name: 'durable', hold_seconds: 0 });
  assert.equal(matched.status, 'matched');
  assert.equal(matched.evidence, 'ready');
  const replay = await fx.engine.run({ name: 'durable', hold_seconds: 0 });
  assert.deepEqual(replay, matched);

  fx.setMatched(false);
  const timeoutCreate = await fx.engine.run({
    name: 'timeout', condition: { kind: 'fake', value: 'timeout' }, timeout_seconds: 1, hold_seconds: 0,
  });
  assert.equal(timeoutCreate.status, 'pending');
  const checksBeforeTimeout = fx.checks();
  fx.setNow(2500);
  const timedOut = await fx.engine.run({ name: 'timeout', hold_seconds: 0 });
  assert.equal(timedOut.status, 'timeout');
  assert.equal(fx.checks(), checksBeforeTimeout);

  const cancelCreate = await fx.engine.run({
    name: 'cancel', condition: { kind: 'fake', value: 'cancel' }, hold_seconds: 0,
  });
  assert.equal(cancelCreate.status, 'pending');
  const cancelled = await fx.engine.run({ name: 'cancel', cancel: true });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await fx.store.read('cancel')).status, 'cancelled');
});

test('aborting an active hold leaves durable wait pending', async (t) => {
  const fx = await fixture(t);
  await fx.engine.run({ name: 'abort-hold', condition: { kind: 'fake' }, hold_seconds: 0 });

  const controller = new AbortController();
  const call = fx.engine.run({ name: 'abort-hold', hold_seconds: 1 }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(call, (error) => error.code === 'WAIT_ABORTED');
  assert.equal((await fx.store.read('abort-hold')).status, 'pending');
});

test('request canceled while queued for wait lock never checks or mutates later', async (t) => {
  const fx = await fixture(t);
  await fx.engine.run({ name: 'abort-queued', condition: { kind: 'fake' }, hold_seconds: 0 });
  const beforeChecks = fx.checks();

  let releaseHolder;
  const gate = new Promise((resolve) => { releaseHolder = resolve; });
  const holder = fx.store.withLock('abort-queued', () => gate, { maxWaitMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const controller = new AbortController();
  const queued = fx.engine.run({ name: 'abort-queued', hold_seconds: 0 }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(queued, (error) => error.code === 'WAIT_ABORTED');
  releaseHolder();
  await holder;
  assert.equal(fx.checks(), beforeChecks);
  assert.equal((await fx.store.read('abort-queued')).status, 'pending');

  const resumed = await fx.engine.run({ name: 'abort-queued', hold_seconds: 0 });
  assert.equal(resumed.status, 'pending');
  assert.ok(fx.checks() > beforeChecks);
});

test('source match completing after the absolute deadline persists timeout instead of matched', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-deadline-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let nowMs = 1000;
  let checkStarted = false;
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  const source = {
    pollIntervalMs: 250,
    async arm() {
      return { status: 'pending', baseline: { token: 'stable' } };
    },
    async check(record) {
      checkStarted = true;
      nowMs = 2001;
      return { status: 'matched', baseline: record.baseline, evidence: 'late-ready' };
    },
  };
  const engine = new WaitEngine({ store, sources: { fake: source }, now: () => nowMs });

  const created = await engine.run({
    name: 'late-match', condition: { kind: 'fake' }, timeout_seconds: 1, hold_seconds: 0,
  });
  assert.equal(checkStarted, true);
  assert.equal(created.status, 'timeout');
  const saved = await store.read('late-match');
  assert.equal(saved.status, 'timeout');
  assert.equal(saved.deadlineAtMs, 2000);
  assert.ok(saved.completedAtMs >= saved.deadlineAtMs);
});

test('initial arm result completing after the absolute deadline is persisted as timeout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-late-arm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let nowMs = 1000;
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  const source = {
    async arm() {
      nowMs = 2001;
      return { status: 'matched', baseline: { boundary: 'late-arm' }, evidence: 'late-arm-match' };
    },
    async check() { assert.fail('late terminal arm result must not be checked again'); },
  };
  const engine = new WaitEngine({ store, sources: { fake: source }, now: () => nowMs });
  const result = await engine.run({
    name: 'late-arm', condition: { kind: 'fake' }, timeout_seconds: 1, hold_seconds: 0,
  });
  assert.equal(result.status, 'timeout');
  const saved = await store.read('late-arm');
  assert.equal(saved.status, 'timeout');
  assert.equal(saved.sourceArmed, true);
  assert.deepEqual(saved.baseline, { boundary: 'late-arm' });
  assert.equal(saved.deadlineAtMs, 2000);
});

test('fast source match before absolute deadline still persists matched', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-fast-match-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let nowMs = 1000;
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  const source = {
    async arm() {
      return { status: 'pending', baseline: { token: 'stable' } };
    },
    async check(record) {
      nowMs = 1500;
      return { status: 'matched', baseline: record.baseline, evidence: 'ready-in-time' };
    },
  };
  const engine = new WaitEngine({ store, sources: { fake: source }, now: () => nowMs });
  const result = await engine.run({
    name: 'fast-match', condition: { kind: 'fake' }, timeout_seconds: 1, hold_seconds: 0,
  });
  assert.equal(result.status, 'matched');
  assert.equal((await store.read('fast-match')).completedAtMs, 1500);
});

test('already expired durable pending record times out without invoking its source check', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-expired-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  await store.create({
    name: 'already-expired',
    definition: { condition: { kind: 'fake' }, timeoutSeconds: 1 },
    condition: { kind: 'fake' },
    timeoutSeconds: 1,
    armedAtMs: 1000,
    deadlineAtMs: 2000,
    status: 'pending',
    sourceArmed: true,
    baseline: { token: 'stable' },
    lastCheckedAtMs: 1000,
  });
  let checks = 0;
  const source = {
    async arm() { assert.fail('expired durable wait must not re-arm'); },
    async check() {
      checks += 1;
      return { status: 'matched', baseline: { token: 'stable' }, evidence: 'too-late' };
    },
  };
  const engine = new WaitEngine({ store, sources: { fake: source }, now: () => 2500 });
  const result = await engine.run({ name: 'already-expired', hold_seconds: 0 });
  assert.equal(result.status, 'timeout');
  assert.equal(checks, 0);
});

test('abort during initial source arm leaves no resumable unarmed wait and retry creates a fresh boundary', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-arm-abort-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  let armStartedResolve;
  const armStarted = new Promise((resolve) => { armStartedResolve = resolve; });
  let releaseArm;
  const armGate = new Promise((resolve) => { releaseArm = resolve; });
  let armCount = 0;
  const source = {
    async arm() {
      armCount += 1;
      armStartedResolve();
      await armGate;
      return { status: 'pending', baseline: { boundary: armCount } };
    },
    async check(record) {
      return { status: 'pending', baseline: record.baseline };
    },
  };
  const engine = new WaitEngine({ store, sources: { fake: source } });
  const condition = { kind: 'fake' };
  const controller = new AbortController();
  const create = engine.run({
    name: 'arm-abort', condition, timeout_seconds: 30, hold_seconds: 0,
  }, controller.signal);
  await armStarted;
  controller.abort();
  releaseArm();
  await assert.rejects(create, (error) => error?.code === 'WAIT_ABORTED');
  assert.equal(await store.read('arm-abort'), null);
  await assert.rejects(
    () => engine.run({ name: 'arm-abort', hold_seconds: 0 }),
    (error) => error?.code === 'WAIT_NOT_FOUND',
  );

  const retried = await engine.run({
    name: 'arm-abort', condition, timeout_seconds: 30, hold_seconds: 0,
  });
  assert.equal(retried.status, 'pending');
  const saved = await store.read('arm-abort');
  assert.equal(saved.sourceArmed, true);
  assert.deepEqual(saved.baseline, { boundary: 2 });
});

test('positive hold expiring during initial arm returns WAIT_HOLD_EXPIRED and never creates late durable state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-initial-hold-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  let lateCompletionFired = false;
  const source = {
    async arm(_condition, signal) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          lateCompletionFired = true;
          resolve({ status: 'pending', baseline: { boundary: 'late' } });
        }, 1500);
        const onAbort = () => {
          signal?.removeEventListener('abort', onAbort);
          const error = new Error('initial arm aborted by operation boundary');
          error.name = 'AbortError';
          error.code = 'ABORT_ERR';
          reject(error);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
    async check() { assert.fail('unpersisted arm must not reach check'); },
  };
  const engine = new WaitEngine({ store, sources: { fake: source } });
  const started = Date.now();
  await assert.rejects(
    () => engine.run({
      name: 'initial-hold-expired', condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 1,
    }),
    (error) => error?.code === 'WAIT_HOLD_EXPIRED',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 850, `positive initial hold returned too early: ${elapsed}ms`);
  assert.ok(elapsed < 1250, `positive initial hold overran its budget: ${elapsed}ms`);
  assert.equal(await store.read('initial-hold-expired'), null);
  await assert.rejects(
    () => engine.run({ name: 'initial-hold-expired', hold_seconds: 0 }),
    (error) => error?.code === 'WAIT_NOT_FOUND',
  );
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(lateCompletionFired, true);
  assert.equal(await store.read('initial-hold-expired'), null);
});

test('caller abort beats positive initial hold and leaves no durable record', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-initial-abort-priority-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  const source = {
    async arm(_condition, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ status: 'pending', baseline: { boundary: 'too-late' } }), 3000);
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const error = new Error('arm aborted');
          error.name = 'AbortError';
          error.code = 'ABORT_ERR';
          reject(error);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
    async check() { assert.fail('aborted create must not check'); },
  };
  const engine = new WaitEngine({ store, sources: { fake: source } });
  const controller = new AbortController();
  const started = Date.now();
  const pending = engine.run({
    name: 'initial-caller-abort', condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 10,
  }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error) => error?.code === 'WAIT_ABORTED');
  assert.ok(Date.now() - started < 300, 'caller abort did not beat positive hold promptly');
  assert.equal(await store.read('initial-caller-abort'), null);
});

test('durable deadline beats positive initial hold before any baseline is persisted', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-initial-deadline-priority-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  const source = {
    async arm(_condition, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ status: 'matched', baseline: { boundary: 'late' }, evidence: 'late' }), 1500);
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const error = new Error('arm deadline');
          error.name = 'AbortError';
          error.code = 'ABORT_ERR';
          reject(error);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
    async check() { assert.fail('deadline-expired create must not check'); },
  };
  const engine = new WaitEngine({ store, sources: { fake: source } });
  const result = await engine.run({
    name: 'initial-deadline-wins', condition: { kind: 'fake' }, timeout_seconds: 1, hold_seconds: 2,
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.name, 'initial-deadline-wins');
  assert.equal(await store.read('initial-deadline-wins'), null);
});

test('initial arm inside positive hold persists a valid baseline and later hold expiry returns pending', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-fast-initial-arm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  const source = {
    pollIntervalMs: 250,
    async arm(_condition, signal) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const error = new Error('fast arm unexpectedly aborted');
          error.name = 'AbortError';
          error.code = 'ABORT_ERR';
          reject(error);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return { status: 'pending', baseline: { boundary: 'inside-hold' } };
    },
    async check(record) {
      return { status: 'pending', baseline: record.baseline };
    },
  };
  const engine = new WaitEngine({ store, sources: { fake: source } });
  const started = Date.now();
  const result = await engine.run({
    name: 'initial-inside-hold', condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 1,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'pending');
  assert.ok(elapsed >= 850, `positive hold returned too early after arm: ${elapsed}ms`);
  assert.ok(elapsed < 1250, `positive hold overran after successful arm: ${elapsed}ms`);
  const saved = await store.read('initial-inside-hold');
  assert.equal(saved.sourceArmed, true);
  assert.deepEqual(saved.baseline, { boundary: 'inside-hold' });
  assert.equal(saved.status, 'pending');
});

test('hold_seconds zero still allows one normal bounded initial arm and check', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-hold-zero-arm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  let arms = 0;
  let checks = 0;
  const source = {
    async arm() {
      arms += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { status: 'pending', baseline: { boundary: 'hold-zero' } };
    },
    async check(record) {
      checks += 1;
      return { status: 'matched', baseline: record.baseline, evidence: 'checked-once' };
    },
  };
  const engine = new WaitEngine({ store, sources: { fake: source } });
  const result = await engine.run({
    name: 'hold-zero-arm', condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 0,
  });
  assert.equal(result.status, 'matched');
  assert.equal(arms, 1);
  assert.equal(checks, 1);
  assert.deepEqual((await store.read('hold-zero-arm')).baseline, { boundary: 'hold-zero' });
});

test('caller abort during first persistence wins before commit and leaves no late durable state', async (t) => {
  let hookEntries = 0;
  const fx = await linearizationFixture(t, {
    beforeCreateCommit: async ({ signal }) => {
      hookEntries += 1;
      await abortableDelay(1500, signal);
    },
  });
  const controller = new AbortController();
  const started = Date.now();
  const pending = fx.engine.run({
    name: 'persist-abort', condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 0,
  }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error) => error?.code === 'WAIT_ABORTED');
  assert.equal(hookEntries, 1);
  assert.ok(Date.now() - started < 350, 'abort did not interrupt first persistence promptly');
  assert.equal(await fx.store.read('persist-abort'), null);
  assert.deepEqual(await noTempFiles(fx.store), []);
  await assert.rejects(
    () => fx.engine.run({ name: 'persist-abort', hold_seconds: 0 }),
    (error) => error?.code === 'WAIT_NOT_FOUND',
  );
  await new Promise((resolve) => setTimeout(resolve, 1550));
  assert.equal(await fx.store.read('persist-abort'), null);
  assert.deepEqual(await noTempFiles(fx.store), []);
});

test('positive hold during first persistence wins before commit without a late install', async (t) => {
  let hookEntries = 0;
  const fx = await linearizationFixture(t, {
    beforeCreateCommit: async ({ signal }) => {
      hookEntries += 1;
      await abortableDelay(1500, signal);
    },
  });
  const started = Date.now();
  await assert.rejects(
    () => fx.engine.run({
      name: 'persist-hold', condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 1,
    }),
    (error) => error?.code === 'WAIT_HOLD_EXPIRED',
  );
  const elapsed = Date.now() - started;
  assert.equal(hookEntries, 1);
  assert.ok(elapsed >= 850, `hold returned too early during first persistence: ${elapsed}ms`);
  assert.ok(elapsed < 1250, `first persistence overran positive hold: ${elapsed}ms`);
  assert.equal(await fx.store.read('persist-hold'), null);
  assert.deepEqual(await noTempFiles(fx.store), []);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(await fx.store.read('persist-hold'), null);
  assert.deepEqual(await noTempFiles(fx.store), []);
});

test('atomic first commit wins over caller abort fired before create returns to the engine', async (t) => {
  const fx = await linearizationFixture(t);
  const controller = new AbortController();
  const originalCreate = fx.store.create.bind(fx.store);
  fx.store.create = async (record, options) => {
    const committed = await originalCreate(record, options);
    controller.abort();
    return committed;
  };
  const result = await fx.engine.run({
    name: 'commit-then-abort', condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 0,
  }, controller.signal);
  assert.equal(result.status, 'pending');
  const saved = await fx.store.read('commit-then-abort');
  assert.equal(saved.status, 'pending');
  assert.equal(saved.sourceArmed, true);
  assert.deepEqual(saved.baseline, { boundary: 1 });
});

test('first commit just before positive hold expiry wins and returns the committed pending wait', async (t) => {
  let hookEntries = 0;
  const fx = await linearizationFixture(t, {
    beforeCreateCommit: async ({ signal }) => {
      hookEntries += 1;
      await abortableDelay(900, signal);
    },
  });
  const started = Date.now();
  const result = await fx.engine.run({
    name: 'commit-then-hold', condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 1,
  });
  const elapsed = Date.now() - started;
  assert.equal(hookEntries, 1);
  assert.equal(result.status, 'pending');
  assert.ok(elapsed >= 850 && elapsed < 1250, `commit/hold arbitration drifted: ${elapsed}ms`);
  const saved = await fx.store.read('commit-then-hold');
  assert.equal(saved.status, 'pending');
  assert.deepEqual(saved.baseline, { boundary: 1 });
});

test('abort versus first-commit stress always produces one coherent linearized outcome', async (t) => {
  const delays = new Map();
  const fx = await linearizationFixture(t, {
    beforeCreateCommit: ({ name, signal }) => abortableDelay(delays.get(name) ?? 20, signal),
  });
  for (let i = 0; i < 16; i += 1) {
    const name = `abort-commit-stress-${i}`;
    delays.set(name, i % 2 === 0 ? 24 : 16);
    const controller = new AbortController();
    const pending = fx.engine.run({
      name, condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 0,
    }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    let result = null;
    let error = null;
    try {
      result = await pending;
    } catch (caught) {
      error = caught;
    }
    const saved = await fx.store.read(name);
    if (error) {
      assert.equal(error.code, 'WAIT_ABORTED');
      assert.equal(saved, null, `WAIT_ABORTED iteration ${i} left a committed record`);
    } else {
      assert.equal(result.status, 'pending');
      assert.equal(saved?.status, 'pending', `commit-winning iteration ${i} lost durable state`);
      assert.equal(saved?.sourceArmed, true);
    }
  }
  assert.deepEqual(await noTempFiles(fx.store), []);
});

test('positive hold versus first-commit stress never reports pre-commit expiry with durable state', async (t) => {
  const delays = new Map();
  const fx = await linearizationFixture(t, {
    beforeCreateCommit: ({ name, signal }) => abortableDelay(delays.get(name) ?? 1000, signal),
  });
  for (const [index, delayMs] of [950, 990, 1010, 1050].entries()) {
    const name = `hold-commit-stress-${index}`;
    delays.set(name, delayMs);
    const started = Date.now();
    let result = null;
    let error = null;
    try {
      result = await fx.engine.run({
        name, condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 1,
      });
    } catch (caught) {
      error = caught;
    }
    const elapsed = Date.now() - started;
    const saved = await fx.store.read(name);
    assert.ok(elapsed < 1250, `hold/commit stress iteration ${index} overran: ${elapsed}ms`);
    if (error) {
      assert.equal(error.code, 'WAIT_HOLD_EXPIRED');
      assert.equal(saved, null, `WAIT_HOLD_EXPIRED iteration ${index} left durable state`);
    } else {
      assert.equal(result.status, 'pending');
      assert.equal(saved?.status, 'pending', `commit-winning hold iteration ${index} lost state`);
      assert.equal(saved?.sourceArmed, true);
    }
  }
  assert.deepEqual(await noTempFiles(fx.store), []);
});

test('durable deadline racing first persistence cannot commit pending or matched after deadline', async (t) => {
  let hookEntries = 0;
  const fx = await linearizationFixture(t, {
    beforeCreateCommit: async ({ signal }) => {
      hookEntries += 1;
      await abortableDelay(1500, signal);
    },
  });
  const started = Date.now();
  const result = await fx.engine.run({
    name: 'deadline-first-commit', condition: { kind: 'fake' }, timeout_seconds: 1, hold_seconds: 2,
  });
  const elapsed = Date.now() - started;
  assert.equal(hookEntries, 1);
  assert.equal(result.status, 'timeout');
  assert.ok(elapsed >= 850 && elapsed < 1300, `deadline/commit arbitration drifted: ${elapsed}ms`);
  const saved = await fx.store.read('deadline-first-commit');
  if (saved !== null) {
    assert.equal(saved.status, 'timeout');
    assert.equal(saved.sourceArmed, true);
    assert.ok(saved.completedAtMs >= saved.deadlineAtMs);
  }
  assert.notEqual(saved?.status, 'pending');
  assert.notEqual(saved?.status, 'matched');
  assert.deepEqual(await noTempFiles(fx.store), []);
});

test('same-definition retry after a successfully armed create preserves one arm boundary and deadline', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-create-retry-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  let armCount = 0;
  const source = {
    async arm() {
      armCount += 1;
      return { status: 'pending', baseline: { boundary: armCount } };
    },
    async check(record) {
      return { status: 'pending', baseline: record.baseline };
    },
  };
  const engine = new WaitEngine({ store, sources: { fake: source } });
  const args = {
    name: 'create-retry', condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 0,
  };
  await engine.run(args);
  const first = await store.read('create-retry');
  await engine.run(args);
  const second = await store.read('create-retry');
  assert.equal(armCount, 1);
  assert.equal(second.deadlineAtMs, first.deadlineAtMs);
  assert.deepEqual(second.baseline, first.baseline);
});

test('hold_seconds bounds the whole resumed check loop instead of allowing a late full probe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-hold-budget-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WaitStore({ stateDir: path.join(root, 'state') });
  const source = {
    pollIntervalMs: 250,
    async arm() {
      return { status: 'pending', baseline: { probe: 0 } };
    },
    async check(record, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({
          status: 'pending',
          baseline: { probe: (record.baseline?.probe ?? 0) + 1 },
        }), 700);
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const error = new Error('probe aborted');
          error.name = 'AbortError';
          error.code = 'ABORT_ERR';
          reject(error);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
  };
  const engine = new WaitEngine({ store, sources: { fake: source } });
  await engine.run({
    name: 'hold-budget', condition: { kind: 'fake' }, timeout_seconds: 30, hold_seconds: 0,
  });

  const started = Date.now();
  const result = await engine.run({ name: 'hold-budget', hold_seconds: 1 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'pending');
  assert.ok(elapsed >= 850, `hold returned unexpectedly early: ${elapsed}ms`);
  assert.ok(elapsed < 1250, `hold overran total budget: ${elapsed}ms`);
});

test('transient systemd unavailability leaves the same durable wait pending for recovery resume', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wait-engine-systemd-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const store = new WaitStore({ stateDir });
  let unavailable = true;
  const local = new LocalWaitSources({
    defaultCwd: root,
    env: { PATH: process.env.PATH ?? '' },
    execFileImpl: async () => {
      if (unavailable) throw new Error('Failed to connect to bus');
      return { stdout: 'active\nrunning\n', stderr: '' };
    },
  });
  const engine = new WaitEngine({ store, sources: { systemd_user: local } });
  const condition = { kind: 'systemd_user', unit: 'demo.service', state: 'active' };

  await assert.rejects(
    () => engine.run({ name: 'systemd-recovery', condition, timeout_seconds: 30, hold_seconds: 0 }),
    (error) => error?.code === 'WAIT_SOURCE_UNAVAILABLE',
  );
  const pending = await store.read('systemd-recovery');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.condition.kind, 'systemd_user');
  const originalDeadline = pending.deadlineAtMs;
  const originalBaseline = structuredClone(pending.baseline);

  unavailable = false;
  const matched = await engine.run({ name: 'systemd-recovery', hold_seconds: 0 });
  assert.equal(matched.status, 'matched');
  const recovered = await store.read('systemd-recovery');
  assert.equal(recovered.deadlineAtMs, originalDeadline);
  assert.deepEqual(recovered.baseline, originalBaseline);
});
