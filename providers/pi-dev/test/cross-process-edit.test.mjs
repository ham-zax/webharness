import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runEdit } from '../files.mjs';
import { withMutationPath, withMutationPaths } from '../mutation-coordinator.mjs';

const filesModuleUrl = new URL('../files.mjs', import.meta.url).href;
const coordinatorModuleUrl = new URL('../mutation-coordinator.mjs', import.meta.url).href;

async function writeWorkerHelper(dir) {
  const helperPath = path.join(dir, 'edit-worker.mjs');
  await fs.writeFile(
    helperPath,
    `import { runEdit } from ${JSON.stringify(filesModuleUrl)};
import { withMutationPath } from ${JSON.stringify(coordinatorModuleUrl)};

const mode = process.argv[2];
const workspaceRoot = process.argv[3];
const targetPath = process.argv[4];
const oldText = process.argv[5];
const newText = process.argv[6];

if (mode === 'hold-lock') {
  await withMutationPath(targetPath, async () => {
    process.send({ type: 'locked', pid: process.pid });
    await new Promise(() => {});
  });
} else {
  let releasePause;
  const pauseGate = new Promise(resolve => { releasePause = resolve; });
  process.on('message', msg => {
    if (msg?.type === 'resume') releasePause();
  });
  try {
    const res = await runEdit(
      {
        pathMode: 'workspace',
        workspaceRoot,
        targets: [{ path: targetPath, edits: [{ oldText, newText }] }],
      },
      undefined,
      mode === 'pause-before-guard'
        ? {
            beforeGuard: async () => {
              process.send({ type: 'at-guard', pid: process.pid });
              await pauseGate;
            },
          }
        : {},
    );
    process.send({ type: 'ok', targets: res.targets.length });
  } catch (error) {
    process.send({ type: 'err', message: error instanceof Error ? error.message : String(error) });
  }
}
`,
    'utf8',
  );
  return helperPath;
}

function waitForMessage(child, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for worker message')), timeoutMs);
    const onMessage = msg => {
      if (!predicate(msg)) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(msg);
    };
    child.on('message', onMessage);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      reject(new Error(`worker exited early (${signal ?? code})`));
    });
  });
}

test('two separate OS processes editing disjoint hunks through hard-link aliases serialize and preserve inode identity', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cross-proc-disjoint-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helperPath = await writeWorkerHelper(root);

  const sharedFile = path.join(root, 'shared.txt');
  const hardLink = path.join(root, 'shared-hardlink.txt');
  await fs.writeFile(sharedFile, 'top: v0\nmiddle: untouched\nbottom: v0\n', 'utf8');
  await fs.link(sharedFile, hardLink);
  const initialStat = await fs.stat(sharedFile);

  const procA = fork(helperPath, ['pause-before-guard', root, 'shared.txt', 'top: v0', 'top: UPDATED_BY_PROC_A']);
  t.after(() => { if (procA.exitCode === null) procA.kill('SIGKILL'); });
  await waitForMessage(procA, msg => msg.type === 'at-guard');

  // Start Process B in a separate OS process while Process A is paused inside mutatePlannedTarget.
  const procB = fork(helperPath, ['direct', root, 'shared-hardlink.txt', 'bottom: v0', 'bottom: UPDATED_BY_PROC_B']);
  t.after(() => { if (procB.exitCode === null) procB.kill('SIGKILL'); });
  const outcomeBPromise = waitForMessage(procB, msg => msg.type === 'ok' || msg.type === 'err');

  // Give Process B time to hit the cross-process lock.
  await new Promise(r => setTimeout(r, 80));
  procA.send({ type: 'resume' });

  const [outcomeA, outcomeB] = await Promise.all([
    waitForMessage(procA, msg => msg.type === 'ok' || msg.type === 'err'),
    outcomeBPromise,
  ]);
  assert.equal(outcomeA.type, 'ok');
  assert.equal(outcomeB.type, 'ok');

  const expected = 'top: UPDATED_BY_PROC_A\nmiddle: untouched\nbottom: UPDATED_BY_PROC_B\n';
  assert.equal(await fs.readFile(sharedFile, 'utf8'), expected);
  assert.equal(await fs.readFile(hardLink, 'utf8'), expected, 'hard link sees exact in-place update');
  const afterStat = await fs.stat(sharedFile);
  assert.equal(afterStat.ino, initialStat.ino, 'in-place O_RDWR write preserved inode identity');
});

