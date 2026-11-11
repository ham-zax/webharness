import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { OperationCore } from '../core.mjs';
import { callMcpTool, closeMcpPools } from '../mcp-client.mjs';
import { parseRequest } from '../protocol.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function withinMs(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function detectInstalled1McpRoot() {
  if (process.env.WEBHARNESS_1MCP_ROOT) return process.env.WEBHARNESS_1MCP_ROOT;
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const candidate = join(globalRoot, '@1mcp', 'agent');
    if (existsSync(join(candidate, 'build', 'index.js'))) return candidate;
  } catch {
    // Portable CI environments do not install global @1mcp/agent.
  }
  return null;
}

async function allocateFreePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitReady(url, child, stderrChunks, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`1MCP exited early (${child.exitCode}): ${Buffer.concat(stderrChunks).toString('utf8')}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return;
    } catch {
      // Keep polling while 1MCP boots.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`1MCP did not become ready within ${timeoutMs}ms: ${Buffer.concat(stderrChunks).toString('utf8')}`);
}

async function terminateGroup(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 4000)),
  ]);
  if (!exited && child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    await once(child, 'exit').catch(() => {});
  }
}

const oneMcpRoot = detectInstalled1McpRoot();
const requireQualification = process.env.WEBHARNESS_REQUIRE_1MCP_QUALIFICATION === '1';

test(
  'real pinned 1MCP 0.39.8 serves compact instructions and overlaps six modern 2026-07-28 sessions with failure/cancel isolation',
  { skip: !oneMcpRoot && !requireQualification ? 'pinned @1mcp/agent is not installed globally' : false },
  async t => {
    assert.ok(oneMcpRoot && existsSync(join(oneMcpRoot, 'build', 'index.js')), 'WEBHARNESS_REQUIRE_1MCP_QUALIFICATION=1 requires pinned @1mcp/agent');
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const adapterPkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const tmp = mkdtempSync(join(tmpdir(), 'websession-real-1mcp-'));
    const configDir = join(tmp, '1mcp');
    const stateDir = join(tmp, 'adapter-state');
    mkdirSync(configDir, { recursive: true });

    const sessionOneEntered = deferred();
    const sessionOneGate = deferred();
    const cancelEntered = deferred();
    const cancelGate = deferred();
    const otherEntered = deferred();
    const otherGate = deferred();
    const invocations = new Map();

    const coordinator = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { session } = JSON.parse(raw || '{}');
      invocations.set(session, (invocations.get(session) ?? 0) + 1);
      if (session === 1) {
        sessionOneEntered.resolve();
        await sessionOneGate.promise;
      } else if (session === 5) {
        await sessionOneEntered.promise;
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('backend tool failed for session 5');
        return;
      } else if (session === 6) {
        await new Promise(resolve => { setTimeout(resolve, 5000).unref(); });
      } else if (session === 7) {
        cancelEntered.resolve();
        await cancelGate.promise;
      } else if (session === 8) {
        otherEntered.resolve();
        await otherGate.promise;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`session-${session}`);
    });
    coordinator.listen(0, '127.0.0.1');
    await once(coordinator, 'listening');
    const coordinatorUrl = `http://127.0.0.1:${coordinator.address().port}/call`;

    const backendScript = join(tmp, 'modern-stdio-fixture.mjs');
    writeFileSync(backendScript, `import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const req = createRequire(${JSON.stringify(adapterPkgPath)});
const { Server } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/server')).href);
const { serveStdio } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/server/stdio')).href);
const coordinatorUrl = process.env.FIXTURE_COORDINATOR_URL;
function createFixtureServer() {
  const server = new Server(
    { name: 'fixture', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: 'Real 1MCP gateway fixture instructions.' },
  );
  server.setRequestHandler('tools/list', async () => ({
    tools: [{
      name: 'read',
      description: 'Read-only concurrency probe',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: { session: { type: 'integer' } },
        required: ['session'],
        additionalProperties: false,
      },
    }],
  }));
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const res = await fetch(coordinatorUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.params.arguments ?? {}),
      signal: ctx.mcpReq.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(body || 'fixture error');
    return { content: [{ type: 'text', text: body }] };
  });
  return server;
}
const handle = serveStdio(createFixtureServer);
process.stdin.once('end', () => { void handle.close(); });
process.once('SIGTERM', () => { void handle.close().finally(() => process.exit(0)); });
`);

    const oneMcpPort = await allocateFreePort();
    const templateText = readFileSync(join(repoRoot, 'config', 'templates', 'instructions-template.md'), 'utf8');
    copyFileSync(join(repoRoot, 'config', 'templates', 'instructions-template.md'), join(configDir, 'instructions-template.md'));
    writeFileSync(join(configDir, 'config.toml'), [
      `port = ${oneMcpPort}`,
      '[admin]',
      'enabled = false',
      '[logging]',
      `file = ${JSON.stringify(join(tmp, 'one-mcp.log'))}`,
      'level = "error"',
      'maxSize = 1048576',
      'maxFiles = 2',
      '',
    ].join('\n'));
    writeFileSync(join(configDir, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        fixture: {
          type: 'stdio',
          protocolVersion: '2026-07-28',
          command: process.execPath,
          args: [backendScript],
          env: { FIXTURE_COORDINATOR_URL: coordinatorUrl },
        },
      },
      instructionTemplates: { webharness: { initialization: templateText, cli: templateText } },
      publishedInstructionTemplates: { webharness: { initialization: templateText, cli: templateText } },
      activeInstructionTemplate: 'webharness',
    }, null, 2)}\n`);

    const counts = { discover: 0, modernCalls: 0, legacyInitializes: 0 };
    const proxy = createServer((clientReq, clientRes) => {
      const chunks = [];
      clientReq.on('data', chunk => chunks.push(chunk));
      clientReq.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        if (clientReq.method === 'POST' && clientReq.url === '/mcp') {
          try {
            const parsed = JSON.parse(bodyBuffer.toString('utf8'));
            if (parsed?.method === 'server/discover') counts.discover += 1;
            if (parsed?.method === 'initialize') counts.legacyInitializes += 1;
            if (parsed?.method === 'tools/call' && clientReq.headers['mcp-protocol-version'] === '2026-07-28') {
              counts.modernCalls += 1;
            }
          } catch {
            // Non-JSON frames are forwarded untouched.
          }
        }
        const upstream = httpRequest({
          hostname: '127.0.0.1',
          port: oneMcpPort,
          path: clientReq.url,
          method: clientReq.method,
          headers: clientReq.headers,
        }, upstreamRes => {
          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(clientRes);
        });
        upstream.on('error', () => {
          if (!clientRes.headersSent) clientRes.writeHead(502);
          clientRes.end();
        });
        clientRes.on('close', () => {
          if (!clientRes.writableEnded) upstream.destroy();
        });
        upstream.end(bodyBuffer);
      });
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxyMcpUrl = `http://127.0.0.1:${proxy.address().port}/mcp`;

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MCP|BRIDGE|ONE_MCP)_/.test(k)));
    const stderrChunks = [];
    const oneMcpChild = spawn(
      process.execPath,
      [join(oneMcpRoot, 'build', 'index.js'), 'serve', '--config-dir', configDir],
      {
        env: { ...cleanEnv, HOME: tmp, XDG_STATE_HOME: join(tmp, 'xdg-state'), XDG_CONFIG_HOME: join(tmp, 'xdg-config') },
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    oneMcpChild.stderr.on('data', chunk => stderrChunks.push(chunk));

    let core;
    t.after(async () => {
      sessionOneGate.resolve();
      cancelGate.resolve();
      otherGate.resolve();
      await core?.close().catch(() => {});
      await closeMcpPools().catch(() => {});
      proxy.closeAllConnections();
      await new Promise(resolve => proxy.close(resolve));
      await terminateGroup(oneMcpChild);
      coordinator.closeAllConnections();
      await new Promise(resolve => coordinator.close(resolve));
      rmSync(tmp, { recursive: true, force: true });
    });

    await waitReady(`http://127.0.0.1:${oneMcpPort}/health/ready`, oneMcpChild, stderrChunks);

    core = new OperationCore({
      stateDir,
      mcpUrl: proxyMcpUrl,
      callbackUrl: 'http://127.0.0.1:9/callback',
      toolTimeoutMs: 1200,
    });
    const capabilities = Array.from({ length: 6 }, () => core.store.issueMainCapability(120));
    const discovered = await core.permittedTools(capabilities[0].token);
    assert.ok(discovered.tools.some(tool => tool.name === 'fixture_read'));
    assert.equal(
      discovered.instructions,
      '<fixture>\nReal 1MCP gateway fixture instructions.\n</fixture>\n\nTools are namespaced by server as `{server}_{tool}`.',
    );
    assert.equal(counts.legacyInitializes, 0, 'modern 1MCP 0.39.8 must negotiate 2026-07-28 without legacy fallback');

    const submitted = capabilities.map((cap, idx) => core.submit(
      cap.token,
      `real-1mcp-session-${idx + 1}`,
      parseRequest({ version: 1, tool: 'fixture_read', arguments: { session: idx + 1 } }),
      'json-post-v1',
    ));

    await withinMs(sessionOneEntered.promise, 15_000, 'session 1 never reached modern stdio backend behind 1MCP');
    const overlappedStates = await Promise.all([
      core.waitForOperation(submitted[1].operation.id, 15_000),
      core.waitForOperation(submitted[2].operation.id, 15_000),
      core.waitForOperation(submitted[3].operation.id, 15_000),
      core.waitForOperation(submitted[4].operation.id, 15_000),
    ]);
    assert.equal(core.store.getOperation(submitted[0].operation.id).state, 'running', 'session 1 remained held while sessions 2..5 finished');
    assert.deepEqual(overlappedStates.slice(0, 3).map(op => op.state), ['completed', 'completed', 'completed']);
    assert.equal(overlappedStates[3].state, 'unknown_outcome');

    sessionOneGate.resolve();
    const [firstDone, timedOutDone] = await Promise.all([
      core.waitForOperation(submitted[0].operation.id, 15_000),
      core.waitForOperation(submitted[5].operation.id, 15_000),
    ]);
    assert.equal(firstDone.state, 'completed');
    assert.equal(firstDone.result_text, 'session-1');
    assert.equal(timedOutDone.state, 'unknown_outcome');

    for (let session = 1; session <= 6; session += 1) {
      assert.equal(invocations.get(session), 1, `session ${session} must execute exactly once without replay`);
    }
    assert.ok(counts.modernCalls >= 6, 'all six calls must traverse 1MCP over modern 2026-07-28 HTTP');
    assert.equal(counts.legacyInitializes, 0);

    const discoversBeforeFollowUp = counts.discover;
    const followUp = core.submit(
      capabilities[0].token,
      'real-1mcp-followup',
      parseRequest({ version: 1, tool: 'fixture_read', arguments: { session: 2 } }),
      'json-post-v1',
    );
    assert.equal((await core.waitForOperation(followUp.operation.id, 15_000)).state, 'completed');
    assert.equal(counts.discover, discoversBeforeFollowUp, 'healthy pooled 1MCP connection is reused after request-isolated failure and timeout');

    const controller = new AbortController();
    const cancelled = callMcpTool({ mcpUrl: proxyMcpUrl, stateDir, callbackUrl: core.callbackUrl, signal: controller.signal }, 'fixture_read', { session: 7 });
    const concurrent = callMcpTool({ mcpUrl: proxyMcpUrl, stateDir, callbackUrl: core.callbackUrl }, 'fixture_read', { session: 8 });
    await withinMs(Promise.all([cancelEntered.promise, otherEntered.promise]), 15_000, 'concurrent cancel/active calls never reached backend');
    controller.abort();
    await assert.rejects(cancelled);
    cancelGate.resolve();
    otherGate.resolve();
    const concurrentRes = await concurrent;
    assert.equal(concurrentRes.content?.[0]?.text, 'session-8');
    assert.equal(counts.discover, discoversBeforeFollowUp, 'cancelling one call must not evict the pooled 1MCP connection');
  },
);
