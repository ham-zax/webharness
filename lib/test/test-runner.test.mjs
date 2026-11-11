import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);

async function fixture(t, { invalidShell = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wh-test-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'scripts', 'tests', 'lib/bridge', 'providers', 'fakebin']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await copyFile(new URL('../../scripts/test-all.sh', import.meta.url), path.join(root, 'scripts/test-all.sh'));
  const helper = '#!/bin/sh\nexit 0\n';
  await writeFile(path.join(root, 'fakebin/node'), helper, { mode: 0o755 });
  await writeFile(path.join(root, 'fakebin/nproc'), '#!/bin/sh\nprintf "16\\n"\n', { mode: 0o755 });
  const suite = `#!/bin/bash
if ! mkdir "$HARNESS_TEST_GUARD"; then
  echo 'heavy suites overlapped' >&2
  exit 1
fi
trap 'rmdir "$HARNESS_TEST_GUARD"' EXIT
sleep 0.05
`;
  for (const name of ['harness', 'smoke-local', 'publication', 'lifecycle']) {
    await writeFile(path.join(root, `tests/${name}.sh`), suite);
  }
  await writeFile(path.join(root, 'scripts/skill-snapshot.sh'), helper);
  await writeFile(path.join(root, 'bin/first'), helper);
  await writeFile(path.join(root, 'lib/bridge/later.sh'), invalidShell ? '#!/bin/sh\nif then\n' : helper);
  await execute('git', ['init', '-q', root]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WEBMCP_')));
  Object.assign(env, { PATH: `${root}/fakebin:${env.PATH}`, HARNESS_TEST_GUARD: path.join(root, 'suite-active') });
  return () => execute('bash', [path.join(root, 'scripts/test-all.sh')], { env, timeout: 20000 });
}

test('test runner keeps heavy suites sequential by default on a 16-CPU host', async t => {
  const run = await fixture(t);
  assert.match((await run()).stdout, /All tests passed successfully!/);
});

test('test runner rejects invalid shell syntax after the first script', async t => {
  const run = await fixture(t, { invalidShell: true });
  await assert.rejects(run(), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /later\.sh/);
    assert.match(error.stderr, /Checking bash syntax/);
    return true;
  });
});
