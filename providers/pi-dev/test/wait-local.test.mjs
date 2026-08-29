import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LocalWaitSources, parseProcStatStartTime } from '../wait-local.mjs';

function record(condition, baseline) {
  return { condition, baseline };
}

test('process_exit arms with proc start-time identity and matches after the process exits', async () => {
  const child = spawn('sleep', ['0.15'], { stdio: 'ignore' });
  const source = new LocalWaitSources({ defaultCwd: process.cwd() });
  const condition = { kind: 'process_exit', pid: child.pid };
  const armed = await source.arm(condition);
  assert.equal(armed.status, 'pending');
  assert.equal(armed.baseline.pid, child.pid);
  assert.match(armed.baseline.startTimeTicks, /^\d+$/);

  await once(child, 'exit');
  const result = await source.check(record(condition, armed.baseline));
  assert.equal(result.status, 'matched');
  assert.match(result.evidence, new RegExp(`pid=${child.pid}`));
});

test('process_exit is immediately matched when the PID is already absent at arm time', async () => {
  const source = new LocalWaitSources({ defaultCwd: process.cwd() });
  const condition = { kind: 'process_exit', pid: 99999999 };
  const armed = await source.arm(condition);
  assert.equal(armed.status, 'matched');
  assert.equal(armed.baseline.pid, 99999999);
  assert.equal(armed.baseline.startTimeTicks, null);
});

test('proc stat parser handles command names containing spaces and parentheses', () => {
  const line = '123 (worker name (nested)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20 21';
  assert.equal(parseProcStatStartTime(line), '424242');
});

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-dev-wait-local-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return port;
}

test('tcp_listen is pending while closed and matches once a local server listens', async (t) => {
  const source = new LocalWaitSources({ defaultCwd: process.cwd() });
  const port = await freePort();
  const condition = { kind: 'tcp_listen', host: '127.0.0.1', port };
  const armed = await source.arm(condition);
  assert.equal(armed.status, 'pending');
  assert.equal((await source.check(record(condition, armed.baseline))).status, 'pending');

  const server = net.createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const result = await source.check(record(condition, armed.baseline));
  assert.equal(result.status, 'matched');
  assert.match(result.evidence, new RegExp(`127\\.0\\.0\\.1:${port}`));
});

test('file_exists is pending while absent and matches after creation', async (t) => {
  const dir = await tempDir(t);
  const source = new LocalWaitSources({ defaultCwd: dir });
  const condition = { kind: 'file_exists', path: 'ready.flag' };
  const armed = await source.arm(condition);
  assert.equal(armed.status, 'pending');
  assert.equal(armed.baseline.path, path.join(dir, 'ready.flag'));
  assert.equal((await source.check(record(condition, armed.baseline))).status, 'pending');

  await fs.writeFile(path.join(dir, 'ready.flag'), 'ready\n');
  const result = await source.check(record(condition, armed.baseline));
  assert.equal(result.status, 'matched');
});

test('file_changed records an existing-file baseline and matches modification', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'watched.txt');
  await fs.writeFile(target, 'before\n');
  const source = new LocalWaitSources({ defaultCwd: dir });
  const condition = { kind: 'file_changed', path: 'watched.txt' };
  const armed = await source.arm(condition);
  assert.equal(armed.status, 'pending');
  assert.equal(armed.baseline.fingerprint.exists, true);
  assert.equal((await source.check(record(condition, armed.baseline))).status, 'pending');

  await fs.writeFile(target, 'after-after\n');
  const result = await source.check(record(condition, armed.baseline));
  assert.equal(result.status, 'matched');
});

test('file_changed records an absent baseline and matches creation', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'created.txt');
  const source = new LocalWaitSources({ defaultCwd: dir });
  const condition = { kind: 'file_changed', path: 'created.txt' };
  const armed = await source.arm(condition);
  assert.deepEqual(armed.baseline.fingerprint, { exists: false });
  assert.equal((await source.check(record(condition, armed.baseline))).status, 'pending');

  await fs.writeFile(target, 'created\n');
  const result = await source.check(record(condition, armed.baseline));
  assert.equal(result.status, 'matched');
});

