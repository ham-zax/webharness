import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { createHttpDiagnosticLog } from '../http-diagnostics.mjs';
import { createConnectorHintsLoader, parseConnectorPolicyYaml } from '../connector-policy.mjs';
import {
  createResponseTelemetryObserver,
  extractRequestTelemetry,
  inferRepoLabel,
  redactSensitiveText,
  summarizeRouteCall,
} from '../telemetry.mjs';
import { createWakeProxy } from '../wake-proxy.mjs';
import {
  analyzeTelemetryRecords,
  loadTelemetryRecords,
  parseSinceMs,
  renderTelemetryReport,
} from '../../../scripts/analyze-telemetry.mjs';

const request = (port, urlPath = '/mcp', options = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, ...options }, res => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end(options.body);
});

test('approval tickets are removed from command and form summaries before truncation', () => {
  const ticket = 'A'.repeat(43);
  for (const command of [
    'curl https://bridge.test/admin/oauth/owner-link?ticket=' + ticket,
    'curl --data-urlencode ticket="' + ticket + '" https://bridge.test/admin/oauth/owner-link',
    'curl https://bridge.test/path?next=owner-link%3Fticket%3D' + ticket,
    'curl --data "action=approve&ticket=' + ticket + '" https://bridge.test/admin/oauth/owner-link',
  ]) {
    for (const summary of [
      summarizeRouteCall('dev', 'exec', { argv: command.split(' ') }),
      summarizeRouteCall('dev', 'bash', { command }),
      summarizeRouteCall('terminal', 'terminal_write', { command }),
    ]) {
      assert.match(summary.cmd, /ticket=\[REDACTED\]/);
      assert.ok(!summary.cmd.includes(ticket));
    }
  }
});

test('redactSensitiveText scrubs keys, tokens, URL credentials, env secrets, and JWTs', () => {
  const dirty = [
    'VOYAGEAI_API_KEY=pa-supersecretkey123456',
    'curl -H "Authorization: Bearer abcdef1234567890" https://alice:mysecretpass@api.example.com/v1',
    '--api-key sk-proj-1234567890abcdef',
    'GH=ghp_1234567890abcdefghij',
  ].join(' ');
  const clean = redactSensitiveText(dirty, 400);
  assert.doesNotMatch(clean, /supersecretkey|abcdef1234567890|mysecretpass|sk-proj-|ghp_1234/);
  assert.match(clean, /VOYAGEAI_API_KEY=\[REDACTED\]/);
  assert.match(clean, /https:\/\/alice:\[REDACTED\]@api\.example\.com/);
  assert.match(clean, /\[REDACTED_KEY\]/);
});

test('extractRequestTelemetry summarizes routes and repos while excluding raw file contents and secrets', () => {
  assert.equal(inferRepoLabel('/home/hamza/repo/webharness/lib/bridge/wake-proxy.mjs'), 'webharness');
  assert.equal(inferRepoLabel('/home/hamza/.local/state/claive/22ef14020a8e/worktree/src/a.ts'), 'claive:22ef1402');

  const batchPayload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'local_fallback_dispatch',
      arguments: {
        sequential: true,
        calls: [
          {
            server: 'dev',
            tool: 'write',
            arguments: { path: '/home/hamza/repo/webharness/tmp.txt', content: 'TOP_SECRET_FILE_BODY' },
          },
          {
            server: 'dev',
            tool: 'edit',
            arguments: {
              targets: [{ path: '/home/hamza/repo/webharness/a.mjs', edits: [{ oldText: 'SECRET_OLD', newText: 'SECRET_NEW' }] }],
            },
          },
          {
            server: 'dev',
            tool: 'exec',
            arguments: { argv: ['just', 'test-fast', '--token', 'secret-tok-value'], cwd: '/home/hamza/repo/webharness' },
          },
          {
            server: 'satori',
            tool: 'search_codebase',
            arguments: { path: '/home/hamza/repo/satori', query: 'auto index budget', alt_terms: ['evaluateAutoIndexPolicy'], limit: 5 },
          },
          {
            server: 'terminal',
            tool: 'terminal_send',
            arguments: { name: 'sudo-shell', text: 'MY_SUDO_PASSWORD\n' },
          },
        ],
      },
    },
  });

  const info = extractRequestTelemetry(batchPayload);
  assert.equal(info.rpc_method, 'tools/call');
  assert.equal(info.outer_tool, 'local_fallback_dispatch');
  assert.equal(info.batch_size, 5);
  assert.equal(info.batch_mode, 'sequential');
  assert.deepEqual(info.repos, ['webharness', 'satori']);
  assert.equal(info.routes[0].content_bytes, Buffer.byteLength('TOP_SECRET_FILE_BODY'));
  assert.equal(info.routes[1].files, 1);
  assert.equal(info.routes[1].edits, 1);
  assert.equal(info.routes[2].bin, 'just');
  assert.match(info.routes[2].cmd, /--token \[REDACTED\]/);
  assert.equal(info.routes[3].alt_terms, 1);
  assert.equal(info.routes[4].target, 'sudo-shell');
  const serialized = JSON.stringify(info);
  assert.doesNotMatch(serialized, /TOP_SECRET_FILE_BODY|SECRET_OLD|SECRET_NEW|secret-tok-value|MY_SUDO_PASSWORD/);
});

