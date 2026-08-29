import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runEdit } from '../files.mjs';
import { applyFileOpsPlan, preflightFileOps, runFileOps } from '../file-ops.mjs';
import { withMutationPath } from '../mutation-coordinator.mjs';

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function holdMutationPath(target) {
  let releaseHolder;
  let holderEntered;
  const gate = new Promise(resolve => { releaseHolder = resolve; });
  const ready = new Promise(resolve => { holderEntered = resolve; });
  const holder = withMutationPath(target, async () => {
    holderEntered();
    await gate;
  });
  await ready;
  return { holder, releaseHolder };
}

test('file_ops rejects an initial final-component symlink without touching its referent', async () => {
  const defaultCwd = await tempDir('file-ops-symlink-');
  const victim = path.join(defaultCwd, 'victim.txt');
  const link = path.join(defaultCwd, 'link.txt');
  await fs.writeFile(victim, 'keep\n');
  await fs.symlink(victim, link);

  await assert.rejects(
    () => runFileOps({
      pathMode: 'user',
      defaultCwd,
      operations: [{ kind: 'delete', path: 'link.txt' }],
    }),
    /symbolic link/i
  );

  assert.equal(await fs.readFile(victim, 'utf8'), 'keep\n');
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test('file_ops rejects a FIFO promptly without waiting for a peer', async () => {
  const defaultCwd = await tempDir('file-ops-fifo-');
  const fifo = path.join(defaultCwd, 'pipe');
  execFileSync('mkfifo', [fifo]);

  let rescueUsed = false;
  let rescuePromise = Promise.resolve();
  const rescue = setTimeout(() => {
    rescueUsed = true;
    rescuePromise = fs.open(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
      .then(handle => handle.close())
      .catch(() => {});
  }, 250);

  try {
    await assert.rejects(
      () => runFileOps({
        pathMode: 'user',
        defaultCwd,
        operations: [{ kind: 'delete', path: 'pipe' }],
      }),
      /regular file/i
    );
  } finally {
    clearTimeout(rescue);
    await rescuePromise;
  }

  assert.equal(rescueUsed, false, 'FIFO validation waited for a peer before rejecting the entry');
});

test('symlink substitution while queued cannot redirect delete to the referent', async () => {
  const defaultCwd = await tempDir('file-ops-queued-symlink-');
  const source = path.join(defaultCwd, 'source.txt');
  const victim = path.join(defaultCwd, 'victim.txt');
  await fs.writeFile(source, 'source\n');
  await fs.writeFile(victim, 'victim\n');
  const plan = await preflightFileOps({
    pathMode: 'user',
    defaultCwd,
    operations: [{ kind: 'delete', path: 'source.txt' }],
  });

  const { holder, releaseHolder } = await holdMutationPath(source);
  const pending = applyFileOpsPlan(plan);
  await new Promise(resolve => setTimeout(resolve, 10));
  await fs.unlink(source);
  await fs.symlink(victim, source);
  releaseHolder();

  await assert.rejects(pending, /symbolic link|changed since preflight/i);
  await holder;
  assert.equal(await fs.readFile(victim, 'utf8'), 'victim\n');
  assert.equal((await fs.lstat(source)).isSymbolicLink(), true);
});

test('replaced source inode while queued is rejected before mutation', async () => {
  const defaultCwd = await tempDir('file-ops-queued-inode-');
  const source = path.join(defaultCwd, 'source.txt');
  await fs.writeFile(source, 'original\n');
  const plan = await preflightFileOps({
    pathMode: 'user',
    defaultCwd,
    operations: [{ kind: 'delete', path: 'source.txt' }],
  });

  const { holder, releaseHolder } = await holdMutationPath(source);
  const pending = applyFileOpsPlan(plan);
  await new Promise(resolve => setTimeout(resolve, 10));
  await fs.unlink(source);
  await fs.writeFile(source, 'replacement\n');
  releaseHolder();

  await assert.rejects(pending, /changed since preflight/i);
  await holder;
  assert.equal(await fs.readFile(source, 'utf8'), 'replacement\n');
});

test('invalid later batch member causes zero mutation', async () => {
  const defaultCwd = await tempDir('file-ops-preflight-batch-');
  const first = path.join(defaultCwd, 'first.txt');
  await fs.writeFile(first, 'keep\n');

  await assert.rejects(
    () => runFileOps({
      pathMode: 'user',
      defaultCwd,
      operations: [
        { kind: 'delete', path: 'first.txt' },
        { kind: 'delete', path: 'missing.txt' },
      ],
    }),
    /existing regular file/i
  );

  assert.equal(await fs.readFile(first, 'utf8'), 'keep\n');
});

test('destination race is rejected without overwrite or source removal', async () => {
  const defaultCwd = await tempDir('file-ops-destination-race-');
  const source = path.join(defaultCwd, 'source.txt');
  const destination = path.join(defaultCwd, 'destination.txt');
  await fs.writeFile(source, 'source\n');
  const plan = await preflightFileOps({
    pathMode: 'user',
    defaultCwd,
    operations: [{ kind: 'move', path: 'source.txt', to: 'destination.txt' }],
  });
  await fs.writeFile(destination, 'external\n');

  await assert.rejects(() => applyFileOpsPlan(plan), /destination.*already exists/i);
  assert.equal(await fs.readFile(source, 'utf8'), 'source\n');
  assert.equal(await fs.readFile(destination, 'utf8'), 'external\n');
});

test('same-filesystem move preserves inode identity and binary contents', async () => {
  const defaultCwd = await tempDir('file-ops-binary-move-');
  const source = path.join(defaultCwd, 'source.bin');
  const destination = path.join(defaultCwd, 'destination.bin');
  const bytes = Buffer.from([0xff, 0x00, 0x80, 0x01, 0x7f]);
  await fs.writeFile(source, bytes);
  const before = await fs.stat(source);

  const result = await runFileOps({
    pathMode: 'user',
    defaultCwd,
    operations: [{ kind: 'move', path: 'source.bin', to: 'destination.bin' }],
  });

  const after = await fs.stat(destination);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.deepEqual(await fs.readFile(destination), bytes);
  await assert.rejects(() => fs.lstat(source), error => error?.code === 'ENOENT');
  assert.deepEqual(result.operations, [{ kind: 'move', path: 'source.bin', to: 'destination.bin' }]);
});

test('EXDEV from hard-link creation is explicit and never falls back to copying', async () => {
  const defaultCwd = await tempDir('file-ops-exdev-');
  const source = path.join(defaultCwd, 'source.bin');
  const destination = path.join(defaultCwd, 'destination.bin');
  const bytes = Buffer.from([0xff, 0x10, 0x00]);
  await fs.writeFile(source, bytes);
  const plan = await preflightFileOps({
    pathMode: 'user',
    defaultCwd,
    operations: [{ kind: 'move', path: 'source.bin', to: 'destination.bin' }],
  });

  let linkCalls = 0;
  await assert.rejects(
    () => applyFileOpsPlan(plan, {
      link: async () => {
        linkCalls += 1;
        const error = new Error('simulated cross-device link');
        error.code = 'EXDEV';
        throw error;
      },
    }),
    error => error?.code === 'EXDEV' && /EXDEV|across filesystems/i.test(error.message)
  );

  assert.equal(linkCalls, 1);
  assert.deepEqual(await fs.readFile(source), bytes);
  await assert.rejects(() => fs.lstat(destination), error => error?.code === 'ENOENT');
});

test('coordinated edit versus preflighted delete has exactly one winner', async () => {
  const defaultCwd = await tempDir('file-ops-edit-delete-');
  const target = path.join(defaultCwd, 'x.txt');
  await fs.writeFile(target, 'alpha\n');
  const deletePlan = await preflightFileOps({
    pathMode: 'user',
    defaultCwd,
    operations: [{ kind: 'delete', path: 'x.txt' }],
  });

  const settled = await Promise.allSettled([
    applyFileOpsPlan(deletePlan),
    runEdit({
      pathMode: 'user',
      defaultCwd,
      targets: [{ path: 'x.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }],
    }),
  ]);

  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of settled) {
    if (result.status === 'rejected') {
      assert.match(String(result.reason?.message ?? result.reason), /changed since preflight|ENOENT|no such file|reread and reconcile/i);
    }
  }
  try {
    assert.equal(await fs.readFile(target, 'utf8'), 'ALPHA\n');
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
  }
});

test('cancellation while queued prevents later mutation', async () => {
  const defaultCwd = await tempDir('file-ops-cancel-queued-');
  const target = path.join(defaultCwd, 'x.txt');
  await fs.writeFile(target, 'keep\n');
  const controller = new AbortController();
  const plan = await preflightFileOps({
    pathMode: 'user',
    defaultCwd,
    signal: controller.signal,
    operations: [{ kind: 'delete', path: 'x.txt' }],
  });

  const { holder, releaseHolder } = await holdMutationPath(target);
  const pending = applyFileOpsPlan(plan);
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  releaseHolder();

  await assert.rejects(pending, /abort/i);
  await holder;
  assert.equal(await fs.readFile(target, 'utf8'), 'keep\n');
});

test('post-link failure returns structured FILE_OPS_PARTIAL with confirmed side effects', async () => {
  const defaultCwd = await tempDir('file-ops-partial-');
  const first = path.join(defaultCwd, 'first.txt');
  const source = path.join(defaultCwd, 'source.txt');
  const destination = path.join(defaultCwd, 'destination.txt');
  const last = path.join(defaultCwd, 'last.txt');
  await fs.writeFile(first, 'first\n');
  await fs.writeFile(source, 'source\n');
  await fs.writeFile(last, 'last\n');
  const plan = await preflightFileOps({
    pathMode: 'user',
    defaultCwd,
    operations: [
      { kind: 'delete', path: 'first.txt' },
      { kind: 'move', path: 'source.txt', to: 'destination.txt' },
      { kind: 'delete', path: 'last.txt' },
    ],
  });

  await assert.rejects(
    () => applyFileOpsPlan(plan, {
      unlink: async target => {
        if (target === source) {
          const error = new Error('simulated source unlink failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.unlink(target);
      },
    }),
    error => {
      assert.equal(error.code, 'FILE_OPS_PARTIAL');
      assert.deepEqual(error.fileOpsPartial.completed, [{ kind: 'delete', path: 'first.txt' }]);
      assert.deepEqual(error.fileOpsPartial.failed, []);
      assert.equal(error.fileOpsPartial.uncertain.length, 1);
      assert.deepEqual(
        { ...error.fileOpsPartial.uncertain[0], message: undefined },
        {
          kind: 'move',
          path: 'source.txt',
          to: 'destination.txt',
          sideEffects: {
            destination_link_created: true,
            expected_source_entry_retained: true,
          },
          message: undefined,
        }
      );
      assert.match(error.fileOpsPartial.uncertain[0].message, /source unlink failure|destination link was created/i);
      assert.deepEqual(error.fileOpsPartial.unattempted, [{ kind: 'delete', path: 'last.txt' }]);
      return true;
    }
  );

  await assert.rejects(() => fs.lstat(first), error => error?.code === 'ENOENT');
  const sourceStat = await fs.stat(source);
  const destinationStat = await fs.stat(destination);
  assert.equal(destinationStat.dev, sourceStat.dev);
  assert.equal(destinationStat.ino, sourceStat.ino);
  assert.equal(await fs.readFile(last, 'utf8'), 'last\n');
});
