import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  LocalToolBroker,
  MAX_LIST_LIMIT,
  createLocalBrokerServer
} from '../server.mjs';

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

test('model-facing broker exposes list, schema, call, and batch', async t => {
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
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['tool_batch', 'tool_call', 'tool_list', 'tool_schema']);
  const call = tools.find(tool => tool.name === 'tool_call');
  const batch = tools.find(tool => tool.name === 'tool_batch');
  assert.equal(call.annotations.readOnlyHint, false);
  assert.equal(call.annotations.openWorldHint, true);
  assert.equal(batch.annotations.destructiveHint, true);
  assert.equal(batch.annotations.openWorldHint, true);

  const result = await client.callTool({ name: 'tool_call', arguments: { server: 'browser', tool: 'take_screenshot' } });
  assert.deepEqual(result.content, image.content);
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
  assert.equal(inner.listCalls.length, 3);
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
    pages: { FIRST: { tools: [] } },
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
    pages: { FIRST: { tools: [] } },
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
  }, undefined, { signal: controller.signal });
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
