import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { OperationCore, renderToolResult } from '../core.mjs';
import { webSessionInstructions, compactInstructions, decodeToolName, parseRequest, parseUniversalRequest, toolListSnapshot } from '../protocol.mjs';
import { callMcpTool, listMcpTools } from '../mcp-client.mjs';
import { AdapterStore, requestHash } from '../store.mjs';

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('universal decoder preserves exact main tool names and arguments', () => {
  const value = { version: 1, tool: 'dev_read', arguments: { path: '/tmp/example.txt', offset: 2, limit: 5 } };
  const parsed = parseUniversalRequest(encode(value));
  assert.deepEqual(parsed.normalized, value);
});

test('enhanced JSON and universal GET normalize to the same request', () => {
  const value = { version: 1, tool: 'code_code_search', arguments: { query: 'needle', limit: 7 } };
  assert.deepEqual(parseRequest(value), parseUniversalRequest(encode(value)));
});

test('tool-name decoder is canonical and exact', () => {
  const name = 'terminal_terminal_read';
  const encoded = Buffer.from(name).toString('base64url');
  assert.equal(decodeToolName(encoded), name);
  assert.throws(() => decodeToolName(`${encoded}=`), /invalid encoded tool name/);
});

test('universal decoder rejects extra fields and non-canonical encoding', () => {
  assert.throws(
    () => parseUniversalRequest(encode({ version: 1, tool: 'dev_read', arguments: { path: '/tmp/x' }, extra: true })),
    /request fields must be exactly/,
  );
  const canonical = encode({ version: 1, tool: 'dev_read', arguments: { path: '/tmp/x' } });
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

    const requestJson = JSON.stringify({ version: 1, tool: 'dev_read', arguments: { path: '/tmp/x' } });
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

test('turn fences persist and reject queued calls from older turns', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-fence-'));
  let core = new OperationCore({ stateDir });
  try {
    const issued = core.store.issueMainCapability(60);
    assert.equal(core.store.advanceTurn(issued.id, 1), true);
    const requestJson = JSON.stringify({ version: 1, tool: 'dev_bash', arguments: { command: 'true' } });
    const old = core.store.submitOperation(issued.id, 'old', requestJson, requestHash(requestJson), { turnId: 1 });
    assert.equal(core.store.advanceTurn(issued.id, 2), true);
    assert.equal(core.store.advanceTurn(issued.id, 1), false);
    assert.equal(core.store.advanceTurn(issued.id, null), false);
    core.close();
    core = new OperationCore({ stateDir });
    assert.equal(core.store.isCurrentTurn(issued.id, 2), true);
    await core._run(old.operation.id);
    assert.equal(core.store.getOperation(old.operation.id).state, 'rejected');
    assert.equal(core.store.getOperation(old.operation.id).error_text, 'superseded_by_newer_turn');
  } finally {
    core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('universal confirmation is hashed, revocation-aware, idempotent, and interruption-safe', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-adapter-confirm-'));
  let store = new AdapterStore(stateDir);
  try {
    const issued = store.issueMainCapability(60);
    const principal = store.resolveCapability(issued.token);
    const requestJson = JSON.stringify({ version: 1, tool: 'dev_write', arguments: { path: '/tmp/new.txt', content: 'hello' } });
    const hash = requestHash(requestJson);
    const prepared = store.submitOperation(principal.id, 'write-nonce', requestJson, hash, {
      tool: 'dev_write',
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
      tool: 'dev_write',
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
      tool: 'dev_write',
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
    const requestJson = JSON.stringify({ version: 1, tool: 'dev_read', arguments: { path: '/tmp/large' } });
    const submitted = store.submitOperation(principal.id, 'chunk-nonce', requestJson, requestHash(requestJson));
    assert.equal(store.getOperationResult('missing-operation'), undefined);
    assert.equal(store.getOperationResult(submitted.operation.id), undefined);
    assert.equal(store.claimQueued(submitted.operation.id), true);
    assert.equal(store.getOperationResult(submitted.operation.id), undefined);

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
    assert.deepEqual(Buffer.from(store.getOperationResult(operation.id), 'utf8'), Buffer.from(result, 'utf8'));
    assert.throws(() => store.completeOperation(operation.id, 'replacement'), /operation is not running/);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('full-result reads require the operation continuation token', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-adapter-result-'));
  const core = new OperationCore({ stateDir });
  try {
    const issued = core.store.issueMainCapability(60);
    const requestJson = JSON.stringify({ version: 1, tool: 'dev_read', arguments: {} });
    const submitted = core.store.submitOperation(issued.id, 'result-nonce', requestJson, requestHash(requestJson));
    const id = submitted.operation.id;
    const continuation = core.store.continuationToken(id);
    assert.equal(core.readOperationResult(id, continuation), undefined);
    assert.equal(core.store.claimQueued(id), true);
    const result = `${'A'.repeat(8191)}${'🌍✓'.repeat(4000)}`;
    core.store.completeOperation(id, result);
    assert.equal(core.readOperationResult(id, 'wrong-token'), undefined);
    assert.equal(core.readOperationResult(id, core.store.continuationToken('other-operation')), undefined);
    assert.deepEqual(Buffer.from(core.readOperationResult(id, continuation), 'utf8'), Buffer.from(result, 'utf8'));
  } finally {
    core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('tool results preserve text-only rendering and serialize non-text or empty content', () => {
  const text = { type: 'text', text: 'hello' };
  const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
  assert.equal(renderToolResult({ content: [text, { type: 'text', text: 'world' }] }), 'hello\nworld');
  for (const result of [{ content: [text, image] }, { content: [image] }, { content: [] }, {}]) {
    assert.equal(renderToolResult(result), JSON.stringify(result));
  }
});

test('tool results preserve the whole JSON when structured content is defined', () => {
  const text = { type: 'text', text: 'summary only' };
  const mixed = { content: [text, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] };
  for (const structuredContent of [{ answer: 42 }, null, false, 0, '', []]) {
    const result = { content: [text], structuredContent };
    assert.equal(renderToolResult(result), JSON.stringify(result));
    assert.equal(renderToolResult({ ...mixed, structuredContent }), JSON.stringify({ ...mixed, structuredContent }));
  }
  assert.equal(renderToolResult({ content: [{ type: 'text', text: 'plain' }] }), 'plain');
  assert.equal(renderToolResult({ content: [{ type: 'text', text: 'plain' }], other: true }), 'plain');
});

test('structured tool results exceeding the byte limit are rejected', () => {
  assert.throws(
    () => renderToolResult({ content: [{ type: 'text', text: 'summary' }], structuredContent: { data: 'A'.repeat(1024 * 1024) } }),
    /result_too_large/,
  );
});

test('tool result errors and byte limits remain enforced', () => {
  assert.throws(() => renderToolResult({ isError: true, content: [{ type: 'text', text: 'failed' }] }), /^Error: failed$/);
  assert.throws(() => renderToolResult({ isError: true, content: [] }), /MCP tool failed/);
  assert.throws(() => renderToolResult({ content: [{ type: 'text', text: '✓'.repeat(350000) }] }), /result_too_large/);
  assert.throws(() => renderToolResult({ content: [{ type: 'image', data: 'A'.repeat(1024 * 1024), mimeType: 'image/png' }] }), /result_too_large/);
});

test('pairing codes redeem once, expire, follow revocation, wipe plaintext, and keep default_cwd', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-pairing-'));
  const store = new AdapterStore(stateDir);
  try {
    const pairing = store.issuePairingCode({ ttlSeconds: 3600, pairTtlSeconds: 120, defaultCwd: '/tmp/pair-work' });
    assert.match(pairing.code, /^[a-z]{4,7}-[0-9]{4}-[a-z0-9]{4}$/);
    assert.equal(pairing.defaultCwd, '/tmp/pair-work');
    assert.ok(pairing.pairExpiresMs <= pairing.expiresMs);

    const redeemed = store.redeemPairingCode(pairing.code);
    assert.ok(redeemed);
    assert.equal(redeemed.capabilityId, pairing.capabilityId);
    assert.equal(redeemed.scope, 'main');
    assert.equal(redeemed.defaultCwd, '/tmp/pair-work');
    assert.match(redeemed.token, /^[A-Za-z0-9_-]{43}$/);
    const principal = store.resolveCapability(redeemed.token);
    assert.ok(principal);
    assert.equal(principal.id, pairing.capabilityId);
    assert.equal(principal.defaultCwd, '/tmp/pair-work');
    assert.equal(store.activeCapabilityById(pairing.capabilityId).defaultCwd, '/tmp/pair-work');

    assert.equal(store.redeemPairingCode(pairing.code), undefined);
    const row = store.db.prepare('SELECT capability_token, redeemed_ms FROM pairing_codes WHERE code = ?').get(pairing.code);
    assert.equal(row.capability_token, '');
    assert.ok(row.redeemed_ms > 0);

    const expiring = store.issuePairingCode({ pairTtlSeconds: 60 });
    assert.equal(expiring.defaultCwd, null);
    store.db.prepare('UPDATE pairing_codes SET expires_ms = ? WHERE code = ?').run(Date.now() - 1, expiring.code);
    assert.equal(store.redeemPairingCode(expiring.code), undefined);

    const revoked = store.issuePairingCode({ ttlSeconds: 600 });
    store.revokeCapability(revoked.capabilityId);
    assert.equal(store.redeemPairingCode(revoked.code), undefined);

    assert.equal(store.redeemPairingCode('not-a-code'), undefined);
    assert.equal(store.redeemPairingCode(42), undefined);
    assert.equal(store.redeemPairingCode('amber-0000-abcdef'), undefined);

    assert.throws(() => store.issuePairingCode({ pairTtlSeconds: 29 }), /pairing code TTL/);
    assert.throws(() => store.issuePairingCode({ pairTtlSeconds: 901 }), /pairing code TTL/);
    assert.throws(() => store.issuePairingCode({ pairTtlSeconds: 60.5 }), /pairing code TTL/);
    assert.throws(() => store.issueMainCapability(60, { defaultCwd: '' }), /default cwd/);
    assert.throws(() => store.issueMainCapability(60, { defaultCwd: '/tmp/a\0b' }), /default cwd/);
    assert.equal(store.issueMainCapability(60).defaultCwd, null);

    const stale = store.issuePairingCode({ pairTtlSeconds: 60 });
    store.db.prepare('UPDATE pairing_codes SET expires_ms = ? WHERE code = ?').run(Date.now() - 86_400_001, stale.code);
    store.issuePairingCode({ pairTtlSeconds: 60 });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM pairing_codes WHERE code = ?').get(stale.code).count, 0);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('operator pair prints pairing details and never the capability secret', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-operator-pair-'));
  try {
    const operatorPath = new URL('../operator.mjs', import.meta.url).pathname;
    const result = spawnSync(process.execPath, [operatorPath, 'pair', '3600', '120', '/tmp/operator-cwd'], {
      env: { ...process.env, WEBSESSION_ADAPTER_STATE_DIR: stateDir },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pair_code: [a-z]{4,7}-[0-9]{4}-[a-z0-9]{4}/);
    assert.match(result.stdout, /capability_id: [0-9a-f-]{36}/);
    assert.match(result.stdout, /pair_expires_at: \d{4}-\d\d-\d\dT/);
    assert.match(result.stdout, /expires_at: \d{4}-\d\d-\d\dT/);
    assert.match(result.stdout, /default_cwd: \/tmp\/operator-cwd/);
    assert.ok(!result.stdout.includes('capability: '));

    const code = /pair_code: (\S+)/.exec(result.stdout)[1];
    const store = new AdapterStore(stateDir);
    try {
      const redeemed = store.redeemPairingCode(code);
      assert.ok(redeemed);
      assert.equal(redeemed.defaultCwd, '/tmp/operator-cwd');
      assert.equal(redeemed.token.length, 43);
      assert.ok(!result.stdout.includes(redeemed.token));
    } finally {
      store.close();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('1MCP preamble is compacted while server blocks and other guidance stay intact', () => {
  const instructions = [
    '# 1MCP - Model Context Protocol Proxy',
    '',
    'This proxy aggregates MCP servers behind one endpoint.',
    'Tool names use a prefix such as filesystem_1mcp_read_file.',
    '',
    '<dev>',
    'Dev server: read and write project files.',
    '</dev>',
    '',
    '<local>',
    'Local server: shell and batch tools.',
    '</local>',
  ].join('\n');
  const compacted = compactInstructions(instructions);
  assert.ok(!compacted.includes('filesystem_1mcp_read_file'));
  assert.ok(!compacted.startsWith('# 1MCP'));
  assert.ok(compacted.startsWith('<dev>'));
  assert.match(compacted, /<local>\nLocal server: shell and batch tools\.\n<\/local>$/);
  assert.equal(compactInstructions(compacted), compacted);

  const custom = '# 1MCP - Model Context Protocol Proxy\n\nIntro line\n<tavily>\nTavily tools\n</tavily>';
  assert.equal(compactInstructions(custom), '<tavily>\nTavily tools\n</tavily>');

  const owner = 'Owner guidance\nUse the configured canonical workflow.\nRead only selected references.';
  assert.equal(compactInstructions(owner), owner);
  assert.equal(compactInstructions(''), '');
  assert.equal(compactInstructions(undefined), undefined);
  assert.equal(compactInstructions(null), null);
  assert.equal(compactInstructions(42), 42);

  const tools = [{ name: 'dev_read' }];
  const base = { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'ready', tool_count: 1, tools: ['dev_read'] };
  assert.deepEqual(toolListSnapshot(tools, owner, '/tmp/project'), { ...base, instructions: webSessionInstructions(owner), default_cwd: '/tmp/project' });
  assert.deepEqual(toolListSnapshot(tools, owner), { ...base, instructions: webSessionInstructions(owner) });
  assert.deepEqual(toolListSnapshot(tools, instructions, '/tmp/project'), { ...base, instructions: webSessionInstructions(compacted), default_cwd: '/tmp/project' });
});

async function reservePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function startAdapterServer(t, stateDir, port, extraEnv = {}) {
  const child = spawn(process.execPath, [new URL('../server.mjs', import.meta.url).pathname], {
    env: {
      ...process.env,
      WEBSESSION_ADAPTER_STATE_DIR: stateDir,
      WEBSESSION_ADAPTER_HOST: '127.0.0.1',
      WEBSESSION_ADAPTER_PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const ended = once(child, 'exit');
      child.kill();
      await ended;
    }
  });
  child.stderr.resume();
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
  return child;
}

test('POST /v1/pair redeems one code, rejects replays, and validates its body', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-pair-http-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const store = new AdapterStore(stateDir);
  const pairing = store.issuePairingCode({ ttlSeconds: 600, pairTtlSeconds: 120, defaultCwd: '/tmp/paired' });
  const plain = store.issuePairingCode({ ttlSeconds: 600, pairTtlSeconds: 120 });
  store.close();

  const port = await reservePort();
  await startAdapterServer(t, stateDir, port);
  const pairUrl = `http://127.0.0.1:${port}/v1/pair`;
  const post = body => fetch(pairUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  const response = await post({ code: pairing.code });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.protocol, 'WEBSESSION-MCP-BRIDGE/1');
  assert.equal(value.state, 'ready');
  assert.equal(value.scope, 'main');
  assert.match(value.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(value.default_cwd, '/tmp/paired');
  assert.equal(new Date(value.expires_at).getTime(), pairing.expiresMs);

  const replay = await post({ code: pairing.code });
  assert.equal(replay.status, 404);
  assert.deepEqual(await replay.json(), { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'not_found' });

  const withoutCwd = await post({ code: plain.code });
  assert.equal(withoutCwd.status, 200);
  assert.equal(Object.hasOwn(await withoutCwd.json(), 'default_cwd'), false);

  const unknown = await post({ code: 'amber-0000-abcdef' });
  assert.equal(unknown.status, 404);

  const wrongType = await fetch(pairUrl, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);

  const invalidJson = await post('{');
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).code, 'invalid_request');

  const extraKey = await post({ code: 'amber-0000-abcdef', extra: true });
  assert.equal(extraKey.status, 400);

  const nonString = await post({ code: 42 });
  assert.equal(nonString.status, 400);

  const oversized = await post({ code: 'a'.repeat(5000) });
  assert.equal(oversized.status, 413);
});

function startToolFixture(t, tools, runTool) {
  const events = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'tool-fixture', version: '1' },
      };
    } else if (message.method === 'tools/list') {
      result = { tools };
    } else if (message.method === 'tools/call') {
      result = await runTool(message.params.name, message.params.arguments, events);
    } else {
      // -32601 is the definitive legacy signal: the adapter's version probe
      // falls back to the plain initialize handshake.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  return { events, server };
}

const CONCURRENCY_TOOLS = [
  { name: 'fixture_read', description: 'Read a file.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'fixture_write', description: 'Write a file.', inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } } },
];

async function slowTool(name, args, events) {
  events.push({ name, phase: 'start', at: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 250));
  events.push({ name, phase: 'end', at: Date.now() });
  return { content: [{ type: 'text', text: `${name} ok` }] };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => { resolve = settle; reject = fail; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

// Bounds a gate wait so a broken fixture fails the test instead of hanging it.
function withinMs(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function jsonRpcMethods(body) {
  if (!body.length) return [];
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return [];
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.map(message => message?.method).filter(method => typeof method === 'string');
}

// In-process modern 2026-07-28 gateway: createMcpHandler serves the stateless
// HTTP era, and the HTTP wrapper counts the JSON-RPC methods the adapter sends.
function startModernMcpStub(t, tools, runTool) {
  const counts = { discover: 0, initialize: 0, listTools: 0, calls: 0 };
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'modern-fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', () => ({ tools }));
    server.setRequestHandler('tools/call', ({ params }) => runTool(params.name, params.arguments, counts));
    return server;
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    for (const method of jsonRpcMethods(body)) {
      if (method === 'server/discover') counts.discover += 1;
      else if (method === 'initialize') counts.initialize += 1;
      else if (method === 'tools/list') counts.listTools += 1;
      else if (method === 'tools/call') counts.calls += 1;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach(entry => headers.append(name, entry));
      else headers.set(name, value);
    }
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
    try {
      const response = await handler.fetch(new Request(url, init));
      const payload = Buffer.from(await response.arrayBuffer());
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(payload);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else if (!res.writableEnded) res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  t.after(() => {
    server.closeAllConnections();
    server.close();
    void handler.close();
  });
  return { counts, server, handler };
}

test('read-only tools run during slow mutations while mutations stay serialized', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-concurrent-'));
  const { events, server } = startToolFixture(t, CONCURRENCY_TOOLS, slowTool);
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const core = new OperationCore({
    stateDir,
    mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
    callbackUrl: 'http://127.0.0.1:9/callback',
    toolTimeoutMs: 15000,
  });
  try {
    const issued = core.store.issueMainCapability(120);
    const access = await core.permittedTools(issued.token);
    assert.ok(access);
    assert.equal(core._readOnlyTools.has('fixture_read'), true);
    assert.equal(core._readOnlyTools.has('fixture_write'), false);

    const submit = (tool, nonce) => core.submit(issued.token, nonce, parseRequest({ version: 1, tool, arguments: { path: '/tmp/x' } }), 'json-post-v1');
    const writeOne = submit('fixture_write', 'write-one');
    const writeTwo = submit('fixture_write', 'write-two');
    const readOne = submit('fixture_read', 'read-one');
    assert.equal(writeOne.operation.state, 'queued');

    await Promise.all([writeOne, writeTwo, readOne].map(entry => core.waitForOperation(entry.operation.id, 15000)));
    for (const entry of [writeOne, writeTwo, readOne]) {
      assert.equal(core.store.getOperation(entry.operation.id).state, 'completed');
    }

    const starts = name => events.filter(event => event.name === name && event.phase === 'start');
    const ends = name => events.filter(event => event.name === name && event.phase === 'end');
    assert.equal(starts('fixture_write').length, 2);
    assert.equal(starts('fixture_read').length, 1);
    const firstWriteEnd = ends('fixture_write')[0].at;
    assert.ok(starts('fixture_read')[0].at < firstWriteEnd, 'read-only call started while the mutation was running');
    assert.ok(starts('fixture_write')[1].at >= firstWriteEnd, 'mutating calls stayed serialized');
  } finally {
    await core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('exact interaction_capacity_exceeded error after dispatch is never replayed', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-capacity-'));
  let backendCalls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    if (message.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: '1mcp-sim', version: '0.39.8' },
      } }));
      return;
    }
    if (message.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: CONCURRENCY_TOOLS } }));
      return;
    }
    if (message.method === 'tools/call') {
      // The exact legacy 1MCP admission error, arriving after dispatch intent
      // is persisted. It must fail the operation, never replay the call.
      backendCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'interaction_capacity_exceeded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const core = new OperationCore({
    stateDir,
    mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
    callbackUrl: 'http://127.0.0.1:9/callback',
    toolTimeoutMs: 5000,
  });
  try {
    const issued = core.store.issueMainCapability(120);
    await core.permittedTools(issued.token);
    const submitted = core.submit(
      issued.token,
      'capacity-after-dispatch',
      parseRequest({ version: 1, tool: 'fixture_write', arguments: { path: '/tmp/x' } }),
      'json-post-v1',
    );
    await core.waitForOperation(submitted.operation.id, 5000);
    assert.equal(backendCalls, 1, 'the dispatched tools/call was attempted exactly once');
    assert.equal(core.store.getOperation(submitted.operation.id).state, 'unknown_outcome');
  } finally {
    await core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a dropped connection after a mutation records unknown outcome without replay', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-drop-write-'));
  let mutations = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: CONCURRENCY_TOOLS };
    else if (message.method === 'tools/call') { mutations += 1; req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const core = new OperationCore({ stateDir, mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`, callbackUrl: 'http://127.0.0.1:9/callback', toolTimeoutMs: 5000 });
  try {
    const issued = core.store.issueMainCapability(120);
    const submitted = core.submit(issued.token, 'dropped-write', parseRequest({ version: 1, tool: 'fixture_write', arguments: {} }), 'json-post-v1');
    const operation = await core.waitForOperation(submitted.operation.id, 10000);
    assert.equal(mutations, 1);
    assert.equal(operation.state, 'unknown_outcome');
  } finally {
    await core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('newer turn fence prevents queued older-turn write from dispatching', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-fence-dispatch-'));
  const firstWriteEntered = deferred();
  const firstWriteGate = deferred();
  const calls = [];
  const { server } = startToolFixture(t, CONCURRENCY_TOOLS, async (name, args) => {
    calls.push({ name, args });
    if (args?.path === '/tmp/first') {
      firstWriteEntered.resolve();
      await firstWriteGate.promise;
    }
    return { content: [{ type: 'text', text: `${name} ok` }] };
  });
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const core = new OperationCore({
    stateDir,
    mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
    callbackUrl: 'http://127.0.0.1:9/callback',
    toolTimeoutMs: 15000,
  });
  try {
    const issued = core.store.issueMainCapability(120);
    await core.permittedTools(issued.token);
    assert.equal(core._readOnlyTools.has('fixture_write'), false, 'writes stay serialized');

    const first = core.submit(issued.token, 'fence-write-1', parseRequest({ version: 1, tool: 'fixture_write', arguments: { path: '/tmp/first' } }), 'json-post-v1', 1);
    const second = core.submit(issued.token, 'fence-write-2', parseRequest({ version: 1, tool: 'fixture_write', arguments: { path: '/tmp/second' } }), 'json-post-v1', 1);
    assert.equal(second.operation.state, 'queued');

    try {
      await withinMs(firstWriteEntered.promise, 15000, 'the first write never reached the backend');
      // A newer turn arrives while the second write still waits behind it.
      assert.equal(core.store.advanceTurn(issued.id, 2), true);
    } finally {
      firstWriteGate.resolve();
    }

    await core.waitForOperation(first.operation.id, 15000);
    await core.waitForOperation(second.operation.id, 15000);

    assert.equal(core.store.getOperation(first.operation.id).state, 'completed');
    const superseded = core.store.getOperation(second.operation.id);
    assert.equal(superseded.state, 'rejected');
    assert.equal(superseded.error_text, 'superseded_by_newer_turn');
    assert.deepEqual(calls.map(call => call.args.path), ['/tmp/first'], 'the superseded write never reached the backend');
  } finally {
    firstWriteGate.resolve();
    await core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('revoked capability cannot dispatch after waiting for the tool catalog', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-revoke-dispatch-'));
  const listingEntered = deferred();
  const listingGate = deferred();
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    } else if (message.method === 'tools/list') {
      listingEntered.resolve();
      await listingGate.promise;
      result = { tools: CONCURRENCY_TOOLS };
    } else if (message.method === 'tools/call') {
      calls += 1;
      result = { content: [{ type: 'text', text: 'unexpected' }] };
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const core = new OperationCore({ stateDir, mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`, callbackUrl: 'http://127.0.0.1:9/callback', toolTimeoutMs: 5000 });
  try {
    const issued = core.store.issueMainCapability(120);
    const submitted = core.submit(issued.token, 'revoke-before-dispatch', parseRequest({ version: 1, tool: 'fixture_write', arguments: {} }), 'json-post-v1');
    await withinMs(listingEntered.promise, 15000, 'tool catalog was not requested');
    assert.equal(core.store.revokeCapability(issued.id), true);
    listingGate.resolve();
    const operation = await core.waitForOperation(submitted.operation.id, 15000);
    assert.equal(operation.state, 'rejected');
    assert.match(operation.error_text, /capability expired or was revoked/);
    assert.equal(calls, 0);
  } finally {
    listingGate.resolve();
    await core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

const SIX_SESSION_TOOLS = [
  {
    name: 'fixture_read',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: { session: { type: 'number' } } },
    annotations: { readOnlyHint: true },
  },
];

test('five modern requests finish while a sixth remains blocked', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-six-overlap-'));
  const entered = deferred();
  const gate = deferred();
  const invocations = [];
  const { counts, server } = startModernMcpStub(t, SIX_SESSION_TOOLS, async (_name, args) => {
    invocations.push(args.session);
    if (args.session === 1) { entered.resolve(); await gate.promise; }
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  await once(server, 'listening');
  const options = { mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`, stateDir, callbackUrl: 'http://127.0.0.1:9/callback' };
  try {
    let firstFinished = false;
    const first = callMcpTool(options, 'fixture_read', { session: 1 }).finally(() => { firstFinished = true; });
    await withinMs(entered.promise, 15000, 'first call did not enter');
    await withinMs(Promise.all([2, 3, 4, 5, 6].map(session => callMcpTool(options, 'fixture_read', { session }))), 15000, 'other calls did not complete');
    assert.equal(firstFinished, false);
    assert.deepEqual(invocations.slice().sort(), [1, 2, 3, 4, 5, 6]);
    assert.equal(counts.discover, 1);
    assert.equal(counts.initialize, 0);
    gate.resolve();
    await first;
  } finally {
    gate.resolve();
    const { closeMcpPools } = await import('../mcp-client.mjs');
    await closeMcpPools();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('six-session modern 2026-07-28 gateway concurrency, barrier overlap, failure isolation, and timeout/cancel isolation', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-six-session-'));
  const sessionOneEntered = deferred();
  const sessionOneGate = deferred();
  const cancelEntered = deferred();
  const cancelGate = deferred();
  const otherEntered = deferred();
  const otherGate = deferred();
  const invocations = new Map();
  // All six sessions exercise the read-only fixture tool here; per-capability
  // mutation queue overlap is tested separately in capability-queues.test.mjs.
  const { counts, server } = startModernMcpStub(t, SIX_SESSION_TOOLS, async (name, args) => {
    const session = Number(args?.session);
    invocations.set(session, (invocations.get(session) ?? 0) + 1);
    if (session === 1) {
      sessionOneEntered.resolve();
      await sessionOneGate.promise;
      return { content: [{ type: 'text', text: 'session 1 ok' }] };
    }
    if (session === 2) await sessionOneEntered.promise;
    if (session === 7) {
      cancelEntered.resolve();
      await cancelGate.promise;
    }
    if (session === 8) {
      otherEntered.resolve();
      await otherGate.promise;
    }
    if (session === 5) {
      await sessionOneEntered.promise;
      throw new Error('backend tool failed for session 5');
    }
    if (session === 6) {
      // Outlives toolTimeoutMs, so the adapter must time out without replaying.
      await new Promise(resolve => { setTimeout(resolve, 5000).unref(); });
      return { content: [{ type: 'text', text: 'session 6 late' }] };
    }
    return { content: [{ type: 'text', text: `session ${session} ok` }] };
  });
  await once(server, 'listening');
  const core = new OperationCore({
    stateDir,
    mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
    callbackUrl: 'http://127.0.0.1:9/callback',
    toolTimeoutMs: 150,
  });
  try {
    const capabilities = [];
    for (let index = 0; index < 6; index += 1) capabilities.push(core.store.issueMainCapability(120));
    assert.ok(await core.permittedTools(capabilities[0].token));
    assert.equal(core._readOnlyTools.has('fixture_read'), true);
    const discoversBeforeExecution = counts.discover;

    const submitted = capabilities.map((issued, index) => core.submit(
      issued.token,
      `six-session-${index + 1}`,
      parseRequest({ version: 1, tool: 'fixture_read', arguments: { session: index + 1 } }),
      'json-post-v1',
    ));

    let overlapped = false;
    const releaseSessionOne = (async () => {
      try {
        await withinMs(sessionOneEntered.promise, 15000, 'session 1 never reached the backend');
        const second = await core.waitForOperation(submitted[1].operation.id, 15000);
        const failure = await core.waitForOperation(submitted[4].operation.id, 15000);
        overlapped = second.state === 'completed' && failure.state === 'unknown_outcome';
      } finally {
        sessionOneGate.resolve();
      }
    })();

    await Promise.all([
      ...submitted.map(entry => core.waitForOperation(entry.operation.id, 20000)),
      releaseSessionOne,
    ]);

    const stateOf = index => core.store.getOperation(submitted[index].operation.id).state;
    assert.equal(overlapped, true, 'session 2 completed while session 1 was still blocked in the backend');
    for (const index of [0, 1, 2, 3]) assert.equal(stateOf(index), 'completed', `session ${index + 1} completed`);
    assert.equal(stateOf(4), 'unknown_outcome', 'session 5 recorded an ambiguous outcome');
    assert.equal(stateOf(5), 'unknown_outcome', 'session 6 recorded an ambiguous outcome after its timeout');
    assert.equal(invocations.get(5), 1, 'session 5 backend invoked once: no replay after dispatch');
    assert.equal(invocations.get(6), 1, 'session 6 backend invoked once: no replay after the timeout');
    assert.equal(counts.initialize, 0, 'modern 2026-07-28 was negotiated without initialize');
    assert.ok(counts.discover >= 1, 'the server/discover probe reached the gateway');
    assert.equal(counts.discover, discoversBeforeExecution + 1, 'all six calls shared one execution connection');

    const discoversBeforeFollowUp = counts.discover;
    const followUp = core.submit(
      capabilities[0].token,
      'six-session-follow-up',
      parseRequest({ version: 1, tool: 'fixture_read', arguments: { session: 1 } }),
      'json-post-v1',
    );
    await core.waitForOperation(followUp.operation.id, 15000);
    assert.equal(core.store.getOperation(followUp.operation.id).state, 'completed');
    assert.equal(counts.discover, discoversBeforeFollowUp, 'the follow-up call reused the pooled execution connection');
    const controller = new AbortController();
    const cancelled = callMcpTool({ mcpUrl: core.mcpUrl, stateDir, callbackUrl: core.callbackUrl, signal: controller.signal }, 'fixture_read', { session: 7 });
    const concurrent = callMcpTool({ mcpUrl: core.mcpUrl, stateDir, callbackUrl: core.callbackUrl }, 'fixture_read', { session: 8 });
    await withinMs(Promise.all([cancelEntered.promise, otherEntered.promise]), 15000, 'concurrent calls never reached the backend');
    controller.abort();
    await assert.rejects(cancelled);
    cancelGate.resolve();
    otherGate.resolve();
    await concurrent;
    const afterCancel = core.submit(capabilities[0].token, 'after-cancel', parseRequest({ version: 1, tool: 'fixture_read', arguments: { session: 1 } }), 'json-post-v1');
    await core.waitForOperation(afterCancel.operation.id, 15000);
    assert.equal(core.store.getOperation(afterCancel.operation.id).state, 'completed');
    assert.equal(invocations.get(7), 1);
    assert.equal(counts.discover, discoversBeforeFollowUp, 'cancellation preserved the pooled connection');
  } finally {
    sessionOneGate.resolve();
    cancelGate.resolve();
    otherGate.resolve();
    await core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('backend errors mentioning capacity are not replayed or marked safe to retry', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-backend-error-'));
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    let result = {};
    if (message.method === 'initialize') {
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    } else if (message.method === 'tools/list') {
      result = { tools: CONCURRENCY_TOOLS };
    } else if (message.method === 'tools/call') {
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: {
        code: -32000, message: 'backend already wrote data, then interaction_capacity_exceeded',
      } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const core = new OperationCore({
    stateDir, mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
    callbackUrl: 'http://127.0.0.1:9/callback', toolTimeoutMs: 100,
  });
  try {
    const issued = core.store.issueMainCapability(120);
    await core.permittedTools(issued.token);
    const batch = core.submitBatch(issued.token, 'backend-error', [
      parseRequest({ version: 1, tool: 'fixture_write', arguments: {} }),
    ]);
    const id = batch.submissions[0].operation.id;
    await core.waitForOperation(id, 5000);
    assert.equal(calls, 1);
    assert.equal(core.store.getOperation(id).state, 'unknown_outcome');
  } finally {
    await core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a capability default cwd resolves missing cwd and relative paths across Dev tools', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-default-cwd-'));
  const calls = [];
  const tools = [
    { name: 'dev_bash', description: 'Run a command.', inputSchema: { type: 'object' } },
    { name: 'dev_read', description: 'Read a file.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'dev_edit', description: 'Edit files.', inputSchema: { type: 'object' } },
    { name: 'dev_write', description: 'Write a file.', inputSchema: { type: 'object' } },
    { name: 'dev_list_directory', description: 'List directory.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'dev_search', description: 'Search files.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ];
  const { server } = startToolFixture(t, tools, async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: 'text', text: 'done' }] };
  });
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const core = new OperationCore({
    stateDir,
    mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
    callbackUrl: 'http://127.0.0.1:9/callback',
    toolTimeoutMs: 15000,
  });
  try {
    const issued = core.store.issueMainCapability(120, { defaultCwd: '/tmp/default-work' });
    const runOne = async (nonce, tool, args) => {
      const sub = core.submit(issued.token, nonce, parseRequest({ version: 1, tool, arguments: args }), 'json-post-v1');
      await core.waitForOperation(sub.operation.id, 15000);
      assert.equal(core.store.getOperation(sub.operation.id).state, 'completed');
    };

    await runOne('c-bash-1', 'dev_bash', { command: 'pwd' });
    assert.deepEqual(calls.at(-1).args, { command: 'pwd', cwd: '/tmp/default-work' });

    await runOne('c-bash-2', 'dev_bash', { command: 'pwd', cwd: '/tmp/explicit' });
    assert.deepEqual(calls.at(-1).args, { command: 'pwd', cwd: '/tmp/explicit' });

    await runOne('c-ls-1', 'dev_list_directory', {});
    assert.deepEqual(calls.at(-1).args, { path: '/tmp/default-work' });

    await runOne('c-search-1', 'dev_search', { pattern: 'foo', path: 'src' });
    assert.deepEqual(calls.at(-1).args, { pattern: 'foo', path: '/tmp/default-work/src' });

    await runOne('c-read-1', 'dev_read', { targets: [{ path: 'a.mjs' }, { path: '/abs/b.mjs' }] });
    assert.deepEqual(calls.at(-1).args, { targets: [{ path: '/tmp/default-work/a.mjs' }, { path: '/abs/b.mjs' }] });

    await runOne('c-edit-1', 'dev_edit', { targets: [{ path: 'sub/x.mjs', edits: [] }] });
    assert.deepEqual(calls.at(-1).args, { targets: [{ path: '/tmp/default-work/sub/x.mjs', edits: [] }] });

    await runOne('c-write-1', 'dev_write', { path: 'out.txt', content: 'hi' });
    assert.deepEqual(calls.at(-1).args, { path: '/tmp/default-work/out.txt', content: 'hi' });
  } finally {
    await core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('POST /v1/batch executes read-only calls concurrently in one HTTP request and respects turn fencing', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-batch-http-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const tools = [
    { name: 'dev_read', description: 'Read file.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'dev_search', description: 'Search.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ];
  const { events, server } = startToolFixture(t, tools, async (name, args, log) => {
    log.push({ name, args, phase: 'start', at: Date.now() });
    await new Promise(resolve => setTimeout(resolve, 180));
    log.push({ name, args, phase: 'end', at: Date.now() });
    return { content: [{ type: 'text', text: `${name}:${args.path}` }] };
  });
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const store = new AdapterStore(stateDir);
  const issued = store.issueMainCapability(600, { defaultCwd: '/workspace/demo' });
  store.close();

  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, {
    WEBSESSION_ADAPTER_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`,
  });
  const batchUrl = `http://127.0.0.1:${port}/v1/batch?wait=5`;

  const badBatch = await fetch(batchUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issued.token}`,
      'content-type': 'application/json',
      'idempotency-key': 'bad-batch-1',
    },
    body: JSON.stringify({ version: 1, calls: [] }),
  });
  assert.equal(badBatch.status, 400);

  const startedAt = Date.now();
  const okResp = await fetch(batchUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issued.token}`,
      'content-type': 'application/json',
      'idempotency-key': 'good-batch-1',
      'x-turn-id': '4',
    },
    body: JSON.stringify({
      version: 1,
      calls: [
        { tool: 'dev_read', arguments: { path: 'one.mjs' } },
        { tool: 'dev_search', arguments: { pattern: 'x' } },
      ],
    }),
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(okResp.status, 200);
  const body = await okResp.json();
  assert.equal(body.state, 'ready');
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].state, 'completed');
  assert.equal(body.results[0].result, 'dev_read:/workspace/demo/one.mjs');
  assert.equal(body.results[1].state, 'completed');
  assert.equal(body.results[1].result, 'dev_search:/workspace/demo');
  assert.ok(elapsedMs < 350 || events.filter(e => e.phase === 'start').every(e => e.at < events.find(x => x.phase === 'end').at), 'batch read-only calls overlapped');

  const staleTurn = await fetch(batchUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issued.token}`,
      'content-type': 'application/json',
      'idempotency-key': 'stale-batch-2',
      'x-turn-id': '3',
    },
    body: JSON.stringify({ version: 1, calls: [{ tool: 'dev_read', arguments: { path: 'one.mjs' } }] }),
  });
  assert.equal(staleTurn.status, 409);
  assert.equal((await staleTurn.json()).code, 'superseded_by_newer_turn');

  const longKey = 'x'.repeat(56);
  const postBatch = (key, path) => fetch(batchUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issued.token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-turn-id': '4',
    },
    body: JSON.stringify({ version: 1, calls: [{ tool: 'dev_read', arguments: { path } }] }),
  });
  const firstKey = await postBatch(`${longKey}11111111`, 'first.mjs');
  assert.equal(firstKey.status, 200);
  const firstResult = (await firstKey.json()).results[0];
  const secondKey = await postBatch(`${longKey}22222222`, 'second.mjs');
  assert.equal(secondKey.status, 200, 'full-length keys sharing a prefix must remain distinct');
  const secondResult = (await secondKey.json()).results[0];
  assert.notEqual(firstResult.operation_id, secondResult.operation_id);
  assert.equal(secondResult.result, 'dev_read:/workspace/demo/second.mjs');
  const replay = await postBatch(`${longKey}11111111`, 'first.mjs');
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).results[0].operation_id, firstResult.operation_id);
});

test('batch admission rolls back earlier mutations and turn fences on a later conflict', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-batch-atomic-'));
  const core = new OperationCore({ stateDir, mcpUrl: 'http://unused' });
  const scheduled = [];
  core._schedule = id => scheduled.push(id);
  try {
    const issued = core.store.issueMainCapability(600);
    const request = command => parseRequest({ version: 1, tool: 'dev_bash', arguments: { command } });
    const nonce = 'atomic-batch';
    const hash = createHash('sha256').update(nonce).digest('base64url');
    core.submit(issued.token, `batch.${hash}.1`, request('original'), 'json-post-v1', 4, { deferSchedule: true });
    assert.deepEqual(core.submitBatch(issued.token, nonce, [request('new mutation'), request('conflicting')], 5), { nonceConflict: true });
    assert.deepEqual(scheduled, []);
    assert.equal(core.store.db.prepare('SELECT count(*) AS count FROM operations').get().count, 1);
    assert.equal(core.store.isCurrentTurn(issued.id, 4), true, 'rejected batch must not advance the turn');
    assert.equal(core.store.db.prepare('SELECT count(*) AS count FROM operations WHERE client_nonce = ?').get(`batch.${hash}.0`).count, 0);

    const accepted = core.submitBatch(issued.token, 'accepted', [request('one'), request('two')], 4);
    assert.equal(accepted.submissions.length, 2);
    assert.deepEqual(scheduled, accepted.submissions.map(item => item.operation.id));
    const replay = core.submitBatch(issued.token, 'accepted', [request('one'), request('two')], 4);
    assert.ok(replay.submissions.every(item => !item.created));
    assert.deepEqual(replay.submissions.map(item => item.operation.id), accepted.submissions.map(item => item.operation.id));
  } finally {
    await core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('GET and POST /v1/cwd inspect, validate, canonicalize, and clear server-side default_cwd', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-cwd-endpoint-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const calls = [];
  const tools = [
    { name: 'dev_list_directory', description: 'List directory.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'dev_read', description: 'Read a file.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ];
  const { server } = startToolFixture(t, tools, async (name, args) => {
    calls.push({ name, args });
    if (name === 'dev_list_directory') {
      if (args.path.includes('missing')) {
        return { isError: true, content: [{ type: 'text', text: 'ENOENT: no such directory' }] };
      }
      const resolved = args.path.startsWith('~/') ? `/home/tester/${args.path.slice(2)}` : args.path;
      return { content: [{ type: 'text', text: `dir: ${resolved}\nentries: 2\ndir src\nfile package.json 120B` }] };
    }
    return { content: [{ type: 'text', text: `read:${args.path}` }] };
  });
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const store = new AdapterStore(stateDir);
  const issued = store.issueMainCapability(300);
  store.close();

  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, {
    WEBSESSION_ADAPTER_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`,
  });
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${issued.token}` };

  const initial = await fetch(`${base}/v1/cwd`, { headers: auth });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).default_cwd, null);

  const updated = await fetch(`${base}/v1/cwd`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '~/projects/alpha' }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.default_cwd, '/home/tester/projects/alpha');
  assert.match(updatedBody.listing, /file package\.json 120B/);

  const relativeSub = await fetch(`${base}/v1/cwd`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: 'packages/api' }),
  });
  assert.equal(relativeSub.status, 200);
  assert.equal((await relativeSub.json()).default_cwd, '/home/tester/projects/alpha/packages/api');

  const callRead = await fetch(`${base}/v1/calls?wait=5`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'cwd-inherit-read' },
    body: JSON.stringify({ version: 1, tool: 'dev_read', arguments: { path: 'index.ts' } }),
  });
  assert.equal(callRead.status, 200);
  assert.equal((await callRead.json()).result, 'read:/home/tester/projects/alpha/packages/api/index.ts');

  const badDir = await fetch(`${base}/v1/cwd`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '~/missing' }),
  });
  assert.equal(badDir.status, 400);
  assert.equal((await badDir.json()).code, 'invalid_cwd');

  const cleared = await fetch(`${base}/v1/cwd`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: null }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).default_cwd, null);
});

test('pair discovery bundles live signatures and HTTP guidance without dispatching tools', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-pair-discovery-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const { server, events } = startToolFixture(t, [
    { name: 'fixture_read', description: 'Read a file.', inputSchema: { type: 'object' } },
  ], async () => { events.push('unexpected dispatch'); return {}; });
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const store = new AdapterStore(stateDir);
  const pairing = store.issuePairingCode({ defaultCwd: '/tmp/project' });
  t.after(() => store.close());
  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, { WEBSESSION_ADAPTER_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp` });
  const base = `http://127.0.0.1:${port}`;
  const post = query => fetch(`${base}/v1/pair${query}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code }),
  });
  const invalid = await post('?discover=yes');
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'invalid_discover');
  assert.equal((await post('?discover=1&discover=0')).status, 400);
  const response = await post('?discover=1');
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.state, 'ready');
  assert.equal(value.discovery_state, 'ready');
  assert.equal(value.tool_count, 1);
  assert.equal(value.default_cwd, '/tmp/project');
  assert.deepEqual(value.signatures, ['fixture_read()  Read a file.']);
  assert.match(value.instructions, /POST \/v1\/calls\?wait=2/);
  assert.match(value.instructions, /Idempotency-Key/);
  assert.match(value.instructions, /do not probe/);
  assert.ok(store.resolveCapability(value.capability));
  const guidance = await (await fetch(`${base}/v1/instructions`, { headers: { authorization: `Bearer ${value.capability}` } })).json();
  assert.equal(guidance.instructions, value.instructions);
  assert.deepEqual(events, []);
  assert.equal((await post('?discover=1')).status, 404);
});

test('pairing retains access and recovery guidance when optional discovery fails', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-pair-offline-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const store = new AdapterStore(stateDir);
  const pairing = store.issuePairingCode();
  t.after(() => store.close());
  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, { WEBSESSION_ADAPTER_MCP_URL: '' });
  const response = await fetch(`http://127.0.0.1:${port}/v1/pair?discover=1`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code }),
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.state, 'ready');
  assert.equal(value.discovery_state, 'unavailable');
  assert.equal(value.discovery_error, 'discovery_unavailable');
  assert.match(value.instructions, /POST \/v1\/calls/);
  assert.ok(store.resolveCapability(value.capability));
  assert.equal(store.redeemPairingCode(pairing.code), undefined);
});

