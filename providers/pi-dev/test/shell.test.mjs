import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneBashSpools, pruneJobSpools, runBash, runExec } from '../shell.mjs';
import { DEFAULT_MAX_OUTPUT_BYTES } from '../output-limits.mjs';

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

test('structured exec passes argv literally without shell interpretation', async () => {
  const workspaceRoot = await tempDir('pi-exec-root-');
  const result = await runExec({
    workspaceRoot,
    argv: [process.execPath, '-e', "console.log(process.argv.slice(1).map(value => `<${value}>`).join('|'))", 'a b', '$HOME', 'x;y'],
    maxOutputBytes: 1024 * 1024,
    stateDir: await tempDir('pi-exec-state-')
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.output.trim(), '<a b>|<$HOME>|<x;y>');
});

test('structured exec settles from parent exit without waiting for detached inherited stdio', async () => {
  const workspaceRoot = await tempDir('pi-exec-inherited-stdio-');
  const code = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'inherit' })",
    "console.log(`child=${child.pid}`)",
    'child.unref()',
    "console.log('parent-exit')"
  ].join('; ');
  const started = Date.now();
  const result = await runExec({
    workspaceRoot,
    argv: [process.execPath, '-e', code],
    timeout_seconds: 0.1,
    maxOutputBytes: 1024 * 1024,
    stateDir: await tempDir('pi-exec-inherited-stdio-state-')
  });
  const wallMs = Date.now() - started;
  const childPid = Number(result.output.match(/child=(\d+)/)?.[1]);
  try {
    assert.equal(result.timed_out, false);
    assert.equal(result.exit_code, 0);
    assert.match(result.output, /parent-exit/);
    assert.ok(wallMs < 1000, `exec waited ${wallMs}ms for inherited stdio`);
  } finally {
    if (Number.isSafeInteger(childPid) && childPid > 0) {
      try { process.kill(-childPid, 'SIGKILL'); } catch {}
    }
  }
});

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

test('detached exec returns at once and records output and exit code', async () => {
  const workspaceRoot = await tempDir('pi-exec-detach-root-');
  const stateDir = await tempDir('pi-exec-detach-state-');
  const started = Date.now();
  const result = await runExec({
    workspaceRoot,
    argv: [process.execPath, '-e', "setTimeout(() => { console.log('out', process.argv[1]); console.error('err'); process.exit(3) }, 300)", 'a b'],
    detach: true,
    stateDir,
  });
  assert.ok(Date.now() - started < 250);
  assert.equal(path.dirname(result.log_path), path.join(stateDir, 'jobs'));
  assert.ok(Number.isSafeInteger(result.pid));
  await waitFor(async () => fs.access(result.exit_path).then(() => true, () => false), 5000);
  assert.equal(await fs.readFile(result.exit_path, 'utf8'), '3\n');
  assert.equal(await fs.readFile(result.log_path, 'utf8'), 'out a b\nerr\n');
});

test('detached Bash executes shell syntax, records its exit, and rejects a timeout', async () => {
  const workspaceRoot = await tempDir('pi-bash-detach-root-');
  const stateDir = await tempDir('pi-bash-detach-state-');
  await assert.rejects(
    runBash({ workspaceRoot, stateDir, command: 'true', detach: true, timeout_seconds: 5 }),
    /timeout_seconds does not apply/,
  );
  const result = await runBash({
    workspaceRoot, stateDir, detach: true,
    command: 'printf "%s\\n" "a b" | tr a-z A-Z; exit 3',
  });
  assert.ok(Number.isSafeInteger(result.pid));
  assert.equal(result.cwd, workspaceRoot);
  assert.equal(path.dirname(result.log_path), path.join(stateDir, 'jobs'));
  await waitFor(async () => fs.access(result.exit_path).then(() => true, () => false), 5000);
  assert.equal(await fs.readFile(result.log_path, 'utf8'), 'A B\n');
  assert.equal(await fs.readFile(result.exit_path, 'utf8'), '3\n');
});

test('detached exec reports a missing executable through the exit file', async () => {
  const result = await runExec({
    workspaceRoot: await tempDir('pi-exec-detach-missing-'),
    argv: ['definitely-not-a-command-xyz'],
    detach: true,
    stateDir: await tempDir('pi-exec-detach-missing-state-'),
  });
  await waitFor(async () => fs.access(result.exit_path).then(() => true, () => false));
  assert.equal(await fs.readFile(result.exit_path, 'utf8'), '127\n');
});

