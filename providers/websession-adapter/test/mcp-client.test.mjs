import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client } from '@modelcontextprotocol/client';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { callMcpTool, closeMcpPools, listMcpTools } from '../mcp-client.mjs';
import { OperationCore } from '../core.mjs';
import { parseRequest } from '../protocol.mjs';
import { AdapterStore, requestHash } from '../store.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture timed out')), 10000); })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-client-fixture-'));
  const state = { tools: ['old'], instructions: 'first instructions', calls: [], listings: 0, listingGate: null, listingEntered: null, factoryGate: null, factoryEntered: null, factories: 0 };
  const handler = createMcpHandler(async () => {
    state.factories += 1;
    if (state.factoryGate) {
      const gate = state.factoryGate;
      state.factoryGate = null;
      state.factoryEntered.resolve();
      await gate.promise;
    }
    const server = new Server({ name: 'client-test', version: '1' }, { capabilities: { tools: { listChanged: true } }, instructions: state.instructions });
    server.setRequestHandler('tools/list', async () => {
      const names = [...state.tools];
      state.listings += 1;
      if (state.listingGate) {
        const gate = state.listingGate;
        state.listingGate = null;
        state.listingEntered.resolve();
        await gate.promise;
      }
      return { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })) };
    });
    server.setRequestHandler('tools/call', ({ params }) => {
      state.calls.push(params.name);
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    return server;
  });
  const serve = toNodeHandler(handler);
  const http = createServer((req, res) => void serve(req, res));
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const options = { stateDir, mcpUrl: `http://127.0.0.1:${http.address().port}/mcp`, callbackUrl: 'http://127.0.0.1:9/callback' };
  t.after(async () => {
    state.listingGate?.resolve();
    state.factoryGate?.resolve();
    await closeMcpPools();
    await handler.close();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { state, handler, options };
}

test('fresh modern discovery returns updated instructions', async t => {
  const { state, options } = await fixture(t);
  assert.equal((await listMcpTools(options)).instructions, 'first instructions');
  state.instructions = 'second instructions';
  assert.equal((await listMcpTools(options)).instructions, 'second instructions');
});

test('abort while metadata is pending never invokes the dispatch hook or backend', async t => {
  const { state, options } = await fixture(t);
  const gate = deferred();
  state.listingGate = gate;
  state.listingEntered = deferred();
  const controller = new AbortController();
  const store = new AdapterStore(options.stateDir);
  const issued = store.issueMainCapability(60);
  const requestJson = JSON.stringify({ version: 1, tool: 'old', arguments: {} });
  const operation = store.submitOperation(issued.id, 'aborted-before-dispatch', requestJson, requestHash(requestJson));
  assert.equal(store.claimQueued(operation.operation.id), true);
  try {
    const call = callMcpTool({ ...options, signal: controller.signal }, 'old', {}, { onBeforeDispatch: () => store.markDispatchStarted(operation.operation.id) });
    await bounded(state.listingEntered.promise);
    controller.abort();
    await assert.rejects(call);
    gate.resolve();
    assert.equal(store.getOperation(operation.operation.id).dispatch_started_ms, null);
    assert.deepEqual(state.calls, []);
    await callMcpTool(options, 'old', {});
    assert.deepEqual(state.calls, ['old']);
  } finally {
    gate.resolve();
    store.close();
  }
});

test('aborting one connection waiter does not abort another', async t => {
  const { state, options } = await fixture(t);
  const gate = deferred();
  state.factoryGate = gate;
  state.factoryEntered = deferred();
  const controller = new AbortController();
  const first = callMcpTool({ ...options, signal: controller.signal }, 'old', {});
  const second = callMcpTool(options, 'old', {});
  await bounded(state.factoryEntered.promise);
  controller.abort();
  await assert.rejects(first);
  gate.resolve();
  await bounded(second);
  assert.deepEqual(state.calls, ['old']);
});

test('closing pools during startup does not revive a pending connection', async t => {
  const { state, options } = await fixture(t);
  const gate = deferred();
  state.factoryGate = gate;
  state.factoryEntered = deferred();
  const call = callMcpTool(options, 'old', {});
  await bounded(state.factoryEntered.promise);
  const closing = closeMcpPools();
  gate.resolve();
  await assert.rejects(call);
  await bounded(closing);
  assert.deepEqual(state.calls, []);
  await callMcpTool(options, 'old', {});
  assert.deepEqual(state.calls, ['old']);
  assert.ok(state.factories >= 2);
});

test('modern tool-list subscription invalidates the adapter cache', async t => {
  const { state, handler, options } = await fixture(t);
  await callMcpTool(options, 'old', {});
  const initialListings = state.listings;
  state.tools = ['old', 'new'];
  handler.notify.toolsChanged();
  await bounded((async () => {
    while (state.listings === initialListings) {
      await callMcpTool(options, 'old', {});
      if (state.listings === initialListings) await new Promise(resolve => setTimeout(resolve, 10));
    }
  })());
  await callMcpTool(options, 'new', {});
  assert.equal(state.calls.at(-1), 'new');
});

test('a newer turn during discovery prevents dispatch', async t => {
  const { state, options } = await fixture(t);
  const core = new OperationCore({ ...options, toolTimeoutMs: 5000 });
  const gate = deferred();
  state.factoryGate = gate;
  state.factoryEntered = deferred();
  try {
    const issued = core.store.issueMainCapability(120);
    const submitted = core.submit(issued.token, 'old-turn-discovery', parseRequest({ version: 1, tool: 'old', arguments: {} }), 'json-post-v1', 1);
    await bounded(state.factoryEntered.promise);
    assert.equal(core.store.advanceTurn(issued.id, 2), true);
    gate.resolve();
    const operation = await core.waitForOperation(submitted.operation.id, 10000);
    assert.equal(operation.state, 'rejected');
    assert.equal(operation.error_text, 'superseded_by_newer_turn');
    assert.equal(operation.dispatch_started_ms, null);
    assert.deepEqual(state.calls, []);
  } finally {
    gate.resolve();
    await core.close();
  }
});

test('a notification during an old listing prevents stale names from being cached', async t => {
  const { state, handler, options } = await fixture(t);
  const original = Client.prototype._setupListChangedHandler;
  let delivered = deferred();
  Client.prototype._setupListChangedHandler = function (kind, method, config, fetcher) {
    const wrapped = { ...config, onChanged: (...args) => { config.onChanged(...args); delivered.resolve(); } };
    return original.call(this, kind, method, wrapped, fetcher);
  };
  const gate = deferred();
  try {
    await callMcpTool(options, 'old', {});
    handler.notify.toolsChanged();
    await bounded(delivered.promise);
    state.listingGate = gate;
    state.listingEntered = deferred();
    const pending = callMcpTool(options, 'old', {});
    await bounded(state.listingEntered.promise);
    state.tools = ['new'];
    delivered = deferred();
    handler.notify.toolsChanged();
    await bounded(delivered.promise);
    gate.resolve();
    await assert.rejects(pending, /unavailable/);
    await callMcpTool(options, 'new', {});
    assert.deepEqual(state.calls, ['old', 'new']);
  } finally {
    gate.resolve();
    Client.prototype._setupListChangedHandler = original;
  }
});
