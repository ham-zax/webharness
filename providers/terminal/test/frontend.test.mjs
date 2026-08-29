import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import { createFrontendController } from '../frontend.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const WSL_TERM = path.join(REPO_ROOT, 'bin', 'wsl-term');

function enoent() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  return error;
}

function fakeChild(pid = 43210) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  return child;
}

function stateClient(states) {
  let index = 0;
  const requests = [];
  return {
    requests,
    client: {
      async request(op, params) {
        requests.push({ op, params });
        assert.equal(op, 'session.list');
        const state = states[Math.min(index, states.length - 1)];
        index += 1;
        return { sessions: state ? [state] : [] };
      },
    },
  };
}

function fakeClock() {
  let ms = 0;
  return {
    now: () => ms,
    sleep: async (delayMs) => { ms += delayMs; },
  };
}

test('frontend controller exposes ensurePresented', () => {
  const controller = createFrontendController();
  assert.equal(typeof controller.ensurePresented, 'function');
});

test('ensurePresented reuses an existing designated frontend without spawning', async () => {
  const { client } = stateClient([
    { name: 'demo', humanLease: false, humanAttached: true },
  ]);
  let spawnCount = 0;
  const controller = createFrontendController({
    client,
    env: { MCP_TERMINAL_FRONTEND: 'windows-terminal' },
    repoRoot: REPO_ROOT,
    spawnFn() { spawnCount += 1; throw new Error('must not spawn'); },
  });

  const result = await controller.ensurePresented('demo');
  assert.deepEqual(result, { name: 'demo', status: 'reused' });
  assert.equal(spawnCount, 0);
});

test('ensurePresented launches explicit Kitty with WSLg child env and safe argv', async () => {
  const { client } = stateClient([
    { name: 'demo', humanLease: false, humanAttached: false },
    { name: 'demo', humanLease: false, humanAttached: true },
  ]);
  const child = fakeChild();
  const spawns = [];
  const env = {
    HOME: '/home/tester',
    PATH: '/usr/bin:/bin',
    MCP_TERMINAL_SOCKET: '/run/user/1000/wsl-agent-terminal.sock',
    MCP_TERMINAL_KITTY_BIN: '/opt/kitty/bin/kitty',
  };
  const socketPaths = new Set([
    '/mnt/wslg/runtime-dir/wayland-0',
    '/mnt/wslg/PulseServer',
  ]);
  const controller = createFrontendController({
    client,
    env,
    repoRoot: REPO_ROOT,
    accessFn: async (candidate) => {
      if (candidate !== '/opt/kitty/bin/kitty') throw enoent();
    },
    statFn: async (candidate) => {
      if (socketPaths.has(candidate)) return { isSocket: () => true };
      if (candidate === '/tmp/.X11-unix/X0') return { isSocket: () => true };
      throw enoent();
    },
    spawnFn(command, args, options) {
      spawns.push({ command, args, options });
      return child;
    },
    ...fakeClock(),
  });

  const result = await controller.ensurePresented('demo');
  assert.deepEqual(result, { name: 'demo', status: 'launch-attempted' });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/opt/kitty/bin/kitty');
  assert.deepEqual(spawns[0].args, [
    '--title', 'Terminal: demo', WSL_TERM, 'present', 'demo',
  ]);
  assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[0].options.stdio, 'ignore');
  assert.equal(spawns[0].options.env.MCP_TERMINAL_SOCKET, env.MCP_TERMINAL_SOCKET);
  assert.equal(spawns[0].options.env.XDG_RUNTIME_DIR, '/mnt/wslg/runtime-dir');
  assert.equal(spawns[0].options.env.WAYLAND_DISPLAY, 'wayland-0');
  assert.equal(spawns[0].options.env.DISPLAY, ':0');
  assert.equal(spawns[0].options.env.PULSE_SERVER, 'unix:/mnt/wslg/PulseServer');
  assert.equal(env.WAYLAND_DISPLAY, undefined);
  assert.equal(child.unrefCalled, true);
});

test('Kitty discovery falls back from explicit override to user install then PATH', async (t) => {
  for (const scenario of [
    {
      name: 'user install',
      env: { HOME: '/home/tester', PATH: '/usr/bin:/bin', MCP_TERMINAL_KITTY_BIN: '/missing/kitty' },
      executable: '/home/tester/.local/kitty.app/bin/kitty',
    },
    {
      name: 'PATH',
      env: { HOME: '/home/tester', PATH: '/first:/second' },
      executable: '/second/kitty',
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { client } = stateClient([
        { name: 'demo', humanLease: false, humanAttached: false },
        { name: 'demo', humanLease: false, humanAttached: true },
      ]);
      const spawns = [];
      const controller = createFrontendController({
        client,
        env: scenario.env,
        repoRoot: REPO_ROOT,
        accessFn: async (candidate) => {
          if (candidate !== scenario.executable) throw enoent();
        },
        statFn: async () => { throw enoent(); },
        spawnFn(command, args, options) {
          spawns.push({ command, args, options });
          return fakeChild();
        },
        ...fakeClock(),
      });

      const result = await controller.ensurePresented('demo');
      assert.equal(result.status, 'launch-attempted');
      assert.equal(spawns[0].command, scenario.executable);
    });
  }
});

