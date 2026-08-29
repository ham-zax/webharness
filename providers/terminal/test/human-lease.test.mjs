import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  brokerRequest,
  makeSandbox,
  onceExit,
  startBroker,
  waitFor,
} from './helpers.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const WSL_TERM = path.join(REPO_ROOT, 'bin', 'wsl-term');

function request(id, op, params = {}) {
  return { id, op, params };
}

function tmuxClients(socketPath) {
  const result = spawnSync('tmux', [
    '-N', '-S', socketPath,
    'list-clients',
    '-F', '#{client_pid}|#{client_session}|#{client_tty}|#{client_readonly}',
  ], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').filter(Boolean).map((line) => {
    const [pid, session, tty, readOnly] = line.split('|');
    return { pid: Number(pid), session, tty, readOnly: readOnly === '1' };
  });
}

function spawnPseudoTtyCommand(t, command, env) {
  const inheritedTerm = process.env.TERM;
  const terminalType = inheritedTerm && inheritedTerm !== 'dumb'
    ? inheritedTerm
    : 'xterm-256color';
  const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
    detached: true,
    env: { ...process.env, ...env, TERM: terminalType },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      await onceExit(child).catch(() => {});
    }
  });
  return child;
}

function spawnTmuxAttach(t, sandbox, name) {
  const command = `exec tmux -N -S '${sandbox.socketPath}' attach-session -t '${name}'`;
  return spawnPseudoTtyCommand(t, command, {});
}

function spawnWslTermAttach(t, sandbox, name) {
  const command = `exec '${WSL_TERM}' attach '${name}'`;
  return spawnPseudoTtyCommand(t, command, sandbox.env);
}

function spawnWslTermPresent(t, sandbox, name, { cols = 50, rows = 20 } = {}) {
  const command = `stty cols ${cols} rows ${rows}; exec '${WSL_TERM}' present '${name}'`;
  return spawnPseudoTtyCommand(t, command, sandbox.env);
}

function spawnWslTermWatch(t, sandbox, name, { cols = 50, rows = 20 } = {}) {
  const command = `stty cols ${cols} rows ${rows}; exec '${WSL_TERM}' watch '${name}'`;
  return spawnPseudoTtyCommand(t, command, sandbox.env);
}

function findWslTermPid(name) {
  const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const suffix = `providers/terminal/cli.mjs attach ${name}`;
  const line = result.stdout.split('\n').find((item) => item.includes(suffix));
  return line ? Number(line.trim().split(/\s+/, 1)[0]) : null;
}

async function collectStateText(root) {
  const chunks = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) chunks.push(await readFile(full));
    }
  }
  await visit(root);
  return Buffer.concat(chunks).toString('utf8');
}


test('broker enforces human ownership below model write paths while read and list stay available', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);

  const opened = await brokerRequest(sandbox.brokerSocket, request('open', 'session.open', {
    name: 'human-owned',
    command: "printf 'LEASE_READABLE\\n'; exec cat",
    cols: 80,
    rows: 24,
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  const acquired = await brokerRequest(sandbox.brokerSocket, request('acquire', 'lease.acquire_human', {
    name: 'human-owned',
    clientId: 'lease-test',
  }));
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  assert.equal(typeof acquired.result.leaseId, 'string');

  const listed = await brokerRequest(sandbox.brokerSocket, request('list', 'session.list'));
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const listedSession = listed.result.sessions.find((session) => session.name === 'human-owned');
  assert.equal(listedSession?.humanLease, true);
  assert.equal(listedSession?.humanAttached, false);

  let read;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('read', 'session.read', {
      name: 'human-owned', cursor: 0, maxBytes: 65536,
    }));
    if (!response.ok || !response.result.text.includes('LEASE_READABLE')) return false;
    read = response;
    return true;
  }, { description: 'read during human control' });
  assert.equal(read.ok, true);

  for (const [id, op, params] of [
    ['send', 'session.send', { name: 'human-owned', text: 'blocked' }],
    ['resize', 'session.resize', { name: 'human-owned', cols: 90, rows: 30 }],
    ['close', 'session.close', { name: 'human-owned' }],
    ['close-false', 'session.close', { name: 'human-owned', force: false }],
  ]) {
    const response = await brokerRequest(sandbox.brokerSocket, request(id, op, params));
    assert.equal(response.ok, false, `${op}: ${JSON.stringify(response)}`);
    assert.equal(response.error.code, 'HUMAN_HAS_CONTROL');
  }

  const forced = await brokerRequest(sandbox.brokerSocket, request('force-close', 'session.close', {
    name: 'human-owned', force: true,
  }));
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(forced.result.closed, true);
});

