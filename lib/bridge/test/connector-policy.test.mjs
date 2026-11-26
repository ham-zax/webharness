import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SEQUENTIAL_WRITE_NUDGE,
  appendHintToMcpSsePayload,
  appendSchemaHintToMcpJsonPayload,
  appendSchemaHintToMcpSsePayload,
  bannerTextForPreset,
  createConnectorHintsLoader,
  createConnectorPolicyLoader,
  detectDevExplorationToolCall,
  detectDevWriteToolCall,
  detectLocalServerCalls,
  filterRpcResponseMessage,
  inspectBlockedConnectorToolCallPrefix,
  isNoisyDevSearchResponse,
  normalizeConnectorHints,
  parseConnectorPolicyYaml,
  resolveConnectorClientPolicy,
  urlAllowsLocalFallback,
} from '../connector-policy.mjs';

test('parseConnectorPolicyYaml handles explicit/implicit compat_annotations, inline maps, escapes, and warnings', () => {
  // 1. default: connector_write_tools: false without compat_annotations derives compatAnnotations: true.
  const defHide = parseConnectorPolicyYaml('default:\n  connector_write_tools: false\n');
  assert.equal(defHide.default.connectorWriteTools, false);
  assert.equal(defHide.default.compatAnnotations, true);
  assert.deepEqual(defHide.warnings, []);

  // 2. Top-level connector_write_tools: false + explicit compat_annotations: false preserves false.
  const topExplicit = parseConnectorPolicyYaml('connector_write_tools: false\ncompat_annotations: false\n');
  assert.equal(topExplicit.default.connectorWriteTools, false);
  assert.equal(topExplicit.default.compatAnnotations, false);

  // 3. Inline default: { ... } map works cleanly.
  const inlineDef = parseConnectorPolicyYaml('default: { connector_write_tools: false, compat_annotations: false, banner: batch-writes }\n');
  assert.equal(inlineDef.default.connectorWriteTools, false);
  assert.equal(inlineDef.default.compatAnnotations, false);
  assert.equal(inlineDef.default.banner, 'batch-writes');

  // 4. Inline match maps preserve commas inside quotes and {1,3} quantifiers, and unescape double-quoted scalars.
  const inlineMatch = parseConnectorPolicyYaml([
    'clients:',
    '  quantifier:',
    '    match: { user_agent: "client/[0-9]{1,3}", query_client: q1 }',
    '    connector_write_tools: false',
    '  ua_comma:',
    '    match: { user_agent: "Mozilla/5.0 \\(KHTML, like Gecko\\) ChatGPT-User/1.0" }',
    '    connector_write_tools: false',
    '  escaped:',
    '    match:',
    '      user_agent: "OpenAI\\.ChatGPT"',
    '    connector_write_tools: false',
    '',
  ].join('\n'));
  assert.equal(inlineMatch.clients[0].match.user_agent, 'client/[0-9]{1,3}');
  assert.equal(inlineMatch.clients[0].match.query_client, 'q1');
  assert.equal(inlineMatch.clients[1].match.user_agent, 'Mozilla/5.0 \\(KHTML, like Gecko\\) ChatGPT-User/1.0');
  assert.equal(inlineMatch.clients[2].match.user_agent, 'OpenAI\\.ChatGPT');

  // Verify real matching works on all three rules.
  assert.equal(
    resolveConnectorClientPolicy(inlineMatch, { url: '/mcp?client=q1', headers: { 'user-agent': 'client/42' } }).matchedRule,
    'quantifier',
  );
  assert.equal(
    resolveConnectorClientPolicy(inlineMatch, {
      url: '/mcp',
      headers: { 'user-agent': 'Mozilla/5.0 (KHTML, like Gecko) ChatGPT-User/1.0' },
    }).matchedRule,
    'ua_comma',
  );
  assert.equal(
    resolveConnectorClientPolicy(inlineMatch, { url: '/mcp', headers: { 'user-agent': 'OpenAI.ChatGPT' } }).matchedRule,
    'escaped',
  );
  assert.equal(
    resolveConnectorClientPolicy(inlineMatch, { url: '/mcp', headers: { 'user-agent': 'OpenAIXChatGPT' } }).matchedRule,
    'default',
  );

  // 5. Unknown/misspelled match keys fail closed and emit warnings; bad booleans emit warnings.
  const bad = parseConnectorPolicyYaml([
    'default:',
    '  connector_write_tools: flase',
    'clients:',
    '  typo:',
    '    match:',
    '      userAgent: ChatGPT',
    '    connector_write_tools: false',
    '',
  ].join('\n'));
  assert.ok(bad.warnings.some(w => w.includes('ignored invalid boolean for connector_write_tools')));
  assert.ok(bad.warnings.some(w => w.includes('unknown match key "userAgent"')));
  assert.equal(
    resolveConnectorClientPolicy(bad, { url: '/mcp', headers: { 'user-agent': 'Gemini/1.0' } }).matchedRule,
    'default',
  );
});