test('ensurePresented waits for attachment-in-progress before deciding to launch', async () => {
  const { client, requests } = stateClient([
    { name: 'demo', humanLease: true, humanAttached: false },
    { name: 'demo', humanLease: true, humanAttached: false },
    { name: 'demo', humanLease: false, humanAttached: false },
    { name: 'demo', humanLease: false, humanAttached: true },
  ]);
  let requestCountAtSpawn = 0;
  const controller = createFrontendController({
    client,
    env: { HOME: '/home/tester', PATH: '/bin' },
    repoRoot: REPO_ROOT,
    accessFn: async (candidate) => {
      if (candidate !== '/bin/kitty') throw enoent();
    },
    statFn: async () => { throw enoent(); },
    spawnFn() {
      requestCountAtSpawn = requests.length;
      return fakeChild();
    },
    readinessTimeoutMs: 100,
    pollIntervalMs: 10,
    ...fakeClock(),
  });

  const result = await controller.ensurePresented('demo');
  assert.equal(result.status, 'launch-attempted');
  assert.ok(requestCountAtSpawn >= 3, `spawned after only ${requestCountAtSpawn} state reads`);
});

test('concurrent ensurePresented calls for one session are single-flight', async () => {
  let attached = false;
  const requests = [];
  const client = {
    async request(op) {
      assert.equal(op, 'session.list');
      requests.push(op);
      return { sessions: [{ name: 'demo', humanLease: false, humanAttached: attached }] };
    },
  };
  let spawnCount = 0;
  const clock = fakeClock();
  const controller = createFrontendController({
    client,
    env: { HOME: '/home/tester', PATH: '/bin' },
    repoRoot: REPO_ROOT,
    accessFn: async (candidate) => {
      if (candidate !== '/bin/kitty') throw enoent();
    },
    statFn: async () => { throw enoent(); },
    spawnFn() {
      spawnCount += 1;
      return fakeChild();
    },
    now: clock.now,
    sleep: async (ms) => {
      await Promise.resolve();
      attached = true;
      await clock.sleep(ms);
    },
  });

  const [first, second] = await Promise.all([
    controller.ensurePresented('demo'),
    controller.ensurePresented('demo'),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.status, 'launch-attempted');
  assert.equal(spawnCount, 1);
});

test('Windows launcher derives both documented WSL UNC forms and quotes ordinary spaces', async (t) => {
  for (const windowsRoot of [
    '\\\\wsl.localhost\\Ubuntu Test',
    '\\\\wsl$\\Ubuntu Test',
  ]) {
    await t.test(windowsRoot, async () => {
      const { client } = stateClient([
        { name: 'demo', humanLease: false, humanAttached: false },
        { name: 'demo', humanLease: false, humanAttached: true },
      ]);
      const execCalls = [];
      const spawns = [];
      const child = fakeChild();
      const controller = createFrontendController({
        client,
        env: { MCP_TERMINAL_FRONTEND: 'windows-terminal', USER: 'wrong-user' },
        repoRoot: '/home/test repo',
        execFileFn: async (command, args, options) => {
          execCalls.push({ command, args, options });
          return { stdout: windowsRoot };
        },
        userInfoFn: () => ({ username: 'right user' }),
        spawnFn(command, args, options) {
          spawns.push({ command, args, options });
          return child;
        },
        ...fakeClock(),
      });

      const result = await controller.ensurePresented('demo');
      assert.equal(result.status, 'launch-attempted');
      assert.deepEqual(execCalls, [{
        command: 'wslpath',
        args: ['-w', '/'],
        options: { encoding: 'utf8' },
      }]);
      assert.equal(spawns.length, 1);
      assert.equal(spawns[0].command, 'cmd.exe');
      assert.deepEqual(spawns[0].args.slice(0, 2), ['/d', '/c']);
      assert.equal(spawns[0].options.cwd, '/mnt/c');
      assert.equal(spawns[0].options.detached, true);
      assert.equal(spawns[0].options.stdio, 'ignore');
      const command = spawns[0].args[2];
      assert.match(command, /^wt\.exe -w new new-tab --title "Terminal: demo" --suppressApplicationTitle wsl\.exe /);
      assert.ok(command.includes('-d "Ubuntu Test"'));
      assert.ok(command.includes('-u "right user"'));
      assert.ok(!command.includes('wrong-user'));
      assert.ok(command.includes(`/usr/bin/env "TERMINAL_NODE_BIN=${process.execPath}"`));
      assert.ok(command.includes('"/home/test repo/bin/wsl-term" present "demo"'));
      assert.equal(child.unrefCalled, true);
    });
  }
});

test('Windows command construction fails closed on unsupported CMD metacharacters', async () => {
  const { client } = stateClient([
    { name: 'demo', humanLease: false, humanAttached: false },
  ]);
  let spawnCount = 0;
  const controller = createFrontendController({
    client,
    env: { MCP_TERMINAL_FRONTEND: 'windows-terminal', WSL_DISTRO_NAME: 'Ubuntu' },
    repoRoot: REPO_ROOT,
    execFileFn: async () => { throw new Error('WSL_DISTRO_NAME should win'); },
    userInfoFn: () => ({ username: 'tester&whoami' }),
    nodeBin: '/usr/bin/node',
    spawnFn() { spawnCount += 1; return fakeChild(); },
  });

  await assert.rejects(
    controller.ensurePresented('demo'),
    (error) => error?.code === 'FRONTEND_LAUNCH_FAILED'
      && /unsupported CMD metacharacters/.test(error.message)
      && error.message.includes(`${WSL_TERM} attach demo`),
  );
  assert.equal(spawnCount, 0);
});

test('clean transient Windows launcher exit can still become attached', async () => {
  const { client } = stateClient([
    { name: 'demo', humanLease: false, humanAttached: false },
    { name: 'demo', humanLease: false, humanAttached: false },
    { name: 'demo', humanLease: false, humanAttached: true },
  ]);
  const child = fakeChild();
  child.exitCode = 0;
  const controller = createFrontendController({
    client,
    env: { MCP_TERMINAL_FRONTEND: 'windows-terminal', WSL_DISTRO_NAME: 'Ubuntu' },
    repoRoot: REPO_ROOT,
    execFileFn: async () => { throw new Error('WSL_DISTRO_NAME should win'); },
    userInfoFn: () => ({ username: 'tester' }),
    nodeBin: '/usr/bin/node',
    spawnFn: () => child,
    readinessTimeoutMs: 50,
    pollIntervalMs: 10,
    ...fakeClock(),
  });

  const result = await controller.ensurePresented('demo');
  assert.equal(result.status, 'launch-attempted');
});

test('broker attachment wins over a nonzero transient Windows launcher exit', async () => {
  const { client } = stateClient([
    { name: 'demo', humanLease: false, humanAttached: false },
    { name: 'demo', humanLease: false, humanAttached: true },
  ]);
  const child = fakeChild();
  child.exitCode = 7;
  const controller = createFrontendController({
    client,
    env: { MCP_TERMINAL_FRONTEND: 'windows-terminal', WSL_DISTRO_NAME: 'Ubuntu' },
    repoRoot: REPO_ROOT,
    userInfoFn: () => ({ username: 'tester' }),
    nodeBin: '/usr/bin/node',
    spawnFn: () => child,
    ...fakeClock(),
  });

  const result = await controller.ensurePresented('demo');
  assert.equal(result.status, 'launch-attempted');
});

test('Windows timeout with a human lease reports settling without immediate manual attach', async () => {
  const { client } = stateClient([
    { name: 'demo', humanLease: false, humanAttached: false },
    { name: 'demo', humanLease: true, humanAttached: false },
  ]);
  const child = fakeChild();
  child.exitCode = 0;
  const controller = createFrontendController({
    client,
    env: { MCP_TERMINAL_FRONTEND: 'windows-terminal', WSL_DISTRO_NAME: 'Ubuntu' },
    repoRoot: REPO_ROOT,
    userInfoFn: () => ({ username: 'tester' }),
    nodeBin: '/usr/bin/node',
    spawnFn: () => child,
    readinessTimeoutMs: 20,
    pollIntervalMs: 10,
    ...fakeClock(),
  });

  await assert.rejects(
    controller.ensurePresented('demo'),
    (error) => error?.code === 'FRONTEND_NOT_READY'
      && /still settling/.test(error.message)
      && /re-list/.test(error.message)
      && !error.message.includes(`${WSL_TERM} attach demo`),
  );
});

test('Windows timeout without attachment or lease returns exact manual fallback', async () => {
  const { client } = stateClient([
    { name: 'demo', humanLease: false, humanAttached: false },
  ]);
  const child = fakeChild();
  child.exitCode = 0;
  const controller = createFrontendController({
    client,
    env: { MCP_TERMINAL_FRONTEND: 'windows-terminal', WSL_DISTRO_NAME: 'Ubuntu' },
    repoRoot: REPO_ROOT,
    userInfoFn: () => ({ username: 'tester' }),
    nodeBin: '/usr/bin/node',
    spawnFn: () => child,
    readinessTimeoutMs: 20,
    pollIntervalMs: 10,
    ...fakeClock(),
  });

  await assert.rejects(
    controller.ensurePresented('demo'),
    (error) => error?.code === 'FRONTEND_NOT_READY'
      && error.message.includes(`${WSL_TERM} attach demo`),
  );
});

test('Windows launcher failure never invokes Kitty process-group cleanup', async () => {
  const { client } = stateClient([
    { name: 'demo', humanLease: false, humanAttached: false },
  ]);
  const child = fakeChild(67890);
  child.exitCode = 9;
  let cleanupCount = 0;
  const spawns = [];
  const controller = createFrontendController({
    client,
    env: { MCP_TERMINAL_FRONTEND: 'windows-terminal', WSL_DISTRO_NAME: 'Ubuntu' },
    repoRoot: REPO_ROOT,
    userInfoFn: () => ({ username: 'tester' }),
    nodeBin: '/usr/bin/node',
    spawnFn(command, args, options) {
      spawns.push({ command, args, options });
      return child;
    },
    killProcessGroup: async () => { cleanupCount += 1; },
    ...fakeClock(),
  });

  await assert.rejects(
    controller.ensurePresented('demo'),
    (error) => error?.code === 'FRONTEND_LAUNCH_FAILED'
      && /code 9/.test(error.message)
      && error.message.includes(`${WSL_TERM} attach demo`),
  );
  assert.equal(cleanupCount, 0);
  assert.equal(spawns[0].command, 'cmd.exe');
  assert.ok(!spawns[0].args[2].toLowerCase().includes('taskkill'));
});

test('frontend unavailable returns actionable manual attach fallback', async () => {
  const { client } = stateClient([
    { name: 'demo', humanLease: false, humanAttached: false },
  ]);
  const controller = createFrontendController({
    client,
    env: { HOME: '/home/tester', PATH: '/one:/two' },
    repoRoot: REPO_ROOT,
    accessFn: async () => { throw enoent(); },
  });

  await assert.rejects(
    controller.ensurePresented('demo'),
    (error) => error?.code === 'FRONTEND_UNAVAILABLE'
      && error.message.includes(`${WSL_TERM} attach demo`),
  );
});

test('synchronous Kitty spawn failure returns a stable frontend error with manual fallback', async () => {
  const { client } = stateClient([
    { name: 'demo', humanLease: false, humanAttached: false },
  ]);
  const controller = createFrontendController({
    client,
    env: { HOME: '/home/tester', PATH: '/bin' },
    repoRoot: REPO_ROOT,
    accessFn: async (candidate) => {
      if (candidate !== '/bin/kitty') throw enoent();
    },
    statFn: async () => { throw enoent(); },
    spawnFn() { throw new Error('spawn exploded'); },
    ...fakeClock(),
  });

  await assert.rejects(
    controller.ensurePresented('demo'),
    (error) => error?.code === 'FRONTEND_LAUNCH_FAILED'
      && /spawn exploded/.test(error.message)
      && error.message.includes(`${WSL_TERM} attach demo`),
  );
});

test('readiness timeout waits for owned Kitty process-group cleanup before returning failure', async () => {
  const { client } = stateClient([
    { name: 'demo', humanLease: false, humanAttached: false },
  ]);
  const child = fakeChild(56789);
  const killed = [];
  const clock = fakeClock();
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  let cleanupWaitStarted = false;
  const controller = createFrontendController({
    client,
    env: { HOME: '/home/tester', PATH: '/bin' },
    repoRoot: REPO_ROOT,
    accessFn: async (candidate) => {
      if (candidate !== '/bin/kitty') throw enoent();
    },
    statFn: async () => { throw enoent(); },
    spawnFn: () => child,
    killProcessGroup: async (pid, signal) => { killed.push({ pid, signal }); },
    waitForChildExit: async () => {
      cleanupWaitStarted = true;
      await cleanupGate;
      return true;
    },
    readinessTimeoutMs: 30,
    pollIntervalMs: 10,
    now: clock.now,
    sleep: clock.sleep,
  });

  let settled = false;
  let capturedError;
  const failure = controller.ensurePresented('demo').then(
    () => { settled = true; },
    (error) => { settled = true; capturedError = error; },
  );
  for (let attempt = 0; attempt < 100 && !cleanupWaitStarted && !settled; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(cleanupWaitStarted, true, 'frontend failure must enter bounded owned-process cleanup');
  assert.equal(settled, false, 'frontend failure must remain pending until owned-process cleanup settles');
  releaseCleanup();
  await failure;
  assert.equal(capturedError?.code, 'FRONTEND_NOT_READY');
  assert.ok(capturedError.message.includes(`${WSL_TERM} attach demo`));
  assert.deepEqual(killed, [{ pid: 56789, signal: 'SIGTERM' }]);
  assert.equal(child.unrefCalled, false);
});
