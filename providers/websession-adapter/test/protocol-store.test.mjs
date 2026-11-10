import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OperationCore, renderToolResult } from '../core.mjs';
import { compactInstructions, decodeToolName, parseRequest, parseUniversalRequest, toolListSnapshot } from '../protocol.mjs';
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
  assert.deepEqual(toolListSnapshot(tools, owner, '/tmp/project'), { ...base, instructions: owner, default_cwd: '/tmp/project' });
  assert.deepEqual(toolListSnapshot(tools, owner), { ...base, instructions: owner });
  assert.deepEqual(toolListSnapshot(tools, instructions, '/tmp/project'), { ...base, instructions: compacted, default_cwd: '/tmp/project' });
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
      result = {};
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