test('createResponseTelemetryObserver detects errors, exits, truncations, matches, and gzip payloads', () => {
  const obs1 = createResponseTelemetryObserver({ maxSnippetBytes: 128 });
  const bigMid = 'x'.repeat(2000);
  const body = `{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"${bigMid}\\n[truncated · 9000 bytes total]\\n[exit 2 · 1.4s]"}]}}`;
  obs1.observe(Buffer.from(body));
  const res1 = obs1.finalize();
  assert.equal(res1.res_bytes, Buffer.byteLength(body));
  assert.equal(res1.is_error, true);
  assert.equal(res1.exit_code, 2);
  assert.equal(res1.truncated, true);

  const obs2 = createResponseTelemetryObserver();
  const gzPayload = zlib.gzipSync(Buffer.from(JSON.stringify({
    jsonrpc: '2.0',
    result: { content: [{ type: 'text', text: '{"status":"indexing","mode":"auto_indexing"}' }] },
  })));
  obs2.observe(gzPayload);
  const res2 = obs2.finalize({ contentEncoding: 'gzip', rpcMethod: 'tools/call' });
  assert.equal(res2.satori_auto_indexing, true);
  assert.ok(res2.res_bytes > 0);

  // Normal file read or tools/list mentioning EISDIR/ENOENT must not set error_code.
  const obs3 = createResponseTelemetryObserver();
  obs3.observe(Buffer.from('{"jsonrpc":"2.0","result":{"tools":[{"name":"dev_read","description":"Refused with EISDIR"}]}}'));
  const res3 = obs3.finalize({ rpcMethod: 'tools/list' });
  assert.equal(res3.is_error, undefined);
  assert.equal(res3.error_code, undefined);

  const obs4 = createResponseTelemetryObserver();
  obs4.observe(Buffer.from('{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"if (err.code === ENOENT) return null;"}]}}'));
  const res4 = obs4.finalize({ rpcMethod: 'tools/call' });
  assert.equal(res4.is_error, undefined);
  assert.equal(res4.error_code, undefined);
});

