import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHttpDiagnosticLog } from '../http-diagnostics.mjs';

test('HTTP diagnostic retention and queued records stay bounded', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-diagnostics-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'http.log');
  const logger = createHttpDiagnosticLog(file, { maxBytes: 160, maxFiles: 3, maxQueued: 2 });
  for (let i = 0; i < 20; i++) logger.log({ event: 'request', index: i });
  await logger.flush();
  logger.log({ event: 'after-overflow' });
  await logger.flush();
  assert.match(await fs.readFile(file, 'utf8'), /"dropped_records":18/);
  for (let i = 0; i < 20; i++) {
    logger.log({ event: 'request', index: i });
    await logger.flush();
  }
  const names = await fs.readdir(dir);
  assert.equal(names.length, 3);
  for (const name of names) assert.ok((await fs.stat(path.join(dir, name))).size <= 160);
});

test('HTTP diagnostic storage failures never reject request-side logging', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-diagnostics-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'not-a-directory'), 'x');
  const logger = createHttpDiagnosticLog(path.join(dir, 'not-a-directory', 'log'));
  logger.log({ event: 'request' });
  await logger.flush();
});
