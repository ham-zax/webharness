import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CODEDB_SHA256,
  CODEDB_VERSION,
  CodeDbChild,
  defaultCodeDbBin,
  verifyCodeDbBinary
} from '../codedb-child.mjs';
import { createCodeRouter } from '../server.mjs';

const execFileAsync = promisify(execFile);

function codeDbEnv() {
  return {
    ...process.env,
    CODEDB_TOOLS_PROFILE: 'core',
    CODEDB_MCP_LEAN: '1',
    CODEDB_NO_TELEMETRY: '1'
  };
}

async function stateRepo(t, prefix, files = {}) {
  const base = process.env.CODE_ROUTER_TEST_STATE_DIR ?? path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'),
    'mcp-dev-bridge',
    'tests',
    'code-router'
  );
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['-C', root, 'init', '-q']);
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'router-test@example.invalid']);
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Router Test']);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await execFileAsync('git', ['-C', root, 'add', '.']);
  await execFileAsync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  return fs.realpath(root);
}

async function indexRepo(root, bin = defaultCodeDbBin()) {
  await execFileAsync(bin, [root, 'index'], { env: codeDbEnv(), maxBuffer: 8 * 1024 * 1024 });
}

function textOf(result) {
  return (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

async function routerSearch(router, cwd, query) {
  const routed = await router.call({
    cwd,
    tool: 'codedb_search',
    arguments: { query, max_results: 20 }
  });
  return textOf(routed.result);
}

function searchCount(text) {
  const match = text.match(/(?:^|\n)(\d+) results? for /);
  if (!match) throw new Error(`unexpected CodeDB search response: ${text}`);
  return Number(match[1]);
}

async function waitForSearch(router, cwd, query, predicate, { timeoutMs = 10000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await routerSearch(router, cwd, query);
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`CodeDB search did not converge for ${query}; last result: ${last}`);
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached before timeout');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function rootedChildPids(root) {
  const bin = defaultCodeDbBin();
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,args='], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split(/\n/).flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) return [];
    return match[2].includes(bin) && match[2].includes(`${root} mcp`) ? [Number(match[1])] : [];
  });
}

test('verifies the pinned CodeDB 0.2.5840 binary and checksum', async () => {
  const verified = await verifyCodeDbBinary(defaultCodeDbBin());
  assert.equal(verified.version, CODEDB_VERSION);
  assert.equal(verified.sha256, CODEDB_SHA256);
  assert.match(verified.path, /codedb-v0\.2\.5840$/);
});

test('real CodeDB child is rooted at its repository and rejects per-call project switching', async t => {
  const marker = 'TASK9_CHILD_ROOTED_MARKER';
  const root = await stateRepo(t, 'child-', { 'src/a.ts': `export const ${marker} = true;\n` });
  await indexRepo(root);
  const child = await CodeDbChild.start({ root });
  t.after(() => child.close());

  assert.equal(child.root, root);
  assert.equal(child.alive, true);
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);

  const result = await child.callTool('codedb_search', { query: marker, max_results: 10 });
  assert.match(textOf(result), new RegExp(marker));

  await assert.rejects(
    () => child.callTool('codedb_search', { query: marker, project: root }),
    error => {
      assert.equal(error.code, 'PROJECT_OVERRIDE_FORBIDDEN');
      assert.match(error.message, /rooted child.*project/i);
      return true;
    }
  );

  await child.close();
  assert.equal(child.alive, false);
});

test('router keeps two rooted watchers independent and follows create then modify without codedb_read', async t => {
  const rootA = await stateRepo(t, 'fresh-a-', { 'src/base.ts': 'export const BASE_A = true;\n' });
  const rootB = await stateRepo(t, 'fresh-b-', { 'src/base.ts': 'export const BASE_B = true;\n' });
  await Promise.all([indexRepo(rootA), indexRepo(rootB)]);
  const router = await createCodeRouter();
  t.after(() => router.shutdown());

  const aOld = 'TASK9_REPO_A_CREATED_OLD';
  const aNew = 'TASK9_REPO_A_CREATED_NEW';
  const bOld = 'TASK9_REPO_B_CREATED_OLD';
  const bNew = 'TASK9_REPO_B_CREATED_NEW';

  assert.equal(searchCount(await routerSearch(router, rootA, aOld)), 0);
  assert.equal(searchCount(await routerSearch(router, rootB, bOld)), 0);

  await fs.writeFile(path.join(rootA, 'src', 'watch-a.ts'), `export const ${aOld} = true;\n`, { flag: 'wx' });
  await waitForSearch(router, rootA, aOld, text => searchCount(text) > 0);
  assert.equal(searchCount(await routerSearch(router, rootB, aOld)), 0);

  await fs.writeFile(path.join(rootA, 'src', 'watch-a.ts'), `export const ${aNew} = true;\n`);
  await waitForSearch(router, rootA, aNew, text => searchCount(text) > 0);
  await waitForSearch(router, rootA, aOld, text => searchCount(text) === 0);

  await fs.writeFile(path.join(rootB, 'src', 'watch-b.ts'), `export const ${bOld} = true;\n`, { flag: 'wx' });
  await waitForSearch(router, rootB, bOld, text => searchCount(text) > 0);
  assert.equal(searchCount(await routerSearch(router, rootA, bOld)), 0);

  await fs.writeFile(path.join(rootB, 'src', 'watch-b.ts'), `export const ${bNew} = true;\n`);
  await waitForSearch(router, rootB, bNew, text => searchCount(text) > 0);
  await waitForSearch(router, rootB, bOld, text => searchCount(text) === 0);

  const children = router.inspect();
  assert.equal(children.length, 2);
  assert.notEqual(children[0].pid, children[1].pid);
  assert.ok(children.every(child => child.alive));
});

test('stdio facade reaps rooted CodeDB children when the client closes stdin', async t => {
  const marker = 'TASK10_STDIO_SHUTDOWN_MARKER';
  const root = await stateRepo(t, 'facade-close-', { 'src/close.ts': `export const ${marker} = true;\n` });
  await indexRepo(root);
  const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, MCP_CODE_DEFAULT_CWD: root },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'code-facade-close-test', version: '1.0.0' });
  let closed = false;
  let childPid = null;
  t.after(async () => {
    if (!closed) await client.close().catch(() => {});
    if (childPid && processExists(childPid)) {
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
  });

  await client.connect(transport);
  const result = await client.callTool({ name: 'code_search', arguments: { query: marker, cwd: root, limit: 10 } });
  assert.match(textOf(result), new RegExp(marker));
  const pids = await rootedChildPids(root);
  assert.equal(pids.length, 1);
  [childPid] = pids;

  await client.close();
  closed = true;
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(processExists(childPid), false);
});

test('router replaces a crashed real CodeDB child and reuses the same repository route', async t => {
  const marker = 'TASK9_RESTART_MARKER';
  const root = await stateRepo(t, 'restart-', { 'src/restart.ts': `export const ${marker} = true;\n` });
  await indexRepo(root);
  const router = await createCodeRouter();
  t.after(() => router.shutdown());

  await routerSearch(router, root, marker);
  const first = router.inspect()[0];
  assert.ok(first?.pid);
  process.kill(first.pid, 'SIGKILL');
  await waitFor(() => router.inspect()[0]?.alive === false);

  const text = await routerSearch(router, root, marker);
  const second = router.inspect()[0];
  assert.match(text, new RegExp(marker));
  assert.ok(second?.pid);
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.alive, true);
});
