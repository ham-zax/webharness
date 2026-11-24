import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  BROKER_TOOL_NAMES,
  DEFAULT_INNER_IDLE_MS,
  DirectLocalServerPool,
  LazyIdleSupervisor,
  LocalDiagnosticLogger,
  LocalToolBroker,
  MAX_LIST_LIMIT,
  createLocalBrokerServer,
  parseInnerIdleMs
} from '../server.mjs';
import { acquireRuntimeLease, hasActiveRuntimeLeases } from '../../../lib/runtime-leases.mjs';
import { reclaimStaleRuntimeOwnership } from '../../../lib/one-mcp-runtime-ownership.mjs';
import { CALL_ID_META, RPC_BUDGET_META, callId, traceCall } from '../../pi-dev/call-diagnostics.mjs';

async function configFile(t, servers = ['browser']) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-tools-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mcp.json');
  await fs.writeFile(file, JSON.stringify({
    version: '1.0.0',
    mcpServers: Object.fromEntries(servers.map(name => [name, { command: 'fixture' }]))
  }));
  return file;
}

test('stale 1MCP ownership is reclaimed without disturbing a matching runtime', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'one-mcp-owner-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  const procRoot = path.join(root, 'proc');
  const ownerDir = path.join(configDir, 'runtime.owner');
  await fs.mkdir(path.join(procRoot, '101'), { recursive: true });
  await fs.mkdir(ownerDir, { recursive: true });

  await fs.writeFile(path.join(ownerDir, 'owner.json'), '');
  assert.equal(await reclaimStaleRuntimeOwnership(configDir, { procRoot }), true);
  await assert.rejects(fs.stat(ownerDir), { code: 'ENOENT' });

  await fs.mkdir(ownerDir, { recursive: true });
  await fs.writeFile(path.join(ownerDir, 'owner.json'), JSON.stringify({ pid: 101 }));
  await fs.writeFile(path.join(procRoot, '101', 'cmdline'), Buffer.from('unrelated\0process\0'));
  assert.equal(await reclaimStaleRuntimeOwnership(configDir, { procRoot }), true);

  await fs.mkdir(ownerDir, { recursive: true });
  await fs.writeFile(path.join(ownerDir, 'owner.json'), JSON.stringify({ pid: 101 }));
  await fs.writeFile(
    path.join(procRoot, '101', 'cmdline'),
    Buffer.from(`node\0/x/@1mcp/agent/build/index.js\0serve\0--config-dir\0${configDir}\0`)
  );
  assert.equal(await reclaimStaleRuntimeOwnership(configDir, { procRoot }), false);
  assert.equal((await fs.stat(ownerDir)).isDirectory(), true);
});

function fakeInner({
  pages,
  callResult = { content: [{ type: 'text', text: 'ok' }] },
  callHandler,
  restartHandler,
  isLive = () => true,
  state = 'unknown',
}) {
  const listCalls = [];
  const callCalls = [];
  const restartCalls = [];
  let closed = false;
  return {
    listCalls,
    callCalls,
    restartCalls,
    get closed() { return closed; },
    serverState: () => state,
    isServerLive: server => (typeof isLive === 'function' ? isLive(server) : Boolean(isLive)),
    async listServerTools(server, cursor) {
      listCalls.push({ server, cursor });
      const key = cursor ?? 'FIRST';
      const page = typeof pages === 'function' ? pages(server, key) : pages[key];
      if (page instanceof Error) throw page;
      return structuredClone(page ?? { tools: [] });
    },
    async callServerTool(server, tool, args, signal) {
      callCalls.push({ server, tool, args });
      if (callHandler) return callHandler(server, tool, args, signal);
      return callResult;
    },
    async restartServer(server, opts) {
      restartCalls.push({ server, opts });
      if (restartHandler) return restartHandler(server, opts);
    },
    async close() { closed = true; }
  };
}

