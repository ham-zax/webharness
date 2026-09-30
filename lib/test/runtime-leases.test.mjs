import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { acquireRuntimeLease, hasActiveRuntimeLeases } from '../runtime-leases.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webharness-leases-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('stateful work pins the runtime until its lease is closed', async t => {
  const directory = await fixture(t);
  assert.equal(await hasActiveRuntimeLeases(directory), false);
  const lease = await acquireRuntimeLease({ directory, kind: 'browser-jev' });
  t.after(() => lease.close());
  assert.equal(await hasActiveRuntimeLeases(directory), true);
  const [file] = await fs.readdir(directory);
  assert.equal((await fs.stat(path.join(directory, file))).mode & 0o777, 0o600);
  await lease.close();
  await lease.close();
  assert.equal(await hasActiveRuntimeLeases(directory), false);
});

test('PID reuse does not keep an abandoned lease alive', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, `${randomUUID()}.json`), JSON.stringify({ pid: process.pid, startTicks: '0' }));
  assert.equal(await hasActiveRuntimeLeases(directory), false);
});

test('an unverifiable lease conservatively prevents eviction', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, `${randomUUID()}.json`), '{invalid');
  assert.equal(await hasActiveRuntimeLeases(directory), true);
});

test('an unconfigured lease directory does not change stand-alone providers', async () => {
  const lease = await acquireRuntimeLease({ directory: '' });
  await lease.close();
  assert.equal(await hasActiveRuntimeLeases(''), false);
});