test('discovery cancellation bounds a stalled upstream handshake', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-discovery-abort-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const server = createServer((_req, _res) => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const started = Date.now();
  await assert.rejects(listMcpTools({
    mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`, stateDir,
    callbackUrl: 'http://127.0.0.1:9/callback', signal: AbortSignal.timeout(100),
  }), /abort|timeout|timed out|closed/i);
  assert.ok(Date.now() - started < 3000, 'cancellation must not wait for the normal MCP timeout');
});

test('POST /v1/batch sequential mode enforces read-after-write ordering and fail-fast skipping', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-seq-batch-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let fileState = 'v0';
  const order = [];
  const tools = [
    { name: 'dev_edit', description: 'Edit.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    { name: 'dev_read', description: 'Read.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'dev_exec', description: 'Exec.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
  ];
  const { server } = startToolFixture(t, tools, async (name, args) => {
    order.push(`${name}:${args.step}`);
    if (name === 'dev_edit') {
      await new Promise(resolve => setTimeout(resolve, 40));
      fileState = args.next;
      return { content: [{ type: 'text', text: `edited:${fileState}` }] };
    }
    if (name === 'dev_exec' && args.fail) {
      return { isError: true, content: [{ type: 'text', text: 'tests failed' }] };
    }
    return { content: [{ type: 'text', text: `seen:${fileState}` }] };
  });
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });

  const store = new AdapterStore(stateDir);
  const issued = store.issueMainCapability(300);
  store.close();
  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, { WEBSESSION_ADAPTER_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp` });
  const base = `http://127.0.0.1:${port}`;
  const postBatch = (key, body) => fetch(`${base}/v1/batch?wait=5`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });

  // stop_on_error without sequential is rejected.
  assert.equal((await postBatch('bad-seq', { version: 1, stop_on_error: false, calls: [{ tool: 'dev_read', arguments: { step: 'x' } }] })).status, 400);

  // Ordered edit -> read -> edit -> read pipeline sees every mutation in order.
  const okRes = await postBatch('seq-ok', {
    version: 1,
    sequential: true,
    calls: [
      { tool: 'dev_edit', arguments: { step: '1', next: 'v1' } },
      { tool: 'dev_read', arguments: { step: '2' } },
      { tool: 'dev_edit', arguments: { step: '3', next: 'v2' } },
      { tool: 'dev_read', arguments: { step: '4' } },
    ],
  });
  assert.equal(okRes.status, 200);
  const okBody = await okRes.json();
  assert.deepEqual(okBody.results.map(r => r.result), ['edited:v1', 'seen:v1', 'edited:v2', 'seen:v2']);
  assert.deepEqual(order, ['dev_edit:1', 'dev_read:2', 'dev_edit:3', 'dev_read:4']);

  // Reusing the same nonce with sequential:false is a 409 nonce_conflict.
  const conflict = await postBatch('seq-ok', {
    version: 1,
    sequential: false,
    calls: [
      { tool: 'dev_edit', arguments: { step: '1', next: 'v1' } },
      { tool: 'dev_read', arguments: { step: '2' } },
      { tool: 'dev_edit', arguments: { step: '3', next: 'v2' } },
      { tool: 'dev_read', arguments: { step: '4' } },
    ],
  });
  assert.equal(conflict.status, 409);

  // Fail-fast stops at the failing test and marks subsequent steps rejected without dispatching them.
  const failRes = await postBatch('seq-fail', {
    version: 1,
    sequential: true,
    calls: [
      { tool: 'dev_edit', arguments: { step: '5', next: 'v3' } },
      { tool: 'dev_exec', arguments: { step: '6', fail: true } },
      { tool: 'dev_edit', arguments: { step: '7', next: 'v4-never' } },
    ],
  });
  assert.equal(failRes.status, 200);
  const failBody = await failRes.json();
  assert.equal(failBody.results[0].state, 'completed');
  assert.equal(failBody.results[0].result, 'edited:v3');
  assert.equal(failBody.results[1].state, 'tool_failed');
  assert.equal(failBody.results[2].state, 'rejected');
  assert.equal(failBody.results[2].error, 'skipped_after_prior_failure');
  assert.equal(fileState, 'v3');
  assert.equal(order.includes('dev_edit:7'), false);

  // stop_on_error: false continues past failures.
  const contRes = await postBatch('seq-cont', {
    version: 1,
    sequential: true,
    stop_on_error: false,
    calls: [
      { tool: 'dev_exec', arguments: { step: '8', fail: true } },
      { tool: 'dev_read', arguments: { step: '9' } },
    ],
  });
  assert.equal(contRes.status, 200);
  const contBody = await contRes.json();
  assert.equal(contBody.results[0].state, 'tool_failed');
  assert.equal(contBody.results[1].state, 'completed');
  assert.equal(contBody.results[1].result, 'seen:v3');
});

