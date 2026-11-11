import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureTranscript } from '../transcript.mjs';
import { onceExit, waitFor } from './helpers.mjs';

async function writerSandbox(t, { panePid = '' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcript-writer-test-'));
  const calls = path.join(dir, 'calls');
  const dead = path.join(dir, 'dead');
  const fakeTmux = path.join(dir, 'tmux');
  await ensureTranscript(dir, { budgetBytes: 4 * 1024 * 1024 });
  await writeFile(fakeTmux, `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, 'probe\\n');
process.stdout.write(existsSync(${JSON.stringify(dead)}) ? '1\\n' : '0\\n');
`, { mode: 0o700 });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await onceExit(child);
    }
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir, calls, dead,
    start() {
      child = spawn(process.execPath, [
        path.resolve(import.meta.dirname, '../transcript-writer.mjs'),
        dir, String(4 * 1024 * 1024), fakeTmux, '', 'test', '%1', '/dev/null', panePid,
      ], { stdio: ['pipe', 'ignore', 'pipe'] });
      child.stdin.on('error', () => {});
      return child;
    },
    async lock() {
      await writeFile(path.join(dir, '.transcript.lock'), JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }));
    },
    async unlock() {
      await rm(path.join(dir, '.transcript.lock'));
    },
  };
}

test('dead-pane detection waits for a blocked append and drains buffered input through EOF', { timeout: 8000 }, async t => {
  const sandbox = await writerSandbox(t);
  const child = sandbox.start();
  await waitFor(async () => (await readFile(sandbox.calls, 'utf8')).includes('probe'), { description: 'writer ready' });
  await sandbox.lock();
  const output = Buffer.alloc(512 * 1024, 'x');
  child.stdin.write(output);
  await writeFile(sandbox.dead, 'dead');
  await delay(1100);
  assert.equal(child.exitCode, null, 'writer must wait for the transcript lock');
  await sandbox.unlock();
  child.stdin.end('final-marker\n');
  assert.equal(await onceExit(child), 0);
  assert.deepEqual(await readFile(path.join(sandbox.dir, 'transcript.bin')), Buffer.concat([output, Buffer.from('final-marker\n')]));
});

test('writer does not exit while transcript initialization waits for its lock', { timeout: 8000 }, async t => {
  const sandbox = await writerSandbox(t);
  await sandbox.lock();
  await writeFile(sandbox.dead, 'dead');
  const child = sandbox.start();
  child.stdin.write('startup-output\n');
  await delay(1100);
  assert.equal(child.exitCode, null);
  await sandbox.unlock();
  child.stdin.end();
  assert.equal(await onceExit(child), 0);
  assert.equal(await readFile(path.join(sandbox.dir, 'transcript.bin'), 'utf8'), 'startup-output\n');
});

test('live Linux pane polling starts no tmux clients', { skip: process.platform !== 'linux', timeout: 8000 }, async t => {
  const sandbox = await writerSandbox(t, { panePid: String(process.pid) });
  await writeFile(sandbox.dead, 'dead');
  const child = sandbox.start();
  await delay(1600);
  assert.equal(child.exitCode, null);
  await assert.rejects(readFile(sandbox.calls), { code: 'ENOENT' });
  child.stdin.end('live-output\n');
  assert.equal(await onceExit(child), 0);
  assert.equal(await readFile(path.join(sandbox.dir, 'transcript.bin'), 'utf8'), 'live-output\n');
});
