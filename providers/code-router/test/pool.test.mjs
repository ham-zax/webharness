import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RepoChildPool } from '../pool.mjs';

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fs.realpath(dir);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached before timeout');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function fakeFactory(options = {}) {
  let sequence = 0;
  const created = [];
  const gates = options.gates ?? new Map();
  const failFirstCallRoots = new Set(options.failFirstCallRoots ?? []);

  const factory = async root => {
    const id = ++sequence;
    const gate = gates.get(root);
    if (gate) await gate.promise;

    let alive = true;
    let calls = 0;
    const child = {
      root,
      pid: 10000 + id,
      get alive() { return alive; },
      async callTool(name, args) {
        calls += 1;
        if (failFirstCallRoots.has(root) && id === 1 && calls === 1) {
          alive = false;
          const error = new Error('simulated child crash');
          error.code = 'CHILD_CLOSED';
          throw error;
        }
        return { childId: id, root, name, args };
      },
      async close() { alive = false; },
      crash() { alive = false; }
    };
    created.push(child);
    return child;
  };

  return { factory, created };
}

test('reuses one active child for repeated calls to the same canonical repository', async t => {
  const root = await tempDir(t, 'code-pool-reuse-');
  const { factory, created } = fakeFactory();
  const pool = new RepoChildPool({ childFactory: factory });
  t.after(() => pool.close());

  const first = await pool.call(root, 'codedb_status', {});
  const second = await pool.call(root, 'codedb_search', { query: 'marker' });

  assert.equal(first.childId, second.childId);
  assert.equal(created.length, 1);
  assert.deepEqual(pool.inspect(), [{ root, pid: first.childId + 10000, alive: true }]);
});

test('different repositories get independent active children', async t => {
  const rootA = await tempDir(t, 'code-pool-a-');
  const rootB = await tempDir(t, 'code-pool-b-');
  const { factory } = fakeFactory();
  const pool = new RepoChildPool({ childFactory: factory });
  t.after(() => pool.close());

  const a = await pool.call(rootA, 'codedb_status', {});
  const b = await pool.call(rootB, 'codedb_status', {});

  assert.notEqual(a.childId, b.childId);
  assert.equal(pool.activeCount, 2);
  assert.deepEqual(pool.inspect().map(x => x.root).sort(), [rootA, rootB].sort());
});

test('concurrent requests for one repository share a single pending spawn', async t => {
  const root = await tempDir(t, 'code-pool-pending-');
  const gate = deferred();
  const { factory, created } = fakeFactory({ gates: new Map([[root, gate]]) });
  const pool = new RepoChildPool({ childFactory: factory });
  t.after(() => pool.close());

  const first = pool.call(root, 'codedb_status', {});
  const second = pool.call(root, 'codedb_search', { query: 'x' });
  try {
    await waitFor(() => pool.pendingCount === 1);
    assert.equal(pool.pendingCount, 1);
  } finally {
    gate.resolve();
  }

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.childId, b.childId);
  assert.equal(created.length, 1);
});

test('different repository spawns can proceed concurrently', async t => {
  const rootA = await tempDir(t, 'code-pool-concurrent-a-');
  const rootB = await tempDir(t, 'code-pool-concurrent-b-');
  const gateA = deferred();
  const gateB = deferred();
  const started = [];
  let nextId = 0;
  const factory = async root => {
    started.push(root);
    await (root === rootA ? gateA.promise : gateB.promise);
    const id = ++nextId;
    let alive = true;
    return {
      root,
      pid: 12000 + id,
      get alive() { return alive; },
      callTool: async name => ({ root, name }),
      close: async () => { alive = false; }
    };
  };
  const pool = new RepoChildPool({ childFactory: factory });
  t.after(() => pool.close());

  const callA = pool.call(rootA, 'codedb_status', {});
  const callB = pool.call(rootB, 'codedb_status', {});
  try {
    await waitFor(() => started.length === 2);
    assert.deepEqual(started.sort(), [rootA, rootB].sort());
    assert.equal(pool.pendingCount, 2);
  } finally {
    gateA.resolve();
    gateB.resolve();
  }
  await Promise.all([callA, callB]);
});

