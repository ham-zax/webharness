import assert from 'node:assert/strict';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import test from 'node:test';

import { loadConfig } from '../broker.mjs';

import {
  brokerRequest,
  makeSandbox,
  onceExit,
  processExists,
  startBroker,
  tmuxValue,
  waitFor,
} from './helpers.mjs';

function request(id, op, params = {}) {
  return { id, op, params };
}

test('broker config defaults cwd to the current user home', () => {
  const previousHome = process.env.HOME;
  const previousDefaultCwd = process.env.MCP_TERMINAL_DEFAULT_CWD;
  process.env.HOME = '/tmp/wsl-portable-broker-home';
  delete process.env.MCP_TERMINAL_DEFAULT_CWD;
  try {
    const config = loadConfig();
    assert.equal(config.defaultCwd, '/tmp/wsl-portable-broker-home');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDefaultCwd === undefined) delete process.env.MCP_TERMINAL_DEFAULT_CWD;
    else process.env.MCP_TERMINAL_DEFAULT_CWD = previousDefaultCwd;
  }
});

test('accepted client socket errors are contained to that connection', async () => {
  const { attachBrokerConnection } = await import('../broker.mjs');
  assert.equal(typeof attachBrokerConnection, 'function');

  class FakeSocket extends EventEmitter {
    destroyed = false;
    setEncoding() {}
    destroy() { this.destroyed = true; }
  }

  const socket = new FakeSocket();
  attachBrokerConnection(socket, async () => ({ sessions: [] }));

  assert.doesNotThrow(() => {
    socket.emit('error', Object.assign(new Error('peer reset'), { code: 'ECONNRESET' }));
  });
  assert.equal(socket.destroyed, true);
});

test('real peer TCP reset is contained and a later request still succeeds', async (t) => {
  const { attachBrokerConnection } = await import('../broker.mjs');
  let accepted = 0;
  let resolveFirstClose;
  const firstClosed = new Promise((resolve) => { resolveFirstClose = resolve; });
  const server = createServer((socket) => {
    accepted += 1;
    if (accepted === 1) socket.once('close', resolveFirstClose);
    attachBrokerConnection(socket, async () => ({ sessions: [] }));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');

  const resetter = createConnection({ host: '127.0.0.1', port: address.port });
  await once(resetter, 'connect');
  resetter.write('{"id":"partial"');
  resetter.resetAndDestroy();
  await firstClosed;

  const healthy = createConnection({ host: '127.0.0.1', port: address.port });
  await once(healthy, 'connect');
  healthy.setEncoding('utf8');
  const responseLine = new Promise((resolve, reject) => {
    let buffered = '';
    healthy.on('data', (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline !== -1) resolve(buffered.slice(0, newline));
    });
    healthy.once('error', reject);
  });
  healthy.write('{"id":"after-reset","op":"session.list","params":{}}\n');
  const response = JSON.parse(await responseLine);
  assert.deepEqual(response, { id: 'after-reset', ok: true, result: { sessions: [] } });
  assert.equal(server.listening, true);
  healthy.end();
  await once(healthy, 'close');
});

test('broker restart preserves tmux server, PTY process, transcript capture, and recovered session', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker1 = await startBroker(t, sandbox);

  const opened = await brokerRequest(sandbox.brokerSocket, request('open', 'session.open', {
    name: 'durable',
    cwd: '/tmp',
    command: "i=0; while :; do printf 'tick:%s\\n' \"$i\"; i=$((i+1)); sleep 0.05; done",
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  const tmuxPidBefore = Number(tmuxValue(sandbox.socketPath, 'durable:0.0', '#{pid}'));
  const panePidBefore = Number(tmuxValue(sandbox.socketPath, 'durable:0.0', '#{pane_pid}'));
  assert.ok(processExists(tmuxPidBefore));
  assert.ok(processExists(panePidBefore));

  let firstRead;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('read-before', 'session.read', {
      name: 'durable', cursor: 0, maxBytes: 65536,
    }));
    if (!response.ok || !response.result.text.includes('tick:')) return false;
    firstRead = response.result;
    return true;
  }, { description: 'initial transcript output' });

  const brokerPidBefore = broker1.pid;
  broker1.kill('SIGTERM');
  await onceExit(broker1);
  assert.equal(processExists(brokerPidBefore), false);
  assert.ok(processExists(tmuxPidBefore));
  assert.ok(processExists(panePidBefore));

  await new Promise((resolve) => setTimeout(resolve, 150));
  const broker2 = await startBroker(t, sandbox);
  const brokerPidAfter = broker2.pid;
  assert.notEqual(brokerPidAfter, brokerPidBefore);

  const tmuxPidAfter = Number(tmuxValue(sandbox.socketPath, 'durable:0.0', '#{pid}'));
  const panePidAfter = Number(tmuxValue(sandbox.socketPath, 'durable:0.0', '#{pane_pid}'));
  assert.equal(tmuxPidAfter, tmuxPidBefore);
  assert.equal(panePidAfter, panePidBefore);

  const listed = await brokerRequest(sandbox.brokerSocket, request('list-after', 'session.list'));
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.result.sessions.some((session) => session.name === 'durable'), true);

  let continued;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('read-after', 'session.read', {
      name: 'durable', cursor: firstRead.nextCursor, maxBytes: 65536,
    }));
    if (!response.ok || response.result.text.length === 0) return false;
    continued = response.result;
    return true;
  }, { description: 'continued transcript after broker restart' });
  assert.match(continued.text, /tick:/);
  assert.ok(continued.nextCursor > firstRead.nextCursor);

  const killed = await brokerRequest(sandbox.brokerSocket, request('close', 'session.close', { name: 'durable' }));
  assert.equal(killed.ok, true, JSON.stringify(killed));
});