test('wake-proxy emits redacted end-to-end telemetry to telemetry.jsonl and analyzer summarizes issues & context', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-telemetry-e2e-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const telemetryPath = path.join(dir, 'telemetry.jsonl');
  const hintsPath = path.join(dir, 'connector-hints.json');
  await fs.writeFile(hintsPath, JSON.stringify({
    version: 1,
    tool_descriptions: { dev_search: '[Prefer satori]' },
    exploration_nudges: [{ server: 'satori', tip: '[tip: satori MCP is live]' }],
  }));

  const policy = parseConnectorPolicyYaml([
    'clients:',
    '  gemini:',
    '    match: { user_agent: "^Google$" }',
    '    connector_write_tools: false',
    '    compat_annotations: true',
    '    banner: none',
    '    rpc_budget_seconds: 25',
    '',
  ].join('\n'));

  const backend = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url?.startsWith('/oauth')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      const rpc = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      const name = rpc.params?.name;
      if (name === 'dev_search') {
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'text', text: `${'match:1:x\n'.repeat(40)}[showing 80 matches (capped at 80) · narrow]` }] },
        }));
        return;
      }
      if (name === 'local_fallback_dispatch' && rpc.params?.arguments?.server === 'dev') {
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'text', text: 'FAIL\n[exit 1 · 0.2s]' }] },
        }));
        return;
      }
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { content: [{ type: 'text', text: '{"status":"ok","results":[]}' }] },
      }));
    });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const backendPort = backend.address().port;
  await new Promise(resolve => backend.close(resolve));

  const telemetryLog = createHttpDiagnosticLog(telemetryPath, { maxBytes: 1024 * 1024, maxFiles: 2, maxRecordBytes: 16384 });
  const proxy = createWakeProxy({
    port: 0,
    backendPort,
    idleMs: 10_000,
    startupMs: 2_000,
    requireAuth: false,
    connectorPolicy: () => policy,
    connectorHints: createConnectorHintsLoader(hintsPath),
    onTelemetry: telemetryLog.log,
    onDiagnostic: () => {},
    startBackend: async () => new Promise(resolve => backend.listen(backendPort, '127.0.0.1', resolve)),
    stopBackend: async () => new Promise(resolve => backend.close(resolve)),
  });
  await proxy.listen();
  t.after(async () => {
    await proxy.close();
    await telemetryLog.flush();
    backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
  });
  const port = proxy.server.address().port;

  // 1. OAuth request must NOT appear in telemetry.jsonl.
  await request(port, '/oauth?token=oauth-secret', { method: 'POST', body: 'grant=secret' });

  // 2. Noisy dev_search from Gemini triggers explore_satori nudge + truncated + search_matches=80.
  await request(port, '/mcp', {
    method: 'POST',
    headers: { 'user-agent': 'Google', authorization: 'Bearer test-gem', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'dev_search', arguments: { path: '/home/hamza/repo/webharness', pattern: 'server' } },
    }),
  });

  // 3. Same session adopts satori.
  await request(port, '/mcp', {
    method: 'POST',
    headers: { 'user-agent': 'Google', authorization: 'Bearer test-gem', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'local_fallback_dispatch',
        arguments: { server: 'satori', tool: 'search_codebase', arguments: { path: '/home/hamza/repo/satori', query: 'budget' } },
      },
    }),
  });

  // 4. Failing dev/exec command with secret flag gets redacted + exit_code=1 logged.
  await request(port, '/mcp', {
    method: 'POST',
    headers: { 'user-agent': 'Google', authorization: 'Bearer test-gem', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'local_fallback_dispatch',
        arguments: { server: 'dev', tool: 'exec', arguments: { argv: ['just', 'test-fast', '--secret', 'super-secret-val'], cwd: '/home/hamza/repo/webharness' } },
      },
    }),
  });

  // 5. WebSession adapter request is also captured in telemetry.jsonl without connector policy interference.
  await request(port, '/mcp', {
    method: 'POST',
    headers: { 'user-agent': 'websession-adapter/1.0', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'dev_read', arguments: { path: '/home/hamza/repo/webharness/justfile' } },
    }),
  });

  await telemetryLog.flush();
  const rawFile = await fs.readFile(telemetryPath, 'utf8');
  assert.doesNotMatch(rawFile, /oauth-secret|grant=secret|super-secret-val/);

  const { records } = await loadTelemetryRecords(telemetryPath, { sinceMs: parseSinceMs('24h') });
  assert.equal(records.length, 4);
  const report = analyzeTelemetryRecords(records);
  assert.equal(report.summary.tool_calls, 4);
  assert.equal(report.summary.error_calls, 1);
  assert.equal(report.summary.truncated_calls, 1);
  assert.equal(report.code_intelligence.dev_search_calls, 1);
  assert.equal(report.code_intelligence.noisy_dev_searches, 1);
  assert.equal(report.code_intelligence.satori_calls, 1);
  assert.equal(report.code_intelligence.explore_satori_nudges, 1);
  assert.equal(report.code_intelligence.post_nudge_satori_sessions, 1);
  assert.equal(report.failing_commands.length, 1);
  assert.match(report.failing_commands[0].cmd, /just test-fast --secret \[REDACTED\]/);
  assert.ok(report.clients.some(c => c.client === 'gemini' && c.calls === 3));
  assert.ok(report.clients.some(c => c.client === 'websession' && c.calls === 1));

  const textReport = renderTelemetryReport(report, { since: '24h' });
  assert.match(textReport, /== WebHarness Telemetry/);
  assert.match(textReport, /post-nudge adoption=1\/1 sessions/);
  assert.match(textReport, /\[exit=1\] \[webharness\] just test-fast --secret \[REDACTED\]/);
});