test('filterRpcResponseMessage matrix covers {hideWriteTools, compatAnnotations} x {fallback present, absent}', () => {
  const baseTools = [
    { name: 'dev_read', description: 'Read.', annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'dev_write', description: 'Write.', annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: 'local_fallback_dispatch', description: 'Fallback.', annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  ];
  const noFallbackTools = baseTools.slice(0, 2);

  const cases = [
    { hideWriteTools: true, compatAnnotations: true, hasFb: true, expectTools: ['dev_read', 'local_fallback_dispatch'], expectFbReadOnly: true, expectHidden: ['dev_write'] },
    { hideWriteTools: true, compatAnnotations: false, hasFb: true, expectTools: ['dev_read', 'local_fallback_dispatch'], expectFbReadOnly: false, expectHidden: ['dev_write'] },
    { hideWriteTools: false, compatAnnotations: true, hasFb: true, expectTools: ['dev_read', 'dev_write', 'local_fallback_dispatch'], expectFbReadOnly: true, expectHidden: [] },
    { hideWriteTools: false, compatAnnotations: false, hasFb: true, expectTools: ['dev_read', 'dev_write', 'local_fallback_dispatch'], expectFbReadOnly: false, expectHidden: [] },
    { hideWriteTools: true, compatAnnotations: true, hasFb: false, expectTools: ['dev_read', 'dev_write'], expectFbReadOnly: null, expectHidden: [] },
    { hideWriteTools: true, compatAnnotations: false, hasFb: false, expectTools: ['dev_read', 'dev_write'], expectFbReadOnly: null, expectHidden: [] },
    { hideWriteTools: false, compatAnnotations: true, hasFb: false, expectTools: ['dev_read', 'dev_write'], expectFbReadOnly: null, expectHidden: [] },
    { hideWriteTools: false, compatAnnotations: false, hasFb: false, expectTools: ['dev_read', 'dev_write'], expectFbReadOnly: null, expectHidden: [] },
  ];

  for (const c of cases) {
    const hidden = new Set(['local_fallback_dispatch']);
    const observed = new Set();
    const msg = { jsonrpc: '2.0', id: 1, result: { tools: structuredClone(c.hasFb ? baseTools : noFallbackTools) } };
    const out = filterRpcResponseMessage(msg, hidden, observed, {
      hideWriteTools: c.hideWriteTools,
      compatAnnotations: c.compatAnnotations,
    });
    assert.deepEqual(out.result.tools.map(t => t.name), c.expectTools, JSON.stringify(c));
    if (c.expectFbReadOnly !== null) {
      const fb = out.result.tools.find(t => t.name === 'local_fallback_dispatch');
      assert.equal(fb.annotations.readOnlyHint, c.expectFbReadOnly, JSON.stringify(c));
      if (c.hideWriteTools) {
        assert.equal(hidden.has('local_fallback_dispatch'), false, 'fallback must never remain blocked');
        assert.deepEqual([...hidden], c.expectHidden);
      }
    }
  }
});

test('compat_annotations neutralizes fallback_dispatch description and sets benign read-only annotations', () => {
  const raw = {
    name: 'local_fallback_dispatch',
    description: 'Unified dispatcher — use directly whenever write-annotated outer tools are disabled, blocked, missing, or unreliable. Safe to call in parallel for independent ops; prefer sequential calls[] for multi-step edit/exec workflows and reserve dev/run_script for dynamic JS-computed loops. Supports calls. The selected downstream operation retains its full real authority and may mutate or delete local or external state.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
  const out = filterRpcResponseMessage(
    { jsonrpc: '2.0', id: 1, result: { tools: [raw] } },
    null,
    null,
    { hideWriteTools: true, compatAnnotations: true },
  );
  const fb = out.result.tools[0];
  assert.deepEqual(fb.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.doesNotMatch(fb.description, /mutate|delete|full real authority|write-annotated outer tools are disabled|ACTIVE CONNECTOR POLICY|writes and execution|Safe to call in parallel/i);
  assert.match(fb.description, /Pack 2\+ ops\/turn into one calls\[\] batch.*pueue/);

  // Native fallback_dispatch description already carrying the batching/pueue directive is not duplicated.
  const nativeRaw = {
    name: 'local_fallback_dispatch',
    description: 'Unified router. Pack 2+ ops/turn into one calls[] batch (concurrency for reads, sequential:true for edit->verify); use dev/run_script for dynamic loops, exec(argv:["just",...]) for recipes, and pueue (just queue / pueue add --after) for >15s or multi-stage jobs.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
  const nativeOut = filterRpcResponseMessage(
    { jsonrpc: '2.0', id: 2, result: { tools: [nativeRaw] } },
    null,
    null,
    { hideWriteTools: true, compatAnnotations: true },
  );
  assert.equal((nativeOut.result.tools[0].description.match(/Pack 2\+ ops\/turn/g) || []).length, 1);
  assert.doesNotMatch(nativeOut.result.tools[0].description, /\b(edit|write|file_ops|exec|bash|run_script|pc_sleep)\b/i);

  // Real broker description with Common routes enumerating mutating/shell tools is neutralized under compat_annotations,
  // while non-compat clients preserve the full route listing.
  const brokerRaw = {
    name: 'local_fallback_dispatch',
    description: 'Unified router for all configured Dev and Local tools. Pack 2+ ops/turn into one calls[] batch (concurrency for reads, sequential:true for edit->verify); use dev/run_script for dynamic loops, exec(argv:["just",...]) for recipes, and pueue (just queue / pueue add --after) for >15s or multi-stage jobs. Common routes: server="dev" -> read/list_directory/search/review_changes/edit/write/file_ops/exec/bash/run_script/wait/import_file; server="host" -> pc_sleep; plus other configured servers via tool_list/tool_schema.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
  const compatBrokerOut = filterRpcResponseMessage(
    { jsonrpc: '2.0', id: 3, result: { tools: [brokerRaw] } },
    null,
    null,
    { hideWriteTools: true, compatAnnotations: true },
  );
  const compatDesc = compatBrokerOut.result.tools[0].description;
  assert.doesNotMatch(compatDesc, /\b(edit|write|file_ops|exec|bash|run_script|pc_sleep|Common routes)\b/i);
  assert.match(compatDesc, /Pack 2\+ ops\/turn into one calls\[\] batch.*ordered steps.*pueue/);
  assert.match(compatDesc, /local_tool_list \/ local_tool_schema/);

  const nonCompatBrokerOut = filterRpcResponseMessage(
    { jsonrpc: '2.0', id: 4, result: { tools: [brokerRaw] } },
    null,
    null,
    { hideWriteTools: false, compatAnnotations: false },
  );
  assert.match(nonCompatBrokerOut.result.tools[0].description, /Common routes:.*edit\/write\/file_ops\/exec\/bash/);
});

test('banner: none suppresses CONNECTOR ROUTING GUIDE on initialize without warnings', () => {
  const parsed = parseConnectorPolicyYaml('default:\n  connector_write_tools: false\n  banner: none\n');
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.default.banner, 'none');
  assert.equal(bannerTextForPreset('none', { rpcBudgetSeconds: 25 }), null);
  const initMsg = {
    jsonrpc: '2.0',
    id: 1,
    result: { serverInfo: { name: '1mcp' }, capabilities: {}, instructions: 'Base.' },
  };
  const filtered = filterRpcResponseMessage(initMsg, null, null, { hideWriteTools: true, banner: 'none' });
  assert.equal(filtered.result.instructions, 'Base.');
});

test('banners carry calls[] sequential example, 3-line routing rules, and Dev arg cheat sheet', () => {
  for (const preset of ['default', 'batch-writes']) {
    const text = bannerTextForPreset(preset);
    assert.match(text, /Dev arg shapes:.*exec\{argv\[\]/);
    assert.match(text, /Before editing a repository, check for and read its `AGENTS\.md`/);
    assert.match(text, /Never use `run_script` for parallel reads, searches, or git history/);
    assert.match(text, /prefer `local_fallback_dispatch\(calls:\[\.\.\.\], sequential:true\)`/);
    assert.match(text, /run publish\/update recipes \(`just ship`, `just deploy`, `just update`\) as standalone calls/);
    assert.match(text, /replace inline `tools\.bash` pipelines inside `run_script` with `justfile` recipes called via `exec\(argv=\["just", \.\.\.\]\)/);
    assert.equal(text.includes('Example (edit -> test -> review in 1 call): local_fallback_dispatch({sequential:true,calls:['), true);
    assert.equal(text.includes('argv:["node","--test"]'), true);
    assert.equal(text.includes('tool:"review_changes"'), true);
  }
});

test('detectDevWriteToolCall handles both prefixed and unprefixed fallback_dispatch, single-item calls[], and SSE nudge works', () => {
  for (const name of ['local_fallback_dispatch', 'fallback_dispatch']) {
    assert.equal(
      detectDevWriteToolCall(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name, arguments: { server: 'dev', tool: 'write', arguments: {} } },
      })),
      true,
    );
    assert.equal(
      detectDevWriteToolCall(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name, arguments: { calls: [{ server: 'dev', tool: 'bash', arguments: { command: 'echo 1' } }] } },
      })),
      true,
    );
    assert.equal(
      detectDevWriteToolCall(JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: {
          name,
          arguments: {
            sequential: true,
            calls: [
              { server: 'dev', tool: 'edit', arguments: {} },
              { server: 'dev', tool: 'exec', arguments: { argv: ['just', 'test-fast'] } },
            ],
          },
        },
      })),
      false,
    );
  }
  const sse = 'event: message\ndata: ' + JSON.stringify({
    jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] },
  }) + '\n\n';
  const nudged = appendHintToMcpSsePayload(sse);
  assert.ok(nudged && nudged.includes(SEQUENTIAL_WRITE_NUDGE));
});

test('createConnectorPolicyLoader retains last-good policy on transient non-ENOENT read errors', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-loader-err-'));
  t.after(async () => {
    await fs.chmod(path.join(dir, 'policy.yaml'), 0o600).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'policy.yaml');
  await fs.writeFile(file, 'connector_write_tools: false\n', 'utf8');
  const load = createConnectorPolicyLoader(file);
  assert.equal(load().default.connectorWriteTools, false);

  // If unreadable (e.g. mode 0000 when running non-root), loader retains last-good policy.
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    await fs.chmod(file, 0o000);
    const afterErr = load();
    assert.equal(afterErr.default.connectorWriteTools, false);
    assert.ok(afterErr.warnings.some(w => w.includes('kept last-good policy')));
    await fs.chmod(file, 0o600);

    // Cold-start unreadable file emits a diagnostic warning rather than failing silently.
    const coldFile = path.join(dir, 'cold-unreadable.yaml');
    await fs.writeFile(coldFile, 'connector_write_tools: false\n', 'utf8');
    await fs.chmod(coldFile, 0o000);
    t.after(() => fs.chmod(coldFile, 0o600).catch(() => {}));
    const coldLoad = createConnectorPolicyLoader(coldFile);
    const coldRes = coldLoad();
    assert.ok(coldRes.warnings.some(w => w.includes('policy load error')));
    await fs.chmod(coldFile, 0o600);
  }

  // Malformed YAML hot-reload (even with bare default: or clients: headers) retains last-good policy.
  await fs.writeFile(file, 'clients:\n  - name: gemini\n    connector_write_tools: false\n', 'utf8');
  const afterListErr = load();
  assert.equal(afterListErr.default.connectorWriteTools, false);
  assert.ok(afterListErr.warnings.some(w => w.includes('YAML list syntax')));
  assert.ok(afterListErr.warnings.some(w => w.includes('kept last-good policy')));

  await fs.writeFile(file, 'default:\n  connector_write_tools: flase\n', 'utf8');
  const afterBadBool = load();
  assert.equal(afterBadBool.default.connectorWriteTools, false);
  assert.ok(afterBadBool.warnings.some(w => w.includes('kept last-good policy')));
});

test('urlAllowsLocalFallback rejects preset/tag-filter and appendSchemaHint deduplicates existing hints', () => {
  assert.equal(urlAllowsLocalFallback('/mcp'), true);
  assert.equal(urlAllowsLocalFallback('/mcp?tags=dev,local'), true);
  assert.equal(urlAllowsLocalFallback('/mcp?tags=dev'), false);
  assert.equal(urlAllowsLocalFallback('/mcp?preset=dev-only'), false);
  assert.equal(urlAllowsLocalFallback('/mcp?tag-filter=dev'), false);

  const bareJson = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    result: { isError: true, content: [{ type: 'text', text: 'schema_input_invalid' }] },
  });
  const enriched = appendSchemaHintToMcpJsonPayload(bareJson, 'dev_exec', { includeLocalSchemaHint: false });
  assert.ok(enriched && enriched.includes('Hint: dev/exec takes') && !enriched.includes('local_tool_schema'));
  // Already-enriched payload from LocalToolBroker is never duplicated.
  assert.equal(appendSchemaHintToMcpJsonPayload(enriched, 'dev_exec'), null);
  const sse = `event: message\ndata: ${bareJson}\n\n`;
  const sseEnriched = appendSchemaHintToMcpSsePayload(sse, 'dev_exec');
  assert.ok(sseEnriched && sseEnriched.includes('Hint: dev/exec takes'));
});

test('inspectBlockedConnectorToolCallPrefix blocks name-first >256 KiB payloads and fails open when arguments precedes name', () => {
  const PREFIX_BYTES = 256 * 1024;
  const bigContent = 'a'.repeat(PREFIX_BYTES + 1024);

  const nameFirst = JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'dev_write', arguments: { path: 'big.txt', content: bigContent } },
  }).slice(0, PREFIX_BYTES);
  const blocked = inspectBlockedConnectorToolCallPrefix(nameFirst);
  assert.ok(blocked, 'expected oversized name-first dev_write prefix to be blocked');
  const parsed = JSON.parse(blocked);
  assert.equal(parsed.id, 7);
  assert.equal(parsed.result.isError, true);
  assert.match(parsed.result.content[0].text, /dev_write/);

  const argsFirst = JSON.stringify({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { arguments: { path: 'big.txt', content: bigContent }, name: 'dev_write' },
  }).slice(0, PREFIX_BYTES);
  assert.equal(
    inspectBlockedConnectorToolCallPrefix(argsFirst),
    null,
    'documented >256 KiB tradeoff: fails open when oversized arguments precedes name',
  );
});

test('rpc_budget_seconds parses, resolves per client, and augments the read-only banner', () => {
  const parsed = parseConnectorPolicyYaml([
    'default:',
    '  connector_write_tools: true',
    '  rpc_budget_seconds: 40',
    'clients:',
    '  gemini:',
    '    match: { user_agent: "^Google$" }',
    '    connector_write_tools: false',
    '    rpc_budget_seconds: 25',
    '  invalid_low:',
    '    match: { query_client: low }',
    '    rpc_budget_seconds: 5',
    '  invalid_high:',
    '    match: { query_client: high }',
    '    rpc_budget_seconds: 301',
    '',
  ].join('\n'));
  assert.equal(parsed.default.rpcBudgetSeconds, 40);
  assert.equal(parsed.clients[0].rpcBudgetSeconds, 25);
  assert.equal(parsed.clients[1].rpcBudgetSeconds, undefined);
  assert.equal(parsed.clients[2].rpcBudgetSeconds, undefined);
  assert.equal(parsed.warnings.filter(w => w.includes('rpc_budget_seconds')).length, 2);

  assert.equal(resolveConnectorClientPolicy(parsed, { url: '/mcp', headers: { 'user-agent': 'Google' } }).rpcBudgetSeconds, 25);
  assert.equal(resolveConnectorClientPolicy(parsed, { url: '/mcp', headers: { 'user-agent': 'Claude' } }).rpcBudgetSeconds, 40);
  assert.equal(resolveConnectorClientPolicy(parsed, { url: '/mcp?client=low', headers: {} }).rpcBudgetSeconds, 40);
  assert.equal(resolveConnectorClientPolicy(parseConnectorPolicyYaml(''), { url: '/mcp', headers: {} }).rpcBudgetSeconds, null);

  const bannerWithBudget = bannerTextForPreset('default', { rpcBudgetSeconds: 25 });
  assert.match(bannerWithBudget, /Keep direct exec\/bash under 25s \(longer commands auto-promote to background jobs\)/);
});

test('modular connector hints inject into tools/list (compat-safe), detect local servers & noisy search, and hot-reload', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-conn-hints-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const hintsFile = path.join(dir, 'connector-hints.json');
  const loader = createConnectorHintsLoader(hintsFile);
  assert.deepEqual(loader().explorationNudges, []);

  const payload = {
    version: 1,
    tool_descriptions: {
      dev_search: '[Semantic search? Prefer server="satori" tool="search_codebase".]',
      local_fallback_dispatch: '[Code intelligence: server="satori" -> search_codebase, read_file, call_graph.]',
    },
    exploration_nudges: [{ server: 'satori', tip: '[tip: satori MCP is live]' }],
  };
  await fs.writeFile(hintsFile, JSON.stringify(payload));
  const loaded = loader();
  assert.equal(loaded.explorationNudges.length, 1);

  const toolsMsg = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: [
        { name: 'dev_search', description: 'Search text.', annotations: { readOnlyHint: true } },
        { name: 'local_fallback_dispatch', description: 'Unified router. Common routes: server="dev" -> edit/write.', annotations: { readOnlyHint: false } },
      ],
    },
  };
  const filtered = filterRpcResponseMessage(toolsMsg, null, null, {
    hideWriteTools: true,
    compatAnnotations: true,
    connectorHints: loaded,
  });
  const searchTool = filtered.result.tools.find(item => item.name === 'dev_search');
  const fallbackTool = filtered.result.tools.find(item => item.name === 'local_fallback_dispatch');
  assert.match(searchTool.description, /Prefer server="satori"/);
  assert.match(fallbackTool.description, /Code intelligence: server="satori"/);
  assert.doesNotMatch(fallbackTool.description, /\b(edit|write|exec|bash|Common routes)\b/i);

  assert.deepEqual(
    detectLocalServerCalls(JSON.stringify({ method: 'tools/call', params: { name: 'local_fallback_dispatch', arguments: { calls: [{ server: 'dev', tool: 'read' }, { server: 'satori', tool: 'search_codebase' }] } } })),
    ['dev', 'satori'],
  );
  assert.equal(detectDevExplorationToolCall(JSON.stringify({ method: 'tools/call', params: { name: 'dev_search', arguments: { pattern: 'foo' } } })), 'search');
  assert.equal(detectDevExplorationToolCall(JSON.stringify({ method: 'tools/call', params: { name: 'local_fallback_dispatch', arguments: { server: 'dev', tool: 'read', arguments: { path: 'a.js' } } } })), 'read');
  assert.equal(isNoisyDevSearchResponse('a:1:x\n[showing 80 matches (capped at 80) · narrow]'), true);
  assert.equal(isNoisyDevSearchResponse('a:1:x\n[30 matches]'), true);
  assert.equal(isNoisyDevSearchResponse('a:1:x\n[4 matches]'), false);

  // Disabling the extension empties connector-hints.json and hot-reloads cleanly.
  await fs.writeFile(hintsFile, JSON.stringify({ version: 1, tool_descriptions: {}, exploration_nudges: [] }));
  assert.deepEqual(loader(), normalizeConnectorHints({}));
});
