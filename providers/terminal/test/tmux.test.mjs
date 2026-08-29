import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { TmuxBackend } from '../tmux.mjs';
import { makeSandbox, tmuxValue, waitFor } from './helpers.mjs';

test('tmux backend defaults cwd to the current user home', () => {
  const previousHome = process.env.HOME;
  process.env.HOME = '/tmp/wsl-portable-terminal-home';
  try {
    const tmux = new TmuxBackend({ stateRoot: '/tmp/wsl-portable-terminal-state' });
    assert.equal(tmux.defaultCwd, '/tmp/wsl-portable-terminal-home');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('dedicated tmux backend covers create, send, resize, capture, list, dead status, and close', async (t) => {
  const sandbox = await makeSandbox(t);
  const tmux = new TmuxBackend({
    socketPath: sandbox.socketPath,
    stateRoot: sandbox.stateRoot,
    defaultCwd: '/tmp',
    transcriptBudgetBytes: 4 * 1024 * 1024,
  });

  await tmux.openSession({ name: 'ops', command: 'cat', cols: 80, rows: 24 });
  assert.equal((await tmux.listSessions()).some((session) => session.name === 'ops'), true);
  assert.deepEqual(await tmux.listClients(), []);

  await tmux.send({ name: 'ops', text: 'screen-marker' });
  await tmux.send({ name: 'ops', key: 'Enter' });
  await waitFor(async () => (await tmux.captureScreen('ops')).includes('screen-marker'), {
    description: 'capture-pane marker',
  });

  await tmux.resize({ name: 'ops', cols: 113, rows: 41 });
  assert.equal(tmuxValue(sandbox.socketPath, 'ops:0.0', '#{pane_width}x#{pane_height}'), '113x41');
  const info = await tmux.sessionInfo('ops');
  assert.equal(info.paneDead, false);
  assert.equal(info.remainOnExit, true);

  await tmux.closeSession('ops');
  assert.equal((await tmux.listSessions()).some((session) => session.name === 'ops'), false);

  const exit7Opened = await tmux.openSession({
    name: 'exit7',
    command: "sleep 0.1; i=1; while [ $i -le 80 ]; do printf 'exit7-history-%03d\\n' $i; i=$((i+1)); done; printf 'exit7-final\\n'; exit 7",
  });
  const exit7PaneId = tmuxValue(sandbox.socketPath, 'exit7:0.0', '#{pane_id}');
  await waitFor(async () => {
    const exited = await tmux.sessionInfo('exit7');
    return exited.paneDead === true && !(await tmux.hasTranscriptPipe('exit7'));
  }, { description: 'finalized dead pane' });
  const exited = await tmux.sessionInfo('exit7');
  assert.equal(exited.remainOnExit, true);
  assert.equal(exited.paneDeadStatus, 7);
  assert.equal(exited.panePid, exit7Opened.panePid);
  assert.equal(tmuxValue(sandbox.socketPath, 'exit7:0.0', '#{pane_id}'), exit7PaneId);
  const exit7State = await tmux.sessionState('exit7');
  await waitFor(async () => (await readFile(path.join(exit7State.dataDir, 'transcript.bin'), 'utf8')).includes('exit7-final'), {
    description: 'finalized exit transcript',
  });
  const exit7Screen = await tmux.captureScreen('exit7');
  assert.match(exit7Screen, /exit7-history-080/);
  assert.match(exit7Screen, /exit7-final/);
  const { stdout: exit7History } = await tmux.run(['capture-pane', '-p', '-S', '-', '-E', '-', '-t', 'exit7:0.0']);
  assert.match(exit7History, /exit7-history-001/);
  assert.equal(exit7History.split('exit7-history-080').length - 1, 1);
  assert.equal(exit7History.split('exit7-final').length - 1, 1);
  await tmux.closeSession('exit7');

  const burstBytes = 2 * 1024 * 1024;
  await tmux.openSession({
    name: 'burst-final',
    command: `${process.execPath} -e "process.stdout.write('x'.repeat(${burstBytes})); process.stdout.write('burst-final-marker\\n'); process.exit(7)"`,
  });
  await waitFor(async () => {
    const burst = await tmux.sessionInfo('burst-final');
    return burst.paneDead === true && !(await tmux.hasTranscriptPipe('burst-final'));
  }, { description: 'large final burst drain' });
  const burstState = await tmux.sessionState('burst-final');
  await waitFor(async () => (await readFile(path.join(burstState.dataDir, 'transcript.bin'))).includes(Buffer.from('burst-final-marker')), {
    description: 'large final burst transcript drain',
  });
  const burstTranscript = await readFile(path.join(burstState.dataDir, 'transcript.bin'));
  assert.ok(burstTranscript.length >= burstBytes);
  assert.equal(burstTranscript.includes(Buffer.from('burst-final-marker')), true);
  await tmux.closeSession('burst-final');

  const signalOpened = await tmux.openSession({
    name: 'signal15',
    command: "sleep 0.1; printf 'signal-final\\n'; exec sh -c 'kill -TERM $$'",
  });
  const signalPaneId = tmuxValue(sandbox.socketPath, 'signal15:0.0', '#{pane_id}');
  await waitFor(async () => {
    const signaled = await tmux.sessionInfo('signal15');
    return signaled.paneDead === true && !(await tmux.hasTranscriptPipe('signal15'));
  }, { description: 'finalized signal pane' });
  const signaled = await tmux.sessionInfo('signal15');
  assert.equal(signaled.paneDeadStatus, null);
  assert.equal(signaled.panePid, signalOpened.panePid);
  assert.equal(tmuxValue(sandbox.socketPath, 'signal15:0.0', '#{pane_id}'), signalPaneId);
  assert.equal(tmuxValue(sandbox.socketPath, 'signal15:0.0', '#{pane_dead_signal}'), '15');
  const signalState = await tmux.sessionState('signal15');
  await waitFor(async () => (await readFile(path.join(signalState.dataDir, 'transcript.bin'), 'utf8')).includes('signal-final'), {
    description: 'finalized signal transcript',
  });
  await tmux.closeSession('signal15');

  await tmux.run(['new-session', '-d', '-s', 'legacy-dead', 'bash']);
  await tmux.run(['set-option', '-w', '-t', 'legacy-dead:0', 'remain-on-exit', 'on']);
  await tmux.installTranscriptPipe('legacy-dead');
  const legacyPaneId = tmuxValue(sandbox.socketPath, 'legacy-dead:0.0', '#{pane_id}');
  const legacyPanePid = Number(tmuxValue(sandbox.socketPath, 'legacy-dead:0.0', '#{pane_pid}'));
  await tmux.send({ name: 'legacy-dead', text: "printf 'legacy-final\\n'; exit 9" });
  await tmux.send({ name: 'legacy-dead', key: 'Enter' });
  await waitFor(async () => tmuxValue(sandbox.socketPath, 'legacy-dead:0.0', '#{pane_dead}') === '1', {
    description: 'historical dead pane',
  });
  assert.equal(await tmux.hasTranscriptPipe('legacy-dead'), true);

  await tmux.reconcileSession('legacy-dead');
  const legacy = await tmux.sessionInfo('legacy-dead');
  assert.equal(legacy.paneDead, true);
  assert.equal(legacy.paneDeadStatus, 9);
  assert.equal(legacy.panePid, legacyPanePid);
  assert.equal(tmuxValue(sandbox.socketPath, 'legacy-dead:0.0', '#{pane_id}'), legacyPaneId);
  assert.equal(await tmux.hasTranscriptPipe('legacy-dead'), false);
  await waitFor(async () => (await readFile(path.join(tmux.sessionDir('legacy-dead'), 'transcript.bin'), 'utf8')).includes('legacy-final'), {
    description: 'historical final transcript',
  });
  await tmux.reconcileSession('legacy-dead');
  assert.equal(await tmux.hasTranscriptPipe('legacy-dead'), false);
  await tmux.closeSession('legacy-dead');
});

test('session metadata carries a stable generation across reconciliation and a new one after reopen', async (t) => {
  const sandbox = await makeSandbox(t);
  const tmux = new TmuxBackend({
    socketPath: sandbox.socketPath,
    stateRoot: sandbox.stateRoot,
    defaultCwd: '/tmp',
    transcriptBudgetBytes: 1024 * 1024,
  });

  await tmux.openSession({ name: 'generation-meta', command: 'cat' });
  const metadataFile = path.join(tmux.sessionDir('generation-meta'), 'session.json');
  const first = JSON.parse(await readFile(metadataFile, 'utf8'));
  assert.match(first.generation, /^[0-9a-f-]{36}$/i);

  await tmux.reconcileSession('generation-meta');
  const reconciled = JSON.parse(await readFile(metadataFile, 'utf8'));
  assert.equal(reconciled.generation, first.generation);

  await tmux.closeSession('generation-meta');
  await tmux.openSession({ name: 'generation-meta', command: 'cat' });
  const replacement = JSON.parse(await readFile(metadataFile, 'utf8'));
  assert.match(replacement.generation, /^[0-9a-f-]{36}$/i);
  assert.notEqual(replacement.generation, first.generation);
});

test('session names are constrained to the frozen contract', async (t) => {
  const sandbox = await makeSandbox(t);
  const tmux = new TmuxBackend({ socketPath: sandbox.socketPath, stateRoot: sandbox.stateRoot });
  await assert.rejects(() => tmux.openSession({ name: 'bad/name', command: 'true' }), /session name/i);
  await assert.rejects(() => tmux.openSession({ name: 'x'.repeat(65), command: 'true' }), /session name/i);
});