test('detached exec rejects timeout_seconds and prunes expired finished jobs', async () => {
  const workspaceRoot = await tempDir('pi-exec-detach-prune-');
  const stateDir = await tempDir('pi-exec-detach-prune-state-');
  await assert.rejects(
    runExec({ workspaceRoot, argv: ['true'], detach: true, timeout_seconds: 5, stateDir }),
    /timeout_seconds does not apply/,
  );
  const jobsDir = path.join(stateDir, 'jobs');
  await fs.mkdir(jobsDir, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  for (const name of ['old.log', 'old.exit', 'running.log']) {
    await fs.writeFile(path.join(jobsDir, name), '0\n');
    await fs.utimes(path.join(jobsDir, name), old, old);
  }
  const result = await runExec({ workspaceRoot, argv: ['true'], detach: true, spoolTtlSeconds: 60, stateDir });
  const names = await fs.readdir(jobsDir);
  assert.ok(!names.includes('old.log') && !names.includes('old.exit'));
  assert.ok(names.includes('running.log'));
  assert.ok(names.includes(path.basename(result.log_path)));
});

test('bounded capture keeps the head and the tail of long output within the byte cap', async () => {
  const workspaceRoot = await tempDir('pi-bash-head-tail-root-');
  const stateDir = await tempDir('pi-bash-head-tail-state-');
  const result = await runBash({
    workspaceRoot,
    command: `node -e "process.stdout.write('START_MARKER' + 'x'.repeat(4900) + 'END_MARKER')"`,
    maxOutputBytes: 1024,
    stateDir
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.output_bytes, 4922);
  assert.ok(result.output.startsWith('START_MARKER'));
  assert.ok(result.output.endsWith('END_MARKER'));
  assert.match(result.output, /\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/);
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= 1024);
  assert.equal(result.output.includes('\uFFFD'), false);
  assert.ok(result.full_output_path);
  assert.equal((await fs.readFile(result.full_output_path)).length, 4922);
});

test('bounded head plus tail keeps multibyte characters whole at both cut points', async () => {
  const workspaceRoot = await tempDir('pi-bash-head-tail-utf8-root-');
  const stateDir = await tempDir('pi-bash-head-tail-utf8-state-');
  const result = await runBash({
    workspaceRoot,
    command: `node -e "process.stdout.write('é'.repeat(2000))"`,
    maxOutputBytes: 300,
    stateDir
  });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= 300);
  assert.equal(result.output.includes('\uFFFD'), false);
  assert.match(result.output, /\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/);
  assert.ok(result.output.length > 0);
});

test('default output cap keeps one result small while the full output stays retrievable', async () => {
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 16 * 1024);
  const total = 200_000;
  const result = await runExec({
    workspaceRoot: await tempDir('pi-exec-default-cap-root-'),
    argv: [process.execPath, '-e', `process.stdout.write('x'.repeat(${total}))`],
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    stateDir: await tempDir('pi-exec-default-cap-state-')
  });
  assert.equal(result.truncated, true);
  assert.equal(result.output_bytes, total);
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= DEFAULT_MAX_OUTPUT_BYTES);
  assert.match(result.output, /bytes omitted/);
  assert.equal((await fs.stat(result.full_output_path)).size, total);
});

test('fast command with softTimeoutSeconds completes inline with promoted: false', async () => {
  const workspaceRoot = await tempDir('pi-soft-fast-root-');
  const stateDir = await tempDir('pi-soft-fast-state-');
  const result = await runExec({
    workspaceRoot,
    argv: [process.execPath, '-e', "console.log('quick')"],
    softTimeoutSeconds: 5,
    maxOutputBytes: 1024 * 1024,
    stateDir,
  });
  assert.equal(result.promoted, false);
  assert.equal(result.exit_code, 0);
  assert.equal(result.output.trim(), 'quick');
});

test('slow command with softTimeoutSeconds auto-promotes to background job and completes exit_path', async () => {
  const workspaceRoot = await tempDir('pi-soft-promote-root-');
  const stateDir = await tempDir('pi-soft-promote-state-');
  const started = Date.now();
  const result = await runBash({
    workspaceRoot,
    command: 'printf "step1\\n"; sleep 0.8; printf "done\\n"',
    softTimeoutSeconds: 0.3,
    timeout_seconds: 10,
    maxOutputBytes: 1024 * 1024,
    stateDir,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 700, `expected early promotion, took ${elapsed}ms`);
  assert.equal(result.promoted, true);
  assert.equal(result.timed_out, false);
  assert.ok(typeof result.job_id === 'string' && result.job_id.length > 0);
  assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0);
  assert.equal(path.dirname(result.log_path), path.join(stateDir, 'jobs'));
  assert.equal(path.dirname(result.exit_path), path.join(stateDir, 'jobs'));
  assert.equal(result.hard_timeout_seconds, 10);
  assert.equal(result.soft_timeout_seconds, 0.3);
  assert.match(result.output, /step1/);

  await waitFor(async () => fs.access(result.exit_path).then(() => true, () => false), 5000);
  assert.equal(await fs.readFile(result.exit_path, 'utf8'), '0\n');
  const fullLog = await fs.readFile(result.log_path, 'utf8');
  assert.match(fullLog, /step1\ndone\n/);
});