test('model-facing broker exposes discovery, call, fallback, and batch', async t => {
  const image = { content: [{ type: 'image', data: 'cG5n', mimeType: 'image/png' }] };
  const broker = {
    async list() { return { tools: [], hasMore: false }; },
    async schema() { return { server: 'browser', tool: 'take_screenshot', definition: {} }; },
    async call() { return image; },
    async batch() { return { server: 'browser', tool: 'take_screenshot', results: [] }; }
  };
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'local-tools-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['fallback_dispatch', 'tool_batch', 'tool_call', 'tool_list', 'tool_schema']);
  const call = tools.find(tool => tool.name === 'tool_call');
  const fallback = tools.find(tool => tool.name === 'fallback_dispatch');
  const batch = tools.find(tool => tool.name === 'tool_batch');
  assert.equal(call.annotations.readOnlyHint, false);
  assert.equal(call.annotations.openWorldHint, true);
  assert.equal(fallback.annotations.readOnlyHint, false);
  assert.equal(fallback.annotations.destructiveHint, true);
  assert.equal(fallback.annotations.openWorldHint, true);
  for (const tool of tools) {
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name}.${hint} must be explicit`);
    }
  }
  assert.equal(batch.annotations.destructiveHint, true);
  assert.equal(batch.annotations.openWorldHint, true);

  const result = await client.callTool({ name: 'tool_call', arguments: { server: 'browser', tool: 'take_screenshot' } });
  assert.deepEqual(result.content, image.content);
});

test('unknown broker tool errors list the valid tools and translate flat downstream names', async t => {
  const broker = {
    async list() { return { tools: [], hasMore: false }; },
    async schema() { return {}; },
    async call() { return { content: [] }; }
  };
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'local-tools-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  assert.deepEqual([...BROKER_TOOL_NAMES].sort(), tools.map(tool => tool.name).sort(), 'BROKER_TOOL_NAMES must match the advertised tools');

  const flat = await client.callTool({ name: 'terminal_1mcp_terminal_open', arguments: {} });
  assert.equal(flat.isError, true);
  assert.equal(flat.structuredContent.error.code, 'UNKNOWN_BROKER_TOOL');
  assert.match(flat.content[0].text, /call tool_call with \{"server":"terminal","tool":"terminal_open","arguments":\{\.\.\.\}\}/);
  assert.match(flat.content[0].text, /valid broker tools: tool_list, tool_schema, tool_call, fallback_dispatch, tool_batch/);

  const nested = await client.callTool({ name: 'browser_1mcp_a_1mcp_b', arguments: {} });
  assert.match(nested.content[0].text, /"server":"browser","tool":"a_1mcp_b"/);

  const plain = await client.callTool({ name: 'bogus', arguments: {} });
  assert.match(plain.content[0].text, /unknown broker tool: bogus; valid broker tools: /);
  assert.doesNotMatch(plain.content[0].text, /"server"/);

  const huge = await client.callTool({ name: `a_1mcp_${'x'.repeat(500)}`, arguments: {} });
  assert.ok(huge.content[0].text.length < 500, 'oversized names are truncated and not echoed as routing hints');
  assert.doesNotMatch(huge.content[0].text, /"server"/);
});

test('unknown broker tool names are recorded on stderr as one bounded line; valid tools are not', async t => {
  const broker = {
    async list() { return { tools: [], hasMore: false }; },
    async schema() { return {}; },
    async call() { return { content: [] }; }
  };
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'local-tools-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    const text = String(chunk);
    if (text.startsWith('local-tools: UNKNOWN_BROKER_TOOL')) { lines.push(text); return true; }
    return original.call(process.stderr, chunk, ...rest);
  };
  try {
    await client.callTool({ name: 'tool_list', arguments: {} });
    await client.callTool({ name: 'terminal_1mcp_terminal_open', arguments: {} });
    await client.callTool({ name: `bad\nname_${'x'.repeat(500)}`, arguments: {} });
  } finally {
    process.stderr.write = original;
  }

  assert.equal(lines.length, 2, 'only the two unknown names are recorded');
  assert.equal(lines[0], 'local-tools: UNKNOWN_BROKER_TOOL name="terminal_1mcp_terminal_open"\n');
  assert.equal(lines[1].split('\n').length, 2, 'a name containing a newline stays on a single log line');
  assert.ok(lines[1].includes('bad\\nname_'), 'control characters are escaped');
  assert.ok(lines[1].length < 250, 'oversized names are truncated in the log');
});

test('tool_list without server discovers logical servers and filters only server names', async t => {
  const configPath = await configFile(t, ['browser-devtools', 'repo-search', 'codebase-memory-mcp']);
  const inner = fakeInner({ pages: {
    FIRST: {
      tools: [
        { name: 'take_heapsnapshot', description: 'analyze browser memory distribution' },
        { name: 'search_codebase', description: 'semantic repository search' }
      ]
    }
  } });
  const broker = new LocalToolBroker({ inner, configPath });

  const all = await broker.list();
  assert.deepEqual(all, {
    servers: [
      { server: 'browser-devtools', available: null, toolCount: null, backendState: 'unknown' },
      { server: 'repo-search', available: null, toolCount: null, backendState: 'unknown' },
      { server: 'codebase-memory-mcp', available: null, toolCount: null, backendState: 'unknown' }
    ],
    hasMore: false
  });

  assert.deepEqual(inner.listCalls, []);
  const memory = await broker.list({ query: 'memory' });
  assert.deepEqual(memory, {
    servers: [{ server: 'codebase-memory-mcp', available: null, toolCount: null, backendState: 'unknown' }],
    hasMore: false
  });
});

test('scoped discovery coalesces targeted recovery for a configured missing server', async t => {
  const configPath = await configFile(t, ['codebase-memory-mcp']);
  let recovered = false;
  let restarts = 0;
  const inner = fakeInner({
    pages: () => ({
      tools: recovered ? [{ name: 'list_projects', description: 'list indexed projects' }] : []
    }),
    restartHandler: async (server) => {
      assert.equal(server, 'codebase-memory-mcp');
      restarts += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      recovered = true;
    }
  });
  const broker = new LocalToolBroker({ inner, configPath, recovery: { pollMs: 5, timeoutMs: 400 } });

  const [first, second] = await Promise.all([
    broker.list({ server: 'codebase-memory-mcp' }),
    broker.list({ server: 'codebase-memory-mcp' })
  ]);
  assert.equal(restarts, 1);
  assert.deepEqual(first.tools.map(tool => tool.tool), ['list_projects']);
  assert.deepEqual(second.tools.map(tool => tool.tool), ['list_projects']);
});

test('failed direct call may recover an absent server but never auto-replays the original action', async t => {
  const configPath = await configFile(t, ['codebase-memory-mcp']);
  let recovered = false;
  let targetCalls = 0;
  const inner = fakeInner({
    isLive: () => recovered,
    pages: () => ({
      tools: recovered ? [{ name: 'list_projects', description: 'list indexed projects' }] : []
    }),
    restartHandler: async (server) => {
      assert.equal(server, 'codebase-memory-mcp');
      recovered = true;
    },
    callHandler: async (_server, _tool) => {
      targetCalls += 1;
      if (!recovered) throw new Error('Error calling tool');
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  });
  const broker = new LocalToolBroker({ inner, configPath, recovery: { pollMs: 5, timeoutMs: 400 } });

  await assert.rejects(
    () => broker.call({ server: 'codebase-memory-mcp', tool: 'list_projects' }),
    /DOWNSTREAM_RECOVERED_RETRY_REQUIRED/
  );
  assert.equal(targetCalls, 1);
  const retry = await broker.call({ server: 'codebase-memory-mcp', tool: 'list_projects' });
  assert.equal(targetCalls, 2);
  assert.equal(retry.content[0].text, 'ok');
});

test('recovery budget exceeds the measured cold browser boot time', () => {
  const inner = fakeInner({ pages: { FIRST: { tools: [] } } });
  const broker = new LocalToolBroker({ inner, configPath: '/unused/mcp.json' });
  assert.ok(
    broker.recoveryTimeoutMs >= 60_000,
    `a cold browser backend boots for up to 34s, so the recovery budget must exceed it; got ${broker.recoveryTimeoutMs}ms`
  );
});

test('recovery polls a slow backend instead of reporting it unavailable', async t => {
  const configPath = await configFile(t, ['browser-devtools']);
  let restarted = false;
  let listingsAfterRestart = 0;
  let restartTimeout;
  const inner = fakeInner({
    pages: () => {
      if (!restarted) return { tools: [] };
      listingsAfterRestart += 1;
      // A cold backend registers no tools until its third listing.
      return {
        tools: listingsAfterRestart >= 3 ? [{ name: 'take_screenshot', description: 'shot' }] : []
      };
    },
    restartHandler: async (server, opts) => {
      assert.equal(server, 'browser-devtools');
      restartTimeout = opts.timeoutMs;
      restarted = true;
    }
  });
  const broker = new LocalToolBroker({ inner, configPath, recovery: { pollMs: 5, timeoutMs: 2_000 } });

  const listed = await broker.list({ server: 'browser-devtools' });
  assert.deepEqual(listed.tools.map(tool => tool.tool), ['take_screenshot']);
  assert.ok(listingsAfterRestart >= 3, 'the broker must re-check until the backend registers its tools');
  assert.equal(restartTimeout, broker.recoveryTimeoutMs, 'restartServer must receive the recovery budget');
});

test('recovery reports the waited time when a backend never registers tools', async t => {
  const configPath = await configFile(t, ['codebase-memory-mcp']);
  const inner = fakeInner({
    pages: () => ({ tools: [] }),
    restartHandler: async () => {}
  });
  const broker = new LocalToolBroker({ inner, configPath, recovery: { pollMs: 5, timeoutMs: 60 } });

  await assert.rejects(
    () => broker.list({ server: 'codebase-memory-mcp' }),
    /DOWNSTREAM_UNAVAILABLE: local server is configured but unavailable after [\d.]+s: codebase-memory-mcp/
  );
});

test('tool_list is bounded, lightweight, resumable without a page cache, and filter-bound', async t => {
  const configPath = await configFile(t, ['browser', 'future']);
  const inner = fakeInner({ pages: {
    FIRST: {
      tools: [
        { name: 'alpha', title: 'Alpha', description: 'network alpha', inputSchema: { type: 'object', properties: { secret: { type: 'string' } } } },
        { name: 'beta', description: 'network beta', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } },
        { name: 'delta', description: 'network delta', inputSchema: { type: 'object' } }
      ],
      nextCursor: 'P2'
    },
    P2: {
      tools: [
        { name: 'epsilon', description: 'network epsilon', inputSchema: { type: 'object' } },
        { name: 'tool_1mcp_suffix', description: 'network separator tool', inputSchema: { type: 'object' } }
      ]
    }
  } });
  const broker = new LocalToolBroker({ inner, configPath });

  const first = await broker.list({ server: 'browser', query: 'network', limit: 2 });
  assert.deepEqual(first.tools.map(tool => tool.tool), ['alpha', 'beta']);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, 'string');
  assert.ok(first.tools.every(tool => tool.inputSchema === undefined));
  assert.ok(first.tools.every(tool => tool.server === 'browser'));

  const second = await broker.list({ server: 'browser', query: 'network', limit: MAX_LIST_LIMIT, cursor: first.nextCursor });
  assert.deepEqual(second.tools.map(tool => tool.tool), ['delta', 'epsilon', 'tool_1mcp_suffix']);
  assert.equal(second.hasMore, false);
  assert.deepEqual(inner.listCalls.slice(0, 2), [
    { server: 'browser', cursor: undefined },
    { server: 'browser', cursor: undefined }
  ]);

  await assert.rejects(
    () => broker.list({ server: 'browser', query: 'different', cursor: first.nextCursor }),
    /INVALID_CURSOR/
  );
});

test('tool_schema reads current inner catalog state and preserves a separator inside tool names', async t => {
  const configPath = await configFile(t);
  let description = 'first';
  const inner = fakeInner({ pages: () => ({ tools: [{
    name: 'tool_1mcp_suffix',
    description,
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { browser_target: { type: 'string' } } },
    outputSchema: { type: 'object' }
  }] }) });
  const broker = new LocalToolBroker({ inner, configPath });

  const first = await broker.schema({ server: 'browser', tool: 'tool_1mcp_suffix' });
  assert.equal(first.definition.name, 'tool_1mcp_suffix');
  assert.equal(first.definition.description, 'first');
  assert.equal(first.definition.inputSchema.properties.browser_target.type, 'string');
  assert.deepEqual(first.definition.annotations, { readOnlyHint: true });

  description = 'second';
  const second = await broker.schema({ server: 'browser', tool: 'tool_1mcp_suffix' });
  assert.equal(second.definition.description, 'second');
  await assert.rejects(() => broker.schema({ server: 'browser', tool: 'missing' }), /UNKNOWN_TOOL/);
  assert.equal(inner.listCalls.length, 6);
});

test('reserved and ambiguous server namespaces are rejected at the broker boundary', async t => {
  const validConfig = await configFile(t, ['browser']);
  const inner = fakeInner({ pages: { FIRST: { tools: [] } } });
  const broker = new LocalToolBroker({ inner, configPath: validConfig });

  await assert.rejects(() => broker.list({ server: '1mcp' }), /server name 1mcp is reserved/);
  await assert.rejects(() => broker.call({ server: 'browser_1mcp_escape', tool: 'x' }), /must not contain _1mcp_/);

  const invalidConfig = await configFile(t, ['bad_1mcp_name']);
  const invalidBroker = new LocalToolBroker({ inner, configPath: invalidConfig });
  await assert.rejects(() => invalidBroker.list(), /INVALID_INNER_SERVER_NAME/);
});

test('tool_call validates only routing fields and returns downstream rich results unchanged', async t => {
  const configPath = await configFile(t);
  const image = {
    content: [{ type: 'image', data: 'cG5n', mimeType: 'image/png' }],
    structuredContent: { source: 'native' }
  };
  const inner = fakeInner({ pages: { FIRST: { tools: [] } }, callResult: image });
  const broker = new LocalToolBroker({ inner, configPath });

  const result = await broker.call({
    server: 'browser',
    tool: 'take_screenshot',
    arguments: { browser_target: 'linux', format: 'png' }
  });
  assert.strictEqual(result, image);
  assert.deepEqual(inner.callCalls, [{
    server: 'browser',
    tool: 'take_screenshot',
    args: { browser_target: 'linux', format: 'png' }
  }]);
  assert.equal(inner.listCalls.length, 0);

  await assert.rejects(() => broker.call({ server: 'missing', tool: 'x' }), /UNKNOWN_SERVER/);
  assert.equal(inner.callCalls.length, 1);

  const downstreamError = { isError: true, content: [{ type: 'text', text: 'Tool not found' }] };
  const errorInner = fakeInner({ pages: { FIRST: { tools: [] } }, callResult: downstreamError });
  const errorBroker = new LocalToolBroker({ inner: errorInner, configPath });
  const errorResult = await errorBroker.call({ server: 'browser', tool: 'missing' });
  assert.strictEqual(errorResult, downstreamError);
});

test('tool_batch preflights all entries, bounds concurrency, preserves order, and separates downstream errors from dispatch rejection', async t => {
  const configPath = await configFile(t);
  let active = 0;
  let maxActive = 0;
  const inner = fakeInner({
    pages: { FIRST: { tools: [{ name: 'observe', description: 'fixture' }] } },
    callHandler: async (_server, _tool, args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise(resolve => setTimeout(resolve, args.delay));
        if (args.kind === 'throw') throw new Error('transport failed');
        if (args.kind === 'downstream') return { isError: true, content: [{ type: 'text', text: 'downstream error' }] };
        return { content: [{ type: 'text', text: args.kind }] };
      } finally {
        active -= 1;
      }
    }
  });
  const broker = new LocalToolBroker({ inner, configPath });

  const result = await broker.batch({
    server: 'browser',
    tool: 'observe',
    concurrency: 2,
    calls: [
      { id: 'slow', arguments: { kind: 'ok', delay: 40 } },
      { id: 'downstream', arguments: { kind: 'downstream', delay: 5 } },
      { id: 'rejected', arguments: { kind: 'throw', delay: 5 } }
    ]
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(result.results.map(entry => entry.id), ['slow', 'downstream', 'rejected']);
  assert.equal(result.results[0].status, 'fulfilled');
  assert.equal(result.results[1].status, 'fulfilled');
  assert.equal(result.results[1].result.isError, true);
  assert.equal(result.results[2].status, 'rejected');
  assert.equal(result.results[2].error.code, 'INNER_CALL_FAILED');

  const dispatched = inner.callCalls.length;
  await assert.rejects(() => broker.batch({
    server: 'browser',
    tool: 'observe',
    calls: [{ arguments: {} }, { arguments: [] }]
  }), /arguments must be an object/);
  assert.equal(inner.callCalls.length, dispatched);
});

test('tool_batch cancellation stops queued dispatches', async t => {
  const configPath = await configFile(t);
  let dispatches = 0;
  let completed = 0;
  const inner = fakeInner({
    pages: { FIRST: { tools: [{ name: 'observe', description: 'fixture' }] } },
    callHandler: async (_server, _tool, _args, signal) => {
      dispatches += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          completed += 1;
          resolve({ content: [{ type: 'text', text: 'ok' }] });
        }, 120);
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('aborted'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  });
  const broker = new LocalToolBroker({ inner, configPath });
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'local-tools-cancel-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const controller = new AbortController();
  const pending = client.callTool({
    name: 'tool_batch',
    arguments: {
      server: 'browser',
      tool: 'observe',
      concurrency: 2,
      calls: [{ arguments: {} }, { arguments: {} }, { arguments: {} }, { arguments: {} }]
    }
  }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('review-cancel')), 20);

  await assert.rejects(() => pending, /review-cancel/);
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(dispatches, 2);
  assert.equal(completed, 0);
});

test('inner transport failures are bounded errors and shutdown closes the private child', async t => {
  const configPath = await configFile(t);
  const unavailable = Object.assign(new Error('gone'), { code: 'INNER_UNAVAILABLE' });
  const inner = fakeInner({ pages: { FIRST: unavailable } });
  const broker = new LocalToolBroker({ inner, configPath });

  await assert.rejects(() => broker.list({ server: 'browser' }), /gone/);
  await broker.shutdown();
  assert.equal(inner.closed, true);
  await assert.rejects(() => broker.call({ server: 'browser', tool: 'x' }), /LOCAL_BROKER_CLOSED/);
});

function fakeInnerFactory() {
  const created = [];
  const start = async () => {
    const inner = {
      alive: true,
      closeCount: 0,
      calls: [],
      async listTools(cursor) { this.calls.push(['list', cursor]); return { tools: [] }; },
      async callTool(name, args, signal) {
        this.calls.push(['call', name]);
        if (this.hold) await this.hold;
        return { content: [], name, args, signal };
      },
      async close() { this.closeCount += 1; this.alive = false; }
    };
    created.push(inner);
    return inner;
  };
  return { created, start };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('inner idle timeout parsing defaults and validates', () => {
  assert.equal(parseInnerIdleMs(undefined), DEFAULT_INNER_IDLE_MS);
  assert.equal(parseInnerIdleMs(''), DEFAULT_INNER_IDLE_MS);
  assert.equal(DEFAULT_INNER_IDLE_MS, 1800000);
  assert.equal(parseInnerIdleMs('0'), 0);
  assert.equal(parseInnerIdleMs('1500'), 1500);
  for (const bad of ['-1', '1.5', 'abc', '1e3', '99999999999']) {
    assert.throws(() => parseInnerIdleMs(bad), /MCP_LOCAL_INNER_IDLE_MS/, bad);
  }
});

test('lazy inner does not start until the first operation and shares one start', async () => {
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyIdleSupervisor({ start, idleMs: 0 });
  assert.equal(created.length, 0);
  await Promise.all([lazy.listTools(), lazy.callTool('a_1mcp_b', {}), lazy.listTools('c')]);
  assert.equal(created.length, 1);
  await lazy.callTool('a_1mcp_b', {});
  assert.equal(created.length, 1);
  await lazy.close();
});

test('lazy inner retries after a failed start', async () => {
  let attempts = 0;
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyIdleSupervisor({
    idleMs: 0,
    start: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      return start();
    }
  });
  await assert.rejects(lazy.listTools(), /boom/);
  await lazy.listTools();
  assert.equal(attempts, 2);
  assert.equal(created.length, 1);
  await lazy.close();
});

test('lazy inner closes after the idle timeout and restarts on the next call', async () => {
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyIdleSupervisor({ start, idleMs: 30 });
  await lazy.listTools();
  assert.equal(created[0].closeCount, 0);
  await sleep(120);
  assert.equal(created[0].closeCount, 1);
  await lazy.callTool('a_1mcp_b', {});
  assert.equal(created.length, 2);
  assert.equal(created[1].closeCount, 0);
  await lazy.close();
  assert.equal(created[1].closeCount, 1);
});

test('lazy inner never closes while an operation is in flight', async () => {
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyIdleSupervisor({ start, idleMs: 20 });
  await lazy.listTools();
  let release;
  created[0].hold = new Promise(resolve => { release = resolve; });
  const pending = lazy.callTool('a_1mcp_b', {});
  await sleep(100);
  assert.equal(created[0].closeCount, 0);
  release();
  await pending;
  await sleep(100);
  assert.equal(created[0].closeCount, 1);
  await lazy.close();
});

test('lazy inner starts a fresh inner after the peer died', async () => {
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyIdleSupervisor({ start, idleMs: 0 });
  await lazy.listTools();
  created[0].alive = false;
  await Promise.all([lazy.listTools(), lazy.listTools()]);
  assert.equal(created.length, 2);
  assert.equal(created[0].closeCount, 1);
  await lazy.close();
});

test('lazy inner with idleMs 0 never idle-stops', async () => {
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyIdleSupervisor({ start, idleMs: 0 });
  await lazy.listTools();
  await sleep(80);
  assert.equal(created[0].closeCount, 0);
  await lazy.close();
  assert.equal(created[0].closeCount, 1);
});

test('lazy inner close is idempotent, cancels the timer, and rejects later calls', async () => {
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyIdleSupervisor({ start, idleMs: 20 });
  await lazy.listTools();
  await lazy.close();
  await lazy.close();
  assert.equal(created[0].closeCount, 1);
  assert.equal(lazy.alive, false);
  await assert.rejects(lazy.listTools(), { code: 'INNER_UNAVAILABLE' });
  await assert.rejects(lazy.callTool('a_1mcp_b', {}), { code: 'INNER_UNAVAILABLE' });
  await sleep(60);
  assert.equal(created.length, 1);
  assert.equal(created[0].closeCount, 1);
});

test('lazy inner close waits for a pending start and closes the started inner', async () => {
  const { created, start } = fakeInnerFactory();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const lazy = new LazyIdleSupervisor({ idleMs: 0, start: async () => { await gate; return start(); } });
  const pending = lazy.listTools();
  const rejected = assert.rejects(pending, { code: 'INNER_UNAVAILABLE' });
  const closing = lazy.close();
  release();
  await closing;
  await rejected;
  assert.equal(created.length, 1);
  assert.equal(created[0].closeCount, 1);
});

test('concurrent lazy inner close calls both wait for in-flight eviction', async () => {
  let releaseClose;
  const closeGate = new Promise(resolve => { releaseClose = resolve; });
  let closeFinished = false;
  const lazy = new LazyIdleSupervisor({
    idleMs: 0,
    start: async () => ({
      alive: true,
      async listTools() { return { tools: [] }; },
      async callTool() { return { content: [] }; },
      async close() { await closeGate; closeFinished = true; }
    })
  });
  await lazy.listTools();
  const firstClose = lazy.close();
  const secondClose = lazy.close();
  let secondSettledEarly = false;
  secondClose.then(() => { if (!closeFinished) secondSettledEarly = true; });
  await sleep(30);
  assert.equal(secondSettledEarly, false, 'concurrent close caller must not resolve before eviction finishes');
  releaseClose();
  await Promise.all([firstClose, secondClose]);
  assert.equal(closeFinished, true);
});

test('broker works through the lazy inner wrapper without starting it on construction', async t => {
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyIdleSupervisor({ start, idleMs: 0 });
  const pool = {
    serverState: () => lazy.state,
    isServerLive: () => lazy.state === 'running',
    listServerTools: (_server, cursor, options) => lazy.listTools(cursor, options),
    callServerTool: (_server, tool, args, signal) => lazy.callTool(tool, args, signal),
    close: () => lazy.close(),
  };
  const broker = new LocalToolBroker({ inner: pool, configPath: await configFile(t) });
  assert.equal(created.length, 0);
  const discovery = await broker.list({});
  assert.equal(created.length, 0);
  assert.deepEqual(discovery.servers, [{ server: 'browser', available: null, toolCount: null, backendState: 'asleep' }]);
  await broker.call({ server: 'browser', tool: 'fixture' });
  assert.equal(created.length, 1);
  await broker.shutdown();
  assert.equal(created[0].closeCount, 1);
});


test('unscoped discovery paginates and filters without touching a sleeping backend', async t => {
  const configPath = await configFile(t, ['alpha', 'beta', 'gamma', 'dev']);
  const inner = {
    serverState: () => 'asleep',
    async listServerTools() { throw new Error('must stay asleep'); },
    async callServerTool() {},
    async close() {},
  };
  const broker = new LocalToolBroker({ inner, configPath, fallbackOnlyServers: ['dev'] });
  const first = await broker.list({ limit: 1 });
  assert.deepEqual(first.servers.map(item => item.server), ['alpha']);
  assert.equal(first.hasMore, true);
  const second = await broker.list({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.servers.map(item => item.server), ['beta', 'gamma']);
  assert.equal(second.hasMore, false);
  await assert.rejects(() => broker.list({ query: 'beta', cursor: first.nextCursor }), /INVALID_CURSOR/);
  assert.deepEqual((await broker.list({ query: 'beta' })).servers.map(item => item.server), ['beta']);
});

test('idle inner stays alive while a background lease pins it', async () => {
  const { created, start } = fakeInnerFactory();
  let pinned = true;
  const lazy = new LazyIdleSupervisor({ start, idleMs: 15, isPinned: async () => pinned });
  await lazy.listTools();
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(created[0].closeCount, 0);
  pinned = false;
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(created[0].closeCount, 1);
  await lazy.close();
});


test('runtime lease file protects the inner until its owner releases it', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-lease-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lease = await acquireRuntimeLease({ directory, kind: 'jev-run' });
  t.after(() => lease.close());
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyIdleSupervisor({ start, idleMs: 15, isPinned: () => hasActiveRuntimeLeases(directory) });
  t.after(() => lazy.close());
  await lazy.listTools();
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(created[0].closeCount, 0);
  await lease.close();
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(created[0].closeCount, 1);
});

test('tool_list shows parameter names with required ones starred, and omits params when there are none', async t => {
  const configPath = await configFile(t, ['terminal']);
  const inner = fakeInner({ pages: {
    FIRST: {
      tools: [
        {
          name: 'terminal_read',
          description: 'read terminal output',
          inputSchema: { type: 'object', properties: { name: { type: 'string' }, max_bytes: { type: 'number' } }, required: ['name'] }
        },
        {
          name: 'terminal_open',
          description: 'open a terminal',
          inputSchema: { type: 'object', properties: { command: { type: 'string' }, name: { type: 'string' } } }
        },
        { name: 'terminal_list', description: 'list terminals', inputSchema: { type: 'object', properties: {} } },
        { name: 'terminal_noschema', description: 'no schema at all' }
      ]
    }
  } });
  const broker = new LocalToolBroker({ inner, configPath });

  const { tools } = await broker.list({ server: 'terminal' });
  const byName = Object.fromEntries(tools.map(tool => [tool.tool, tool]));
  assert.equal(byName.terminal_read.params, 'name*, max_bytes');
  assert.equal(byName.terminal_open.params, 'command, name');
  assert.equal('params' in byName.terminal_list, false);
  assert.equal('params' in byName.terminal_noschema, false);
});

test('createLocalBrokerServer catches async tool_call and fallback_dispatch rejections as structured errors', async t => {
  const failErr = Object.assign(new Error('unknown local server: missing'), { code: 'UNKNOWN_SERVER' });
  const broker = {
    async list() { return { tools: [], hasMore: false }; },
    async schema() { throw failErr; },
    async call() { throw failErr; },
    async fallbackDispatch() { throw failErr; },
    async batch() { throw failErr; }
  };
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'local-tools-error-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  for (const name of ['tool_call', 'fallback_dispatch']) {
    const res = await client.callTool({ name, arguments: { server: 'missing', tool: 'noop' } });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.error?.code, 'UNKNOWN_SERVER');
  }
});

const mcpServerModUrl = new URL('../node_modules/@modelcontextprotocol/server/dist/index.mjs', import.meta.url).href;
const mcpServerStdioModUrl = new URL('../node_modules/@modelcontextprotocol/server/dist/stdio.mjs', import.meta.url).href;

async function writeFixtureMcpServer(dir, name, { modern = true, modernOnly = false, slowMs = 0, crashFirstCall = false } = {}) {
  const pidLog = path.join(dir, `${name}.pids`);
  const callLog = path.join(dir, `${name}.calls`);
  const script = path.join(dir, `${name}.mjs`);
  await fs.writeFile(
    script,
    `import fs from 'node:fs';
import { McpServer } from ${JSON.stringify(mcpServerModUrl)};
import { StdioServerTransport, serveStdio } from ${JSON.stringify(mcpServerStdioModUrl)};

fs.appendFileSync(${JSON.stringify(pidLog)}, String(process.pid) + '\\n');
function buildServer() {
  const mcp = new McpServer({ name: ${JSON.stringify(name)}, version: '1.0.0' });
  mcp.server.registerCapabilities({ tools: {} });
  mcp.server.setRequestHandler('tools/list', async () => ({
    tools: [{ name: ${JSON.stringify(`ping_${name}`)}, description: 'Ping fixture', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }]
  }));
  mcp.server.setRequestHandler('tools/call', async req => {
    const prev = fs.existsSync(${JSON.stringify(callLog)}) ? fs.readFileSync(${JSON.stringify(callLog)}, 'utf8').trim().split('\\n').filter(Boolean).length : 0;
    fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(req.params) + '\\n');
    process.stderr.write(${JSON.stringify(`${name}: handling call\n`)});
    if (${JSON.stringify(crashFirstCall)} && prev === 0) {
      process.exit(1);
    }
    if (${JSON.stringify(slowMs)} > 0) {
      await new Promise(r => setTimeout(r, ${JSON.stringify(slowMs)}));
    }
    return { content: [{ type: 'text', text: ${JSON.stringify(`${name}:`)} + String(req.params.arguments?.msg ?? 'pong') }] };
  });
  return mcp;
}
if (${JSON.stringify(modern)}) {
  const handle = serveStdio(() => buildServer(), { legacy: ${JSON.stringify(modernOnly)} ? 'reject' : 'serve' });
  process.stdin.once('end', () => { void handle.close(); });
} else {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.once('end', () => { void server.close(); });
}
`,
    'utf8'
  );
  return { script, pidLog, callLog };
}

async function readPids(pidLog) {
  try {
    return (await fs.readFile(pidLog, 'utf8')).trim().split('\n').filter(Boolean).map(Number);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

test('Local call and fallback preserve verified Dev receipts and correlation across real worker IPC', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-dev-trace-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfgPath = path.join(dir, 'mcp.json');
  await fs.writeFile(cfgPath, JSON.stringify({ version: '1.0.0', mcpServers: {
    dev: { type: 'stdio', protocolVersion: '2026-07-28', command: process.execPath,
      args: [path.resolve(import.meta.dirname, '../../pi-dev/server.mjs')], env: {
        MCP_DEV_PATH_MODE: 'workspace', MCP_DEV_WORKSPACE_ROOT: dir,
        MCP_DEV_STATE_DIR: path.join(dir, 'state'), MCP_DEV_SHELL_MODE: 'unrestricted',
      } },
  } }));
  const records = [];
  const logger = { log: (_level, row) => records.push(row), async flush() {} };
  const pool = new DirectLocalServerPool({ configPath: cfgPath, idleMs: 0, logger });
  const broker = new LocalToolBroker({ inner: pool, configPath: cfgPath, logger });
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'local-trace-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); await broker.shutdown(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  for (const [index, name] of ['tool_call', 'fallback_dispatch'].entries()) {
    const id = `12345678-1234-1234-1234-123456789ab${index}`;
    const result = await client.callTool({ name, _meta: { 'webharness/call-id': id }, arguments: {
      server: 'dev', tool: 'write', arguments: { path: 'written', content: 'private-payload', overwrite: index === 1 },
    } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.operation_id, id);
    assert.equal(result.structuredContent.bytes_written, 15);
    assert.equal(result._meta['webharness/call-id'], id);
    assert.equal(result._meta['webharness/mutation-state'], 'published');
    assert.ok(records.some(row => row.event === 'call_completed' && row.call_id === id && row.outcome === 'success'));
  }
  assert.doesNotMatch(JSON.stringify(records), /private-payload/);
});

test('fallback_dispatch reaches every Dev operation and ordinary Local routes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-fallback-reach-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixture = await writeFixtureMcpServer(dir, 'alpha', { modern: true });
  const cfgPath = path.join(dir, 'mcp.json');
  await fs.writeFile(cfgPath, JSON.stringify({ version: '1.0.0', mcpServers: {
    dev: { type: 'stdio', protocolVersion: '2026-07-28', command: process.execPath,
      args: [path.resolve(import.meta.dirname, '../../pi-dev/server.mjs')], env: {
        MCP_DEV_PATH_MODE: 'user', MCP_DEV_DEFAULT_CWD: dir,
        MCP_DEV_STATE_DIR: path.join(dir, 'state'), MCP_DEV_SHELL_MODE: 'unrestricted',
        MCP_DEV_TERMINAL_SOCKET: path.join(dir, 'terminal.sock'),
      } },
    alpha: { type: 'stdio', protocolVersion: '2026-07-28', command: process.execPath, args: [fixture.script] },
  } }));
  const pool = new DirectLocalServerPool({ configPath: cfgPath, idleMs: 0 });
  const broker = new LocalToolBroker({ inner: pool, configPath: cfgPath, fallbackOnlyServers: ['dev'] });
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'local-fallback-reach', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); await broker.shutdown(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const dispatch = async (serverName, tool, args) => {
    const result = await client.callTool({ name: 'fallback_dispatch', arguments: { server: serverName, tool, arguments: args } });
    assert.notEqual(result.isError, true, `${serverName}/${tool}: ${JSON.stringify(result)}`);
    return result;
  };

  await dispatch('dev', 'bash', { command: 'printf bash-ok', cwd: dir });
  await dispatch('dev', 'exec', { argv: ['printf', 'exec-ok'], cwd: dir });

  await fs.writeFile(path.join(dir, 'move-me'), 'x');
  await dispatch('dev', 'file_ops', { operations: [{ kind: 'move', path: 'move-me', to: 'moved' }], cwd: dir });
  assert.equal(await fs.readFile(path.join(dir, 'moved'), 'utf8'), 'x');

  const script = await dispatch('dev', 'run_script', { script: "return await tools.read({ path: 'moved' });", cwd: dir });
  assert.match(script.content[0].text, /x/);

  const waited = await dispatch('dev', 'wait', { name: 'reach-wait', condition: { kind: 'file_exists', path: path.join(dir, 'moved') } });
  assert.match(waited.content[0].text, /reach-wait/);

  const local = await dispatch('alpha', 'ping_alpha', { msg: 'local-ok' });
  assert.match(local.content[0].text, /alpha:local-ok/);

  // Prefixed dev_* tool names normalize cleanly without wasting a round trip.
  const prefixed = await dispatch('dev', 'dev_exec', { argv: ['printf', 'prefixed-ok'], cwd: dir });
  assert.match(prefixed.content[0].text, /prefixed-ok/);
  const schemaPrefixed = await client.callTool({ name: 'tool_schema', arguments: { server: 'dev', tool: 'dev_read' } });
  assert.notEqual(schemaPrefixed.isError, true);
  assert.equal(schemaPrefixed.structuredContent.tool, 'read');

  // Read-only fallback calls report not_applicable; validation failures report not_started (never unknown).
  const readRes = await dispatch('dev', 'read', { path: path.join(dir, 'moved') });
  assert.equal(readRes._meta['webharness/mutation-state'], 'not_applicable');
  const badServer = await client.callTool({ name: 'fallback_dispatch', arguments: { server: 'missing', tool: 'noop', arguments: {} } });
  assert.equal(badServer.isError, true);
  assert.equal(badServer._meta['webharness/mutation-state'], 'not_started');

  // Parallel fallback_dispatch calls execute concurrently across disjoint writes and reads.
  const parallelWrites = await Promise.all([1, 2, 3, 4].map(i =>
    dispatch('dev', 'write', { path: path.join(dir, `p-${i}.txt`), content: `val-${i}\n`, overwrite: true })
  ));
  for (let i = 0; i < 4; i += 1) {
    assert.equal(parallelWrites[i]._meta['webharness/mutation-state'], 'published');
    assert.equal(await fs.readFile(path.join(dir, `p-${i + 1}.txt`), 'utf8'), `val-${i + 1}\n`);
  }

  // Batch mode on fallback_dispatch works for both Dev (fallback-only) and public Local servers.
  const batchDev = await client.callTool({
    name: 'fallback_dispatch',
    arguments: {
      server: 'dev',
      tool: 'read',
      concurrency: 4,
      calls: [1, 2, 3].map(i => ({ id: `r${i}`, arguments: { path: path.join(dir, `p-${i}.txt`) } })),
    },
  });
  assert.notEqual(batchDev.isError, true, JSON.stringify(batchDev));
  assert.equal(batchDev._meta['webharness/mutation-state'], 'not_applicable');
  assert.equal(batchDev.structuredContent.results.length, 3);
  assert.deepEqual(batchDev.structuredContent.results.map(r => r.id), ['r1', 'r2', 'r3']);
  assert.match(batchDev.structuredContent.results[1].result.content[0].text, /val-2/);

  const batchLocal = await client.callTool({
    name: 'fallback_dispatch',
    arguments: {
      server: 'alpha',
      tool: 'ping_alpha',
      calls: [{ id: 'a', arguments: { msg: 'one' } }, { id: 'b', arguments: { msg: 'two' } }],
    },
  });
  assert.notEqual(batchLocal.isError, true);
  assert.equal(batchLocal.content.length, 1);
  assert.match(batchLocal.content[0].text, /call 0 \(a\): fulfilled\nalpha:one\ncall 1 \(b\): fulfilled\nalpha:two/);
  assert.deepEqual(batchLocal.structuredContent.results.map(r => r.result.content[0].text), ['alpha:one', 'alpha:two']);

  const ambiguous = await client.callTool({
    name: 'fallback_dispatch',
    arguments: { server: 'alpha', tool: 'ping_alpha', arguments: { msg: 'x' }, calls: [{ arguments: { msg: 'y' } }] },
  });
  assert.equal(ambiguous.isError, true);
  assert.equal(ambiguous.structuredContent.error.code, 'INVALID_ARGUMENT');

  // Auto-learning: once a server's tools are listed, annotations.readOnlyHint is used automatically.
  broker._recordToolAnnotations('alpha', [{ name: 'ping_alpha', annotations: { readOnlyHint: true } }]);
  const learnedRead = await dispatch('alpha', 'ping_alpha', { msg: 'learned' });
  assert.equal(learnedRead._meta['webharness/mutation-state'], 'not_applicable');

  // Hybrid argument-aware classification: terminal_read is read-only only with snapshot:true.
  assert.equal(broker.isReadOnlyRoute('terminal', 'terminal_read', { name: 's1' }), false);
  assert.equal(broker.isReadOnlyRoute('terminal', 'terminal_read', { name: 's1', snapshot: true }), true);
  assert.equal(broker.isReadOnlyRoute('browser-daily', 'tabs', { action: 'list' }), true);
  assert.equal(broker.isReadOnlyRoute('browser-daily', 'tabs', { action: 'new', url: 'https://example.com' }), false);

  // Heterogeneous + sequential fallback_dispatch batch spans dev + local servers and honors stop_on_error.
  const heteroSeq = await client.callTool({
    name: 'fallback_dispatch',
    arguments: {
      sequential: true,
      stop_on_error: true,
      calls: [
        { id: 'w', server: 'dev', tool: 'write', arguments: { path: path.join(dir, 'seq.txt'), content: 'seq-ok\n', overwrite: true } },
        { id: 'ping', server: 'alpha', tool: 'ping_alpha', arguments: { msg: 'after-write' } },
        { id: 'fail-cmd', server: 'dev', tool: 'bash', arguments: { command: 'exit 7', cwd: dir } },
        { id: 'skipped', server: 'dev', tool: 'write', arguments: { path: path.join(dir, 'never.txt'), content: 'nope', overwrite: true } },
      ],
    },
  });
  assert.notEqual(heteroSeq.isError, true, JSON.stringify(heteroSeq));
  assert.equal(heteroSeq.structuredContent.sequential, true);
  assert.equal(heteroSeq.structuredContent.results.length, 4);
  assert.equal(heteroSeq.structuredContent.results[0].status, 'fulfilled');
  assert.equal(heteroSeq.structuredContent.results[0].server, 'dev');
  assert.equal(heteroSeq.structuredContent.results[1].status, 'fulfilled');
  assert.equal(heteroSeq.structuredContent.results[1].server, 'alpha');
  assert.match(heteroSeq.structuredContent.results[1].result.content[0].text, /alpha:after-write/);
  assert.equal(heteroSeq.structuredContent.results[2].status, 'fulfilled');
  assert.match(heteroSeq.structuredContent.results[2].result.content[0].text, /\[exit 7/);
  assert.equal(heteroSeq.structuredContent.results[3].status, 'rejected');
  assert.equal(heteroSeq.structuredContent.results[3].error.code, 'SKIPPED_AFTER_PRIOR_FAILURE');
  await assert.rejects(() => fs.stat(path.join(dir, 'never.txt')), /ENOENT/);

  // stop_on_error: false continues past a non-zero Dev command in sequential mode.
  const heteroContinue = await client.callTool({
    name: 'fallback_dispatch',
    arguments: {
      sequential: true,
      stop_on_error: false,
      calls: [
        { id: 'fail-cmd', server: 'dev', tool: 'bash', arguments: { command: 'exit 3', cwd: dir } },
        { id: 'still-runs', server: 'alpha', tool: 'ping_alpha', arguments: { msg: 'continued' } },
      ],
    },
  });
  assert.equal(heteroContinue.structuredContent.results[1].status, 'fulfilled');
  assert.match(heteroContinue.structuredContent.results[1].result.content[0].text, /alpha:continued/);

  // Invalid concurrency is rejected even when sequential: true.
  const badSeqConcurrency = await client.callTool({
    name: 'fallback_dispatch',
    arguments: {
      sequential: true,
      concurrency: 0,
      calls: [{ server: 'alpha', tool: 'ping_alpha', arguments: { msg: 'nope' } }],
    },
  });
  assert.equal(badSeqConcurrency.isError, true);
  assert.equal(badSeqConcurrency.structuredContent.error.code, 'INVALID_ARGUMENT');

  // Single-call mode rejects batch-only concurrency option, and schema omits contradictory defaults.
  const badSingleConcurrency = await client.callTool({
    name: 'fallback_dispatch',
    arguments: { server: 'alpha', tool: 'ping_alpha', arguments: { msg: 'x' }, concurrency: 2 },
  });
  assert.equal(badSingleConcurrency.isError, true);
  assert.equal(badSingleConcurrency.structuredContent.error.code, 'INVALID_ARGUMENT');
  const { tools: listedBrokerTools } = await client.listTools();
  const fbSchema = listedBrokerTools.find(tool => tool.name === 'fallback_dispatch').inputSchema.properties;
  assert.equal(fbSchema.concurrency.default, undefined);
  assert.equal(fbSchema.sequential.default, undefined);
  assert.equal(fbSchema.stop_on_error.default, undefined);
});

test('browser-daily/tabs classifies only list/omitted action as read-only for single calls and batches', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-bd-tabs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bdFixture = await writeFixtureMcpServer(dir, 'browser_daily', { modern: true });
  const cfgPath = path.join(dir, 'mcp.json');
  await fs.writeFile(cfgPath, JSON.stringify({ version: '1.0.0', mcpServers: {
    'browser-daily': { type: 'stdio', protocolVersion: '2026-07-28', command: process.execPath, args: [bdFixture.script] },
  } }));
  const pool = new DirectLocalServerPool({ configPath: cfgPath, idleMs: 0 });
  const broker = new LocalToolBroker({ inner: pool, configPath: cfgPath });
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'local-bd-tabs-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); await broker.shutdown(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const callTabs = args => client.callTool({
    name: 'fallback_dispatch',
    arguments: { server: 'browser-daily', tool: 'tabs', ...(args === undefined ? {} : { arguments: args }) },
  });
  assert.equal((await callTabs(undefined))._meta['webharness/mutation-state'], 'not_applicable');
  assert.equal((await callTabs({}))._meta['webharness/mutation-state'], 'not_applicable');
  assert.equal((await callTabs({ action: 'list' }))._meta['webharness/mutation-state'], 'not_applicable');
  assert.equal((await callTabs({ action: 'new', url: 'https://example.com' }))._meta['webharness/mutation-state'], 'unknown');
  assert.equal((await callTabs({ action: 'close', tab: 1 }))._meta['webharness/mutation-state'], 'unknown');

  const batchList = await client.callTool({
    name: 'tool_batch',
    arguments: { server: 'browser-daily', tool: 'tabs', calls: [{ arguments: {} }, { arguments: { action: 'list' } }] },
  });
  assert.equal(batchList._meta['webharness/mutation-state'], 'not_applicable');

  const batchMixed = await client.callTool({
    name: 'tool_batch',
    arguments: { server: 'browser-daily', tool: 'tabs', calls: [{ arguments: { action: 'list' } }, { arguments: { action: 'close', tab: 1 } }] },
  });
  assert.equal(batchMixed._meta['webharness/mutation-state'], 'unknown');
});

test('DirectLocalServerPool wakes only the addressed server and negotiates both modern 2026-07-28 and legacy stdio servers', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-direct-pool-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const alpha = await writeFixtureMcpServer(dir, 'alpha', { modern: true, modernOnly: true });
  const beta = await writeFixtureMcpServer(dir, 'beta', { modern: false });
  const cfgPath = path.join(dir, 'mcp.json');
  await fs.writeFile(cfgPath, JSON.stringify({
    version: '1.0.0',
    mcpServers: {
      alpha: { type: 'stdio', protocolVersion: '2026-07-28', command: process.execPath, args: [alpha.script] },
      beta: { type: 'stdio', protocolVersion: 'legacy', command: process.execPath, args: [beta.script] }
    }
  }), 'utf8');

  const records = [];
  const logger = { log: (_level, record) => records.push(record), flush: async () => {} };
  const pool = new DirectLocalServerPool({ configPath: cfgPath, idleMs: 0, logger });
  const broker = new LocalToolBroker({ inner: pool, configPath: cfgPath });
  t.after(() => broker.shutdown());

  const initial = await broker.list({});
  assert.deepEqual(initial.servers, [
    { server: 'alpha', available: null, toolCount: null, backendState: 'asleep' },
    { server: 'beta', available: null, toolCount: null, backendState: 'asleep' }
  ]);
  assert.deepEqual(await readPids(alpha.pidLog), []);
  assert.deepEqual(await readPids(beta.pidLog), []);

  const id = callId();
  const alphaRes = await traceCall({ id, layer: 'local', tool: 'tool_call', log: () => {} },
    () => broker.call({ server: 'alpha', tool: 'ping_alpha', arguments: { msg: 'one' } }));
  assert.equal(alphaRes.content[0].text, 'alpha:one');
  assert.deepEqual(records.filter(record => record.event === 'tool_call_completed').map(({ duration_ms, ...record }) => {
    assert.ok(duration_ms >= 0);
    return record;
  }), [{ event: 'tool_call_completed', call_id: id, server: 'alpha', tool: 'ping_alpha', outcome: 'success' }]);
  const alphaPids = await readPids(alpha.pidLog);
  assert.equal(alphaPids.length, 1);
  assert.deepEqual(await readPids(beta.pidLog), [], 'addressing alpha must never spawn beta');

  const mid = await broker.list({});
  assert.deepEqual(mid.servers, [
    { server: 'alpha', available: null, toolCount: null, backendState: 'running' },
    { server: 'beta', available: null, toolCount: null, backendState: 'asleep' }
  ]);

  const betaRes = await broker.call({ server: 'beta', tool: 'ping_beta', arguments: { msg: 'two' } });
  assert.equal(betaRes.content[0].text, 'beta:two');
  const betaPids = await readPids(beta.pidLog);
  assert.equal(betaPids.length, 1);

  await broker.shutdown();
  for (const pid of [...alphaPids, ...betaPids]) {
    assert.throws(() => process.kill(pid, 0), err => err.code === 'ESRCH');
  }
});

function poolGate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function lifecyclePoolFixture(t) {
  const configPath = await configFile(t, ['fixture']);
  const clients = [];
  const pool = new DirectLocalServerPool({
    configPath,
    idleMs: 0,
    clientFactory: async () => {
      const client = {
        alive: true,
        listTools: async () => ({ tools: [] }),
        close: async () => { client.alive = false; }
      };
      clients.push(client);
      return client;
    }
  });
  t.after(async () => {
    await pool.close();
    await Promise.all(clients.map(client => client.close()));
  });
  return { pool, clients, configPath };
}

test('concurrent config replacements share one supervisor and leave no client after close', async t => {
  const { pool, clients, configPath } = await lifecyclePoolFixture(t);
  await pool.listServerTools('fixture');
  const entered = poolGate();
  const release = poolGate();
  const originalClose = clients[0].close;
  clients[0].close = async () => { entered.resolve(); await release.promise; await originalClose(); };
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { fixture: { command: 'fixture', args: ['new'] } } }));
  const first = pool.listServerTools('fixture');
  await entered.promise;
  const second = pool.listServerTools('fixture');
  try {
    release.resolve();
    await Promise.all([first, second]);
    assert.equal(clients.length, 2, 'one original and one replacement client');
    assert.equal(pool.entries.size, 1);
    assert.equal(pool.entryUpdates.size, 0);
    await pool.close();
    assert.equal(clients.filter(client => client.alive).length, 0);
  } finally {
    release.resolve();
  }
});

for (const blockedRead of [1, 2]) {
  test(`closing the pool during config read ${blockedRead} prevents late startup and awaits pending work`, async t => {
    const { pool, clients } = await lifecyclePoolFixture(t);
    const entered = poolGate();
    const release = poolGate();
    const original = pool._readServerDefinition.bind(pool);
    let reads = 0;
    pool._readServerDefinition = async server => {
      const result = await original(server);
      if (++reads === blockedRead) { entered.resolve(); await release.promise; }
      return result;
    };
    const call = pool.listServerTools('fixture');
    const rejected = assert.rejects(call, /shut down|abort/i);
    await entered.promise;
    const closing = pool.close();
    assert.equal(pool.close(), closing, 'repeated close waits for the same cleanup');
    release.resolve();
    await Promise.all([rejected, closing]);
    assert.equal(clients.length, 0);
    assert.equal(pool.entries.size, 0);
    assert.equal(pool.entryUpdates.size, 0);
  });
}

test('DirectLocalServerPool negotiates protocolVersion auto via detached probe sibling on both modern and strict-legacy servers without orphan processes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-direct-auto-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const autoSrv = await writeFixtureMcpServer(dir, 'autosrv', { modern: true });
  const strictLegacyPidLog = path.join(dir, 'strict-legacy.pids');
  const strictLegacyScript = path.join(dir, 'strict-legacy.mjs');
  await fs.writeFile(
    strictLegacyScript,
    `import fs from 'node:fs';
import readline from 'node:readline';
fs.appendFileSync(${JSON.stringify(strictLegacyPidLog)}, String(process.pid) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (!initialized && msg.method !== 'initialize') process.exit(1);
  if (msg.method === 'initialize') {
    initialized = true;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'strict-legacy', version: '1.0.0' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'legacy_ping', inputSchema: { type: 'object' } }] } }) + '\\n');
  }
});
`,
    'utf8'
  );
  const cfgPath = path.join(dir, 'mcp.json');
  await fs.writeFile(cfgPath, JSON.stringify({
    version: '1.0.0',
    mcpServers: {
      autosrv: { type: 'stdio', protocolVersion: 'auto', command: process.execPath, args: [autoSrv.script] },
      strictlegacy: { type: 'stdio', protocolVersion: 'auto', command: process.execPath, args: [strictLegacyScript] }
    }
  }), 'utf8');

  const pool = new DirectLocalServerPool({ configPath: cfgPath, idleMs: 0 });
  const broker = new LocalToolBroker({ inner: pool, configPath: cfgPath });
  t.after(() => broker.shutdown());

  const listed = await broker.list({ server: 'autosrv' });
  assert.deepEqual(listed.tools.map(tool => tool.tool), ['ping_autosrv']);
  const legacyListed = await broker.list({ server: 'strictlegacy' });
  assert.deepEqual(legacyListed.tools.map(tool => tool.tool), ['legacy_ping']);

  for (const pidLog of [autoSrv.pidLog, strictLegacyPidLog]) {
    const pids = await readPids(pidLog);
    assert.equal(pids.length, 2, 'auto negotiation probes on one disposable sibling then opens one session');
    assert.throws(() => process.kill(pids[0], 0), err => err.code === 'ESRCH', 'probe sibling must already be reaped');
  }
  const allPids = [...await readPids(autoSrv.pidLog), ...await readPids(strictLegacyPidLog)];
  await broker.shutdown();
  for (const pid of allPids) {
    assert.throws(() => process.kill(pid, 0), err => err.code === 'ESRCH');
  }
});

test('DirectLocalServerPool enforces per-server requestTimeout and logs failure details', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-direct-timeout-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const slow = await writeFixtureMcpServer(dir, 'slow', { modern: true, slowMs: 2000 });
  const cfgPath = path.join(dir, 'mcp.json');
  const logFile = path.join(dir, 'logs', 'local-inner.log');
  const tomlPath = path.join(dir, 'config.toml');
  await fs.writeFile(tomlPath, `[logging]\nfile = ${JSON.stringify(logFile)}\nlevel = "info"\nmaxSize = 4096\nmaxFiles = 3\n`, 'utf8');
  await fs.writeFile(cfgPath, JSON.stringify({
    version: '1.0.0',
    mcpServers: {
      slow: { type: 'stdio', protocolVersion: '2026-07-28', command: process.execPath, args: [slow.script], requestTimeout: 120 }
    }
  }), 'utf8');

  const logger = new LocalDiagnosticLogger({ appConfigPath: tomlPath });
  const pool = new DirectLocalServerPool({ configPath: cfgPath, idleMs: 0, logger });
  const broker = new LocalToolBroker({ inner: pool, configPath: cfgPath, logger });
  t.after(() => broker.shutdown());

  const startedAt = Date.now();
  await assert.rejects(
    () => broker.call({ server: 'slow', tool: 'ping_slow', arguments: {} }),
    err => err.code === 'INNER_CALL_FAILED' && /timed out/i.test(err.message)
  );
  assert.ok(Date.now() - startedAt < 1800, 'requestTimeout must abort slow tool call promptly');
  await logger.flush();
  const logText = await fs.readFile(logFile, 'utf8');
  assert.match(logText, /event="tool_call_failed" server="slow" tool="ping_slow" duration_ms=\d+/);
  assert.match(logText, /event="tool_call_completed" server="slow" tool="ping_slow" duration_ms=\d+ outcome="error"/);
  assert.match(logText, /event="server_stderr" server="slow" stderr="slow: handling call"/);
});

test('broker budgets browser-daily execute and reports mixed batch outcomes with the ingress call ID', async t => {
  const configPath = await configFile(t, ['browser-daily']);
  const records = [];
  const observed = [];
  const inner = {
    isServerLive: () => true,
    listServerTools: async () => ({ tools: [{ name: 'execute' }] }),
    callServerTool: async (_server, _tool, args) => {
      observed.push(args);
      if (args.code === 'fail') return { content: [], isError: true, structuredContent: { error: { code: 'BROWSE_FAILED' } } };
      return { content: [] };
    },
    close: async () => {},
  };
  const broker = new LocalToolBroker({ inner, configPath, logger: { log: (_level, record) => records.push(record), flush: async () => {} } });
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'local-budget-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); await broker.shutdown(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const id = callId();
  const route = { server: 'browser-daily', tool: 'execute' };
  const result = await client.callTool({
    name: 'fallback_dispatch',
    _meta: { [CALL_ID_META]: id, [RPC_BUDGET_META]: 25_000 },
    arguments: {
      ...route,
      calls: [
        { arguments: { code: 'ok' } },
        { arguments: { code: 'fail', timeoutMs: 55_000 } },
        { arguments: { code: 'ok', timeoutMs: 0 } },
        { arguments: { code: 'ok', timeoutMs: 5_000 } },
      ],
    },
  });
  assert.deepEqual(observed.map(args => args.timeoutMs), [22_000, 22_000, 22_000, 5_000]);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.results[1].result.isError, true);
  const completed = records.find(row => row.event === 'call_completed' && row.call_id === id);
  assert.equal(completed.outcome, 'partial_error');
  assert.equal(completed.batch_total, 4);
  assert.equal(completed.batch_failed, 1);
  assert.equal(completed.error_code, 'BROWSE_FAILED');
  const failed = await client.callTool({
    name: 'fallback_dispatch',
    arguments: { ...route, calls: [{ arguments: { code: 'fail' } }] },
  });
  assert.equal(failed.isError, undefined);
  assert.equal(records.at(-1).outcome, 'error');
  await client.callTool({ name: 'tool_call', arguments: { ...route, arguments: { code: 'ok' } } });
  assert.equal(observed.at(-1).timeoutMs, undefined);
});

test('DirectLocalServerPool crash recovery respects restartOnExit without auto-replaying failed calls', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-direct-crash-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sup = await writeFixtureMcpServer(dir, 'supervised', { modern: true, crashFirstCall: true });
  const one = await writeFixtureMcpServer(dir, 'oneshot', { modern: true, crashFirstCall: true });
  const cfgPath = path.join(dir, 'mcp.json');
  await fs.writeFile(cfgPath, JSON.stringify({
    version: '1.0.0',
    mcpServers: {
      supervised: { type: 'stdio', protocolVersion: '2026-07-28', command: process.execPath, args: [sup.script], restartOnExit: true },
      oneshot: { type: 'stdio', protocolVersion: '2026-07-28', command: process.execPath, args: [one.script], restartOnExit: false }
    }
  }), 'utf8');

  const pool = new DirectLocalServerPool({ configPath: cfgPath, idleMs: 0 });
  const broker = new LocalToolBroker({ inner: pool, configPath: cfgPath, recovery: { pollMs: 10, timeoutMs: 3000 } });
  t.after(() => broker.shutdown());

  await assert.rejects(
    () => broker.call({ server: 'supervised', tool: 'ping_supervised', arguments: { msg: 'first' } }),
    { code: 'DOWNSTREAM_RECOVERED_RETRY_REQUIRED' }
  );
  const supCallsAfterCrash = (await fs.readFile(sup.callLog, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(supCallsAfterCrash.length, 1, 'ambiguous crashed call must never be auto-replayed');
  const retryRes = await broker.call({ server: 'supervised', tool: 'ping_supervised', arguments: { msg: 'second' } });
  assert.equal(retryRes.content[0].text, 'supervised:second');
  assert.equal((await readPids(sup.pidLog)).length, 2);

  await assert.rejects(
    () => broker.call({ server: 'oneshot', tool: 'ping_oneshot', arguments: { msg: 'only' } }),
    { code: 'INNER_CALL_FAILED' }
  );
  await assert.rejects(
    () => broker.call({ server: 'oneshot', tool: 'ping_oneshot', arguments: { msg: 'again' } }),
    { code: 'DOWNSTREAM_UNAVAILABLE' }
  );
  assert.equal((await readPids(one.pidLog)).length, 1, 'restartOnExit=false must not respawn crashed server');
});

test('LocalDiagnosticLogger rotates local-inner*.log files within maxSize * maxFiles budget', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-diag-rotate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'local-inner.log');
  const logger = new LocalDiagnosticLogger({ file: logFile, maxSize: 512, maxFiles: 3 });
  for (let i = 0; i < 40; i += 1) {
    logger.log('error', { event: 'tool_call_failed', server: 'browser-devtools', iter: i, detail: 'x'.repeat(60) });
  }
  await logger.flush();
  const names = (await fs.readdir(dir)).filter(name => /^local-inner.*\.log$/.test(name)).sort();
  assert.ok(names.length >= 2 && names.length <= 3, `expected 2..3 rotated files, got ${names.join(',')}`);
  let totalBytes = 0;
  for (const name of names) {
    const st = await fs.stat(path.join(dir, name));
    assert.ok(st.size <= 512, `${name} exceeded maxSize (${st.size} > 512)`);
    totalBytes += st.size;
  }
  assert.ok(totalBytes <= 512 * 3, `total bytes ${totalBytes} exceeded policy budget ${512 * 3}`);
});

test('fallback_dispatch enriches downstream schema validation errors with actionable route hints', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-schema-hint-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'inner.json');
  await fs.writeFile(configPath, JSON.stringify({
    mcpServers: {
      dev: {
        type: 'stdio',
        command: process.execPath,
        args: [path.resolve('providers/pi-dev/server.mjs')],
        env: {
          MCP_DEV_SHELL_MODE: 'unrestricted',
          MCP_DEV_PATH_MODE: 'user',
          MCP_DEV_DEFAULT_CWD: dir,
          MCP_DEV_STATE_DIR: dir,
          MCP_DEV_TERMINAL_SOCKET: path.join(dir, 'broker.sock'),
        },
      },
    },
  }));
  const inner = new DirectLocalServerPool({ configPath, idleMs: 0 });
  const broker = new LocalToolBroker({ inner, configPath, fallbackOnlyServers: ['dev'] });
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hint-test', version: '1' });
  t.after(async () => {
    await client.close();
    await server.close();
    await broker.shutdown();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const badExec = await client.callTool({
    name: 'fallback_dispatch',
    arguments: { server: 'dev', tool: 'exec', arguments: { command: 'echo hi | cat' } },
  });
  assert.equal(badExec.isError, true);
  assert.match(badExec.content[0].text, /Schema mismatch for dev\/exec:.*missing required property "argv"/);
  assert.match(badExec.content[0].text, /Hint: dev\/exec takes \{ argv: string\[\]/);
  assert.match(badExec.content[0].text, /use dev\/bash/);
  assert.match(badExec.content[0].text, /tool_schema\(server="dev", tool="exec"\)/);
});

test('local broker explains live field-level schema_input_invalid violations for non-Dev Local routes', async t => {
  const inner = {
    async listServerTools(server) {
      assert.equal(server, 'custom');
      return {
        tools: [{
          name: 'deploy_widget',
          description: 'Deploy a widget.',
          inputSchema: {
            type: 'object',
            properties: {
              target: { type: 'string', enum: ['staging', 'prod'] },
              replicas: { type: 'integer', minimum: 1 },
            },
            required: ['target', 'replicas'],
            additionalProperties: false,
          },
        }],
      };
    },
    async callServerTool(_server, _tool, args) {
      if (args.throwMode) {
        const err = new Error('schema_input_invalid');
        err.code = -32602;
        throw err;
      }
      return { isError: true, content: [{ type: 'text', text: 'schema_input_invalid' }] };
    },
    isServerLive: () => true,
    close: async () => {},
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-nondev-schema-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'inner.json');
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { custom: { command: process.execPath } } }));
  const broker = new LocalToolBroker({ inner, configPath });
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'nondev-schema-test', version: '1' });
  t.after(async () => {
    await client.close();
    await server.close();
    await broker.shutdown();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // Case 1: isError result carrying opaque schema_input_invalid
  const res1 = await client.callTool({
    name: 'fallback_dispatch',
    arguments: { server: 'custom', tool: 'deploy_widget', arguments: { target: 'dev', extra: true } },
  });
  assert.equal(res1.isError, true);
  assert.match(res1.content[0].text, /Schema mismatch for custom\/deploy_widget:/);
  assert.match(res1.content[0].text, /missing required property "replicas"/);
  assert.match(res1.content[0].text, /target: expected one of "staging", "prod"/);
  assert.match(res1.content[0].text, /unexpected property "extra"/);
  assert.match(res1.content[0].text, /tool_schema\(server="custom", tool="deploy_widget"\)/);

  // Case 2: thrown -32602 InvalidParams error
  const res2 = await client.callTool({
    name: 'tool_call',
    arguments: { server: 'custom', tool: 'deploy_widget', arguments: { target: 'prod', replicas: 0, throwMode: true } },
  });
  assert.equal(res2.isError, true);
  assert.match(res2.content[0].text, /Schema mismatch for custom\/deploy_widget:/);
  assert.match(res2.content[0].text, /replicas: must be >= 1/);
  assert.match(res2.content[0].text, /unexpected property "throwMode"/);
});

test('_lookupSchemaViolation aborts promptly on caller signal and never wakes dead servers', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-schema-abort-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'inner.json');
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { slow: { command: process.execPath }, dead: { command: process.execPath } } }));

  let wokeDead = false;
  let abortedLookup = false;
  const inner = {
    isServerLive: s => s === 'slow',
    listLiveServerTools: async (_s, _c, opts) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => { abortedLookup = true; reject(new Error('aborted')); }, { once: true });
    }),
    listServerTools: async s => { if (s === 'dead') wokeDead = true; return { tools: [{ name: 'op' }] }; },
    callServerTool: async () => ({ content: [] }),
    close: async () => {},
  };
  const broker = new LocalToolBroker({ inner, configPath });

  // 1. Dead server returns null without calling listServerTools.
  assert.equal(await broker._lookupSchemaViolation('dead', 'op', {}, undefined), null);
  assert.equal(wokeDead, false);

  // 2. Caller signal abort terminates hung lookup immediately instead of stalling 2s.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  const detail = await broker._lookupSchemaViolation('slow', 'op', {}, controller.signal, { timeoutMs: 2000 });
  const elapsed = Date.now() - started;
  assert.equal(detail, null);
  assert.equal(abortedLookup, true);
  assert.ok(elapsed < 500, `lookup abort took too long: ${elapsed}ms`);

  // 3. sequential: true rejects concurrency > 1 while accepting explicit concurrency: 1.
  await assert.rejects(
    () => broker.batchWithAllowedServers({ sequential: true, concurrency: 2, calls: [{ server: 'slow', tool: 'op', arguments: {} }] }, new Set(['slow'])),
    { code: 'INVALID_ARGUMENT' },
  );
  const seqOne = await broker.batchWithAllowedServers(
    { sequential: true, concurrency: 1, calls: [{ server: 'slow', tool: 'op', arguments: {} }] },
    new Set(['slow']),
    undefined,
    { allowHeterogeneous: true },
  );
  assert.equal(seqOne.sequential, true);
  assert.equal(seqOne.results[0].status, 'fulfilled');
});

test('batchResult coalesces consecutive plain text blocks while preserving non-plain blocks, empty content, and immutability', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-batch-coalesce-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'inner.json');
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { media: { command: process.execPath } } }));

  const img = { type: 'image', data: 'cG5n', mimeType: 'image/png' };
  const annotated = { type: 'text', text: 'note', annotations: { audience: ['user'] } };
  const inner = {
    isServerLive: () => true,
    listServerTools: async () => ({ tools: [{ name: 'op' }] }),
    callServerTool: async (_server, _tool, args) => {
      if (args.kind === 'img') return { content: [{ type: 'text', text: 'before-img' }, img, { type: 'text', text: 'after-img' }] };
      if (args.kind === 'annotated') return { content: [annotated] };
      if (args.kind === 'empty') return { content: [] };
      return { content: [{ type: 'text', text: `res:${args.kind}` }] };
    },
    close: async () => {},
  };
  const broker = new LocalToolBroker({ inner, configPath });
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'batch-coalesce-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
    await broker.shutdown();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const res = await client.callTool({
    name: 'fallback_dispatch',
    arguments: {
      server: 'media',
      tool: 'op',
      calls: [
        { id: 't1', arguments: { kind: 'one' } },
        { id: 'e1', arguments: { kind: 'empty' } },
        { id: 'm1', arguments: { kind: 'img' } },
        { id: 'a1', arguments: { kind: 'annotated' } },
        { id: 't2', arguments: { kind: 'two' } },
      ],
    },
  });
  assert.equal(res.isError, undefined);
  assert.equal(res.content.length, 5);
  assert.equal(res.content[0].type, 'text');
  assert.equal(res.content[0].text, 'call 0 (t1): fulfilled\nres:one\ncall 1 (e1): fulfilled\ncall 2 (m1): fulfilled\nbefore-img');
  assert.deepEqual(res.content[1], img);
  assert.equal(res.content[2].type, 'text');
  assert.equal(res.content[2].text, 'after-img\ncall 3 (a1): fulfilled');
  assert.deepEqual(res.content[3], annotated);
  assert.equal(res.content[4].type, 'text');
  assert.equal(res.content[4].text, 'call 4 (t2): fulfilled\nres:two');
  assert.deepEqual(res.structuredContent.results[0].result.content, [{ type: 'text', text: 'res:one' }]);
  assert.deepEqual(res.structuredContent.results[1].result.content, []);
});

test('sequential batch tracks wall-clock rpcBudgetMs, forwards decremented budget, and defers on low budget or soft promotion', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-seq-budget-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'inner.json');
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { dev: { command: process.execPath } } }));

  const seenBudgets = [];
  let executedCalls = [];
  const inner = {
    isServerLive: () => true,
    listServerTools: async () => ({ tools: [{ name: 'exec' }, { name: 'read' }] }),
    callServerTool: async (_server, tool, args, _signal, metaOverrides) => {
      executedCalls.push(tool);
      seenBudgets.push(metaOverrides?.rpcBudgetMs);
      if (args.sleepMs) await sleep(args.sleepMs);
      if (args.promote) {
        return {
          content: [{
            type: 'text',
            text: [
              'partial output',
              '[still running after 5.0s · promoted to job 1700000000000-abcd1234 (pid 1234, hard cap 120s)]',
              'log: /tmp/jobs/1700000000000-abcd1234.log',
              'exit: /tmp/jobs/1700000000000-abcd1234.exit',
              'Next: wait {"name":"job-1700000000000-abcd1234","condition":{"kind":"file_exists","path":"/tmp/jobs/1700000000000-abcd1234.exit"}}, then read the log.',
            ].join('\n'),
          }],
        };
      }
      return { content: [{ type: 'text', text: 'ok\n[exit 0 · 0.1s]' }] };
    },
    close: async () => {},
  };
  const broker = new LocalToolBroker({ inner, configPath });
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'seq-budget-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
    await broker.shutdown();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // 1. Step 1 takes ~3.5s out of 6s budget (<3s left) -> step 2 & 3 deferred with DEFERRED_RPC_BUDGET
  const budgetRes = await client.request(
    {
      method: 'tools/call',
      params: {
        name: 'fallback_dispatch',
        arguments: {
          sequential: true,
          calls: [
            { id: 's1', server: 'dev', tool: 'exec', arguments: { sleepMs: 3500 } },
            { id: 's2', server: 'dev', tool: 'exec', arguments: {} },
            { id: 's3', server: 'dev', tool: 'read', arguments: {} },
          ],
        },
        _meta: { 'webharness/rpc-budget-ms': 6_000 },
      },
    },
    // CallToolResultSchema is default on client.callTool, or use raw request
    (await import('@modelcontextprotocol/client')).CallToolResultSchema,
  );
  assert.equal(budgetRes.structuredContent.results[0].status, 'fulfilled');
  assert.equal(budgetRes.structuredContent.results[1].status, 'rejected');
  assert.equal(budgetRes.structuredContent.results[1].error.code, 'DEFERRED_RPC_BUDGET');
  assert.equal(budgetRes.structuredContent.results[2].status, 'rejected');
  assert.equal(budgetRes.structuredContent.results[2].error.code, 'DEFERRED_RPC_BUDGET');
  assert.deepEqual(executedCalls, ['exec']);

  // 2. Step 1 takes 200ms out of 10s budget -> step 2 runs and receives decremented rpcBudgetMs
  executedCalls = [];
  seenBudgets.length = 0;
  const decRes = await client.request(
    {
      method: 'tools/call',
      params: {
        name: 'fallback_dispatch',
        arguments: {
          sequential: true,
          calls: [
            { id: 'd1', server: 'dev', tool: 'exec', arguments: { sleepMs: 250 } },
            { id: 'd2', server: 'dev', tool: 'exec', arguments: {} },
          ],
        },
        _meta: { 'webharness/rpc-budget-ms': 10_000 },
      },
    },
    (await import('@modelcontextprotocol/client')).CallToolResultSchema,
  );
  assert.equal(decRes.structuredContent.results[0].status, 'fulfilled');
  assert.equal(decRes.structuredContent.results[1].status, 'fulfilled');
  assert.equal(seenBudgets.length, 2);
  assert.equal(seenBudgets[0], 10_000);
  assert.ok(seenBudgets[1] < 9_850 && seenBudgets[1] >= 3_000, `expected decremented budget, got ${seenBudgets[1]}`);

  // 3. Step 1 soft-promotes -> step 1 stays fulfilled, step 2 is deferred with DEFERRED_AFTER_PROMOTION
  executedCalls = [];
  const promoRes = await client.request(
    {
      method: 'tools/call',
      params: {
        name: 'fallback_dispatch',
        arguments: {
          sequential: true,
          calls: [
            { id: 'p1', server: 'dev', tool: 'exec', arguments: { promote: true } },
            { id: 'p2', server: 'dev', tool: 'read', arguments: {} },
          ],
        },
        _meta: { 'webharness/rpc-budget-ms': 25_000 },
      },
    },
    (await import('@modelcontextprotocol/client')).CallToolResultSchema,
  );
  assert.equal(promoRes.structuredContent.results[0].status, 'fulfilled');
  assert.equal(promoRes.structuredContent.results[1].status, 'rejected');
  assert.equal(promoRes.structuredContent.results[1].error.code, 'DEFERRED_AFTER_PROMOTION');
  assert.deepEqual(executedCalls, ['exec']);

  // 4. Boundary case: step 1 leaves ~4.5s (< 5000ms Dev minimum) out of 6s -> step 2 is deferred with DEFERRED_RPC_BUDGET
  executedCalls = [];
  seenBudgets.length = 0;
  const boundaryRes = await client.request(
    {
      method: 'tools/call',
      params: {
        name: 'fallback_dispatch',
        arguments: {
          sequential: true,
          calls: [
            { id: 'b1', server: 'dev', tool: 'exec', arguments: { sleepMs: 1500 } },
            { id: 'b2', server: 'dev', tool: 'exec', arguments: {} },
          ],
        },
        _meta: { 'webharness/rpc-budget-ms': 6_000 },
      },
    },
    (await import('@modelcontextprotocol/client')).CallToolResultSchema,
  );
  assert.equal(boundaryRes.structuredContent.results[0].status, 'fulfilled');
  assert.equal(boundaryRes.structuredContent.results[1].status, 'rejected');
  assert.equal(boundaryRes.structuredContent.results[1].error.code, 'DEFERRED_RPC_BUDGET');
  assert.deepEqual(executedCalls, ['exec']);
});

test('sequential batch treats failed dev command printing prior promoted footer as failure, not promotion', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-seq-failed-promo-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'inner.json');
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { dev: { command: process.execPath } } }));

  const inner = {
    isServerLive: () => true,
    listServerTools: async () => ({ tools: [{ name: 'bash' }, { name: 'read' }] }),
    callServerTool: async () => ({
      content: [{
        type: 'text',
        text: [
          '[still running after 5.0s · promoted to job 1700000000000-abcd1234 (pid 1234, hard cap 120s)]',
          'log: /tmp/jobs/1700000000000-abcd1234.log',
          'exit: /tmp/jobs/1700000000000-abcd1234.exit',
          'Next: wait {"name":"job-1700000000000-abcd1234","condition":{"kind":"file_exists","path":"/tmp/jobs/1700000000000-abcd1234.exit"}}, then read the log.',
          '[exit 1 · 0.1s]',
        ].join('\n'),
      }],
      _meta: { 'webharness/command-outcome': 'failed' },
    }),
    close: async () => {},
  };
  const broker = new LocalToolBroker({ inner, configPath });
  const res = await broker.fallbackDispatch({
    sequential: true,
    calls: [
      { id: 'c1', server: 'dev', tool: 'bash', arguments: {} },
      { id: 'c2', server: 'dev', tool: 'read', arguments: {} },
    ],
  });
  assert.equal(res.structuredContent.results[0].status, 'fulfilled');
  assert.equal(res.structuredContent.results[1].status, 'rejected');
  assert.equal(res.structuredContent.results[1].error.code, 'SKIPPED_AFTER_PRIOR_FAILURE');
});

test('malformed JSON-bleed in tool or server name fails fast with MALFORMED_TOOL_NAME', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-malformed-tool-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'inner.json');
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { dev: { command: process.execPath } } }));
  const inner = {
    isServerLive: () => true,
    listServerTools: async () => ({ tools: [] }),
    callServerTool: async () => ({ content: [] }),
    close: async () => {},
  };
  const broker = new LocalToolBroker({ inner, configPath, fallbackOnlyServers: ['dev'] });
  await assert.rejects(
    () => broker.fallbackDispatch({ server: 'dev', tool: 'bash},{arguments:{command:"ls"}}', arguments: {} }),
    err => err.code === 'MALFORMED_TOOL_NAME' && /looks like JSON arguments leaked/.test(err.message),
  );
});

test('DirectLocalServerPool logs startup stderr for operators, returns selected diagnostics to clients, and classifies JSON call_* stderr as info', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-startup-stderr-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const crashScript = path.join(dir, 'crash.mjs');
  await fs.writeFile(crashScript, [
    'process.stderr.write("Authorization: Bearer super-secret-token-xyz\\n");',
    'process.stderr.write("skill-library: MISSING_DEPENDENCY: approved file is missing: /private/path/foo/SKILL.md\\n");',
    'process.exit(1);',
  ].join('\n'), 'utf8');

  const healthy = await writeFixtureMcpServer(dir, 'healthy', { modern: true });
  const diagScript = path.join(dir, 'diag-wrapper.mjs');
  await fs.writeFile(diagScript, [
    'process.stderr.write(JSON.stringify({ event: "call_started", layer: "dev", tool: "read" }) + "\\n");',
    'process.stderr.write(JSON.stringify({ event: "call_completed", layer: "dev", tool: "read", outcome: "error" }) + "\\n");',
    'process.stderr.write("plain warning line\\n");',
    `await import(${JSON.stringify(new URL(`file://${healthy.script}`).href)});`,
  ].join('\n'), 'utf8');

  const cfgPath = path.join(dir, 'mcp.json');
  const logFile = path.join(dir, 'logs', 'local-inner.log');
  const tomlPath = path.join(dir, 'config.toml');
  await fs.writeFile(tomlPath, `[logging]\nfile = ${JSON.stringify(logFile)}\nlevel = "info"\nmaxSize = 65536\nmaxFiles = 2\n`, 'utf8');
  await fs.writeFile(cfgPath, JSON.stringify({
    version: '1.0.0',
    mcpServers: {
      broken: { type: 'stdio', protocolVersion: '2026-07-28', command: process.execPath, args: [crashScript] },
      diag: { type: 'stdio', protocolVersion: '2026-07-28', command: process.execPath, args: [diagScript] },
    },
  }), 'utf8');

  const logger = new LocalDiagnosticLogger({ appConfigPath: tomlPath });
  const pool = new DirectLocalServerPool({ configPath: cfgPath, idleMs: 0, logger });
  const broker = new LocalToolBroker({ inner: pool, configPath: cfgPath, logger });
  t.after(() => broker.shutdown());

  await assert.rejects(
    () => broker.call({ server: 'broken', tool: 'find_skills', arguments: {} }),
    err => err.code === 'INNER_CALL_FAILED'
      && err.cause?.code === 'INNER_START_FAILED'
      && /exit code 1/.test(err.message)
      && /code MISSING_DEPENDENCY/.test(err.message)
      && /see local-inner\.log for startup stderr/.test(err.message)
      && !/super-secret-token-xyz/.test(err.message)
      && !/\/private\/path\/foo\/SKILL\.md/.test(err.message),
  );

  const list = await broker.list({ server: 'diag' });
  assert.ok(list.tools.length >= 1);
  await logger.flush();
  const logText = await fs.readFile(logFile, 'utf8');
  assert.match(logText, /\[error\] event="server_start_failed" server="broken".*MISSING_DEPENDENCY.*\/private\/path\/foo\/SKILL\.md/);
  assert.match(logText, /\[info\] event="server_stderr" server="diag" stderr="\{\\"event\\":\\"call_started\\"/);
  assert.match(logText, /\[warn\] event="server_stderr" server="diag" stderr="\{\\"event\\":\\"call_completed\\".*\\"outcome\\":\\"error\\"/);
  assert.match(logText, /\[warn\] event="server_stderr" server="diag" stderr="plain warning line"/);
});

test('broker rewrites misleading browser-daily timeoutMs advice when capped by rpcBudgetMs', async t => {
  const configPath = await configFile(t, ['browser-daily']);
  const inner = {
    isServerLive: () => true,
    listServerTools: async () => ({ tools: [{ name: 'execute' }] }),
    callServerTool: async (_server, _tool, args) => ({
      isError: true,
      content: [{
        type: 'text',
        text: `tab: 42 Error: execute timed out after ${args.timeoutMs ?? 60000} ms (pass a larger timeoutMs, or split the work into several calls)`,
      }],
    }),
    close: async () => {},
  };
  const broker = new LocalToolBroker({ inner, configPath });
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'local-browser-timeout-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); await broker.shutdown(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const capped = await client.callTool({
    name: 'fallback_dispatch',
    _meta: { [CALL_ID_META]: callId(), [RPC_BUDGET_META]: 25_000 },
    arguments: { server: 'browser-daily', tool: 'execute', arguments: { code: 'slow()' } },
  });
  assert.equal(capped.isError, true);
  assert.match(capped.content[0].text, /capped at 22000 ms by this client's 25s RPC budget; split the work into smaller calls instead of passing a larger timeoutMs/);

  const uncapped = await client.callTool({
    name: 'fallback_dispatch',
    _meta: { [CALL_ID_META]: callId(), [RPC_BUDGET_META]: 25_000 },
    arguments: { server: 'browser-daily', tool: 'execute', arguments: { code: 'slow()', timeoutMs: 5_000 } },
  });
  assert.equal(uncapped.isError, true);
  assert.match(uncapped.content[0].text, /pass a larger timeoutMs, or split the work into several calls/);
});

test('broker recycles skill-library once on POLICY_CHANGED and bounds retries', async t => {
  const configPath = await configFile(t, ['skill-library', 'other']);
  const policyChangedRes = {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code: 'POLICY_CHANGED', message: 'approved policy changed' }) }],
  };
  const events = [];
  const logger = { log: (level, record) => events.push({ level, ...record }) };

  let skillCalls = 0;
  let restarted = false;
  const inner = fakeInner({
    pages: { FIRST: { tools: [{ name: 'find_skills' }] } },
    callHandler: async (server) => {
      if (server === 'skill-library') {
        skillCalls += 1;
        return restarted ? { content: [{ type: 'text', text: '{"candidates":[]}' }] } : policyChangedRes;
      }
      return policyChangedRes;
    },
    restartHandler: async () => { restarted = true; },
  });
  const broker = new LocalToolBroker({ inner, configPath, logger, recovery: { pollMs: 5, timeoutMs: 500 } });
  const recovered = await broker.call({ server: 'skill-library', tool: 'find_skills', arguments: {} });
  assert.equal(recovered.isError, undefined);
  assert.equal(skillCalls, 2);
  assert.equal(inner.restartCalls.length, 1);
  assert.equal(inner.restartCalls[0].server, 'skill-library');
  assert.ok(events.some(e => e.event === 'server_policy_reload' && e.server === 'skill-library'));

  // Other servers returning POLICY_CHANGED must not trigger skill-library recycling.
  const otherRes = await broker.call({ server: 'other', tool: 'find_skills', arguments: {} });
  assert.equal(otherRes.isError, true);
  assert.equal(inner.restartCalls.length, 1);

  // Persistent POLICY_CHANGED must only retry once (no infinite loop).
  const stuckInner = fakeInner({
    pages: { FIRST: { tools: [{ name: 'find_skills' }] } },
    callHandler: async () => policyChangedRes,
  });
  const stuckBroker = new LocalToolBroker({ inner: stuckInner, configPath, recovery: { pollMs: 5, timeoutMs: 500 } });
  const stuckRes = await stuckBroker.call({ server: 'skill-library', tool: 'find_skills', arguments: {} });
  assert.equal(stuckRes.isError, true);
  assert.equal(stuckInner.callCalls.length, 2);
  assert.equal(stuckInner.restartCalls.length, 1);

  // Respect restartOnExit: false (canAutoRecover === false).
  const noAutoInner = {
    ...fakeInner({
      pages: { FIRST: { tools: [{ name: 'find_skills' }] } },
      callHandler: async () => policyChangedRes,
    }),
    canAutoRecover: async () => false,
  };
  const noAutoBroker = new LocalToolBroker({ inner: noAutoInner, configPath, recovery: { pollMs: 5, timeoutMs: 500 } });
  const noAutoRes = await noAutoBroker.call({ server: 'skill-library', tool: 'find_skills', arguments: {} });
  assert.equal(noAutoRes.isError, true);
  assert.equal(noAutoInner.callCalls.length, 1);
  assert.equal(noAutoInner.restartCalls.length, 0);
});