test('sequential pipelines persist ordering and stop-on-error across restarts', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-seq-restart-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let fileState = 'v0';
  const order = [];
  let releaseBarrier;
  const barrierEntered = new Promise(resolve => { releaseBarrier = resolve; });
  let holdBarrier = true;
  const tools = [
    { name: 'dev_edit', description: 'Edit.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    { name: 'dev_read', description: 'Read.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'dev_exec', description: 'Exec.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
  ];
  const { server } = startToolFixture(t, tools, async (name, args) => {
    if (name === 'dev_exec' && args.barrier && holdBarrier) {
      releaseBarrier();
      await new Promise(() => {});
    }
    order.push(`${name}:${args.step}`);
    if (name === 'dev_edit') {
      await new Promise(resolve => setTimeout(resolve, 50));
      fileState = args.next;
      return { content: [{ type: 'text', text: `edited:${fileState}` }] };
    }
    return { content: [{ type: 'text', text: `seen:${fileState}` }] };
  });
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`;

  // 1. Persist a queued edit -> read pipeline behind an in-flight barrier, then restart.
  const core1 = new OperationCore({ stateDir, mcpUrl, callbackUrl: 'http://127.0.0.1:9/cb', toolTimeoutMs: 5000 });
  const issued = core1.store.issueMainCapability(300);
  core1.start();
  const barrierSub = core1.submit(
    issued.token,
    'barrier-op',
    parseRequest({ version: 1, tool: 'dev_exec', arguments: { barrier: true, step: 'barrier' } }),
    'json-post-v1',
  );
  await barrierEntered;

  const batchSub = core1.submitBatch(
    issued.token,
    'restart-seq-edit-read',
    [
      parseRequest({ version: 1, tool: 'dev_edit', arguments: { step: 'edit-1', next: 'v1' } }),
      parseRequest({ version: 1, tool: 'dev_read', arguments: { step: 'read-2' } }),
    ],
    null,
    { sequential: true, stopOnError: true },
  );
  const [editId, readId] = batchSub.submissions.map(item => item.operation.id);
  assert.equal(core1.store.getOperation(editId).state, 'queued');
  assert.equal(core1.store.getOperation(readId).state, 'queued');
  await core1.close();

  // Also submit a second pipeline whose step 0 was interrupted mid-dispatch before recovery.
  holdBarrier = false;
  const prepStore = new AdapterStore(stateDir);
  const interruptedBatch = [
    parseRequest({ version: 1, tool: 'dev_edit', arguments: { step: 'int-1', next: 'v-ambiguous' } }),
    parseRequest({ version: 1, tool: 'dev_edit', arguments: { step: 'int-2', next: 'v-should-skip' } }),
  ];
  const s0 = prepStore.submitOperation(issued.id, 'int.0', interruptedBatch[0].requestJson, requestHash(interruptedBatch[0].requestJson), {
    tool: 'dev_edit', state: 'running', batchId: 'seq.interrupted', batchIndex: 0, stopOnError: 1,
  });
  prepStore.markDispatchStarted(s0.operation.id);
  const s1 = prepStore.submitOperation(issued.id, 'int.1', interruptedBatch[1].requestJson, requestHash(interruptedBatch[1].requestJson), {
    tool: 'dev_edit', state: 'queued', batchId: 'seq.interrupted', batchIndex: 1, stopOnError: 1,
  });
  prepStore.close();

  const core2 = new OperationCore({ stateDir, mcpUrl, callbackUrl: 'http://127.0.0.1:9/cb', toolTimeoutMs: 5000 });
  t.after(() => core2.close());
  core2.start();

  assert.equal(core2.store.getOperation(barrierSub.operation.id).state, 'unknown_outcome');
  const editOp = await core2.waitForOperation(editId, 3000);
  const readOp = await core2.waitForOperation(readId, 3000);
  assert.equal(editOp.state, 'completed');
  assert.equal(readOp.state, 'completed');
  assert.equal(readOp.result_text, 'seen:v1', 'recovered read must wait for earlier edit in sequential pipeline');
  assert.deepEqual(order, ['dev_edit:edit-1', 'dev_read:read-2']);

  const skippedAfterCrash = await core2.waitForOperation(s1.operation.id, 3000);
  assert.equal(core2.store.getOperation(s0.operation.id).state, 'unknown_outcome');
  assert.equal(skippedAfterCrash.state, 'rejected');
  assert.equal(skippedAfterCrash.error_text, 'skipped_after_prior_failure');
  assert.equal(order.includes('dev_edit:int-2'), false);
});

test('sequential pipelines stop on unsuccessful Dev command exits while preserving command output', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-seq-cmdexit-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const executed = [];
  const tools = [
    { name: 'dev_edit', description: 'Edit.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    { name: 'dev_exec', description: 'Exec.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    { name: 'dev_bash', description: 'Bash.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
  ];
  const { server } = startToolFixture(t, tools, async (name, args) => {
    executed.push(`${name}:${args.step}`);
    if (args.mode === 'exit1') {
      const { runExec } = await import('../../pi-dev/shell.mjs');
      const { renderBashText } = await import('../../pi-dev/render.mjs');
      const execResult = await runExec({
        pathMode: 'user',
        defaultCwd: stateDir,
        argv: [process.execPath, '-e', 'console.error("FAIL test/unit.test.mjs"); process.exit(1);'],
        maxOutputBytes: 65536,
        stateDir,
      });
      return { content: [{ type: 'text', text: renderBashText(execResult) }] };
    }
    if (args.mode === 'big-exit2') {
      return { content: [{ type: 'text', text: `${'x'.repeat(70_000)}\n[exit 2 · 1.1s]` }] };
    }
    if (args.mode === 'timeout') {
      return { content: [{ type: 'text', text: 'partial log\n[timed out after 5s · 5.0s]' }] };
    }
    if (args.mode === 'exit0-with-noise') {
      return { content: [{ type: 'text', text: '[exit 1]\nall tests green\n[exit 0 · 0.1s]' }] };
    }
    return { content: [{ type: 'text', text: `ok:${args.step}` }] };
  });
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });

  const store = new AdapterStore(stateDir);
  const issued = store.issueMainCapability(300);
  store.close();
  const port = await reservePort();
  await startAdapterServer(t, stateDir, port, { WEBSESSION_ADAPTER_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp` });
  const base = `http://127.0.0.1:${port}`;
  const postBatch = (key, calls) => fetch(`${base}/v1/batch?wait=5`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ version: 1, sequential: true, calls }),
  });

  // Real dev_exec [exit 1 · 0.2s] stays completed with full stdout, and aborts step 3.
  const r1 = await (await postBatch('cmd-exit-1', [
    { tool: 'dev_edit', arguments: { step: '1' } },
    { tool: 'dev_exec', arguments: { step: '2', mode: 'exit1' } },
    { tool: 'dev_edit', arguments: { step: '3-never' } },
  ])).json();
  assert.equal(r1.results[0].state, 'completed');
  assert.equal(r1.results[1].state, 'completed');
  assert.match(r1.results[1].result, /FAIL test\/unit\.test\.mjs/);
  assert.equal(r1.results[2].state, 'rejected');
  assert.equal(r1.results[2].error, 'skipped_after_prior_failure');
  assert.equal(executed.includes('dev_edit:3-never'), false);

  // Multi-chunk (>64 KiB) non-zero exit and command timeout also stop the pipeline.
  const r2 = await (await postBatch('cmd-big-exit2', [
    { tool: 'dev_exec', arguments: { step: '4', mode: 'big-exit2' } },
    { tool: 'dev_edit', arguments: { step: '5-never' } },
  ])).json();
  assert.equal(r2.results[0].state, 'completed');
  assert.ok(r2.results[0].chunk_count >= 2);
  assert.equal(r2.results[1].state, 'rejected');
  assert.equal(r2.results[1].error, 'skipped_after_prior_failure');

  const r3 = await (await postBatch('cmd-timeout', [
    { tool: 'dev_bash', arguments: { step: '6', mode: 'timeout' } },
    { tool: 'dev_edit', arguments: { step: '7-never' } },
  ])).json();
  assert.equal(r3.results[1].state, 'rejected');

  // Earlier stdout containing '[exit 1]' does not false-positive when final footer is '[exit 0 · 0.1s]'.
  const r4 = await (await postBatch('cmd-exit0', [
    { tool: 'dev_exec', arguments: { step: '8', mode: 'exit0-with-noise' } },
    { tool: 'dev_edit', arguments: { step: '9-runs' } },
  ])).json();
  assert.equal(r4.results[0].state, 'completed');
  assert.equal(r4.results[1].state, 'completed');
  assert.equal(r4.results[1].result, 'ok:9-runs');
});