test('runaway promoted command hard-kills process group at timeout_seconds and writes 124 to exit_path', async () => {
  const workspaceRoot = await tempDir('pi-soft-runaway-root-');
  const stateDir = await tempDir('pi-soft-runaway-state-');
  const pidFile = path.join(workspaceRoot, 'bg.pid');
  const result = await runBash({
    workspaceRoot,
    command: `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`,
    softTimeoutSeconds: 0.25,
    timeout_seconds: 0.9,
    maxOutputBytes: 1024 * 1024,
    stateDir,
  });
  assert.equal(result.promoted, true);
  await waitFor(async () => fs.access(pidFile).then(() => true, () => false), 2000);
  const childPid = Number((await fs.readFile(pidFile, 'utf8')).trim());

  await waitFor(async () => fs.access(result.exit_path).then(() => true, () => false), 5000);
  assert.equal(await fs.readFile(result.exit_path, 'utf8'), '124\n');
  const logText = await fs.readFile(result.log_path, 'utf8');
  assert.match(logText, /\[hard timeout after 0\.9s\]/);
  await waitForDeath(childPid);
});

test('explicit timeout_seconds <= softTimeoutSeconds enforces strict hard timeout without promotion', async () => {
  const workspaceRoot = await tempDir('pi-soft-strict-root-');
  const stateDir = await tempDir('pi-soft-strict-state-');
  const result = await runExec({
    workspaceRoot,
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
    timeout_seconds: 0.35,
    softTimeoutSeconds: 5,
    maxOutputBytes: 1024 * 1024,
    stateDir,
  });
  assert.equal(result.promoted, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.exit_code, null);
});

test('promotion setup failure kills child before returning error so it cannot mutate afterward', async t => {
  const workspaceRoot = await tempDir('pi-promote-fail-root-');
  const stateDir = await tempDir('pi-promote-fail-state-');
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  // Pre-create jobs path as a regular file so mkdirSync(jobsDir) fails during promotion.
  await fs.writeFile(path.join(stateDir, 'jobs'), 'blocker');
  const pidFile = path.join(workspaceRoot, 'cmd.pid');
  const marker = path.join(workspaceRoot, 'late-write.txt');

  await assert.rejects(() => runBash({
    workspaceRoot,
    command: `echo $$ > ${JSON.stringify(pidFile)} && sleep 0.5 && echo mutated > ${JSON.stringify(marker)}`,
    softTimeoutSeconds: 0.15,
    timeout_seconds: 5,
    maxOutputBytes: 1024 * 1024,
    stateDir,
  }));

  const childPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  await waitForDeath(childPid);
  await assert.rejects(() => fs.access(marker), { code: 'ENOENT' });
});