test('broker reconciliation keeps an existing live transcript pipe attached after restart', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker1 = await startBroker(t, sandbox);

  const opened = await brokerRequest(sandbox.brokerSocket, request('pipe-open', 'session.open', {
    name: 'pipe-live', command: 'cat',
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  await brokerRequest(sandbox.brokerSocket, request('pipe-before-text', 'session.send', {
    name: 'pipe-live', text: 'PIPE_BEFORE',
  }));
  await brokerRequest(sandbox.brokerSocket, request('pipe-before-enter', 'session.send', {
    name: 'pipe-live', key: 'Enter',
  }));

  let before;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('pipe-read-before', 'session.read', {
      name: 'pipe-live', cursor: 0, maxBytes: 65536,
    }));
    if (!response.ok || !response.result.text.includes('PIPE_BEFORE')) return false;
    before = response.result;
    return true;
  }, { description: 'pre-restart pipe output' });

  broker1.kill('SIGTERM');
  await onceExit(broker1);
  await startBroker(t, sandbox);

  await brokerRequest(sandbox.brokerSocket, request('pipe-after-text', 'session.send', {
    name: 'pipe-live', text: 'PIPE_AFTER',
  }));
  await brokerRequest(sandbox.brokerSocket, request('pipe-after-enter', 'session.send', {
    name: 'pipe-live', key: 'Enter',
  }));

  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('pipe-read-after', 'session.read', {
      name: 'pipe-live', cursor: before.nextCursor, maxBytes: 65536,
    }));
    return response.ok && response.result.text.includes('PIPE_AFTER');
  }, { description: 'post-restart output through existing transcript pipe' });
});

