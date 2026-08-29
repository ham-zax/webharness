import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  brokerRequest,
  makeSandbox,
  startBroker,
  waitFor,
} from './helpers.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const WSL_TERM = path.join(REPO_ROOT, 'bin', 'wsl-term');

function request(id, op, params = {}) {
  return { id, op, params };
}

test('wsl-term wrapper is executable and delegates to the Terminal CLI', async () => {
  const info = await stat(WSL_TERM);
  assert.notEqual(info.mode & 0o111, 0);
  const source = await readFile(WSL_TERM, 'utf8');
  assert.match(source, /providers\/terminal\/cli\.mjs/);
});

test('wsl-term list reads broker state and preserves exact dead exit status', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);

  assert.equal((await brokerRequest(sandbox.brokerSocket, request('open-live', 'session.open', {
    name: 'cli-live', command: 'cat',
  }))).ok, true);
  assert.equal((await brokerRequest(sandbox.brokerSocket, request('open-dead', 'session.open', {
    name: 'cli-dead', command: "printf 'CLI_DEAD\\n'; exit 7",
  }))).ok, true);

  await waitFor(async () => {
    const listed = await brokerRequest(sandbox.brokerSocket, request('wait-dead', 'session.list'));
    return listed.ok && listed.result.sessions.find((session) => session.name === 'cli-dead')?.paneDeadStatus === 7;
  }, { description: 'cli dead pane status' });

  const result = spawnSync(WSL_TERM, ['list'], {
    env: { ...sandbox.env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cli-live.*live/);
  assert.match(result.stdout, /cli-dead.*dead.*exit=7/);
});
