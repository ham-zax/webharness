import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../scripts/wh-browser.cjs', import.meta.url));

test('standalone WH Browser discovers tools and schemas without a bridge or adapter connection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wh-browser-cli-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MCP|BRIDGE|WH)_/.test(key)));
  Object.assign(env, { HOME: home, XDG_RUNTIME_DIR: root, WH_BROWSER_IDLE_MS: '10000' });
  const run = (...args) => execute(process.execPath, [cli, ...args], { env, timeout: 20000 });
  try {
    assert.match((await run('status')).stdout, /fast: stopped/);
    assert.match((await run('fast', 'tools')).stdout, /observe\(/);
    assert.match((await run('status')).stdout, /fast: running/);
    const schema = JSON.parse((await run('fast', 'schema', 'observe')).stdout);
    assert.equal(schema.name, 'observe');
    assert.ok(schema.inputSchema.properties.browser_target);
    await run('fast', 'stop');
    assert.match((await run('status')).stdout, /fast: stopped/);
  } finally {
    // This runtime directory owns only the daemon created by this test.
    await run('fast', 'stop').catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