test('model read uses one persisted broker-owned cursor across zero-output reads, recovery controls, snapshots, and restart', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker1 = await startBroker(t, sandbox);

  const opened = await brokerRequest(sandbox.brokerSocket, request('model-open', 'session.open', {
    name: 'model-cursor',
    command: "printf 'MODEL_FIRST\\n'; exec cat",
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  let first = null;
  let firstText = '';
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('model-read-first', 'model.read', {
      name: 'model-cursor',
    }));
    if (!response.ok) return false;
    first = response.result;
    firstText += response.result.text;
    return firstText.includes('MODEL_FIRST');
  }, { description: 'first model cursor output' });
  assert.ok(first.nextCursor > 0);

  const duplicate = await brokerRequest(sandbox.brokerSocket, request('model-read-empty', 'model.read', {
    name: 'model-cursor',
  }));
  assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
  assert.equal(duplicate.result.text, '');
  assert.equal(duplicate.result.cursor, first.nextCursor);
  assert.equal(duplicate.result.nextCursor, first.nextCursor);

  assert.equal((await brokerRequest(sandbox.brokerSocket, request('model-send-second', 'session.send', {
    name: 'model-cursor', text: 'MODEL_SECOND',
  }))).ok, true);
  assert.equal((await brokerRequest(sandbox.brokerSocket, request('model-send-enter', 'session.send', {
    name: 'model-cursor', key: 'Enter',
  }))).ok, true);

  let second = null;
  let secondText = '';
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('model-read-second', 'model.read', {
      name: 'model-cursor',
    }));
    if (!response.ok) return false;
    second = response.result;
    secondText += response.result.text;
    return secondText.includes('MODEL_SECOND');
  }, { description: 'second model cursor output' });
  assert.ok(second.nextCursor > first.nextCursor);

  const replay = await brokerRequest(sandbox.brokerSocket, request('model-read-explicit', 'model.read', {
    name: 'model-cursor', cursor: 0,
  }));
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.match(replay.result.text, /MODEL_FIRST/);
  const replayEnd = replay.result.nextCursor;

  const ahead = await brokerRequest(sandbox.brokerSocket, request('model-read-ahead', 'model.read', {
    name: 'model-cursor', cursor: replay.result.endOffset + 1,
  }));
  assert.equal(ahead.ok, false, JSON.stringify(ahead));
  assert.equal(ahead.error.code, 'CURSOR_AHEAD');

  const afterAhead = await brokerRequest(sandbox.brokerSocket, request('model-read-after-ahead', 'model.read', {
    name: 'model-cursor',
  }));
  assert.equal(afterAhead.ok, true, JSON.stringify(afterAhead));
  assert.equal(afterAhead.result.cursor, replayEnd);
  assert.equal(afterAhead.result.text, '');

  const snapshot = await brokerRequest(sandbox.brokerSocket, request('model-snapshot', 'model.read', {
    name: 'model-cursor', snapshot: true,
  }));
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.equal(snapshot.result.snapshot, true);
  assert.match(snapshot.result.text, /MODEL_SECOND/);

  const brokerPidBefore = broker1.pid;
  broker1.kill('SIGTERM');
  await onceExit(broker1);
  const broker2 = await startBroker(t, sandbox);
  assert.notEqual(broker2.pid, brokerPidBefore);

  assert.equal((await brokerRequest(sandbox.brokerSocket, request('model-send-third', 'session.send', {
    name: 'model-cursor', text: 'MODEL_THIRD',
  }))).ok, true);
  assert.equal((await brokerRequest(sandbox.brokerSocket, request('model-send-third-enter', 'session.send', {
    name: 'model-cursor', key: 'Enter',
  }))).ok, true);

  let third = null;
  let thirdText = '';
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('model-read-third', 'model.read', {
      name: 'model-cursor',
    }));
    if (!response.ok) return false;
    third = response.result;
    thirdText += response.result.text;
    return thirdText.includes('MODEL_THIRD');
  }, { description: 'model cursor output after broker restart' });
  assert.equal(third.cursor, replayEnd);
  assert.match(thirdText, /MODEL_THIRD/);
  assert.doesNotMatch(thirdText, /MODEL_FIRST/);

  const closed = await brokerRequest(sandbox.brokerSocket, request('model-close', 'session.close', { name: 'model-cursor' }));
  assert.equal(closed.ok, true, JSON.stringify(closed));
});