test('capacity is explicit at four active or pending repositories and never evicts', async t => {
  const roots = [];
  for (let i = 0; i < 5; i += 1) roots.push(await tempDir(t, `code-pool-cap-${i}-`));
  const { factory } = fakeFactory();
  const pool = new RepoChildPool({ childFactory: factory });
  t.after(() => pool.close());

  for (const root of roots.slice(0, 4)) await pool.call(root, 'codedb_status', {});
  assert.equal(pool.activeCount, 4);

  await assert.rejects(
    () => pool.call(roots[4], 'codedb_status', {}),
    error => {
      assert.equal(error.code, 'ROUTER_CAPACITY');
      assert.match(error.message, /maximum active CodeDB children is 4/i);
      return true;
    }
  );
  assert.equal(pool.activeCount, 4);

  const reused = await pool.call(roots[0], 'codedb_status', {});
  assert.equal(reused.root, roots[0]);
  assert.equal(pool.activeCount, 4);
});

test('a child that crashes during a call is replaced once and the read-only call is retried', async t => {
  const root = await tempDir(t, 'code-pool-crash-');
  const { factory, created } = fakeFactory({ failFirstCallRoots: [root] });
  const pool = new RepoChildPool({ childFactory: factory });
  t.after(() => pool.close());

  const result = await pool.call(root, 'codedb_search', { query: 'recover' });

  assert.equal(result.childId, 2);
  assert.equal(created.length, 2);
  assert.equal(pool.activeCount, 1);
  assert.equal(pool.inspect()[0].pid, 10002);
});

test('repository disappearance closes and removes its child', async t => {
  const root = await tempDir(t, 'code-pool-disappear-');
  const { factory, created } = fakeFactory();
  const pool = new RepoChildPool({ childFactory: factory });
  t.after(() => pool.close());

  await pool.call(root, 'codedb_status', {});
  await fs.rm(root, { recursive: true, force: true });

  await assert.rejects(
    () => pool.call(root, 'codedb_status', {}),
    error => {
      assert.equal(error.code, 'REPOSITORY_DISAPPEARED');
      return true;
    }
  );
  assert.equal(created[0].alive, false);
  assert.equal(pool.activeCount, 0);
});

test('pruneMissing reaps disappeared repositories without evicting healthy children', async t => {
  const rootA = await tempDir(t, 'code-pool-prune-a-');
  const rootB = await tempDir(t, 'code-pool-prune-b-');
  const { factory, created } = fakeFactory();
  const pool = new RepoChildPool({ childFactory: factory });
  t.after(() => pool.close());

  await pool.call(rootA, 'codedb_status', {});
  await pool.call(rootB, 'codedb_status', {});
  await fs.rm(rootA, { recursive: true, force: true });

  const removed = await pool.pruneMissing();

  assert.deepEqual(removed, [rootA]);
  assert.equal(pool.activeCount, 1);
  assert.deepEqual(pool.inspect().map(x => x.root), [rootB]);
  assert.equal(created.find(child => child.root === rootA).alive, false);
  assert.equal(created.find(child => child.root === rootB).alive, true);
});

test('clean shutdown closes all children and rejects subsequent work', async t => {
  const rootA = await tempDir(t, 'code-pool-close-a-');
  const rootB = await tempDir(t, 'code-pool-close-b-');
  const { factory, created } = fakeFactory();
  const pool = new RepoChildPool({ childFactory: factory });

  await pool.call(rootA, 'codedb_status', {});
  await pool.call(rootB, 'codedb_status', {});
  await pool.close();
  await pool.close();

  assert.equal(pool.activeCount, 0);
  assert.ok(created.every(child => !child.alive));
  await assert.rejects(
    () => pool.call(rootA, 'codedb_status', {}),
    error => error.code === 'ROUTER_CLOSED'
  );
});
