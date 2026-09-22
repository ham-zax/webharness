import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createBrowserJevServer } from '../server.mjs';

test('browser-jev exposes exactly five strict tools and routes calls', async t => {
  const calls = [];
  const manager = {
    async runToTerminal(args) { calls.push(['run', args]); return { run_id: 'run-auto', status: 'done' }; },
    async start(args) { calls.push(['start', args]); return { run_id: 'run1', status: 'ready' }; },
    async tick(id) { calls.push(['tick', id]); return { run_id: id, status: 'ready', elapsed_ms: 12 }; },
    state(id) { calls.push(['state', id]); return { run_id: id, status: 'ready' }; },
    async stop(id) { calls.push(['stop', id]); return { run_id: id, status: 'stopped' }; },
    async close() {}
  };
  const server = createBrowserJevServer({ manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'browser-jev-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'jev_run', 'jev_start', 'jev_state', 'jev_stop', 'jev_tick'
  ]);
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  assert.equal(byName.jev_run.annotations.readOnlyHint, false);
  assert.equal(byName.jev_run.annotations.idempotentHint, false);
  assert.equal(byName.jev_start.annotations.readOnlyHint, false);
  assert.equal(byName.jev_start.annotations.idempotentHint, false);
  assert.equal(byName.jev_tick.annotations.idempotentHint, false);
  assert.equal(byName.jev_stop.annotations.idempotentHint, false);
  assert.equal(byName.jev_state.annotations.readOnlyHint, true);
  assert.equal(byName.jev_state.annotations.idempotentHint, true);
  assert.deepEqual(byName.jev_run.inputSchema, byName.jev_start.inputSchema);
  assert.equal(byName.jev_start.inputSchema.additionalProperties, false);
  assert.equal(byName.jev_start.inputSchema.properties.scenario.additionalProperties, false);
  assert.equal(byName.jev_start.inputSchema.properties.scenario.properties.success.additionalProperties, false);
  assert.deepEqual(
    byName.jev_start.inputSchema.properties.scenario.properties.success.properties.required_operations.items.enum,
    ['CLICK', 'TYPE_TEXT', 'SELECT', 'WAIT']
  );
  const serializedSchemas = JSON.stringify(tools.map(tool => tool.inputSchema));
  for (const forbidden of ['api_key', 'credential', 'selector', 'javascript', 'cdp_url', 'endpoint']) {
    assert.equal(serializedSchemas.toLowerCase().includes(forbidden), false);
  }

  const startArgs = {
    url: 'https://example.com',
    goal: 'Confirm it',
    scenario: { success: { title_contains: ['Example'] } }
  };
  const completed = await client.callTool({ name: 'jev_run', arguments: startArgs });
  assert.deepEqual(completed.structuredContent, { run_id: 'run-auto', status: 'done' });
  const started = await client.callTool({ name: 'jev_start', arguments: startArgs });
  assert.deepEqual(started.structuredContent, { run_id: 'run1', status: 'ready' });
  assert.deepEqual(JSON.parse(started.content[0].text), started.structuredContent);
  await client.callTool({ name: 'jev_tick', arguments: { run_id: 'run1' } });
  await client.callTool({ name: 'jev_state', arguments: { run_id: 'run1' } });
  await client.callTool({ name: 'jev_stop', arguments: { run_id: 'run1' } });
  assert.deepEqual(calls, [
    ['run', startArgs], ['start', startArgs], ['tick', 'run1'], ['state', 'run1'], ['stop', 'run1']
  ]);
});

test('tool failures are structured and do not expose stacks or secrets', async t => {
  const secret = 'never-return-this-value';
  const error = Object.assign(new Error('safe failure'), { code: 'EXPECTED_FAILURE' });
  error.stack = `stack with ${secret}`;
  const manager = {
    async runToTerminal() { throw error; },
    async start() { throw error; },
    async tick() { throw error; },
    state() { throw error; },
    async stop() { throw error; },
    async close() {}
  };
  const server = createBrowserJevServer({ manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'browser-jev-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({
    name: 'jev_start',
    arguments: { url: 'https://example.com', goal: 'Confirm', scenario: { success: { text_contains: ['Example'] } } }
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: { code: 'EXPECTED_FAILURE', message: 'safe failure' }
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('stack with'), false);
});