test('session generation survives broker restart and changes on same-name reopen', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker1 = await startBroker(t, sandbox);

  const opened = await brokerRequest(sandbox.brokerSocket, request('generation-open', 'session.open', {
    name: 'generation', command: 'cat',
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  const first = await brokerRequest(sandbox.brokerSocket, request('generation-observe-first', 'session.observe', {
    name: 'generation',
  }));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.match(first.result.generation, /^[0-9a-f-]{36}$/i);

  broker1.kill('SIGTERM');
  await onceExit(broker1);
  await startBroker(t, sandbox);

  const afterRestart = await brokerRequest(sandbox.brokerSocket, request('generation-observe-restart', 'session.observe', {
    name: 'generation',
  }));
  assert.equal(afterRestart.ok, true, JSON.stringify(afterRestart));
  assert.equal(afterRestart.result.generation, first.result.generation);

  assert.equal((await brokerRequest(sandbox.brokerSocket, request('generation-close', 'session.close', {
    name: 'generation', force: true,
  }))).ok, true);
  assert.equal((await brokerRequest(sandbox.brokerSocket, request('generation-reopen', 'session.open', {
    name: 'generation', command: 'cat',
  }))).ok, true);

  const replacement = await brokerRequest(sandbox.brokerSocket, request('generation-observe-replacement', 'session.observe', {
    name: 'generation',
  }));
  assert.equal(replacement.ok, true, JSON.stringify(replacement));
  assert.match(replacement.result.generation, /^[0-9a-f-]{36}$/i);
  assert.notEqual(replacement.result.generation, first.result.generation);
});

test('same-name reopen starts with fresh transcript and model cursor state', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);

  assert.equal((await brokerRequest(sandbox.brokerSocket, request('reopen-old-open', 'session.open', {
    name: 'same-name', command: "printf 'OLD_SESSION_MARKER\\n'; exec cat",
  }))).ok, true);

  let oldRead;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('reopen-old-read', 'model.read', { name: 'same-name' }));
    if (!response.ok || !response.result.text.includes('OLD_SESSION_MARKER')) return false;
    oldRead = response.result;
    return true;
  }, { description: 'old incarnation marker' });
  assert.match(oldRead.text, /OLD_SESSION_MARKER/);

  assert.equal((await brokerRequest(sandbox.brokerSocket, request('reopen-old-close', 'session.close', {
    name: 'same-name', force: true,
  }))).ok, true);
  assert.equal((await brokerRequest(sandbox.brokerSocket, request('reopen-new-open', 'session.open', {
    name: 'same-name', command: "printf 'NEW_SESSION_MARKER\\n'; exec cat",
  }))).ok, true);

  let newText = '';
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('reopen-new-read', 'model.read', { name: 'same-name' }));
    if (!response.ok) return false;
    newText += response.result.text;
    return newText.includes('NEW_SESSION_MARKER');
  }, { description: 'new incarnation marker' });
  assert.match(newText, /NEW_SESSION_MARKER/);
  assert.doesNotMatch(newText, /OLD_SESSION_MARKER/);
});

