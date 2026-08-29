import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withMutationPath, withMutationPaths } from '../mutation-coordinator.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withTimeout(promise, ms = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('same canonical path mutation critical sections do not overlap', async () => {
  let active = 0;
  let maxActive = 0;

  const run = () => withMutationPath('/tmp/shared.txt', async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(10);
    active -= 1;
  });

  await Promise.all([run(), run(), run()]);
  assert.equal(maxActive, 1);
});

test('different canonical paths may execute concurrently', async () => {
  let entered = 0;
  let release;
  const bothEntered = new Promise(resolve => { release = resolve; });

  const run = target => withMutationPath(target, async () => {
    entered += 1;
    if (entered === 2) release();
    await bothEntered;
  });

  await withTimeout(Promise.all([
    run('/tmp/a.txt'),
    run('/tmp/b.txt')
  ]));
  assert.equal(entered, 2);
});

test('missing targets through symlinked parent aliases share one canonical lease', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mutation-coordinator-alias-'));
  const realDir = path.join(root, 'real');
  const aliasDir = path.join(root, 'alias');
  await fs.mkdir(realDir);
  await fs.symlink(realDir, aliasDir);

  let active = 0;
  let maxActive = 0;
  const run = target => withMutationPath(target, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(10);
    active -= 1;
  });

  await Promise.all([
    run(path.join(realDir, 'new.txt')),
    run(path.join(aliasDir, 'new.txt'))
  ]);
  assert.equal(maxActive, 1);
});

test('multiple-path acquisition uses stable ordering and does not deadlock', async () => {
  let active = 0;
  let maxActive = 0;

  const first = withMutationPaths(['/tmp/b.txt', '/tmp/a.txt'], async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(10);
    active -= 1;
  });
  const second = withMutationPaths(['/tmp/a.txt', '/tmp/b.txt'], async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(10);
    active -= 1;
  });

  await withTimeout(Promise.all([first, second]));
  assert.equal(maxActive, 1);
});

test('leases release after success and thrown failure', async () => {
  await assert.rejects(
    () => withMutationPath('/tmp/release.txt', async () => {
      throw new Error('expected failure');
    }),
    /expected failure/
  );

  let entered = false;
  await withTimeout(withMutationPath('/tmp/release.txt', async () => {
    entered = true;
  }));
  assert.equal(entered, true);
});

test('already-aborted acquisition rejects before its callback begins', async () => {
  const controller = new AbortController();
  controller.abort();
  let entered = false;

  await assert.rejects(
    () => withMutationPath('/tmp/already-aborted.txt', async () => {
      entered = true;
    }, { signal: controller.signal }),
    /abort/i
  );
  assert.equal(entered, false);
});

test('canceling a queued waiter removes it and a later live waiter still runs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mutation-coordinator-cancel-'));
  const target = path.join(root, 'x.txt');
  await fs.writeFile(target, 'x\n');

  let releaseHolder;
  let holderEntered;
  const holderGate = new Promise(resolve => { releaseHolder = resolve; });
  const holderReady = new Promise(resolve => { holderEntered = resolve; });
  const holder = withMutationPath(target, async () => {
    holderEntered();
    await holderGate;
  });
  await holderReady;

  const controller = new AbortController();
  let canceledEntered = false;
  let liveEntered = false;
  const canceled = withMutationPath(target, async () => {
    canceledEntered = true;
  }, { signal: controller.signal });
  const live = withMutationPath(target, async () => {
    liveEntered = true;
  });

  await delay(10);
  controller.abort();
  releaseHolder();

  await assert.rejects(canceled, /abort/i);
  await withTimeout(Promise.all([holder, live]));
  assert.equal(canceledEntered, false);
  assert.equal(liveEntered, true);
});

test('canceling multi-path acquisition releases earlier keys while waiting for a later key', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mutation-coordinator-multipath-cancel-'));
  const a = path.join(root, 'a.txt');
  const b = path.join(root, 'b.txt');
  await fs.writeFile(a, 'a\n');
  await fs.writeFile(b, 'b\n');

  let releaseB;
  let bEntered;
  const bGate = new Promise(resolve => { releaseB = resolve; });
  const bReady = new Promise(resolve => { bEntered = resolve; });
  const bHolder = withMutationPath(b, async () => {
    bEntered();
    await bGate;
  });
  await bReady;

  const controller = new AbortController();
  let multiEntered = false;
  const multi = withMutationPaths([b, a], async () => {
    multiEntered = true;
  }, { signal: controller.signal });
  await delay(10);

  let aProbeEntered = false;
  const aProbe = withMutationPath(a, async () => {
    aProbeEntered = true;
  });
  await delay(10);

  controller.abort();
  try {
    await withTimeout(aProbe, 100);
  } finally {
    releaseB();
    await bHolder;
  }

  await assert.rejects(multi, /abort/i);
  assert.equal(aProbeEntered, true);
  assert.equal(multiEntered, false);
});

test('abort wins the queued grant boundary before callback entry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mutation-coordinator-abort-grant-'));
  const target = path.join(root, 'x.txt');
  await fs.writeFile(target, 'x\n');

  for (let iteration = 0; iteration < 100; iteration += 1) {
    let releaseHolder;
    let holderEntered;
    const holderGate = new Promise(resolve => { releaseHolder = resolve; });
    const holderReady = new Promise(resolve => { holderEntered = resolve; });
    const holder = withMutationPath(target, async () => {
      holderEntered();
      await holderGate;
    });
    await holderReady;

    const controller = new AbortController();
    let callbackEntered = false;
    let enteredAfterAbort = false;
    const pending = withMutationPath(target, async () => {
      callbackEntered = true;
      if (controller.signal.aborted) enteredAfterAbort = true;
    }, { signal: controller.signal });
    await delay(1);

    queueMicrotask(() => controller.abort());
    queueMicrotask(() => releaseHolder());

    await assert.rejects(pending, /abort/i, `iteration ${iteration}`);
    await holder;
    assert.equal(callbackEntered, false, `iteration ${iteration}: canceled callback must not begin`);
    assert.equal(enteredAfterAbort, false, `iteration ${iteration}: callback must not start after abort won`);
  }
});
