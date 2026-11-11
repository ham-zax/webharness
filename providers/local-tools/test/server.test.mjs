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
  LazyInner1Mcp,
  LocalDiagnosticLogger,
  LocalToolBroker,
  MAX_LIST_LIMIT,
  createLocalBrokerServer,
  parseInnerIdleMs
} from '../server.mjs';
import { acquireRuntimeLease, hasActiveRuntimeLeases } from '../../../lib/runtime-leases.mjs';
import { reclaimStaleRuntimeOwnership } from '../../../lib/one-mcp-runtime-ownership.mjs';

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

function fakeInner({ pages, callResult = { content: [{ type: 'text', text: 'ok' }] }, callHandler }) {
  const listCalls = [];
  const callCalls = [];
  let closed = false;
  return {
    listCalls,
    callCalls,
    get closed() { return closed; },
    async listTools(cursor) {
      listCalls.push(cursor);
      const key = cursor ?? 'FIRST';
      const page = typeof pages === 'function' ? pages(key) : pages[key];
      if (page instanceof Error) throw page;
      return structuredClone(page ?? { tools: [] });
    },
    async callTool(name, args, signal) {
      callCalls.push({ name, args });
      if (callHandler) return callHandler(name, args, signal);
      return callResult;
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
  assert.equal(fallback.annotations.readOnlyHint, true);
  assert.equal(fallback.annotations.destructiveHint, false);
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
        { name: '1mcp_1mcp_mcp_reload', description: 'private recovery tool' },
        { name: 'browser-devtools_1mcp_take_heapsnapshot', description: 'analyze browser memory distribution' },
        { name: 'repo-search_1mcp_search_codebase', description: 'semantic repository search' }
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
  let reloads = 0;
  const inner = fakeInner({
    pages: () => ({
      tools: recovered ? [{ name: 'codebase-memory-mcp_1mcp_list_projects', description: 'list indexed projects' }] : []
    }),
    callHandler: async (name) => {
      assert.equal(name, '1mcp_1mcp_mcp_reload');
      reloads += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      recovered = true;
      return { structuredContent: { status: 'success' }, content: [{ type: 'text', text: 'reloaded' }] };
    }
  });
  const broker = new LocalToolBroker({ inner, configPath, recovery: { pollMs: 5, timeoutMs: 400 } });

  const [first, second] = await Promise.all([
    broker.list({ server: 'codebase-memory-mcp' }),
    broker.list({ server: 'codebase-memory-mcp' })
  ]);
  assert.equal(reloads, 1);
  assert.deepEqual(first.tools.map(tool => tool.tool), ['list_projects']);
  assert.deepEqual(second.tools.map(tool => tool.tool), ['list_projects']);
});

test('failed direct call may recover an absent server but never auto-replays the original action', async t => {
  const configPath = await configFile(t, ['codebase-memory-mcp']);
  let recovered = false;
  let targetCalls = 0;
  const inner = fakeInner({
    pages: () => ({
      tools: recovered ? [{ name: 'codebase-memory-mcp_1mcp_list_projects', description: 'list indexed projects' }] : []
    }),
    callHandler: async (name) => {
      if (name === '1mcp_1mcp_mcp_reload') {
        recovered = true;
        return { structuredContent: { status: 'success' }, content: [{ type: 'text', text: 'reloaded' }] };
      }
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
  let reloaded = false;
  let listingsAfterReload = 0;
  let reloadTimeout;
  const inner = fakeInner({
    pages: () => {
      if (!reloaded) return { tools: [] };
      listingsAfterReload += 1;
      // A cold backend registers no tools until its third listing.
      return {
        tools: listingsAfterReload >= 3 ? [{ name: 'browser-devtools_1mcp_take_screenshot', description: 'shot' }] : []
      };
    },
    callHandler: async (name, args) => {
      assert.equal(name, '1mcp_1mcp_mcp_reload');
      reloadTimeout = args.timeout;
      reloaded = true;
      return { structuredContent: { status: 'success' }, content: [{ type: 'text', text: 'reloaded' }] };
    }
  });
  const broker = new LocalToolBroker({ inner, configPath, recovery: { pollMs: 5, timeoutMs: 2_000 } });

  const listed = await broker.list({ server: 'browser-devtools' });
  assert.deepEqual(listed.tools.map(tool => tool.tool), ['take_screenshot']);
  assert.ok(listingsAfterReload >= 3, 'the broker must re-check until the backend registers its tools');
  assert.equal(reloadTimeout, broker.recoveryTimeoutMs, 'the inner reload must receive the recovery budget');
});

test('recovery reports the waited time when a backend never registers tools', async t => {
  const configPath = await configFile(t, ['codebase-memory-mcp']);
  const inner = fakeInner({
    pages: () => ({ tools: [] }),
    callHandler: async () => ({ structuredContent: { status: 'success' }, content: [{ type: 'text', text: 'reloaded' }] })
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
        { name: '1mcp_1mcp_tool_search', description: 'internal', inputSchema: { type: 'object' } },
        { name: 'browser_1mcp_alpha', title: 'Alpha', description: 'network alpha', inputSchema: { type: 'object', properties: { secret: { type: 'string' } } } },
        { name: 'browser_1mcp_beta', description: 'network beta', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } },
        { name: 'future_1mcp_gamma', description: 'future provider', inputSchema: { type: 'object' } },
        { name: 'browser_1mcp_delta', description: 'network delta', inputSchema: { type: 'object' } }
      ],
      nextCursor: 'P2'
    },
    P2: {
      tools: [
        { name: 'browser_1mcp_epsilon', description: 'network epsilon', inputSchema: { type: 'object' } },
        { name: 'browser_1mcp_tool_1mcp_suffix', description: 'network separator tool', inputSchema: { type: 'object' } }
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
  assert.ok(first.tools.every(tool => tool.tool !== '1mcp_tool_search'));

  const second = await broker.list({ server: 'browser', query: 'network', limit: MAX_LIST_LIMIT, cursor: first.nextCursor });
  assert.deepEqual(second.tools.map(tool => tool.tool), ['delta', 'epsilon', 'tool_1mcp_suffix']);
  assert.equal(second.hasMore, false);
  assert.deepEqual(inner.listCalls.slice(0, 2), [undefined, undefined]);

  await assert.rejects(
    () => broker.list({ server: 'browser', query: 'different', cursor: first.nextCursor }),
    /INVALID_CURSOR/
  );
});

test('tool_schema reads current inner catalog state and preserves a separator inside tool names', async t => {
  const configPath = await configFile(t);
  let description = 'first';
  const inner = fakeInner({ pages: () => ({ tools: [{
    name: 'browser_1mcp_tool_1mcp_suffix',
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
    name: 'browser_1mcp_take_screenshot',
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
    pages: { FIRST: { tools: [{ name: 'browser_1mcp_observe', description: 'fixture' }] } },
    callHandler: async (_name, args) => {
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
    pages: { FIRST: { tools: [{ name: 'browser_1mcp_observe', description: 'fixture' }] } },
    callHandler: async (_name, _args, signal) => {
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
  const lazy = new LazyInner1Mcp({ start, idleMs: 0 });
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
  const lazy = new LazyInner1Mcp({
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
  const lazy = new LazyInner1Mcp({ start, idleMs: 30 });
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
  const lazy = new LazyInner1Mcp({ start, idleMs: 20 });
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
  const lazy = new LazyInner1Mcp({ start, idleMs: 0 });
  await lazy.listTools();
  created[0].alive = false;
  await Promise.all([lazy.listTools(), lazy.listTools()]);
  assert.equal(created.length, 2);
  assert.equal(created[0].closeCount, 1);
  await lazy.close();
});

test('lazy inner with idleMs 0 never idle-stops', async () => {
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyInner1Mcp({ start, idleMs: 0 });
  await lazy.listTools();
  await sleep(80);
  assert.equal(created[0].closeCount, 0);
  await lazy.close();
  assert.equal(created[0].closeCount, 1);
});

test('lazy inner close is idempotent, cancels the timer, and rejects later calls', async () => {
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyInner1Mcp({ start, idleMs: 20 });
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
  const lazy = new LazyInner1Mcp({ idleMs: 0, start: async () => { await gate; return start(); } });
  const pending = lazy.listTools();
  const rejected = assert.rejects(pending, { code: 'INNER_UNAVAILABLE' });
  const closing = lazy.close();
  release();
  await closing;
  await rejected;
  assert.equal(created.length, 1);
  assert.equal(created[0].closeCount, 1);
});

test('broker works through the lazy inner wrapper without starting it on construction', async t => {
  const { created, start } = fakeInnerFactory();
  const lazy = new LazyInner1Mcp({ start, idleMs: 0 });
  const broker = new LocalToolBroker({ inner: lazy, configPath: await configFile(t) });
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
  const inner = { state: 'asleep', async listTools() { throw new Error('must stay asleep'); }, async callTool() {}, async close() {} };
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
  const lazy = new LazyInner1Mcp({ start, idleMs: 15, isPinned: async () => pinned });
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
  const lazy = new LazyInner1Mcp({ start, idleMs: 15, isPinned: () => hasActiveRuntimeLeases(directory) });
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
          name: 'terminal_1mcp_terminal_read',
          description: 'read terminal output',
          inputSchema: { type: 'object', properties: { name: { type: 'string' }, max_bytes: { type: 'number' } }, required: ['name'] }
        },
        {
          name: 'terminal_1mcp_terminal_open',
          description: 'open a terminal',
          inputSchema: { type: 'object', properties: { command: { type: 'string' }, name: { type: 'string' } } }
        },
        { name: 'terminal_1mcp_terminal_list', description: 'list terminals', inputSchema: { type: 'object', properties: {} } },
        { name: 'terminal_1mcp_terminal_noschema', description: 'no schema at all' }
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
import { Server } from ${JSON.stringify(mcpServerModUrl)};
import { StdioServerTransport, serveStdio } from ${JSON.stringify(mcpServerStdioModUrl)};

fs.appendFileSync(${JSON.stringify(pidLog)}, String(process.pid) + '\\n');
function buildServer() {
  const server = new Server({ name: ${JSON.stringify(name)}, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({
    tools: [{ name: ${JSON.stringify(`ping_${name}`)}, description: 'Ping fixture', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }]
  }));
  server.setRequestHandler('tools/call', async req => {
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
  return server;
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

  const pool = new DirectLocalServerPool({ configPath: cfgPath, idleMs: 0 });
  const broker = new LocalToolBroker({ inner: pool, configPath: cfgPath });
  t.after(() => broker.shutdown());

  const initial = await broker.list({});
  assert.deepEqual(initial.servers, [
    { server: 'alpha', available: null, toolCount: null, backendState: 'asleep' },
    { server: 'beta', available: null, toolCount: null, backendState: 'asleep' }
  ]);
  assert.deepEqual(await readPids(alpha.pidLog), []);
  assert.deepEqual(await readPids(beta.pidLog), []);

  const alphaRes = await broker.call({ server: 'alpha', tool: 'ping_alpha', arguments: { msg: 'one' } });
  assert.equal(alphaRes.content[0].text, 'alpha:one');
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
  assert.match(logText, /event="server_stderr" server="slow" stderr="slow: handling call"/);
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
