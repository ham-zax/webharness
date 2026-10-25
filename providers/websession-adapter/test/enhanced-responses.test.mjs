import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { OperationCore } from '../core.mjs';
import { enhancedSnapshot, parseWait, prefersPlainText, renderOperation, upstreamUnavailable } from '../protocol.mjs';

test('only downstream 5xx errors are reported as a retryable backend outage', () => {
  assert.equal(upstreamUnavailable({ code: 503 }), true);
  assert.equal(upstreamUnavailable({ code: 502 }), true);
  assert.equal(upstreamUnavailable({ code: 500 }), true);
  assert.equal(upstreamUnavailable({ code: 401 }), false);
  assert.equal(upstreamUnavailable({ code: 404 }), false);
  assert.equal(upstreamUnavailable(new Error('boom')), false);
  assert.equal(upstreamUnavailable(undefined), false);
});

test('wait accepts whole seconds from zero to ninety and distinguishes absence', () => {
  assert.equal(parseWait(new URLSearchParams()), undefined);
  for (const seconds of [0, 1, 45, 90]) {
    assert.equal(parseWait(new URLSearchParams(`wait=${seconds}`)), seconds * 1000);
  }
  for (const value of ['', '-1', '91', '1.5', '1e1', '+1', ' 1', 'NaN', 'Infinity', '1x']) {
    assert.throws(() => parseWait(new URLSearchParams({ wait: value })), /invalid_wait/);
  }
  assert.throws(() => parseWait(new URLSearchParams('wait=1&wait=2')), /invalid_wait/);
});

test('plain text is selected only when Accept includes text/plain without application/json', () => {
  for (const accept of ['text/plain', 'text/html, text/plain', 'TEXT/PLAIN; charset=utf-8']) {
    assert.equal(prefersPlainText(accept), true);
  }
  for (const accept of [undefined, '', '*/*', 'text/html', 'application/json', 'text/plain, application/json']) {
    assert.equal(prefersPlainText(accept), false);
  }
});

test('full results share rendering overrides while default snapshots remain chunked', () => {
  const operation = { id: 'operation-1', state: 'completed', chunk_count: 3, result_text: null };
  const statusUrl = 'https://bridge.example/v1/operations/token/operation-1';
  const original = { ...operation };
  const result = `${'🌍'.repeat(5000)}\nlast line\n`;
  assert.equal(JSON.stringify(enhancedSnapshot(operation, statusUrl)), JSON.stringify({
    protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'completed', operation_id: 'operation-1',
    status_url: statusUrl, chunk_count: 3, chunk_base_url: `${statusUrl}/chunk/`,
  }));
  assert.equal(renderOperation(operation, statusUrl), [
    'WEBSESSION-MCP-BRIDGE/1', 'state: completed', 'operation_id: operation-1',
    `status_url: ${statusUrl}`, 'chunk_count: 3', `chunk_base_url: ${statusUrl}/chunk/`,
  ].join('\n'));
  for (const fullResult of [result, '']) {
    const snapshot = enhancedSnapshot(operation, statusUrl, undefined, fullResult);
    assert.equal(snapshot.chunk_count, 1);
    assert.equal(snapshot.result, fullResult);
    assert.equal(snapshot.status_url, statusUrl);
    assert.equal('chunk_base_url' in snapshot, false);
    assert.equal(renderOperation(operation, statusUrl, undefined, fullResult), [
      'WEBSESSION-MCP-BRIDGE/1', 'state: completed', 'operation_id: operation-1',
      `status_url: ${statusUrl}`, 'chunk_count: 1', 'result:', fullResult,
    ].join('\n'));
  }
  assert.deepEqual(operation, original);
  const single = { ...operation, chunk_count: 1, result_text: 'small result' };
  assert.equal(enhancedSnapshot(single, statusUrl).result, 'small result');
  const running = { id: operation.id, state: 'running' };
  assert.deepEqual(enhancedSnapshot(running, statusUrl, undefined, result), enhancedSnapshot(running, statusUrl));
  assert.equal(renderOperation(running, statusUrl, undefined, result), renderOperation(running, statusUrl));
});

test('aborting a held wait clears its timer and listener without cancelling execution', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clearTimer = t.mock.method(globalThis, 'clearTimeout');
  let finish;
  const active = new Promise(resolve => { finish = resolve; });
  const operation = { id: 'operation-1', state: 'running' };
  const core = Object.create(OperationCore.prototype);
  core._active = new Map([[operation.id, active]]);
  core.store = { getOperation: () => operation };
  const controller = new AbortController();
  const waiting = core.waitForOperation(operation.id, 90000, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  assert.equal(await waiting, operation);
  assert.equal(clearTimer.mock.callCount(), 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(core._active.get(operation.id), active);
  operation.state = 'completed';
  finish();
  await active;
  t.mock.timers.tick(90000);
  assert.equal(await core.waitForOperation(operation.id, 90000, controller.signal), operation);
});

test('held waits finish on execution or timeout and remove abort listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  const active = new Promise(resolve => { finish = resolve; });
  const operation = { id: 'operation-1', state: 'running' };
  const core = Object.create(OperationCore.prototype);
  core._active = new Map([[operation.id, active]]);
  core.store = { getOperation: () => operation };
  const controller = new AbortController();
  const timed = core.waitForOperation(operation.id, 1000, controller.signal);
  t.mock.timers.tick(1000);
  assert.equal(await timed, operation);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const completed = core.waitForOperation(operation.id, 90000, controller.signal);
  operation.state = 'completed';
  finish();
  assert.equal(await completed, operation);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
