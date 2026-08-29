import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneBashSpools, runBash } from '../shell.mjs';

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

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('condition did not become true before timeout');
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

test('user Bash defaults to stable cwd and accepts relative or absolute cwd', async () => {
  const defaultCwd = await tempDir('pi-user-bash-');
  await fs.mkdir(path.join(defaultCwd, 'repo'));
  const stateDir = await tempDir('pi-user-bash-state-');

  const base = await runBash({
    pathMode: 'user',
    defaultCwd,
    command: 'pwd',
    maxOutputBytes: 1024 * 1024,
    stateDir
  });
  assert.equal(base.cwd, await fs.realpath(defaultCwd));
  assert.equal(base.output.trim(), await fs.realpath(defaultCwd));

  const relative = await runBash({
    pathMode: 'user',
    defaultCwd,
    cwd: 'repo',
    command: 'pwd',
    maxOutputBytes: 1024 * 1024,
    stateDir
  });
  assert.equal(relative.cwd, await fs.realpath(path.join(defaultCwd, 'repo')));

  const absolute = await runBash({
    pathMode: 'user',
    defaultCwd,
    cwd: '/tmp',
    command: 'pwd',
    maxOutputBytes: 1024 * 1024,
    stateDir
  });
  assert.equal(absolute.cwd, await fs.realpath('/tmp'));
});