test('expectedGeneration rejects replacement state and generation changes during explicit reads', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);

  assert.equal((await brokerRequest(sandbox.brokerSocket, request('expected-open', 'session.open', {
    name: 'expected-generation', command: "printf 'GENERATION_ONE\\n'; exec cat",
  }))).ok, true);
  const observed = await brokerRequest(sandbox.brokerSocket, request('expected-observe', 'session.observe', {
    name: 'expected-generation',
  }));
  assert.equal(observed.ok, true, JSON.stringify(observed));

  assert.equal((await brokerRequest(sandbox.brokerSocket, request('expected-close', 'session.close', {
    name: 'expected-generation', force: true,
  }))).ok, true);
  const reopened = await brokerRequest(sandbox.brokerSocket, request('expected-reopen', 'session.open', {
    name: 'expected-generation', command: "printf 'GENERATION_TWO\\n'; exec cat",
  }));
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  const replacement = await brokerRequest(sandbox.brokerSocket, request('expected-observe-replacement', 'session.observe', {
    name: 'expected-generation',
  }));
  assert.equal(replacement.ok, true, JSON.stringify(replacement));

  const stale = await brokerRequest(sandbox.brokerSocket, request('expected-stale-read', 'session.read', {
    name: 'expected-generation', cursor: 0, maxBytes: 65536, expectedGeneration: observed.result.generation,
  }));
  assert.equal(stale.ok, false, JSON.stringify(stale));
  assert.equal(stale.error.code, 'SESSION_GENERATION_MISMATCH');

  const sessionRoot = path.join(sandbox.stateRoot, 'sessions', 'expected-generation');
  const dataDir = path.join(sessionRoot, 'incarnations', replacement.result.generation);
  const lockFile = path.join(dataDir, '.transcript.lock');
  const lockDeadline = Date.now() + 1000;
  while (true) {
    try {
      await writeFile(lockFile, `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() })}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || Date.now() >= lockDeadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  let settled = false;
  let earlyResult;
  const racingRead = brokerRequest(sandbox.brokerSocket, request('expected-racing-read', 'session.read', {
    name: 'expected-generation', cursor: 0, maxBytes: 65536, expectedGeneration: replacement.result.generation,
  })).then((result) => {
    earlyResult = result;
    return result;
  }).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(settled, false, JSON.stringify(earlyResult));

  const metadataFile = path.join(sessionRoot, 'session.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  const tempMetadata = `${metadataFile}.race`;
  await writeFile(tempMetadata, `${JSON.stringify({
    ...metadata,
    generation: '00000000-0000-4000-8000-000000000001',
  })}\n`, { mode: 0o600 });
  await rename(tempMetadata, metadataFile);
  await unlink(lockFile);

  const raced = await racingRead;
  assert.equal(raced.ok, false, JSON.stringify(raced));
  assert.equal(raced.error.code, 'SESSION_GENERATION_MISMATCH');
});

test('concurrent same-name opens serialize to one incarnation and one SESSION_EXISTS failure', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);

  const [a, b] = await Promise.all([
    brokerRequest(sandbox.brokerSocket, request('concurrent-open-a', 'session.open', {
      name: 'concurrent-open', command: 'cat',
    })),
    brokerRequest(sandbox.brokerSocket, request('concurrent-open-b', 'session.open', {
      name: 'concurrent-open', command: 'cat',
    })),
  ]);
  const successes = [a, b].filter((response) => response.ok);
  const failures = [a, b].filter((response) => !response.ok);
  assert.equal(successes.length, 1, JSON.stringify([a, b]));
  assert.equal(failures.length, 1, JSON.stringify([a, b]));
  assert.equal(failures[0].error.code, 'SESSION_EXISTS');

  const observed = await brokerRequest(sandbox.brokerSocket, request('concurrent-observe', 'session.observe', {
    name: 'concurrent-open',
  }));
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.match(observed.result.generation, /^[0-9a-f-]{36}$/i);
  assert.equal(observed.result.transcript.baseOffset, 0);
});

test('expired broker-owned model cursor remains explicit and is not silently rewritten', async (t) => {
  const sandbox = await makeSandbox(t, { budgetBytes: 64 });
  await startBroker(t, sandbox);

  const opened = await brokerRequest(sandbox.brokerSocket, request('expired-open', 'session.open', {
    name: 'model-expired',
    command: "printf 'BEGIN:'; printf 'x%.0s' {1..160}; printf ':END\\n'",
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  let firstError;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('expired-read-1', 'model.read', {
      name: 'model-expired',
    }));
    if (response.ok || response.error.code !== 'CURSOR_EXPIRED') return false;
    firstError = response.error;
    return true;
  }, { description: 'expired model cursor error' });
  assert.ok(firstError.details.baseOffset > 0);
  assert.ok(Buffer.byteLength(firstError.details.recovery.text) <= 4096);

  const again = await brokerRequest(sandbox.brokerSocket, request('expired-read-2', 'model.read', {
    name: 'model-expired',
  }));
  assert.equal(again.ok, false, JSON.stringify(again));
  assert.equal(again.error.code, 'CURSOR_EXPIRED');
  assert.equal(again.error.details.baseOffset, firstError.details.baseOffset);
  assert.equal(again.error.details.endOffset, firstError.details.endOffset);
});

test('broker restart reconciles mixed live and dead retained panes idempotently', async (t) => {
  const sandbox = await makeSandbox(t);
  const broker1 = await startBroker(t, sandbox);

  for (const [name, command] of [
    ['mixed-live', "i=0; while :; do printf 'live:%s\\n' \"$i\"; i=$((i+1)); sleep 0.05; done"],
    ['mixed-zero', "printf 'zero-final\\n'; exit 0"],
    ['mixed-seven', "printf 'seven-final\\n'; exit 7"],
  ]) {
    const opened = await brokerRequest(sandbox.brokerSocket, request(`open-${name}`, 'session.open', {
      name,
      cwd: '/tmp',
      command,
    }));
    assert.equal(opened.ok, true, JSON.stringify(opened));
  }

  let listedBefore;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('list-before-mixed', 'session.list'));
    if (!response.ok) return false;
    const byName = new Map(response.result.sessions.map((session) => [session.name, session]));
    if (byName.get('mixed-live')?.paneDead !== false) return false;
    if (byName.get('mixed-zero')?.paneDead !== true || byName.get('mixed-zero')?.paneDeadStatus !== 0) return false;
    if (byName.get('mixed-seven')?.paneDead !== true || byName.get('mixed-seven')?.paneDeadStatus !== 7) return false;
    listedBefore = response;
    return true;
  }, { description: 'mixed live/dead pane states' });
  assert.equal(listedBefore.ok, true);

  const tmuxPidBefore = Number(tmuxValue(sandbox.socketPath, 'mixed-live:0.0', '#{pid}'));
  const livePanePidBefore = Number(tmuxValue(sandbox.socketPath, 'mixed-live:0.0', '#{pane_pid}'));
  assert.ok(processExists(tmuxPidBefore));
  assert.ok(processExists(livePanePidBefore));

  async function readUntil(name, marker) {
    let captured;
    await waitFor(async () => {
      const response = await brokerRequest(sandbox.brokerSocket, request(`read-${name}`, 'session.read', {
        name, cursor: 0, maxBytes: 65536,
      }));
      if (!response.ok || !response.result.text.includes(marker)) return false;
      captured = response.result;
      return true;
    }, { description: `${name} final transcript` });
    return captured;
  }

  const liveBefore = await readUntil('mixed-live', 'live:');
  const zeroFinal = await readUntil('mixed-zero', 'zero-final');
  const sevenFinal = await readUntil('mixed-seven', 'seven-final');

  broker1.kill('SIGTERM');
  await onceExit(broker1);
  assert.ok(processExists(tmuxPidBefore));
  assert.ok(processExists(livePanePidBefore));

  const broker2 = await startBroker(t, sandbox);
  const tmuxPidAfterFirst = Number(tmuxValue(sandbox.socketPath, 'mixed-live:0.0', '#{pid}'));
  const livePanePidAfterFirst = Number(tmuxValue(sandbox.socketPath, 'mixed-live:0.0', '#{pane_pid}'));
  assert.equal(tmuxPidAfterFirst, tmuxPidBefore);
  assert.equal(livePanePidAfterFirst, livePanePidBefore);

  const listedAfterFirst = await brokerRequest(sandbox.brokerSocket, request('list-after-first', 'session.list'));
  assert.equal(listedAfterFirst.ok, true, JSON.stringify(listedAfterFirst));
  const firstByName = new Map(listedAfterFirst.result.sessions.map((session) => [session.name, session]));
  assert.equal(firstByName.get('mixed-live')?.paneDead, false);
  assert.equal(firstByName.get('mixed-zero')?.paneDead, true);
  assert.equal(firstByName.get('mixed-zero')?.paneDeadStatus, 0);
  assert.equal(firstByName.get('mixed-seven')?.paneDead, true);
  assert.equal(firstByName.get('mixed-seven')?.paneDeadStatus, 7);

  for (const [name, marker, finalRead] of [
    ['mixed-zero', 'zero-final', zeroFinal],
    ['mixed-seven', 'seven-final', sevenFinal],
  ]) {
    const preserved = await brokerRequest(sandbox.brokerSocket, request(`read-${name}-preserved-after-first`, 'session.read', {
      name, cursor: 0, maxBytes: 65536,
    }));
    assert.equal(preserved.ok, true, JSON.stringify(preserved));
    assert.match(preserved.result.text, new RegExp(marker));
    assert.equal(preserved.result.nextCursor, finalRead.nextCursor);

    const response = await brokerRequest(sandbox.brokerSocket, request(`read-${name}-after-first`, 'session.read', {
      name, cursor: finalRead.nextCursor, maxBytes: 65536,
    }));
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.result.text, '');
    assert.equal(response.result.nextCursor, finalRead.nextCursor);
  }

  let liveAfterFirst;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('read-live-after-first', 'session.read', {
      name: 'mixed-live', cursor: liveBefore.nextCursor, maxBytes: 65536,
    }));
    if (!response.ok || response.result.text.length === 0) return false;
    liveAfterFirst = response.result;
    return true;
  }, { description: 'live transcript after first restart' });
  assert.match(liveAfterFirst.text, /live:/);
  assert.ok(liveAfterFirst.nextCursor > liveBefore.nextCursor);

  broker2.kill('SIGTERM');
  await onceExit(broker2);
  const broker3 = await startBroker(t, sandbox);
  assert.notEqual(broker3.pid, broker2.pid);
  assert.equal(Number(tmuxValue(sandbox.socketPath, 'mixed-live:0.0', '#{pid}')), tmuxPidBefore);
  assert.equal(Number(tmuxValue(sandbox.socketPath, 'mixed-live:0.0', '#{pane_pid}')), livePanePidBefore);

  const listedAfterSecond = await brokerRequest(sandbox.brokerSocket, request('list-after-second', 'session.list'));
  assert.equal(listedAfterSecond.ok, true, JSON.stringify(listedAfterSecond));
  const secondByName = new Map(listedAfterSecond.result.sessions.map((session) => [session.name, session]));
  assert.equal(secondByName.get('mixed-live')?.paneDead, false);
  assert.equal(secondByName.get('mixed-zero')?.paneDeadStatus, 0);
  assert.equal(secondByName.get('mixed-seven')?.paneDeadStatus, 7);

  for (const [name, marker, finalRead] of [
    ['mixed-zero', 'zero-final', zeroFinal],
    ['mixed-seven', 'seven-final', sevenFinal],
  ]) {
    const preserved = await brokerRequest(sandbox.brokerSocket, request(`read-${name}-preserved-after-second`, 'session.read', {
      name, cursor: 0, maxBytes: 65536,
    }));
    assert.equal(preserved.ok, true, JSON.stringify(preserved));
    assert.match(preserved.result.text, new RegExp(marker));
    assert.equal(preserved.result.nextCursor, finalRead.nextCursor);

    const response = await brokerRequest(sandbox.brokerSocket, request(`read-${name}-after-second`, 'session.read', {
      name, cursor: finalRead.nextCursor, maxBytes: 65536,
    }));
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.result.text, '');
    assert.equal(response.result.nextCursor, finalRead.nextCursor);
  }

  let liveAfterSecond;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('read-live-after-second', 'session.read', {
      name: 'mixed-live', cursor: liveAfterFirst.nextCursor, maxBytes: 65536,
    }));
    if (!response.ok || response.result.text.length === 0) return false;
    liveAfterSecond = response.result;
    return true;
  }, { description: 'live transcript after second restart' });
  assert.match(liveAfterSecond.text, /live:/);
  assert.ok(liveAfterSecond.nextCursor > liveAfterFirst.nextCursor);

  for (const name of ['mixed-live', 'mixed-zero', 'mixed-seven']) {
    const closed = await brokerRequest(sandbox.brokerSocket, request(`close-${name}`, 'session.close', { name }));
    assert.equal(closed.ok, true, JSON.stringify(closed));
  }
});

test('immediate process output is captured from its first bytes', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);

  const marker = 'FIRST_BYTES_IMMEDIATE';
  const opened = await brokerRequest(sandbox.brokerSocket, request('open-burst', 'session.open', {
    name: 'burst',
    command: `printf '${marker}\\n'`,
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  let read;
  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('read-burst', 'session.read', {
      name: 'burst', cursor: 0, maxBytes: 65536,
    }));
    if (!response.ok || !response.result.text.includes(marker)) return false;
    read = response.result;
    return true;
  }, { description: 'immediate output marker' });
  assert.ok(read.text.indexOf(marker) >= 0);

  await waitFor(async () => {
    const listed = await brokerRequest(sandbox.brokerSocket, request('list-burst', 'session.list'));
    const session = listed.result.sessions.find((item) => item.name === 'burst');
    return session?.paneDead === true && session?.paneDeadStatus === 0;
  }, { description: 'dead pane status for immediate command' });
});

test('broker protocol supports send, resize, close, and human lease round-trip', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);

  const opened = await brokerRequest(sandbox.brokerSocket, request('open-cat', 'session.open', {
    name: 'interactive', command: 'cat', cols: 80, rows: 24,
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  assert.equal((await brokerRequest(sandbox.brokerSocket, request('send-text', 'session.send', {
    name: 'interactive', text: 'hello terminal',
  }))).ok, true);
  assert.equal((await brokerRequest(sandbox.brokerSocket, request('send-enter', 'session.send', {
    name: 'interactive', key: 'Enter',
  }))).ok, true);

  await waitFor(async () => {
    const response = await brokerRequest(sandbox.brokerSocket, request('read-cat', 'session.read', {
      name: 'interactive', cursor: 0, maxBytes: 65536,
    }));
    return response.ok && response.result.text.includes('hello terminal');
  }, { description: 'cat echo' });

  const resized = await brokerRequest(sandbox.brokerSocket, request('resize', 'session.resize', {
    name: 'interactive', cols: 101, rows: 37,
  }));
  assert.equal(resized.ok, true, JSON.stringify(resized));
  assert.equal(tmuxValue(sandbox.socketPath, 'interactive:0.0', '#{pane_width}x#{pane_height}'), '101x37');

  const acquired = await brokerRequest(sandbox.brokerSocket, request('lease-acquire', 'lease.acquire_human', {
    name: 'interactive', clientId: 'test-client',
  }));
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  assert.equal(typeof acquired.result.leaseId, 'string');

  const released = await brokerRequest(sandbox.brokerSocket, request('lease-release', 'lease.release_human', {
    name: 'interactive', leaseId: acquired.result.leaseId,
  }));
  assert.equal(released.ok, true, JSON.stringify(released));

  const closed = await brokerRequest(sandbox.brokerSocket, request('close-cat', 'session.close', { name: 'interactive' }));
  assert.equal(closed.ok, true, JSON.stringify(closed));
});

test('stopping the tmux lifetime boundary ends its PTY process', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);
  const opened = await brokerRequest(sandbox.brokerSocket, request('open-boundary', 'session.open', {
    name: 'boundary', command: 'while :; do sleep 60; done',
  }));
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const panePid = Number(tmuxValue(sandbox.socketPath, 'boundary:0.0', '#{pane_pid}'));
  assert.ok(processExists(panePid));

  const { spawnSync } = await import('node:child_process');
  const stopped = spawnSync('tmux', ['-N', '-S', sandbox.socketPath, 'kill-server'], { encoding: 'utf8' });
  assert.equal(stopped.status, 0, stopped.stderr);
  await waitFor(() => !processExists(panePid), { description: 'PTY process exit after tmux stop' });
});