test('timer after_seconds persists one target and matches only after it is reached', async () => {
  let now = Date.parse('2026-08-17T00:00:00Z');
  const source = new LocalWaitSources({ defaultCwd: process.cwd(), now: () => now });
  const condition = { kind: 'timer', after_seconds: 120 };
  const armed = await source.arm(condition);
  assert.equal(armed.status, 'pending');
  assert.equal(armed.baseline.targetAtMs, Date.parse('2026-08-17T00:02:00Z'));
  assert.equal(armed.baseline.targetIso, '2026-08-17T00:02:00.000Z');
  assert.equal((await source.check(record(condition, armed.baseline))).status, 'pending');

  now = Date.parse('2026-08-17T00:02:00Z');
  const matched = await source.check(record(condition, armed.baseline));
  assert.equal(matched.status, 'matched');
  assert.equal(matched.evidence, 'timer=2026-08-17T00:02:00.000Z reached');
});

test('timer at is absolute and an already-due target matches during arm', async () => {
  const now = Date.parse('2026-08-17T00:02:00Z');
  const source = new LocalWaitSources({ defaultCwd: process.cwd(), now: () => now });
  const condition = { kind: 'timer', at: '2026-08-17T05:31:59+05:30' };
  const armed = await source.arm(condition);
  assert.equal(armed.status, 'matched');
  assert.equal(armed.baseline.targetAtMs, Date.parse(condition.at));
  assert.equal(armed.baseline.targetIso, '2026-08-17T00:01:59.000Z');
  assert.equal(armed.evidence, 'timer=2026-08-17T00:01:59.000Z reached');
});

test('timer local source rejects invalid relative and absolute definitions', async () => {
  const source = new LocalWaitSources({ defaultCwd: process.cwd() });
  const invalid = [
    { kind: 'timer' },
    { kind: 'timer', after_seconds: 0 },
    { kind: 'timer', after_seconds: -1 },
    { kind: 'timer', after_seconds: 1.5 },
    { kind: 'timer', after_seconds: 86400 },
    { kind: 'timer', at: 'not-a-time' },
    { kind: 'timer', at: '2026-08-17Z' },
    { kind: 'timer', at: '2026-08-17T00:00:00' },
    { kind: 'timer', after_seconds: 5, at: '2026-08-17T00:00:05Z' },
  ];
  for (const condition of invalid) {
    await assert.rejects(
      () => source.arm(condition),
      (error) => error?.code === 'INVALID_WAIT_CONDITION',
      JSON.stringify(condition),
    );
  }
});

async function listenHttp(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('http_ready transitions from 503 pending to 204 matched and supports exact status', async (t) => {
  let status = 503;
  const url = await listenHttp(t, (_req, res) => {
    res.writeHead(status);
    res.end('ignored body');
  });
  const source = new LocalWaitSources({ defaultCwd: process.cwd() });
  const condition = { kind: 'http_ready', url };
  const armed = await source.arm(condition);
  assert.equal(armed.status, 'pending');
  assert.equal((await source.check(record(condition, armed.baseline))).status, 'pending');

  status = 204;
  const ready = await source.check(record(condition, armed.baseline));
  assert.equal(ready.status, 'matched');
  assert.match(ready.evidence, /status=204/);

  status = 503;
  const exact = { kind: 'http_ready', url, status: 503 };
  const exactArm = await source.arm(exact);
  assert.equal((await source.check(record(exact, exactArm.baseline))).status, 'matched');
});

test('http_ready rejects URL credentials and does not follow redirects', async (t) => {
  const source = new LocalWaitSources({ defaultCwd: process.cwd() });
  await assert.rejects(
    () => source.arm({ kind: 'http_ready', url: 'http://user:secret@127.0.0.1:12345/' }),
    (error) => error?.code === 'INVALID_WAIT_CONDITION',
  );

  let targetHits = 0;
  const target = await listenHttp(t, (_req, res) => {
    targetHits += 1;
    res.writeHead(204);
    res.end();
  });
  const redirect = await listenHttp(t, (_req, res) => {
    res.writeHead(302, { location: target });
    res.end();
  });
  const condition = { kind: 'http_ready', url: redirect, status: 204 };
  const armed = await source.arm(condition);
  const result = await source.check(record(condition, armed.baseline));
  assert.equal(result.status, 'pending');
  assert.equal(targetHits, 0);
});

test('systemd_user derives missing user-bus env, preserves supplied env, and bounds the execFile probe', async () => {
  const calls = [];
  const execFileImpl = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: 'active\nrunning\n', stderr: '' };
  };
  const controller = new AbortController();
  const source = new LocalWaitSources({
    defaultCwd: process.cwd(),
    systemctlBin: '/usr/bin/systemctl',
    execFileImpl,
    env: { PATH: '/custom/bin', KEEP_ME: 'yes' },
  });
  const condition = { kind: 'systemd_user', unit: 'demo@one.service' };
  const armed = await source.arm(condition);
  const result = await source.check(record(condition, armed.baseline), controller.signal);
  assert.equal(result.status, 'matched');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/systemctl');
  assert.deepEqual(calls[0].args, [
    '--user', 'show', 'demo@one.service', '--property=ActiveState', '--property=SubState', '--value',
  ]);
  assert.equal(calls[0].options.encoding, 'utf8');
  assert.equal(calls[0].options.timeout, 2000);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.env.PATH, '/custom/bin');
  assert.equal(calls[0].options.env.KEEP_ME, 'yes');
  assert.equal(calls[0].options.env.XDG_RUNTIME_DIR, `/run/user/${process.getuid()}`);
  assert.equal(
    calls[0].options.env.DBUS_SESSION_BUS_ADDRESS,
    `unix:path=/run/user/${process.getuid()}/bus`,
  );
});

