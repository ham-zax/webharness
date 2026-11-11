import assert from 'node:assert/strict';
import test from 'node:test';
import { CALL_ID_META, MUTATION_META, callId, currentCall, markMutation, traceCall } from '../call-diagnostics.mjs';

test('call diagnostics preserve rich results and exclude payloads and exception messages', async () => {
  const records = [];
  const id = callId();
  const image = { type: 'image', data: 'secret-image', mimeType: 'image/png' };
  const structuredContent = { secret: 'secret-file-content' };
  const result = await traceCall({ id, layer: 'test', tool: 'write', log: row => records.push(row) }, async () => {
    assert.equal(currentCall().id, id);
    markMutation('published');
    return { content: [image], structuredContent };
  });
  assert.strictEqual(result.content[0], image);
  assert.strictEqual(result.structuredContent, structuredContent);
  assert.equal(result._meta[CALL_ID_META], id);
  assert.equal(result._meta[MUTATION_META], 'published');
  await assert.rejects(traceCall({ id, layer: 'test', tool: 'write', log: row => records.push(row) }, async () => {
    markMutation('unknown');
    throw Object.assign(new Error('secret-exception'), { code: 'EIO' });
  }), /secret-exception/);
  assert.equal(records.at(-1).error_code, 'EIO');
  assert.equal(records.at(-1).mutation_state, 'unknown');
  assert.doesNotMatch(JSON.stringify(records), /secret/);
});

test('concurrent calls keep independent identities and mutation states', async () => {
  const records = [];
  const ids = [callId(), callId()];
  const results = await Promise.all(ids.map((id, index) => traceCall({
    id, layer: 'test', tool: 'write', log: row => records.push(row),
  }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(currentCall().id, id);
    markMutation(index ? 'published' : 'started');
    return { content: [] };
  })));
  assert.equal(results[0]._meta[MUTATION_META], 'started');
  assert.equal(results[1]._meta[MUTATION_META], 'published');
  assert.equal(currentCall(), undefined);
});

test('invalid identities and failing diagnostic sinks cannot change tool outcomes', async () => {
  const result = await traceCall({ id: 'secret\nforged', layer: 'test', tool: 'read', mutating: false,
    log: () => { throw new Error('logger failed'); } }, async () => ({ content: [] }));
  assert.match(result._meta[CALL_ID_META], /^[a-f0-9-]{36}$/);
  assert.equal(result._meta[MUTATION_META], 'not_applicable');
});

test('error results retain coded errors without logging their text', async () => {
  const records = [];
  const result = await traceCall({ layer: 'test', tool: 'write', log: row => records.push(row) }, async () => ({
    isError: true, content: [{ type: 'text', text: 'WRITE_EXPECTATION_MISMATCH: secret-content' }],
  }));
  assert.equal(result.isError, true);
  assert.equal(records.at(-1).error_code, 'WRITE_EXPECTATION_MISMATCH');
  assert.equal(records.at(-1).mutation_state, 'not_started');
  assert.doesNotMatch(JSON.stringify(records), /secret-content/);
});