test('configured runtime lease acquisition failure rejects promotion and kills child', async t => {
  const workspaceRoot = await tempDir('pi-lease-fail-root-');
  const stateDir = await tempDir('pi-lease-fail-state-');
  const badLeaseDir = path.join(stateDir, 'lease-file-blocker');
  await fs.writeFile(badLeaseDir, 'not-a-directory');
  const prevLeaseDir = process.env.MCP_LIFECYCLE_LEASE_DIR;
  process.env.MCP_LIFECYCLE_LEASE_DIR = badLeaseDir;
  t.after(async () => {
    if (prevLeaseDir === undefined) delete process.env.MCP_LIFECYCLE_LEASE_DIR;
    else process.env.MCP_LIFECYCLE_LEASE_DIR = prevLeaseDir;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const pidFile = path.join(workspaceRoot, 'cmd.pid');
  const marker = path.join(workspaceRoot, 'late-lease-write.txt');
  await assert.rejects(() => runBash({
    workspaceRoot,
    command: `echo $$ > ${JSON.stringify(pidFile)} && sleep 0.5 && echo mutated > ${JSON.stringify(marker)}`,
    softTimeoutSeconds: 0.15,
    timeout_seconds: 5,
    maxOutputBytes: 1024 * 1024,
    stateDir,
  }));

  const childPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  await waitForDeath(childPid);
  await assert.rejects(() => fs.access(marker), { code: 'ENOENT' });
});

test('large RPC budgets schedule promotion before the hard timeout', async t => {
  const workspaceRoot = await tempDir('pi-large-budget-root-');
  const stateDir = await tempDir('pi-large-budget-state-');
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const schedule = t.mock.method(globalThis, 'setTimeout');
  for (const { options, timers } of [
    { options: { rpcBudgetMs: 123_000 }, timers: [150_000, 120_000] },
    { options: { rpcBudgetMs: 300_000 }, timers: [300_000, 297_000] },
    { options: { softTimeoutSeconds: 300 }, timers: [300_000] },
  ]) {
    schedule.mock.resetCalls();
    const result = await runExec({
      ...options,
      workspaceRoot,
      argv: [process.execPath, '--version'],
      maxOutputBytes: 1024,
      stateDir,
    });
    assert.equal(result.exit_code, 0);
    assert.deepEqual(
      schedule.mock.calls.map(call => call.arguments[1]).filter(delay => delay >= 1000),
      timers,
    );
  }
});

test('short accepted rpcBudgetMs (5000ms) derives softTimeoutSeconds=2 leaving room for completion and return', async t => {
  const workspaceRoot = await tempDir('pi-short-budget-root-');
  const stateDir = await tempDir('pi-short-budget-state-');
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const started = Date.now();
  const result = await runBash({
    workspaceRoot,
    command: 'sleep 10',
    rpcBudgetMs: 5_000,
    maxOutputBytes: 1024 * 1024,
    stateDir,
  });
  const elapsedMs = Date.now() - started;
  assert.equal(result.promoted, true);
  assert.equal(result.soft_timeout_seconds, 2);
  assert.ok(elapsedMs < 3_500, `expected promotion well within 5000ms budget, took ${elapsedMs}ms`);
});

test('spool GC prunes expired finished jobs, stale .exit.tmp, and pre-boot or quiet orphan job logs while keeping active post-boot logs', async t => {
  const stateDir = await tempDir('pi-jobs-gc-');
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const jobsDir = path.join(stateDir, 'jobs');
  await fs.mkdir(jobsDir, { recursive: true });
  const nowMs = Date.now();
  const bootTimeMs = nowMs - 2 * 3600_000; // 2h ago

  const writeAged = async (name, content, ageMs) => {
    const file = path.join(jobsDir, name);
    await fs.writeFile(file, content);
    const ts = new Date(nowMs - ageMs);
    await fs.utimes(file, ts, ts);
    return file;
  };

  // Expired finished job (> 1h TTL) -> deleted
  const expLog = await writeAged('finished-old.log', 'old out', 7200_000);
  const expExit = await writeAged('finished-old.exit', '0\n', 7200_000);
  // Fresh finished job (< 1h TTL) -> kept
  const freshLog = await writeAged('finished-fresh.log', 'fresh out', 600_000);
  const freshExit = await writeAged('finished-fresh.exit', '0\n', 600_000);
  // Stale .exit.tmp (> 1h TTL) -> deleted
  const staleTmp = await writeAged('stale.exit.tmp', '0\n', 7200_000);
  // Orphan .log predating boot (3h old, > 1h TTL, < bootTimeMs) -> deleted
  const preBootOrphan = await writeAged('pre-boot-orphan.log', 'dead server', 3 * 3600_000);
  // Post-boot running .log (90m old: > 1h TTL, > bootTimeMs, < 24h orphanMinTtl) -> kept
  const liveServerLog = await writeAged('live-server.log', 'serving', 90 * 60_000);
  // Very old orphan (> 24h) even if bootTimeMs were earlier -> deleted
  const ancientOrphan = await writeAged('ancient-orphan.log', 'ancient', 30 * 3600_000);

  const direct = await pruneJobSpools({
    jobsDir,
    ttlSeconds: 3600,
    bootTimeMs,
    nowMs,
  });
  assert.equal(direct.deletedFiles, 5);
  for (const gone of [expLog, expExit, staleTmp, preBootOrphan, ancientOrphan]) {
    await assert.rejects(() => fs.stat(gone), { code: 'ENOENT' });
  }
  for (const kept of [freshLog, freshExit, liveServerLog]) {
    assert.equal((await fs.stat(kept)).isFile(), true);
  }

  // Also verify pruneBashSpools delegates into stateDir/jobs.
  const viaTop = await writeAged('via-top.exit', '0\n', 8 * 86400_000);
  const viaTopLog = await writeAged('via-top.log', 'body', 8 * 86400_000);
  const gc = await pruneBashSpools({
    stateDir,
    maxSpoolBytes: 2048,
    ttlSeconds: 7 * 86400,
    maxTotalBytes: 8192,
    nowMs,
  });
  assert.equal(gc.deletedJobFiles, 2);
  await assert.rejects(() => fs.stat(viaTop), { code: 'ENOENT' });
  await assert.rejects(() => fs.stat(viaTopLog), { code: 'ENOENT' });
});