test('systemd_user preserves explicit runtime and bus environment values', async () => {
  let options;
  const source = new LocalWaitSources({
    defaultCwd: process.cwd(),
    env: {
      PATH: '/custom/bin',
      XDG_RUNTIME_DIR: '/explicit/runtime',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/explicit/bus',
    },
    execFileImpl: async (_file, _args, receivedOptions) => {
      options = receivedOptions;
      return { stdout: 'inactive\ndead\n', stderr: '' };
    },
  });
  const condition = { kind: 'systemd_user', unit: 'demo.service', state: 'inactive' };
  const armed = await source.arm(condition);
  const result = await source.check(record(condition, armed.baseline));
  assert.equal(result.status, 'matched');
  assert.equal(options.env.XDG_RUNTIME_DIR, '/explicit/runtime');
  assert.equal(options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/explicit/bus');
});

test('systemd_user propagates command or bus failures as transient WAIT_SOURCE_UNAVAILABLE', async () => {
  const source = new LocalWaitSources({
    defaultCwd: process.cwd(),
    execFileImpl: async () => {
      throw Object.assign(new Error('Failed to connect to bus'), { code: 1 });
    },
  });
  const condition = { kind: 'systemd_user', unit: 'demo.service', state: 'active' };
  const armed = await source.arm(condition);
  await assert.rejects(
    () => source.check(record(condition, armed.baseline)),
    (error) => error?.code === 'WAIT_SOURCE_UNAVAILABLE' && /Failed to connect to bus/.test(error.message),
  );
});

test('systemd_user aborts an in-flight systemctl subprocess as WAIT_ABORTED', async (t) => {
  const dir = await tempDir(t);
  const pidFile = path.join(dir, 'systemctl.pid');
  const fakeSystemctl = path.join(dir, 'systemctl-stall');
  await fs.writeFile(fakeSystemctl, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  await fs.chmod(fakeSystemctl, 0o755);

  const source = new LocalWaitSources({
    defaultCwd: process.cwd(),
    systemctlBin: fakeSystemctl,
  });
  const condition = { kind: 'systemd_user', unit: 'demo.service', state: 'active' };
  const armed = await source.arm(condition);
  const controller = new AbortController();
  const pending = source.check(record(condition, armed.baseline), controller.signal);

  let childPid;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      childPid = Number(await fs.readFile(pidFile, 'utf8'));
      if (Number.isSafeInteger(childPid) && childPid > 0) break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0, 'fake systemctl child did not start');

  controller.abort();
  await assert.rejects(pending, (error) => error?.code === 'WAIT_ABORTED');

  const exitDeadline = Date.now() + 2000;
  while (Date.now() < exitDeadline) {
    try {
      process.kill(childPid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`aborted systemctl child ${childPid} remained alive`);
});
