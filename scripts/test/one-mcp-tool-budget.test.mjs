import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '../../providers/local-tools/node_modules/@modelcontextprotocol/client/dist/index.mjs';
import { createConnectorPolicyLoader } from '../../lib/bridge/connector-policy.mjs';
import { createWakeProxy } from '../../lib/bridge/wake-proxy.mjs';

const agentRoot = process.env.WEBHARNESS_1MCP_AGENT_ROOT
  ?? path.resolve(path.dirname(process.execPath), '../lib/node_modules/@1mcp/agent');
const skip = !fs.existsSync(path.join(agentRoot, 'package.json')) ? '1MCP is not installed' : false;
const patch = fileURLToPath(new URL('../patch-1mcp-tool-budget.mjs', import.meta.url));
const sdk = new URL('../../providers/local-tools/node_modules/@modelcontextprotocol/server/dist/', import.meta.url);
const idKey = 'webharness/call-id';
const budgetKey = 'webharness/rpc-budget-ms';

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  socket.close();
  await once(socket, 'close');
  return port;
}

test('real 1MCP HTTP and stdio hops preserve gateway tool budgets and call IDs', { skip, timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-budget-'));
  let backend;
  let proxy;
  let runtimeOutput = '';
  const stop = async () => {
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
    const stopped = once(backend, 'exit');
    backend.kill();
    const fallback = setTimeout(() => backend.kill('SIGKILL'), 2_000);
    try { await stopped; } finally { clearTimeout(fallback); }
  };
  try {
    const copy = path.join(dir, 'agent');
    fs.mkdirSync(copy);
    fs.copyFileSync(path.join(agentRoot, 'package.json'), path.join(copy, 'package.json'));
    fs.cpSync(path.join(agentRoot, 'build'), path.join(copy, 'build'), { recursive: true });
    fs.symlinkSync(path.join(agentRoot, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
    execFileSync(process.execPath, [patch, copy]);
    execFileSync(process.execPath, [patch, copy]); // Installer re-runs must be harmless.
    const { SCHEMA_LIMITS } = await import(pathToFileURL(path.join(copy, 'build/core/validation/schemaPolicy.js')));
    assert.equal(SCHEMA_LIMITS.compileMs, 1500);
    assert.equal(SCHEMA_LIMITS.evaluateMs, 250);
    const cmSource = fs.readFileSync(path.join(copy, 'build/sdk/legacy/client/runtime/clientManager.js'), 'utf8');
    assert.match(cmSource, /if \(isUnknownMessageIdError\(error\)\) \{\s*if \(this\.isShuttingDown\) \{\s*return;\s*\}/);
    const loggerSource = fs.readFileSync(path.join(copy, 'build/logger/logger.js'), 'utf8');
    assert.match(loggerSource, /function isWebHarnessInfoStderr\(content\)/);
    assert.doesNotMatch(loggerSource, /return;\s*sink\.warn\(/);

    const config = path.join(dir, 'runtime');
    fs.mkdirSync(config, { mode: 0o700 });
    const fixture = path.join(dir, 'echo.mjs');
    fs.writeFileSync(fixture, `
import { McpServer } from '${new URL('index.mjs', sdk)}';
import { serveStdio } from '${new URL('stdio.mjs', sdk)}';
const handle = serveStdio(() => {
  const mcp = new McpServer({ name: 'echo', version: '1.0.0' });
  mcp.server.registerCapabilities({ tools: {} });
  mcp.server.setRequestHandler('tools/list', async () => ({
    tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }],
  }));
  mcp.server.setRequestHandler('tools/call', async (request, { mcpReq }) => {
    process.stderr.write(JSON.stringify({ event: 'call_started', layer: 'dev', tool: 'echo' }) + '\\n');
    process.stderr.write('echo-backend-real-warning\\n');
    return {
      content: [{ type: 'text', text: JSON.stringify({ args: request.params.arguments, meta: mcpReq._meta ?? request.params._meta }) }],
    };
  });
  return mcp;
}, { legacy: 'serve' });
process.stdin.once('end', () => { void handle.close(); });
`);
    const target = protocolVersion => ({ command: process.execPath, args: [fixture], protocolVersion });
    fs.writeFileSync(path.join(config, 'mcp.json'), JSON.stringify({
      version: '1.0.0', mcpServers: { local: target('2026-07-28'), dev: target('legacy'), other: target('2026-07-28') },
    }));
    const policy = path.join(dir, 'policy.yml');
    fs.writeFileSync(policy, 'default:\n  rpc_budget_seconds: 25\n');
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const start = async (coldStart = '1') => {
      backend = spawn(process.execPath, [path.join(copy, 'build/index.js'), 'serve',
        '--config-dir', config, '--transport', 'http', '--host', '127.0.0.1',
        '--port', String(port), '--external-url', origin, '--log-level', 'warn'], {
        env: { ...process.env, BRIDGE_COLD_START: coldStart, WEBHARNESS_MCP_URI_SEPARATOR: '_', ONE_MCP_PRODUCT_TELEMETRY: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [backend.stdout, backend.stderr]) {
        stream.on('data', data => { runtimeOutput = (runtimeOutput + data).slice(-8_000); });
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        const ready = await fetch(origin + '/health/ready', { signal: AbortSignal.timeout(200) }).catch(() => null);
        if (ready?.ok) return;
        if (backend.exitCode !== null) break;
        await delay(50);
      }
      throw new Error('Isolated runtime did not become ready');
    };

    let starts = 0;
    let resolveIdleStopped = null;
    proxy = createWakeProxy({
      port: 0, backendPort: port, idleMs: 250, publicUrl: 'https://mcp.example.test',
      startBackend: async () => { starts++; await start(); },
      stopBackend: async () => {
        await stop();
        if (resolveIdleStopped) {
          const done = resolveIdleStopped;
          resolveIdleStopped = null;
          done();
        }
      },
      connectorPolicy: createConnectorPolicyLoader(policy), onDiagnostic: () => {},
    });
    await proxy.listen();
    const gateway = `http://127.0.0.1:${proxy.server.address().port}`;
    const id = randomUUID();
    const spoof = randomUUID();
    const args = { value: 'preserved' };
    const invoke = async (url, mode, cases) => {
      const client = new Client({ name: 'WebHarness budget test', version: '1.0.0' }, { versionNegotiation: { mode } });
      const transport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
        requestInit: { headers: { 'x-webharness-request-id': id, 'x-webharness-rpc-budget-ms': '300000' } },
      });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        for (const [name, hint, budget, callId] of cases) {
          assert.ok(tools.some(tool => tool.name === name), JSON.stringify(tools.map(tool => tool.name)));
          const result = await client.callTool({
            name, arguments: args, _meta: { [idKey]: spoof, [budgetKey]: hint, 'caller-only': true },
          });
          assert.equal(result.isError, undefined, JSON.stringify(result));
          const echo = JSON.parse(result.content[0].text);
          assert.deepEqual(echo.args, args);
          assert.equal(echo.meta?.[idKey], callId, name);
          assert.equal(echo.meta?.[budgetKey], budget, name);
          assert.equal(echo.meta?.['caller-only'], undefined, name);
        }
      } finally { await client.close(); }
    };
    for (const mode of ['legacy', { pin: '2026-07-28' }]) {
      await invoke(gateway, mode, [
        ['local_echo', 12_000, 12_000, id],
        ['dev_echo', 60_000, 25_000, id],
        ['other_echo', 12_000, undefined, undefined],
      ]);
    }

    // Real 1MCP persisted-session teardown across cold sleep:
    // create a persisted session, wait for idle sleep, verify unauthenticated DELETE stays asleep
    // with a Bearer challenge, then verify authenticated DELETE wakes 1MCP and retires the session.
    const idleStopped = new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('1MCP did not enter idle sleep')), 5_000);
      guard.unref?.();
      resolveIdleStopped = () => { clearTimeout(guard); resolve(); };
    });
    const initResp = await fetch(gateway + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 101, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'teardown-test', version: '1.0.0' } },
      }),
    });
    assert.equal(initResp.status, 200);
    await initResp.text();
    const persistedSid = initResp.headers.get('mcp-session-id');
    assert.ok(persistedSid, '1MCP must issue a persisted mcp-session-id');

    await idleStopped;
    assert.equal((await fetch(gateway + '/health/ready').then(r => r.json())).backend, 'asleep');
    const startsBeforeDelete = starts;

    const coldUnauthDel = await fetch(gateway + '/mcp', { method: 'DELETE', headers: { 'mcp-session-id': persistedSid } });
    assert.equal(coldUnauthDel.status, 401);
    assert.match(coldUnauthDel.headers.get('www-authenticate') ?? '', /Bearer error="invalid_token".*resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/);
    assert.equal(starts, startsBeforeDelete, 'unauthenticated cold DELETE must not wake 1MCP');

    const coldAuthDel = await fetch(gateway + '/mcp', {
      method: 'DELETE',
      headers: { authorization: 'Bearer test-token', 'mcp-session-id': persistedSid },
    });
    assert.ok(coldAuthDel.status >= 200 && coldAuthDel.status < 300, `expected 2xx DELETE teardown, got ${coldAuthDel.status}`);
    assert.equal(starts, startsBeforeDelete + 1, 'authenticated cold DELETE must wake 1MCP to retire persisted session');

    const afterTeardown = await fetch(gateway + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': persistedSid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list', params: {} }),
    });
    assert.equal(afterTeardown.status, 404, 'retired persisted session must not remain resumable after cold DELETE');

    await proxy.close();
    proxy = undefined;
    assert.doesNotMatch(runtimeOutput, /"event":"call_started"/);
    assert.match(runtimeOutput, /echo-backend-real-warning/);
    assert.doesNotMatch(runtimeOutput, /received a response for an unknown message ID/);
    await start('0');
    await invoke(origin, 'legacy', [['local_echo', 12_000, undefined, undefined]]);
  } catch (error) {
    error.message += '\n1MCP output:\n' + runtimeOutput;
    throw error;
  } finally {
    await proxy?.close();
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