test('user Bash does not persist cd state across one-shot calls', async () => {
  const defaultCwd = await tempDir('pi-user-bash-immutable-');
  await fs.mkdir(path.join(defaultCwd, 'repo'));
  const stateDir = await tempDir('pi-user-bash-immutable-state-');

  const changedInsideCall = await runBash({
    pathMode: 'user',
    defaultCwd,
    command: 'cd repo && pwd',
    maxOutputBytes: 1024 * 1024,
    stateDir
  });
  assert.equal(changedInsideCall.output.trim(), await fs.realpath(path.join(defaultCwd, 'repo')));

  const nextCall = await runBash({
    pathMode: 'user',
    defaultCwd,
    command: 'pwd',
    maxOutputBytes: 1024 * 1024,
    stateDir
  });
  assert.equal(nextCall.cwd, await fs.realpath(defaultCwd));
  assert.equal(nextCall.output.trim(), await fs.realpath(defaultCwd));
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

test('retained Bash spool is capped while total output accounting remains exact', async () => {
  const workspaceRoot = await tempDir('pi-bash-spool-root-');
  const stateDir = await tempDir('pi-bash-spool-state-');
  const result = await runBash({
    workspaceRoot,
    command: `node -e "process.stdout.write('x'.repeat(5000))"`,
    maxOutputBytes: 1024,
    maxSpoolBytes: 2048,
    stateDir
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.output_bytes, 5000);
  assert.equal(result.truncated, true);
  assert.equal(result.spool_truncated, true);
  assert.ok(Buffer.byteLength(result.output) <= 1024);
  assert.ok(result.full_output_path);
  assert.equal((await fs.stat(result.full_output_path)).size, 2048);
});

test('active Bash spools stay outside GC until the command finalizes', async () => {
  const workspaceRoot = await tempDir('pi-bash-active-root-');
  const stateDir = await tempDir('pi-bash-active-state-');
  const running = runBash({
    workspaceRoot,
    command: `node -e "process.stdout.write('x'.repeat(5000)); setTimeout(() => {}, 250)"`,
    timeout_seconds: 2,
    maxOutputBytes: 1024,
    maxSpoolBytes: 2048,
    spoolTtlSeconds: 3600,
    maxSpoolTotalBytes: 4096,
    stateDir,
  });

  await waitFor(async () => (await fs.readdir(stateDir)).some(name => name.endsWith('.log.active')));
  const activeName = (await fs.readdir(stateDir)).find(name => name.endsWith('.log.active'));
  const activePath = path.join(stateDir, activeName);
  await pruneBashSpools({
    stateDir,
    maxSpoolBytes: 2048,
    ttlSeconds: 1,
    maxTotalBytes: 2048,
    nowMs: Date.now() + 3600_000,
  });
  assert.equal((await fs.stat(activePath)).isFile(), true);

  const result = await running;
  assert.equal(result.exit_code, 0);
  assert.match(result.full_output_path, /\.log$/);
  await assert.rejects(() => fs.stat(activePath), { code: 'ENOENT' });
  assert.equal((await fs.stat(result.full_output_path)).size, 2048);
});

test('ordinary Bash commands opportunistically prune expired finalized spools', async () => {
  const workspaceRoot = await tempDir('pi-bash-gc-ordinary-root-');
  const stateDir = await tempDir('pi-bash-gc-ordinary-state-');
  const expired = path.join(stateDir, 'bash-expired.log');
  await fs.writeFile(expired, Buffer.alloc(2048));
  const old = new Date(Date.now() - 7200_000);
  await fs.utimes(expired, old, old);

  const result = await runBash({
    workspaceRoot,
    command: `printf 'small\n'`,
    maxOutputBytes: 1024,
    maxSpoolBytes: 2048,
    spoolTtlSeconds: 3600,
    maxSpoolTotalBytes: 4096,
    stateDir,
  });

  assert.equal(result.truncated, false);
  await assert.rejects(() => fs.stat(expired), { code: 'ENOENT' });
});

test('runBash enforces the aggregate finalized spool budget after each command', async () => {
  const workspaceRoot = await tempDir('pi-bash-budget-root-');
  const stateDir = await tempDir('pi-bash-budget-state-');
  for (let i = 0; i < 3; i += 1) {
    const result = await runBash({
      workspaceRoot,
      command: `node -e "process.stdout.write('${'x'.repeat(3000)}')"`,
      maxOutputBytes: 1024,
      maxSpoolBytes: 2048,
      spoolTtlSeconds: 3600,
      maxSpoolTotalBytes: 4096,
      stateDir,
    });
    assert.equal(result.truncated, true);
  }
  const finalized = (await fs.readdir(stateDir)).filter(name => /^bash-.*\.log$/.test(name));
  const sizes = await Promise.all(finalized.map(async name => (await fs.stat(path.join(stateDir, name))).size));
  assert.equal(finalized.length, 2);
  assert.equal(sizes.reduce((sum, size) => sum + size, 0), 4096);
});

test('runBash does not evict its own retained spool before returning the path', async () => {
  const workspaceRoot = await tempDir('pi-bash-returned-spool-root-');
  const stateDir = await tempDir('pi-bash-returned-spool-state-');
  const existing = path.join(stateDir, 'bash-existing-newer.log');
  await fs.writeFile(existing, Buffer.alloc(2048));
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(existing, future, future);

  const result = await runBash({
    workspaceRoot,
    command: `node -e "process.stdout.write('${'x'.repeat(3000)}')"`,
    maxOutputBytes: 1024,
    maxSpoolBytes: 2048,
    spoolTtlSeconds: 3600,
    maxSpoolTotalBytes: 2048,
    stateDir,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.full_output_path);
  assert.equal((await fs.stat(result.full_output_path)).size, 2048);
  await assert.rejects(() => fs.stat(existing), { code: 'ENOENT' });
});

test('concurrent truncated Bash commands converge to the aggregate finalized spool budget', async () => {
  const workspaceRoot = await tempDir('pi-bash-concurrent-budget-root-');
  const stateDir = await tempDir('pi-bash-concurrent-budget-state-');
  const results = await Promise.all(Array.from({ length: 8 }, () => runBash({
    workspaceRoot,
    command: `node -e "process.stdout.write('${'x'.repeat(3000)}')"`,
    maxOutputBytes: 1024,
    maxSpoolBytes: 2048,
    spoolTtlSeconds: 3600,
    maxSpoolTotalBytes: 4096,
    stateDir,
  })));
  assert.ok(results.every(result => result.truncated));
  const entries = await fs.readdir(stateDir);
  assert.equal(entries.some(name => name.endsWith('.log.active')), false);
  const finalized = entries.filter(name => /^bash-.*\.log$/.test(name));
  const sizes = await Promise.all(finalized.map(async name => (await fs.stat(path.join(stateDir, name))).size));
  assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= 4096);
});

test('spool GC removes expired finalized files while preserving live active spools', async () => {
  const stateDir = await tempDir('pi-bash-spool-gc-ttl-');
  const nowMs = Date.now();
  const expired = path.join(stateDir, 'bash-expired.log');
  const fresh = path.join(stateDir, 'bash-fresh.log');
  const active = path.join(stateDir, `bash-${nowMs}-${process.pid}-live.log.active`);
  await fs.writeFile(expired, Buffer.alloc(1024));
  await fs.writeFile(fresh, Buffer.alloc(1024));
  await fs.writeFile(active, Buffer.alloc(4096));
  await fs.utimes(expired, new Date(nowMs - 7200_000), new Date(nowMs - 7200_000));
  await fs.utimes(fresh, new Date(nowMs - 1000), new Date(nowMs - 1000));
  await fs.utimes(active, new Date(nowMs - 1000), new Date(nowMs - 1000));

  const result = await pruneBashSpools({
    stateDir,
    maxSpoolBytes: 2048,
    ttlSeconds: 3600,
    maxTotalBytes: 8192,
    nowMs,
  });

  await assert.rejects(() => fs.stat(expired), { code: 'ENOENT' });
  assert.equal((await fs.stat(fresh)).size, 1024);
  assert.equal((await fs.stat(active)).size, 4096);
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.retainedBytes, 1024);
});

test('spool GC removes abandoned active spools from dead provider processes', async () => {
  const stateDir = await tempDir('pi-bash-spool-gc-active-');
  const nowMs = Date.now();
  const stalePid = 999999999;
  const abandoned = path.join(stateDir, `bash-${nowMs - 1000}-${stalePid}-abandoned.log.active`);
  await fs.writeFile(abandoned, Buffer.alloc(4096));

  const result = await pruneBashSpools({
    stateDir,
    maxSpoolBytes: 2048,
    ttlSeconds: 3600,
    maxTotalBytes: 8192,
    nowMs,
  });

  await assert.rejects(() => fs.stat(abandoned), { code: 'ENOENT' });
  assert.equal(result.deletedActiveFiles, 1);
  assert.equal(result.deletedActiveBytes, 4096);
});

test('spool GC reclaims active names older than the maximum command lifetime even if the PID was reused', async () => {
  const stateDir = await tempDir('pi-bash-spool-gc-reused-pid-');
  const nowMs = Date.now();
  const abandoned = path.join(stateDir, `bash-${nowMs - 400_000}-${process.pid}-reused.log.active`);
  await fs.writeFile(abandoned, Buffer.alloc(2048));

  const result = await pruneBashSpools({
    stateDir,
    maxSpoolBytes: 2048,
    ttlSeconds: 3600,
    maxTotalBytes: 8192,
    nowMs,
  });

  await assert.rejects(() => fs.stat(abandoned), { code: 'ENOENT' });
  assert.equal(result.deletedActiveFiles, 1);
});

test('spool GC caps oversized legacy files and evicts oldest finalized spools to the total budget', async () => {
  const stateDir = await tempDir('pi-bash-spool-gc-budget-');
  const nowMs = Date.now();
  const oldest = path.join(stateDir, 'bash-oldest.log');
  const middle = path.join(stateDir, 'bash-middle.log');
  const newest = path.join(stateDir, 'bash-newest.log');
  await fs.writeFile(oldest, Buffer.alloc(3000));
  await fs.writeFile(middle, Buffer.alloc(2000));
  await fs.writeFile(newest, Buffer.alloc(2000));
  await fs.utimes(oldest, new Date(nowMs - 3000), new Date(nowMs - 3000));
  await fs.utimes(middle, new Date(nowMs - 2000), new Date(nowMs - 2000));
  await fs.utimes(newest, new Date(nowMs - 1000), new Date(nowMs - 1000));

  const result = await pruneBashSpools({
    stateDir,
    maxSpoolBytes: 2048,
    ttlSeconds: 3600,
    maxTotalBytes: 4096,
    nowMs,
  });

  await assert.rejects(() => fs.stat(oldest), { code: 'ENOENT' });
  assert.equal((await fs.stat(middle)).size, 2000);
  assert.equal((await fs.stat(newest)).size, 2000);
  assert.equal(result.truncatedFiles, 1);
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.retainedBytes, 4000);
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
