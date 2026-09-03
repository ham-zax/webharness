import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeToolName, parseRequest, parseUniversalRequest } from '../protocol.mjs';
import { AdapterStore, requestHash } from '../store.mjs';

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('universal decoder preserves exact main tool names and arguments', () => {
  const value = { version: 1, tool: 'dev_1mcp_read', arguments: { path: '/tmp/example.txt', offset: 2, limit: 5 } };
  const parsed = parseUniversalRequest(encode(value));
  assert.deepEqual(parsed.normalized, value);
});

test('enhanced JSON and universal GET normalize to the same request', () => {
  const value = { version: 1, tool: 'code_1mcp_code_search', arguments: { query: 'needle', limit: 7 } };
  assert.deepEqual(parseRequest(value), parseUniversalRequest(encode(value)));
});

test('tool-name decoder is canonical and exact', () => {
  const name = 'terminal_1mcp_terminal_read';
  const encoded = Buffer.from(name).toString('base64url');
  assert.equal(decodeToolName(encoded), name);
  assert.throws(() => decodeToolName(`${encoded}=`), /invalid encoded tool name/);
});

test('universal decoder rejects extra fields and non-canonical encoding', () => {
  assert.throws(
    () => parseUniversalRequest(encode({ version: 1, tool: 'dev_1mcp_read', arguments: { path: '/tmp/x' }, extra: true })),
    /request fields must be exactly/,
  );
  const canonical = encode({ version: 1, tool: 'dev_1mcp_read', arguments: { path: '/tmp/x' } });
  assert.throws(() => parseUniversalRequest(`${canonical}=`), /invalid encoded request/);
});

test('store hashes main capabilities, deduplicates nonce reuse, and scopes continuation tokens', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-adapter-test-'));
  const store = new AdapterStore(stateDir);
  try {
    const issued = store.issueMainCapability(60);
    const principal = store.resolveCapability(issued.token);
    assert.ok(principal);
    assert.equal(principal.scope, 'main');

    const requestJson = JSON.stringify({ version: 1, tool: 'dev_1mcp_read', arguments: { path: '/tmp/x' } });
    const hash = requestHash(requestJson);
    const first = store.submitOperation(principal.id, 'nonce-1', requestJson, hash);
    const second = store.submitOperation(principal.id, 'nonce-1', requestJson, hash);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.operation.id, second.operation.id);

    const continuation = store.continuationToken(first.operation.id);
    assert.equal(store.continuationMatches(first.operation.id, continuation), true);
    assert.equal(store.continuationMatches(first.operation.id, `${continuation.slice(0, -1)}x`), false);

    assert.equal(store.revokeCapability(issued.id), true);
    assert.equal(store.resolveCapability(issued.token), undefined);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('universal confirmation is hashed, revocation-aware, idempotent, and interruption-safe', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-adapter-confirm-'));
  let store = new AdapterStore(stateDir);
  try {
    const issued = store.issueMainCapability(60);
    const principal = store.resolveCapability(issued.token);
    const requestJson = JSON.stringify({ version: 1, tool: 'dev_1mcp_write', arguments: { path: '/tmp/new.txt', content: 'hello' } });
    const hash = requestHash(requestJson);
    const prepared = store.submitOperation(principal.id, 'write-nonce', requestJson, hash, {
      tool: 'dev_1mcp_write',
      policyClass: 'confirmation_required',
      sourceProfile: 'universal-get-v1',
      state: 'confirmation_required',
    });
    assert.equal(prepared.operation.state, 'confirmation_required');
    assert.equal(prepared.operation.source_profile, 'universal-get-v1');
    assert.ok(prepared.challenge);
    assert.notEqual(prepared.operation.confirmation_hash, prepared.challenge);
    assert.equal(store.confirmationCapabilityMatches(prepared.operation.id, prepared.confirmationCapability), true);
    assert.equal(store.confirmOperation(prepared.operation.id, 'wrong-challenge').invalid, true);

    const confirmed = store.confirmOperation(prepared.operation.id, prepared.challenge);
    assert.equal(confirmed.operation.state, 'queued');
    assert.equal(store.confirmOperation(prepared.operation.id, prepared.challenge).operation.state, 'queued');
    assert.equal(store.claimQueued(prepared.operation.id), true);
    assert.equal(store.markDispatchStarted(prepared.operation.id), true);

    store.close();
    store = new AdapterStore(stateDir);
    store.recoverOperations();
    assert.equal(store.getOperation(prepared.operation.id).state, 'unknown_outcome');

    const expiring = store.issueMainCapability(60);
    const expiringPrincipal = store.resolveCapability(expiring.token);
    const expiringPrepared = store.submitOperation(expiringPrincipal.id, 'expired-write', requestJson, hash, {
      tool: 'dev_1mcp_write',
      policyClass: 'confirmation_required',
      sourceProfile: 'universal-get-v1',
      state: 'confirmation_required',
    });
    store.db.prepare('UPDATE operations SET confirmation_expires_ms = ? WHERE id = ?').run(Date.now() - 1, expiringPrepared.operation.id);
    const expiredConfirm = store.confirmOperation(expiringPrepared.operation.id, expiringPrepared.challenge);
    assert.equal(expiredConfirm.expired, true);
    assert.equal(expiredConfirm.operation.state, 'expired');

    const revoked = store.issueMainCapability(60);
    const revokedPrincipal = store.resolveCapability(revoked.token);
    const revokedPrepared = store.submitOperation(revokedPrincipal.id, 'revoked-write', requestJson, hash, {
      tool: 'dev_1mcp_write',
      policyClass: 'confirmation_required',
      sourceProfile: 'universal-get-v1',
      state: 'confirmation_required',
    });
    store.revokeCapability(revoked.id);
    const revokedConfirm = store.confirmOperation(revokedPrepared.operation.id, revokedPrepared.challenge);
    assert.equal(revokedConfirm.authorizationInvalid, true);
    assert.equal(store.getOperation(revokedPrepared.operation.id).state, 'confirmation_required');
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('completed results are stored as immutable UTF-8 chunks', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-adapter-chunks-'));
  const store = new AdapterStore(stateDir);
  try {
    const issued = store.issueMainCapability(60);
    const principal = store.resolveCapability(issued.token);
    const requestJson = JSON.stringify({ version: 1, tool: 'dev_1mcp_read', arguments: { path: '/tmp/large' } });
    const submitted = store.submitOperation(principal.id, 'chunk-nonce', requestJson, requestHash(requestJson));
    assert.equal(store.claimQueued(submitted.operation.id), true);

    const result = `${'A'.repeat(9000)}${'✓'.repeat(4000)}`;
    store.completeOperation(submitted.operation.id, result);
    const operation = store.getOperation(submitted.operation.id);
    assert.equal(operation.state, 'completed');
    assert.ok(operation.chunk_count > 1);
    assert.equal(operation.result_text, null);

    const chunks = [];
    for (let chunkNumber = 1; chunkNumber <= operation.chunk_count; chunkNumber += 1) {
      const chunk = store.getOperationChunk(operation.id, chunkNumber);
      assert.equal(chunk.chunk_number, chunkNumber);
      assert.ok(Buffer.byteLength(chunk.content, 'utf8') <= 8192);
      chunks.push(chunk.content);
    }
    assert.equal(chunks.join(''), result);
    assert.throws(() => store.completeOperation(operation.id, 'replacement'), /operation is not running/);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
