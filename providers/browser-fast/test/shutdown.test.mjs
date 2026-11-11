import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ManagedCloakBrowserRuntime } from '../cloakbrowser-runtime.mjs';
import { AgentBrowserRunner } from '../server.mjs';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitPidFile(file) {
  for (let i = 0; i < 200; i += 1) {
    try {
      const pid = Number((await fs.readFile(file, 'utf8')).trim());
      if (pid > 0) return pid;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for pid file ${file}`);
}

async function waitReaped(pids, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pids.filter(pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (alive.length === 0) return;
    await sleep(25);
  }
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), err => err.code === 'ESRCH', `process ${pid} leaked`);
  }
}

test('AgentBrowserRunner.close reaps in-flight spawned child processes with zero orphans', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-fast-reap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'wslpath.pid');
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const slowCmd = path.join(binDir, 'wslpath');
  await fs.writeFile(
    slowCmd,
    `#!/bin/sh
echo $$ > ${JSON.stringify(pidFile)}
exec sleep 30
`,
    { mode: 0o755 },
  );

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });

  const runner = new AgentBrowserRunner({ cloakbrowserRuntime: { close: async () => {} } });
  const pending = runner.pathForTarget('windows', '/tmp/example.png').catch(() => null);
  const childPid = await waitPidFile(pidFile);
  await runner.close();
  await pending;
  await waitReaped([childPid]);
});

test('closing one runner reaps its subprocess tree without stopping a separate provider', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-fast-tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parentFile = path.join(root, 'parent.pid');
  const descendantFile = path.join(root, 'descendant.pid');
  const helper = path.join(root, 'wslpath');
  await fs.writeFile(helper, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.on('SIGTERM', () => { child.once('exit', () => process.exit(0)); });
child.once('spawn', () => {
  writeFileSync(${JSON.stringify(parentFile)}, String(process.pid));
  writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid));
});
`, { mode: 0o755 });
  const separate = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(separate, 'spawn');
  t.after(async () => {
    if (separate.exitCode !== null || separate.signalCode !== null) return;
    const exited = once(separate, 'exit');
    separate.kill('SIGTERM');
    await exited;
  });
  const oldPath = process.env.PATH;
  process.env.PATH = `${root}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const runner = new AgentBrowserRunner({ cloakbrowserRuntime: { close: async () => {} } });
  const pending = runner.pathForTarget('windows', '/tmp/probe.png').catch(() => null);
  const parent = await waitPidFile(parentFile);
  const descendant = await waitPidFile(descendantFile);
  t.after(() => { for (const pid of [parent, descendant]) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  await runner.close();
  await pending;
  await waitReaped([parent, descendant]);
  assert.equal(separate.exitCode, null);
  assert.equal(separate.signalCode, null);
});

test('ManagedCloakBrowserRuntime.close awaits in-flight startup launches and closes the resulting context', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloak-abort-start-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let contextClosed = false;
  let releaseLaunch;
  const launchGate = new Promise(resolve => { releaseLaunch = resolve; });
  let launchEnteredResolve;
  const launchEntered = new Promise(resolve => { launchEnteredResolve = resolve; });

  const runtime = new ManagedCloakBrowserRuntime({
    stateRoot: root,
    launch: async () => {
      launchEnteredResolve();
      await launchGate;
      return {
        on() {},
        browser: () => ({ isConnected: () => true }),
        close: async () => { contextClosed = true; },
      };
    },
  });

  const ensurePromise = runtime.ensure({
    browser: 'cloakbrowser',
    managed: true,
    profileName: 'work',
    profile: {},
  });
  await launchEntered;
  const closePromise = runtime.close();
  releaseLaunch();
  await assert.rejects(ensurePromise, /CLOAKBROWSER_RUNTIME_CLOSED/);
  await closePromise;
  assert.equal(contextClosed, true, 'late-resolving launch context was immediately closed');
  assert.equal(runtime.runtimes.size, 0);
});

for (const mode of ['eof', 'sigterm']) {
  test(`browser-fast stdio server exits cleanly on ${mode} with zero orphan child processes`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `browser-fast-${mode}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, MCP_BROWSER_DEFAULT_TARGET: 'linux' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocol-version': '2026-07-28' } },
    })}\n`);
    await once(child.stdout, 'data');

    if (mode === 'eof') child.stdin.end();
    else child.kill('SIGTERM');
    await once(child, 'exit');
    await waitReaped([pid]);
  });
}
