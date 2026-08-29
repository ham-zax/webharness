import assert from 'node:assert/strict';
import test from 'node:test';

import { OPERATIONS, decodeRequest, encodeResponse } from '../protocol.mjs';

const expectedOperations = [
  'session.open',
  'session.open_human',
  'session.list',
  'session.read',
  'session.observe',
  'session.send',
  'session.resize',
  'session.close',
  'model.read',
  'lease.acquire_human',
  'lease.bind_human',
  'lease.release_human',
  'control.give_model',
  'control.take_human',
];

test('private protocol freezes the Terminal broker operation vocabulary', () => {
  assert.deepEqual([...OPERATIONS].sort(), [...expectedOperations].sort());
});

test('request decoder accepts one newline-delimited JSON request and rejects unknown operations', () => {
  const request = decodeRequest('{"id":"7","op":"session.list","params":{}}');
  assert.deepEqual(request, { id: '7', op: 'session.list', params: {} });
  assert.throws(() => decodeRequest('{"id":"8","op":"terminal_wait","params":{}}'), /unsupported operation/i);
});

test('response encoder emits exactly one JSON line', () => {
  const line = encodeResponse({ id: '7', ok: true, result: { sessions: [] } });
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.indexOf('\n'), line.length - 1);
  assert.deepEqual(JSON.parse(line), { id: '7', ok: true, result: { sessions: [] } });
});
