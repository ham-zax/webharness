import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
const mcpServerModuleUrl = new URL('../node_modules/@modelcontextprotocol/server/dist/index.mjs', import.meta.url).href;
const mcpStdioModuleUrl = new URL('../node_modules/@modelcontextprotocol/server/dist/stdio.mjs', import.meta.url).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitPidFile(file) {
  for (let i = 0; i < 200; i += 1) {
    try {
      const pid = Number((await fs.readFile(file, 'utf8')).trim());
      if (pid > 0) return pid;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for pid file ${file}`);
}

async function waitReaped(pids, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pids.filter(pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (alive.length === 0) return;
    await sleep(25);
  }
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), err => err.code === 'ESRCH', `process ${pid} leaked`);
  }
}

async function setupFakeChromeDevtoolsNpx(root, { stallStartup = false, managedNotRunning = false } = {}) {
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const pidFile = path.join(root, 'chrome-mcp.pid');
  const workerScript = path.join(root, 'fake-chrome-mcp.mjs');
  await fs.writeFile(
    workerScript,
    `import fs from 'node:fs';
import { Server } from ${JSON.stringify(mcpServerModuleUrl)};
import { serveStdio } from ${JSON.stringify(mcpStdioModuleUrl)};

fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (${JSON.stringify(stallStartup)}) {
  setInterval(() => {}, 30000);
} else {
  const handle = serveStdio(() => {
    const server = new Server({ name: 'fake-chrome-devtools', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({
      tools: [{ name: 'list_pages', description: 'List pages.', inputSchema: { type: 'object', properties: {} } }],
    }));
    server.setRequestHandler('tools/call', async () => ({
      content: [{ type: 'text', text: 'pages ok' }],
    }));
    return server;
  });
  process.stdin.once('end', () => { void handle.close(); });
  process.once('SIGTERM', () => { void handle.close().finally(() => process.exit(0)); });
}
`,
    'utf8',
  );
  const npxShim = path.join(binDir, 'npx');
  await fs.writeFile(
    npxShim,
    `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(workerScript)} "$@"
`,
    { mode: 0o755 },
  );

  const cfgDir = path.join(root, 'home', '.config', 'mcp-dev-bridge');
  await fs.mkdir(cfgDir, { recursive: true });
  if (managedNotRunning) {
    await fs.writeFile(
      path.join(cfgDir, 'browsers.json'),
      JSON.stringify({
        default: { browser: 'cloakbrowser', profile: 'work' },
        profiles: { work: { browser: 'cloakbrowser' } },
      }),
      'utf8',
    );
  } else {
    await fs.writeFile(
      path.join(cfgDir, 'browsers.json'),
      JSON.stringify({ default: { browser: 'chrome' }, profiles: {} }),
      'utf8',
    );
  }
  return {
    pidFile,
    env: {
      ...process.env,
      HOME: path.join(root, 'home'),
      XDG_STATE_HOME: path.join(root, 'state'),
      MCP_BROWSER_DEFAULT_TARGET: 'linux',
      PATH: `${binDir}:${process.env.PATH}`,
    },
  };
}

for (const mode of ['eof', 'sigterm']) {
  test(`browser facade ${mode} shutdown reaps spawned Chrome DevTools child with zero orphans`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `browser-${mode}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { pidFile, env } = await setupFakeChromeDevtoolsNpx(root);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env,
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'browser-shutdown-test', version: '1.0.0' },
      { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(transport);
    const facadePid = transport.pid;
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 1);
    const childPid = await waitPidFile(pidFile);

    if (mode === 'eof') {
      await transport.close();
    } else {
      process.kill(facadePid, 'SIGTERM');
    }
    await waitReaped([facadePid, childPid]);
    await transport.close().catch(() => {});
  });
}

test('browser facade SIGTERM during ephemeral discoverToolsWithoutBrowser startup reaps the starting child without leaking', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-ephemeral-abort-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { pidFile, env } = await setupFakeChromeDevtoolsNpx(root, {
    stallStartup: true,
    managedNotRunning: true,
  });

  const child = spawn(process.execPath, [serverPath], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const facadePid = child.pid;
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/protocol-version': '2026-07-28' } },
  })}\n`);

  const ephemeralPid = await waitPidFile(pidFile);
  child.kill('SIGTERM');
  await once(child, 'exit');
  await waitReaped([facadePid, ephemeralPid]);
});