test('real tmux client ownership reconciles stale leases and survives broker restart', async (t) => {
  const sandbox = await makeSandbox(t);
  let broker = await startBroker(t, sandbox);

  const opened = await brokerRequest(sandbox.brokerSocket, request('real-open', 'session.open', {
    name: 'real-human', command: 'cat',
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  async function acquireAndAttach(id) {
    const acquired = await brokerRequest(sandbox.brokerSocket, request(`acquire-${id}`, 'lease.acquire_human', {
      name: 'real-human', clientId: `client-${id}`,
    }));
    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    const attach = spawnTmuxAttach(t, sandbox, 'real-human');
    let actualClient;
    await waitFor(() => {
      actualClient = tmuxClients(sandbox.socketPath).find((client) => client.session === 'real-human');
      return Boolean(actualClient);
    }, { description: `real tmux client ${id}` });
    const bound = await brokerRequest(sandbox.brokerSocket, request(`bind-${id}`, 'lease.bind_human', {
      name: 'real-human', leaseId: acquired.result.leaseId, clientPid: actualClient.pid,
    }));
    assert.equal(bound.ok, true, JSON.stringify(bound));
    return { acquired, attach, actualClient };
  }

  const first = await acquireAndAttach('first');
  const blocked = await brokerRequest(sandbox.brokerSocket, request('real-blocked', 'session.send', {
    name: 'real-human', text: 'blocked while attached',
  }));
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.error.code, 'HUMAN_HAS_CONTROL');

  const detachedFirst = spawnSync('tmux', [
    '-N', '-S', sandbox.socketPath, 'detach-client', '-t', first.actualClient.tty,
  ], { encoding: 'utf8' });
  assert.equal(detachedFirst.status, 0, detachedFirst.stderr);
  await waitFor(() => tmuxClients(sandbox.socketPath).every((client) => client.session !== 'real-human'), {
    description: 'first tmux client detach',
  });
  const restored = await brokerRequest(sandbox.brokerSocket, request('real-restored', 'session.send', {
    name: 'real-human', text: 'restored',
  }));
  assert.equal(restored.ok, true, JSON.stringify(restored));

  const second = await acquireAndAttach('second');
  const brokerPidBefore = broker.pid;
  broker.kill('SIGTERM');
  await onceExit(broker);
  broker = await startBroker(t, sandbox);
  assert.notEqual(broker.pid, brokerPidBefore);

  const listed = await brokerRequest(sandbox.brokerSocket, request('real-list-after-restart', 'session.list'));
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const restartedSession = listed.result.sessions.find((session) => session.name === 'real-human');
  assert.equal(restartedSession?.humanLease, true);
  assert.equal(restartedSession?.humanAttached, true);
  const blockedAfterRestart = await brokerRequest(sandbox.brokerSocket, request('real-blocked-after-restart', 'session.resize', {
    name: 'real-human', cols: 90, rows: 30,
  }));
  assert.equal(blockedAfterRestart.ok, false, JSON.stringify(blockedAfterRestart));
  assert.equal(blockedAfterRestart.error.code, 'HUMAN_HAS_CONTROL');

  const detachedSecond = spawnSync('tmux', [
    '-N', '-S', sandbox.socketPath, 'detach-client', '-t', second.actualClient.tty,
  ], { encoding: 'utf8' });
  assert.equal(detachedSecond.status, 0, detachedSecond.stderr);
  await waitFor(() => tmuxClients(sandbox.socketPath).every((client) => client.session !== 'real-human'), {
    description: 'second tmux client detach',
  });
  const restoredAfterRestart = await brokerRequest(sandbox.brokerSocket, request('real-restored-after-restart', 'session.resize', {
    name: 'real-human', cols: 91, rows: 31,
  }));
  assert.equal(restoredAfterRestart.ok, true, JSON.stringify(restoredAfterRestart));
});

test('read-only tmux observer does not take model control or inject input', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);

  const opened = await brokerRequest(sandbox.brokerSocket, request('observer-open', 'session.open', {
    name: 'observer', command: 'cat', cols: 80, rows: 24,
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  const observer = spawnWslTermWatch(t, sandbox, 'observer', { cols: 50, rows: 20 });
  let actualClient;
  await waitFor(() => {
    actualClient = tmuxClients(sandbox.socketPath).find((client) => client.session === 'observer');
    return Boolean(actualClient?.readOnly);
  }, { description: 'read-only tmux observer' });

  const listed = await brokerRequest(sandbox.brokerSocket, request('observer-list', 'session.list'));
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const observerSession = listed.result.sessions.find((session) => session.name === 'observer');
  assert.equal(observerSession?.humanLease, false);
  assert.equal(observerSession?.humanAttached, false);
  assert.equal(observerSession?.cols, 80);
  assert.equal(observerSession?.rows, 24);

  const watcherMarker = `WATCHER_INPUT_${process.pid}_${Date.now()}`;
  observer.stdin.write(`${watcherMarker}\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterWatcherInput = await brokerRequest(sandbox.brokerSocket, request('observer-read-watcher', 'session.read', {
    name: 'observer', cursor: 0, maxBytes: 65536,
  }));
  assert.equal(afterWatcherInput.ok, true, JSON.stringify(afterWatcherInput));
  assert.doesNotMatch(afterWatcherInput.result.text, new RegExp(watcherMarker));

  const modelMarker = `MODEL_INPUT_${process.pid}_${Date.now()}`;
  const sent = await brokerRequest(sandbox.brokerSocket, request('observer-send', 'session.send', {
    name: 'observer', text: `${modelMarker}\n`,
  }));
  assert.equal(sent.ok, true, JSON.stringify(sent));

  const resized = await brokerRequest(sandbox.brokerSocket, request('observer-resize', 'session.resize', {
    name: 'observer', cols: 93, rows: 33,
  }));
  assert.equal(resized.ok, true, JSON.stringify(resized));

  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('observer-read-model', 'session.read', {
      name: 'observer', cursor: 0, maxBytes: 65536,
    }));
    return response.ok && response.result.text.includes(modelMarker);
  }, { description: 'model marker while read-only observer attached' });

  const detached = spawnSync('tmux', [
    '-N', '-S', sandbox.socketPath, 'detach-client', '-t', actualClient.tty,
  ], { encoding: 'utf8' });
  assert.equal(detached.status, 0, detached.stderr);
  await onceExit(observer);
});

test('bound lease that never becomes a real tmux client expires after attach grace', async (t) => {
  const sandbox = await makeSandbox(t);
  sandbox.env.MCP_TERMINAL_LEASE_ATTACH_GRACE_MS = '120';
  await startBroker(t, sandbox);

  const opened = await brokerRequest(sandbox.brokerSocket, request('grace-open', 'session.open', {
    name: 'grace-human', command: 'cat',
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const acquired = await brokerRequest(sandbox.brokerSocket, request('grace-acquire', 'lease.acquire_human', {
    name: 'grace-human', clientId: 'grace-client',
  }));
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  const bound = await brokerRequest(sandbox.brokerSocket, request('grace-bind', 'lease.bind_human', {
    name: 'grace-human', leaseId: acquired.result.leaseId, clientPid: 99999999,
  }));
  assert.equal(bound.ok, true, JSON.stringify(bound));

  const blocked = await brokerRequest(sandbox.brokerSocket, request('grace-blocked', 'session.send', {
    name: 'grace-human', text: 'still pending',
  }));
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.error.code, 'HUMAN_HAS_CONTROL');

  await new Promise((resolve) => setTimeout(resolve, 180));
  const restored = await brokerRequest(sandbox.brokerSocket, request('grace-restored', 'session.send', {
    name: 'grace-human', text: 'after grace',
  }));
  assert.equal(restored.ok, true, JSON.stringify(restored));
});

test('wsl-term present keeps model control, then reuses the same exact PTY client for human handoff', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);
  const opened = await brokerRequest(sandbox.brokerSocket, request('present-open', 'session.open', {
    name: 'cli-present', command: "printf 'PRESENT_READABLE\\n'; exec cat", cols: 100, rows: 40,
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const distractor = await brokerRequest(sandbox.brokerSocket, request('present-other-open', 'session.open', {
    name: 'cli-present-other', command: 'exec cat', cols: 80, rows: 24,
  }));
  assert.equal(distractor.ok, true, JSON.stringify(distractor));

  const present = spawnWslTermPresent(t, sandbox, 'cli-present');
  let actualClient;
  await waitFor(async () => {
    actualClient = tmuxClients(sandbox.socketPath).find((client) => client.session === 'cli-present');
    if (!actualClient?.readOnly) return false;
    const listed = await brokerRequest(sandbox.brokerSocket, request('present-list', 'session.list'));
    const session = listed.result?.sessions.find((candidate) => candidate.name === 'cli-present');
    return listed.ok && session?.humanLease === false && session?.humanAttached === true;
  }, { description: 'wsl-term designated read-only presentation' });

  const modelSend = await brokerRequest(sandbox.brokerSocket, request('present-model-send', 'session.send', {
    name: 'cli-present', text: 'model while presented',
  }));
  assert.equal(modelSend.ok, true, JSON.stringify(modelSend));

  const modelResize = await brokerRequest(sandbox.brokerSocket, request('present-model-resize', 'session.resize', {
    name: 'cli-present', cols: 111, rows: 37,
  }));
  assert.equal(modelResize.ok, true, JSON.stringify(modelResize));
  assert.equal(modelResize.result.cols, 111);
  assert.equal(modelResize.result.rows, 37);

  const taken = await brokerRequest(sandbox.brokerSocket, request('present-take', 'control.take_human', {
    name: 'cli-present',
  }));
  assert.equal(taken.ok, true, JSON.stringify(taken));
  const writableClient = tmuxClients(sandbox.socketPath).find((client) => client.pid === actualClient.pid);
  assert.equal(writableClient?.session, 'cli-present');
  assert.equal(writableClient?.pid, actualClient.pid);
  assert.equal(writableClient?.readOnly, false);

  const humanResize = spawnSync('stty', ['-F', actualClient.tty, 'cols', '73', 'rows', '27'], {
    encoding: 'utf8',
  });
  assert.equal(humanResize.status, 0, humanResize.stderr);
  await waitFor(async () => {
    const listed = await brokerRequest(sandbox.brokerSocket, request('present-human-size', 'session.list'));
    const session = listed.result?.sessions.find((candidate) => candidate.name === 'cli-present');
    return listed.ok && session?.cols === 73 && session?.rows === 27;
  }, { description: 'writable human frontend resize' });

  const blocked = await brokerRequest(sandbox.brokerSocket, request('present-blocked', 'session.send', {
    name: 'cli-present', text: 'blocked while human owns',
  }));
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.error.code, 'HUMAN_HAS_CONTROL');

  const given = await brokerRequest(sandbox.brokerSocket, request('present-give', 'control.give_model', {
    name: 'cli-present',
  }));
  assert.equal(given.ok, true, JSON.stringify(given));
  const readOnlyAgain = tmuxClients(sandbox.socketPath).find((client) => client.pid === actualClient.pid);
  assert.equal(readOnlyAgain?.session, 'cli-present');
  assert.equal(readOnlyAgain?.pid, actualClient.pid);
  assert.equal(readOnlyAgain?.readOnly, true);

  const restored = await brokerRequest(sandbox.brokerSocket, request('present-restored', 'session.send', {
    name: 'cli-present', text: 'restored after give',
  }));
  assert.equal(restored.ok, true, JSON.stringify(restored));

  const detached = spawnSync('tmux', [
    '-N', '-S', sandbox.socketPath, 'detach-client', '-t', actualClient.tty,
  ], { encoding: 'utf8' });
  assert.equal(detached.status, 0, detached.stderr);
  await onceExit(present);
});

test('wsl-term present does not let a smaller passive viewport resize the model-owned PTY', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);
  const opened = await brokerRequest(sandbox.brokerSocket, request('present-size-open', 'session.open', {
    name: 'cli-present-size', command: 'cat', cols: 100, rows: 40,
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  const present = spawnWslTermPresent(t, sandbox, 'cli-present-size', { cols: 50, rows: 20 });
  let actualClient;
  await waitFor(() => {
    actualClient = tmuxClients(sandbox.socketPath).find((client) => client.session === 'cli-present-size');
    return Boolean(actualClient?.readOnly);
  }, { description: 'small read-only presentation client' });

  const listed = await brokerRequest(sandbox.brokerSocket, request('present-size-list', 'session.list'));
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const session = listed.result.sessions.find((candidate) => candidate.name === 'cli-present-size');
  assert.equal(session?.cols, 100);
  assert.equal(session?.rows, 40);

  const detached = spawnSync('tmux', [
    '-N', '-S', sandbox.socketPath, 'detach-client', '-t', actualClient.tty,
  ], { encoding: 'utf8' });
  assert.equal(detached.status, 0, detached.stderr);
  await onceExit(present);
});

test('wsl-term exact-PTY attach blocks model mutation, keeps reads available, and restores writes after detach', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);
  const opened = await brokerRequest(sandbox.brokerSocket, request('cli-attach-open', 'session.open', {
    name: 'cli-attach', command: "printf 'WSL_TERM_READABLE\\n'; exec cat",
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  const attach = spawnWslTermAttach(t, sandbox, 'cli-attach');
  let actualClient;
  await waitFor(async () => {
    actualClient = tmuxClients(sandbox.socketPath).find((client) => client.session === 'cli-attach');
    if (!actualClient) return false;
    const listed = await brokerRequest(sandbox.brokerSocket, request('cli-attach-list', 'session.list'));
    const session = listed.result.sessions.find((candidate) => candidate.name === 'cli-attach');
    return listed.ok && session?.humanLease === true && session?.humanAttached === true;
  }, { description: 'wsl-term human control' });

  for (const [id, op, params] of [
    ['cli-block-send', 'session.send', { name: 'cli-attach', text: 'blocked' }],
    ['cli-block-resize', 'session.resize', { name: 'cli-attach', cols: 92, rows: 32 }],
    ['cli-block-close', 'session.close', { name: 'cli-attach' }],
  ]) {
    const response = await brokerRequest(sandbox.brokerSocket, request(id, op, params));
    assert.equal(response.ok, false, `${op}: ${JSON.stringify(response)}`);
    assert.equal(response.error.code, 'HUMAN_HAS_CONTROL');
  }

  let read;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('cli-read-during-human', 'session.read', {
      name: 'cli-attach', cursor: 0, maxBytes: 65536,
    }));
    if (!response.ok || !response.result.text.includes('WSL_TERM_READABLE')) return false;
    read = response;
    return true;
  }, { description: 'model read during wsl-term attach' });
  assert.equal(read.ok, true);

  const detached = spawnSync('tmux', [
    '-N', '-S', sandbox.socketPath, 'detach-client', '-t', actualClient.tty,
  ], { encoding: 'utf8' });
  assert.equal(detached.status, 0, detached.stderr);
  await waitFor(() => tmuxClients(sandbox.socketPath).every((client) => client.session !== 'cli-attach'), {
    description: 'wsl-term tmux client detach',
  });
  await onceExit(attach);

  const restored = await brokerRequest(sandbox.brokerSocket, request('cli-restored-send', 'session.send', {
    name: 'cli-attach', text: 'restored after detach',
  }));
  assert.equal(restored.ok, true, JSON.stringify(restored));
});

test('crashed wsl-term wrapper cannot leave a stale permanent human lock', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);
  assert.equal((await brokerRequest(sandbox.brokerSocket, request('crash-open', 'session.open', {
    name: 'cli-crash', command: 'cat',
  }))).ok, true);

  const attach = spawnWslTermAttach(t, sandbox, 'cli-crash');
  let actualClient;
  let cliPid;
  await waitFor(async () => {
    const listed = await brokerRequest(sandbox.brokerSocket, request('crash-list', 'session.list'));
    actualClient = tmuxClients(sandbox.socketPath).find((client) => client.session === 'cli-crash');
    cliPid = findWslTermPid('cli-crash');
    return listed.ok
      && listed.result.sessions.find((session) => session.name === 'cli-crash')?.humanLease === true
      && Boolean(actualClient)
      && Number.isInteger(cliPid);
  }, { description: 'wsl-term attached before crash' });

  process.kill(cliPid, 'SIGKILL');
  try { process.kill(actualClient.pid, 'SIGKILL'); } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await onceExit(attach).catch(() => {});
  await waitFor(() => tmuxClients(sandbox.socketPath).every((client) => client.session !== 'cli-crash'), {
    description: 'tmux client gone after wrapper crash',
  });

  const restored = await brokerRequest(sandbox.brokerSocket, request('crash-restored', 'session.send', {
    name: 'cli-crash', text: 'write after crashed attach',
  }));
  assert.equal(restored.ok, true, JSON.stringify(restored));
});

test('human secret typed through wsl-term is not copied into Terminal state or broker logs', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker = await startBroker(t, sandbox);
  const secret = `SUDO_STYLE_SECRET_${process.pid}_${Date.now()}`;
  const opened = await brokerRequest(sandbox.brokerSocket, request('secret-open', 'session.open', {
    name: 'cli-secret',
    command: "stty -echo; printf 'PASSWORD_PROMPT\\n'; IFS= read -r secret; stty echo; printf '\\nSECRET_ACCEPTED\\n'; exec cat",
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  const attach = spawnWslTermAttach(t, sandbox, 'cli-secret');
  let actualClient;
  await waitFor(async () => {
    actualClient = tmuxClients(sandbox.socketPath).find((client) => client.session === 'cli-secret');
    if (!actualClient) return false;
    const response = await brokerRequest(sandbox.brokerSocket, request('secret-prompt', 'session.read', {
      name: 'cli-secret', cursor: 0, maxBytes: 65536,
    }));
    return response.ok && response.result.text.includes('PASSWORD_PROMPT');
  }, { description: 'no-echo password prompt' });

  attach.stdin.write(`${secret}\n`);
  let finalTranscript;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('secret-result', 'session.read', {
      name: 'cli-secret', cursor: 0, maxBytes: 65536,
    }));
    if (!response.ok || !response.result.text.includes('SECRET_ACCEPTED')) return false;
    finalTranscript = response.result.text;
    return true;
  }, { description: 'secret acceptance marker' });

  assert.doesNotMatch(finalTranscript, new RegExp(secret));
  assert.doesNotMatch(await collectStateText(sandbox.stateRoot), new RegExp(secret));
  assert.doesNotMatch(Buffer.concat(broker.testStderr).toString('utf8'), new RegExp(secret));

  const detached = spawnSync('tmux', [
    '-N', '-S', sandbox.socketPath, 'detach-client', '-t', actualClient.tty,
  ], { encoding: 'utf8' });
  assert.equal(detached.status, 0, detached.stderr);
  await onceExit(attach);
});
