import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBash } from '../shell.mjs';

const tempDir = prefix => fs.mkdtemp(path.join(os.tmpdir(), prefix));

async function waitForDeath(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} is still alive`);
}

test('native compound command runs from immutable workspace root by default', async () => {
  const workspaceRoot = await tempDir('pi-bash-root-');
  await fs.writeFile(path.join(workspaceRoot, 'id'), 'ROOT\n');
  const result = await runBash({
    workspaceRoot,
    command: "cat id && printf 'one\\ntwo\\n' | tail -1",
    maxOutputBytes: 1024 * 1024,
    stateDir: await tempDir('pi-bash-state-')
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.cwd, await fs.realpath(workspaceRoot));
  assert.match(result.output, /ROOT/);
  assert.match(result.output, /two/);
});

test('relative cwd selects a directory below workspace', async () => {
  const workspaceRoot = await tempDir('pi-bash-cwd-');
  await fs.mkdir(path.join(workspaceRoot, 'repo'));
  await fs.writeFile(path.join(workspaceRoot, 'repo', 'id'), 'REPO\n');
  const result = await runBash({
    workspaceRoot,
    cwd: 'repo',
    command: 'cat id',
    maxOutputBytes: 1024 * 1024,
    stateDir: await tempDir('pi-bash-cwd-state-')
  });
  assert.equal(result.cwd, await fs.realpath(path.join(workspaceRoot, 'repo')));
  assert.match(result.output, /REPO/);
});

test('normal non-zero exit is returned as data', async () => {
  const workspaceRoot = await tempDir('pi-bash-exit-');
  const result = await runBash({
    workspaceRoot,
    command: "printf 'no-match\\n'; exit 7",
    maxOutputBytes: 1024 * 1024,
    stateDir: await tempDir('pi-bash-exit-state-')
  });
  assert.equal(result.exit_code, 7);
  assert.equal(result.timed_out, false);
  assert.equal(result.cancelled, false);
  assert.match(result.output, /no-match/);
});

test('timeout kills a background descendant', async () => {
  const workspaceRoot = await tempDir('pi-bash-timeout-');
  const pidFile = path.join(workspaceRoot, 'child.pid');
  const result = await runBash({
    workspaceRoot,
    command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
    timeout_seconds: 0.2,
    maxOutputBytes: 1024 * 1024,
    stateDir: await tempDir('pi-bash-timeout-state-')
  });
  assert.equal(result.timed_out, true);
  assert.equal(result.exit_code, null);
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  await waitForDeath(pid);
});

test('AbortSignal cancels and kills descendants', async () => {
  const workspaceRoot = await tempDir('pi-bash-cancel-');
  const pidFile = path.join(workspaceRoot, 'child.pid');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const result = await runBash({
    workspaceRoot,
    command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
    timeout_seconds: 30,
    maxOutputBytes: 1024 * 1024,
    stateDir: await tempDir('pi-bash-cancel-state-')
  }, controller.signal);
  assert.equal(result.cancelled, true);
  assert.equal(result.exit_code, null);
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  await waitForDeath(pid);
});

test('large output is bounded and full output is retained', async () => {
  const workspaceRoot = await tempDir('pi-bash-output-');
  const stateDir = await tempDir('pi-bash-output-state-');
  const result = await runBash({
    workspaceRoot,
    command: `node -e "process.stdout.write('x'.repeat(5000))"`,
    maxOutputBytes: 1024,
    stateDir
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output) <= 1024);
  assert.ok(result.full_output_path);
  assert.equal((await fs.readFile(result.full_output_path)).length, 5000);
  assert.equal(result.output_bytes, 5000);
});

test('timeout policy rejects values above 300 seconds', async () => {
  const workspaceRoot = await tempDir('pi-bash-limit-');
  const stateDir = await tempDir('pi-bash-limit-state-');
  await assert.rejects(() => runBash({
    workspaceRoot,
    command: 'true',
    timeout_seconds: 301,
    maxOutputBytes: 1024 * 1024,
    stateDir
  }), /300/);
});

test('truncated multibyte output remains valid UTF-8 within the byte limit', async () => {
  const workspaceRoot = await tempDir('pi-bash-utf8-root-');
  const stateDir = await tempDir('pi-bash-utf8-state-');
  const result = await runBash({
    workspaceRoot,
    command: `node -e "process.stdout.write('αβγδε')"`,
    maxOutputBytes: 5,
    stateDir
  });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= 5);
  assert.doesNotMatch(result.output, /�/);
  assert.equal(result.output, 'δε');
});