test('a held inode lease blocks another process through a hard-link alias and cancellation releases its pathname lease', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cross-proc-alias-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helperPath = await writeWorkerHelper(root);
  const original = path.join(root, 'original.txt');
  const alias = path.join(root, 'alias.txt');
  await fs.writeFile(original, 'original');
  await fs.link(original, alias);
  const holder = fork(helperPath, ['hold-lock', root, original, '', '']);
  t.after(async () => {
    if (holder.exitCode !== null || holder.signalCode !== null) return;
    const exited = once(holder, 'exit');
    holder.kill('SIGKILL');
    await exited;
  });
  await waitForMessage(holder, msg => msg.type === 'locked');
  let entered = false;
  await assert.rejects(withMutationPath(alias, async () => { entered = true; }, {
    signal: AbortSignal.timeout(150),
  }), /timeout|abort/i);
  assert.equal(entered, false);
  const exited = once(holder, 'exit');
  holder.kill('SIGKILL');
  await exited;
  // Duplicate inode identities in a multi-path request must not self-deadlock.
  await withMutationPaths([original, alias], async () => { entered = true; }, { maxWaitMs: 500 });
  assert.equal(entered, true);
});

test('two separate OS processes editing the same line never silently clobber each other; one wins and one fails cleanly', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cross-proc-conflict-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helperPath = await writeWorkerHelper(root);

  const sharedFile = path.join(root, 'conflict.txt');
  await fs.writeFile(sharedFile, 'line: original\n', 'utf8');

  const procA = fork(helperPath, ['pause-before-guard', root, 'conflict.txt', 'line: original', 'line: PROC_A']);
  t.after(() => { if (procA.exitCode === null) procA.kill('SIGKILL'); });
  await waitForMessage(procA, msg => msg.type === 'at-guard');

  const procB = fork(helperPath, ['direct', root, 'conflict.txt', 'line: original', 'line: PROC_B']);
  t.after(() => { if (procB.exitCode === null) procB.kill('SIGKILL'); });
  const outcomeBPromise = waitForMessage(procB, msg => msg.type === 'ok' || msg.type === 'err');

  await new Promise(r => setTimeout(r, 80));
  procA.send({ type: 'resume' });

  const [outcomeA, outcomeB] = await Promise.all([
    waitForMessage(procA, msg => msg.type === 'ok' || msg.type === 'err'),
    outcomeBPromise,
  ]);
  assert.equal(outcomeA.type, 'ok');
  assert.equal(outcomeB.type, 'err');
  assert.match(outcomeB.message, /text was not found/);
  assert.equal(await fs.readFile(sharedFile, 'utf8'), 'line: PROC_A\n');
});

test('SIGKILL releases the kernel mutation lock and snapshot guards detect earlier external writes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cross-proc-kill-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helperPath = await writeWorkerHelper(root);

  const sharedFile = path.join(root, 'crash.txt');
  await fs.writeFile(sharedFile, 'state: initial\n', 'utf8');

  const crashed = fork(helperPath, ['hold-lock', root, sharedFile, '', '']);
  await waitForMessage(crashed, msg => msg.type === 'locked');
  crashed.kill('SIGKILL');
  await once(crashed, 'exit');

  await runEdit({
    pathMode: 'workspace',
    workspaceRoot: root,
    targets: [{ path: 'crash.txt', edits: [{ oldText: 'state: initial', newText: 'state: recovered' }] }],
  });
  assert.equal(await fs.readFile(sharedFile, 'utf8'), 'state: recovered\n');

  // Snapshot verification detects an external change made before the guard.
  // External writers do not participate in the advisory mutation locks.
  await assert.rejects(
    () => runEdit(
      {
        pathMode: 'workspace',
        workspaceRoot: root,
        targets: [{ path: 'crash.txt', edits: [{ oldText: 'state: recovered', newText: 'state: stale-edit' }] }],
      },
      undefined,
      {
        beforeGuard: async () => {
          await fs.writeFile(sharedFile, 'state: external-writer\n', 'utf8');
        },
      },
    ),
    /file changed since preflight/,
  );
  assert.equal(await fs.readFile(sharedFile, 'utf8'), 'state: external-writer\n');
});
