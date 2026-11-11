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

async function writeFakeInner1Mcp(dir, { stallStartup = false } = {}) {
  const pidFile = path.join(dir, 'inner.pid');
  const entry = path.join(dir, 'fake-inner-1mcp.mjs');
  await fs.writeFile(
    entry,
    `import fs from 'node:fs';
import { Server } from ${JSON.stringify(mcpServerModuleUrl)};
import { serveStdio } from ${JSON.stringify(mcpStdioModuleUrl)};

fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (${JSON.stringify(stallStartup)}) {
  setInterval(() => {}, 30000);
} else {
  const handle = serveStdio(() => {
    const server = new Server({ name: 'fake-inner', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({
      tools: [{ name: 'browser_1mcp_ping', description: 'Ping.', inputSchema: { type: 'object' } }],
    }));
    return server;
  });
  process.stdin.once('end', () => { void handle.close(); });
  process.once('SIGTERM', () => { void handle.close().finally(() => process.exit(0)); });
}
`,
    'utf8',
  );
  const configPath = path.join(dir, 'mcp.json');
  await fs.writeFile(configPath, JSON.stringify({ version: '1.0.0', mcpServers: { browser: { command: 'true' } } }), 'utf8');
  return { entry, configPath, pidFile };
}

for (const mode of ['eof', 'sigterm']) {
  test(`local-tools ${mode} shutdown reaps spawned inner 1MCP process with zero orphans`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `local-tools-${mode}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { entry, configPath, pidFile } = await writeFakeInner1Mcp(root);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: {
        ...process.env,
        MCP_LOCAL_INNER_CONFIG: configPath,
        MCP_LOCAL_ONE_MCP_ENTRY: entry,
        MCP_LOCAL_INNER_IDLE_MS: '60000',
      },
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'local-shutdown-test', version: '1.0.0' },
      { capabilities: {}, versionNegotiation: { pin: '2026-07-28' } },
    );
    await client.connect(transport);
    const brokerPid = transport.pid;
    const listed = await client.callTool({ name: 'tool_list', arguments: { server: 'browser' } });
    assert.equal(listed.isError, undefined);
    const innerPid = await waitPidFile(pidFile);

    if (mode === 'eof') {
      await transport.close();
    } else {
      process.kill(brokerPid, 'SIGTERM');
    }
    await waitReaped([brokerPid, innerPid]);
    await transport.close().catch(() => {});
  });
}

test('local-tools shutdown during inner 1MCP startup aborts pending connect and reaps the starting child', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-tools-abort-start-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { entry, configPath, pidFile } = await writeFakeInner1Mcp(root, { stallStartup: true });

  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      MCP_LOCAL_INNER_CONFIG: configPath,
      MCP_LOCAL_ONE_MCP_ENTRY: entry,
      MCP_LOCAL_INNER_IDLE_MS: '60000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const brokerPid = child.pid;
  // Trigger inner 1MCP startup via a modern tools/call message.
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'tool_list',
      arguments: { server: 'browser' },
      _meta: { 'io.modelcontextprotocol/protocol-version': '2026-07-28' },
    },
  })}\n`);

  const innerPid = await waitPidFile(pidFile);
  const startedCloseAt = Date.now();
  child.kill('SIGTERM');
  await once(child, 'exit');
  const elapsedMs = Date.now() - startedCloseAt;
  assert.ok(elapsedMs < 4000, `SIGTERM during inner startup must not stall (took ${elapsedMs}ms)`);
  await waitReaped([brokerPid, innerPid]);
});
