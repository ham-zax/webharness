import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { OperationCore } from '../core.mjs';
import { parseRequest } from '../protocol.mjs';
import { AdapterStore, requestHash } from '../store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const piDevServerPath = resolve(here, '..', '..', 'pi-dev', 'server.mjs');

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((settle, fail) => {
    resolvePromise = settle;
    rejectPromise = fail;
  });
  promise.catch(() => {});
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function withinMs(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function startModernGateway(t, tools, runTool) {
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'queue-fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', () => ({ tools }));
    server.setRequestHandler('tools/call', ({ params }) => runTool(params.name, params.arguments));
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
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach(entry => headers.append(name, entry));
      else headers.set(name, value);
    }
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
    const response = await handler.fetch(new Request(url, init));
    const payload = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(payload);
  });
  server.listen(0, '127.0.0.1');
  t.after(() => {
    server.closeAllConnections();
    server.close();
    void handler.close();
  });
  return server;
}

const QUEUE_TOOLS = [
  { name: 'fixture_read', description: 'Read fixture.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'fixture_write', description: 'Write fixture.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
];

test('per-capability mutation queues overlap across capabilities, stay FIFO per capability, isolate sequential batches, and self-clean', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-cap-queues-'));
  const a1Entered = deferred();
  const a1Gate = deferred();
  const events = [];
  let cState = 'c0';

  const server = startModernGateway(t, QUEUE_TOOLS, async (name, args) => {
    const step = args.step;
    events.push({ step, phase: 'start' });
    if (step === 'a1') {
      a1Entered.resolve();
      await a1Gate.promise;
    }
    if (step === 'b1') {
      await new Promise(r => setTimeout(r, 35));
    }
    if (step === 'c-write-1') {
      await new Promise(r => setTimeout(r, 25));
      cState = 'c1';
    }
    if (step === 'c-fail') {
      events.push({ step, phase: 'fail' });
      return { isError: true, content: [{ type: 'text', text: 'boom' }] };
    }
    events.push({ step, phase: 'end' });
    if (name === 'fixture_read') {
      return { content: [{ type: 'text', text: `seen:${cState}` }] };
    }
    return { content: [{ type: 'text', text: `ok:${step}` }] };
  });
  await once(server, 'listening');

  const core = new OperationCore({
    stateDir,
    mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
    callbackUrl: 'http://127.0.0.1:9/cb',
    toolTimeoutMs: 15_000,
  });
  try {
    const capA = core.store.issueMainCapability(300);
    const capB = core.store.issueMainCapability(300);
    const capC = core.store.issueMainCapability(300);
    await core.permittedTools(capA.token);

    // Capability A queues two mutations; a1 blocks at the barrier, a2 waits behind a1.
    const a1 = core.submit(capA.token, 'a-1', parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'a1' } }), 'json-post-v1');
    const a2 = core.submit(capA.token, 'a-2', parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'a2' } }), 'json-post-v1');
    await withinMs(a1Entered.promise, 10_000, 'a1 did not enter backend');
    assert.equal(core.store.getOperation(a2.operation.id).state, 'queued');
    assert.equal(events.some(e => e.step === 'a2'), false);

    // While Capability A is blocked, Capability B runs two mutations in strict FIFO order.
    const b1 = core.submit(capB.token, 'b-1', parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'b1' } }), 'json-post-v1');
    const b2 = core.submit(capB.token, 'b-2', parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'b2' } }), 'json-post-v1');
    await withinMs(
      Promise.all([
        core.waitForOperation(b1.operation.id, 10_000),
        core.waitForOperation(b2.operation.id, 10_000),
      ]),
      10_000,
      'Capability B mutations were blocked by Capability A',
    );
    assert.equal(core.store.getOperation(b1.operation.id).state, 'completed');
    assert.equal(core.store.getOperation(b2.operation.id).state, 'completed');
    assert.equal(core.store.getOperation(a1.operation.id).state, 'running', 'a1 stayed blocked while Capability B completed');
    const b1EndIndex = events.findIndex(e => e.step === 'b1' && e.phase === 'end');
    const b2StartIndex = events.findIndex(e => e.step === 'b2' && e.phase === 'start');
    assert.ok(b1EndIndex !== -1 && b2StartIndex > b1EndIndex, 'Capability B serialized its own writes FIFO');

    // While Capability A is still blocked, Capability C runs a sequential batch with read-after-write and stop_on_error,
    // followed by a single write queued behind that batch.
    const cBatch = core.submitBatch(
      capC.token,
      'c-seq',
      [
        parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'c-write-1' } }),
        parseRequest({ version: 1, tool: 'fixture_read', arguments: { step: 'c-read-2' } }),
        parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'c-fail' } }),
        parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'c-skip' } }),
      ],
      null,
      { sequential: true, stopOnError: true },
    );
    const cAfter = core.submit(capC.token, 'c-after', parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'c-after' } }), 'json-post-v1');

    await withinMs(
      Promise.all([
        ...cBatch.submissions.map(item => core.waitForOperation(item.operation.id, 10_000)),
        core.waitForOperation(cAfter.operation.id, 10_000),
      ]),
      10_000,
      'Capability C sequential batch was blocked by Capability A',
    );
    const cOps = cBatch.submissions.map(item => core.store.getOperation(item.operation.id));
    assert.equal(cOps[0].state, 'completed');
    assert.equal(cOps[1].state, 'completed');
    assert.equal(cOps[1].result_text, 'seen:c1');
    assert.equal(cOps[2].state, 'tool_failed');
    assert.equal(cOps[3].state, 'rejected');
    assert.equal(cOps[3].error_text, 'skipped_after_prior_failure');
    assert.equal(core.store.getOperation(cAfter.operation.id).state, 'completed');
    const cFailIndex = events.findIndex(e => e.step === 'c-fail' && e.phase === 'fail');
    const cAfterStartIndex = events.findIndex(e => e.step === 'c-after' && e.phase === 'start');
    assert.ok(cFailIndex !== -1 && cAfterStartIndex > cFailIndex, 'write submitted after sequential batch waited for the batch');

    // Completed Capabilities B and C have already cleaned their tail entries while Capability A remains active.
    await new Promise(r => setImmediate(r));
    assert.equal(core._tails.has(capB.id), false);
    assert.equal(core._tails.has(capC.id), false);
    assert.equal(core._tails.has(capA.id), true);

    // Release Capability A and verify a1 finishes before a2 starts, then all tail entries clean up.
    a1Gate.resolve();
    await Promise.all([
      core.waitForOperation(a1.operation.id, 10_000),
      core.waitForOperation(a2.operation.id, 10_000),
    ]);
    assert.equal(core.store.getOperation(a1.operation.id).state, 'completed');
    assert.equal(core.store.getOperation(a2.operation.id).state, 'completed');
    const a1EndIndex = events.findIndex(e => e.step === 'a1' && e.phase === 'end');
    const a2StartIndex = events.findIndex(e => e.step === 'a2' && e.phase === 'start');
    assert.ok(a1EndIndex !== -1 && a2StartIndex > a1EndIndex, 'Capability A preserved FIFO ordering');
    await new Promise(r => setImmediate(r));
    assert.equal(core._tails.size, 0, 'all completed capability tails self-cleaned');
  } finally {
    a1Gate.resolve();
    await core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('turn fences, revocation, and restart recovery stay isolated per capability and leave zero tail leaks', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-cap-recovery-'));
  const recoveryBarrierEntered = deferred();
  const recoveryBarrierGate = deferred();
  const fenceEntered = deferred();
  const fenceGate = deferred();
  const ran = [];

  const server = startModernGateway(t, QUEUE_TOOLS, async (_name, args) => {
    ran.push(args.step);
    if (args.step === 'fence-a1') {
      fenceEntered.resolve();
      await fenceGate.promise;
    }
    if (args.step === 'rec-a-seq-1') {
      recoveryBarrierEntered.resolve();
      await recoveryBarrierGate.promise;
    }
    if (args.step === 'rec-b-1') {
      await new Promise(r => setTimeout(r, 30));
    }
    return { content: [{ type: 'text', text: `done:${args.step}` }] };
  });
  await once(server, 'listening');
  const mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`;

  // Phase 1: Turn fence + revocation on Capability A & C while Capability B runs independently.
  const core1 = new OperationCore({ stateDir, mcpUrl, callbackUrl: 'http://127.0.0.1:9/cb', toolTimeoutMs: 10_000 });
  const capA = core1.store.issueMainCapability(300);
  const capB = core1.store.issueMainCapability(300);
  const capC = core1.store.issueMainCapability(300);
  await core1.permittedTools(capA.token);

  const fa1 = core1.submit(capA.token, 'fa-1', parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'fence-a1' } }), 'json-post-v1', 1);
  const fa2 = core1.submit(capA.token, 'fa-2', parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'fence-a2' } }), 'json-post-v1', 1);
  const fc1 = core1.submit(capC.token, 'fc-1', parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'revoked-c1' } }), 'json-post-v1', 1, { deferSchedule: true });
  await withinMs(fenceEntered.promise, 10_000, 'fence-a1 did not start');

  // Advance Capability A turn and revoke Capability C; Capability B turn 1 must still execute normally.
  assert.equal(core1.store.advanceTurn(capA.id, 2), true);
  assert.equal(core1.store.revokeCapability(capC.id), true);
  core1._schedule(fc1.operation.id);
  const fb1 = core1.submit(capB.token, 'fb-1', parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'live-b1' } }), 'json-post-v1', 1);

  await withinMs(core1.waitForOperation(fb1.operation.id, 10_000), 10_000, 'Capability B blocked on Capability A turn fence');
  assert.equal(core1.store.getOperation(fb1.operation.id).state, 'completed');
  const fcOp = await core1.waitForOperation(fc1.operation.id, 10_000);
  assert.equal(fcOp.state, 'rejected');
  assert.match(fcOp.error_text, /revoked/);

  fenceGate.resolve();
  await Promise.all([
    core1.waitForOperation(fa1.operation.id, 10_000),
    core1.waitForOperation(fa2.operation.id, 10_000),
  ]);
  assert.equal(core1.store.getOperation(fa2.operation.id).state, 'rejected');
  assert.equal(core1.store.getOperation(fa2.operation.id).error_text, 'superseded_by_newer_turn');
  await new Promise(r => setImmediate(r));
  assert.equal(core1._tails.size, 0);
  await core1.close();

  // Phase 2: Seed persisted queued operations for Capability A (sequential batch) and Capability B (two single writes),
  // then recover via core2.start() and prove Capability B finishes while Capability A's recovered batch is blocked.
  const seed = new AdapterStore(stateDir);
  const reqA1 = parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'rec-a-seq-1' } });
  const reqA2 = parseRequest({ version: 1, tool: 'fixture_read', arguments: { step: 'rec-a-seq-2' } });
  const sA1 = seed.submitOperation(capA.id, 'rec-a.0', reqA1.requestJson, requestHash(reqA1.requestJson), {
    tool: 'fixture_write', state: 'queued', batchId: 'seq.recA', batchIndex: 0, stopOnError: 1, turnId: 2,
  });
  const sA2 = seed.submitOperation(capA.id, 'rec-a.1', reqA2.requestJson, requestHash(reqA2.requestJson), {
    tool: 'fixture_read', state: 'queued', batchId: 'seq.recA', batchIndex: 1, stopOnError: 1, turnId: 2,
  });
  const reqB1 = parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'rec-b-1' } });
  const reqB2 = parseRequest({ version: 1, tool: 'fixture_write', arguments: { step: 'rec-b-2' } });
  const sB1 = seed.submitOperation(capB.id, 'rec-b.0', reqB1.requestJson, requestHash(reqB1.requestJson), {
    tool: 'fixture_write', state: 'queued', turnId: 1,
  });
  const sB2 = seed.submitOperation(capB.id, 'rec-b.1', reqB2.requestJson, requestHash(reqB2.requestJson), {
    tool: 'fixture_write', state: 'queued', turnId: 1,
  });
  seed.close();

  const core2 = new OperationCore({ stateDir, mcpUrl, callbackUrl: 'http://127.0.0.1:9/cb', toolTimeoutMs: 10_000 });
  try {
    core2.start();
    await withinMs(recoveryBarrierEntered.promise, 10_000, 'recovered Capability A batch did not start');
    await withinMs(
      Promise.all([
        core2.waitForOperation(sB1.operation.id, 10_000),
        core2.waitForOperation(sB2.operation.id, 10_000),
      ]),
      10_000,
      'recovered Capability B writes were blocked by Capability A sequential batch',
    );
    assert.equal(core2.store.getOperation(sB1.operation.id).state, 'completed');
    assert.equal(core2.store.getOperation(sB2.operation.id).state, 'completed');
    assert.equal(core2.store.getOperation(sA1.operation.id).state, 'running');
    assert.ok(ran.indexOf('rec-b-1') < ran.indexOf('rec-b-2'), 'recovered Capability B writes stayed FIFO');

    recoveryBarrierGate.resolve();
    await Promise.all([
      core2.waitForOperation(sA1.operation.id, 10_000),
      core2.waitForOperation(sA2.operation.id, 10_000),
    ]);
    assert.equal(core2.store.getOperation(sA1.operation.id).state, 'completed');
    assert.equal(core2.store.getOperation(sA2.operation.id).state, 'completed');
    assert.ok(ran.indexOf('rec-a-seq-1') < ran.indexOf('rec-a-seq-2'));
    await new Promise(r => setImmediate(r));
    assert.equal(core2._tails.size, 0);
  } finally {
    fenceGate.resolve();
    recoveryBarrierGate.resolve();
    await core2.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('real pi-dev coordinates concurrent same-file dev_edit calls across two WebSession capabilities', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'websession-pidev-coedit-'));
  const workspaceDir = mkdtempSync(join(tmpdir(), 'websession-pidev-work-'));
  const piStateDir = mkdtempSync(join(tmpdir(), 'websession-pidev-state-'));
  t.after(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(piStateDir, { recursive: true, force: true });
  });

  const stdioTransport = new StdioClientTransport({
    command: process.execPath,
    args: [piDevServerPath],
    env: {
      ...process.env,
      MCP_DEV_SHELL_MODE: 'unrestricted',
      MCP_DEV_PATH_MODE: 'user',
      MCP_DEV_DEFAULT_CWD: workspaceDir,
      MCP_DEV_STATE_DIR: piStateDir,
      MCP_DEV_TERMINAL_SOCKET: join(piStateDir, 'terminal.sock'),
    },
    stderr: 'pipe',
  });
  const piClient = new Client(
    { name: 'pidev-bridge-test', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { pin: '2026-07-28' } },
  );
  await piClient.connect(stdioTransport);
  t.after(async () => {
    await stdioTransport.close().catch(() => {});
  });

  const listed = await piClient.listTools();
  const gatewayTools = listed.tools
    .filter(tool => tool.name === 'edit' || tool.name === 'read')
    .map(tool => ({ ...tool, name: `dev_${tool.name}` }));

  const server = startModernGateway(t, gatewayTools, (name, args) => {
    const upstreamName = name.replace(/^dev_/, '');
    return piClient.callTool({ name: upstreamName, arguments: args });
  });
  await once(server, 'listening');

  const core = new OperationCore({
    stateDir,
    mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
    callbackUrl: 'http://127.0.0.1:9/cb',
    toolTimeoutMs: 15_000,
  });
  try {
    const capA = core.store.issueMainCapability(300, { defaultCwd: workspaceDir });
    const capB = core.store.issueMainCapability(300, { defaultCwd: workspaceDir });
    await core.permittedTools(capA.token);

    const sharedFile = join(workspaceDir, 'shared.txt');
    writeFileSync(
      sharedFile,
      ['header: alpha', 'middle: stable', 'conflict: base', 'footer: omega', ''].join('\n'),
      'utf8',
    );

    // 1. Disjoint hunks on the same file submitted concurrently by Capability A and Capability B.
    const disjointA = core.submit(
      capA.token,
      'disjoint-a',
      parseRequest({
        version: 1,
        tool: 'dev_edit',
        arguments: {
          targets: [{ path: 'shared.txt', edits: [{ oldText: 'header: alpha', newText: 'header: ALPHA_BY_A' }] }],
        },
      }),
      'json-post-v1',
    );
    const disjointB = core.submit(
      capB.token,
      'disjoint-b',
      parseRequest({
        version: 1,
        tool: 'dev_edit',
        arguments: {
          targets: [{ path: 'shared.txt', edits: [{ oldText: 'footer: omega', newText: 'footer: OMEGA_BY_B' }] }],
        },
      }),
      'json-post-v1',
    );

    const [opDisjointA, opDisjointB] = await Promise.all([
      core.waitForOperation(disjointA.operation.id, 15_000),
      core.waitForOperation(disjointB.operation.id, 15_000),
    ]);
    assert.equal(opDisjointA.state, 'completed');
    assert.equal(opDisjointB.state, 'completed');
    assert.equal(
      readFileSync(sharedFile, 'utf8'),
      ['header: ALPHA_BY_A', 'middle: stable', 'conflict: base', 'footer: OMEGA_BY_B', ''].join('\n'),
      'in-worker mutation coordinator preserved both concurrent disjoint edits',
    );

    // 2. Conflicting edits to the same line submitted concurrently: one succeeds, one fails cleanly without corruption.
    const conflictA = core.submit(
      capA.token,
      'conflict-a',
      parseRequest({
        version: 1,
        tool: 'dev_edit',
        arguments: {
          targets: [{ path: 'shared.txt', edits: [{ oldText: 'conflict: base', newText: 'conflict: WON_BY_A' }] }],
        },
      }),
      'json-post-v1',
    );
    const conflictB = core.submit(
      capB.token,
      'conflict-b',
      parseRequest({
        version: 1,
        tool: 'dev_edit',
        arguments: {
          targets: [{ path: 'shared.txt', edits: [{ oldText: 'conflict: base', newText: 'conflict: WON_BY_B' }] }],
        },
      }),
      'json-post-v1',
    );

    const [opConflictA, opConflictB] = await Promise.all([
      core.waitForOperation(conflictA.operation.id, 15_000),
      core.waitForOperation(conflictB.operation.id, 15_000),
    ]);
    const states = [opConflictA.state, opConflictB.state].sort();
    assert.deepEqual(states, ['completed', 'tool_failed']);
    const loser = opConflictA.state === 'tool_failed' ? opConflictA : opConflictB;
    assert.match(loser.error_text, /text was not found/);
    const winnerLine = opConflictA.state === 'completed' ? 'conflict: WON_BY_A' : 'conflict: WON_BY_B';
    assert.equal(
      readFileSync(sharedFile, 'utf8'),
      ['header: ALPHA_BY_A', 'middle: stable', winnerLine, 'footer: OMEGA_BY_B', ''].join('\n'),
      'losing concurrent edit failed cleanly while preserving the winning edit intact',
    );

    await new Promise(r => setImmediate(r));
    assert.equal(core._tails.size, 0);
  } finally {
    await core.close();
  }
});
