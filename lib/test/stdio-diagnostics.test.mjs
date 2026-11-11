import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Server } from '../../providers/pi-dev/node_modules/@modelcontextprotocol/server/dist/index.mjs';
import { StdioServerTransport, serveStdio } from '../../providers/pi-dev/node_modules/@modelcontextprotocol/server/dist/stdio.mjs';
import { createStdioErrorReporter, formatStdioDiagnostic } from '../stdio-diagnostics.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('formatStdioDiagnostic produces bounded single-line diagnostics stripped of control bytes', () => {
  const multiline = new Error('bad frame\nsecond line\r\n\x1b[31mred\x00tail');
  const formatted = formatStdioDiagnostic('pi-dev', multiline);
  assert.equal(formatted, 'pi-dev: stdio error: bad frame second line [31mred tail\n');
  assert.equal(formatted.split('\n').length, 2);

  const huge = new Error('x'.repeat(2000));
  const bounded = formatStdioDiagnostic('local-tools', huge);
  assert.ok(bounded.endsWith('...\n'));
  assert.ok(bounded.length <= 'local-tools: stdio error: '.length + 512 + 1);

  assert.equal(formatStdioDiagnostic('host', ''), 'host: stdio error: unknown stdio error\n');
});

test('serveStdio routes malformed inbound stdio frames to stderr reporter without touching stdout', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderrChunks = [];
  const stdoutChunks = [];
  stdout.on('data', chunk => stdoutChunks.push(chunk));
  const fakeStderr = { write: chunk => { stderrChunks.push(String(chunk)); return true; } };

  const transport = new StdioServerTransport(stdin, stdout);
  const handle = serveStdio(
    () => new Server({ name: 'diag-fixture', version: '1.0.0' }, { capabilities: { tools: {} } }),
    { transport, onerror: createStdioErrorReporter('diag-fixture', fakeStderr) },
  );
  try {
    stdin.write('{"not":"jsonrpc"}\n');
    await new Promise(r => setImmediate(r));
    assert.equal(stdoutChunks.length, 0, 'stdout must remain strictly JSON-RPC');
    assert.equal(stderrChunks.length, 1);
    assert.match(stderrChunks[0], /^diag-fixture: stdio error: .+\n$/);
    assert.equal(stderrChunks[0].split('\n').length, 2, 'multiline schema error collapsed to one line');
  } finally {
    stdin.end();
    await handle.close();
  }
});

test('all 7 built-in stdio entrypoints emit bounded single-line stderr diagnostics and keep stdout pure JSON-RPC', async t => {
  const root = mkdtempSync(join(tmpdir(), 'stdio-diag-all-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const innerConfig = join(root, 'inner-mcp.json');
  writeFileSync(innerConfig, JSON.stringify({ version: '1.0.0', mcpServers: {} }), 'utf8');
  const dummyEntry = join(root, 'dummy-1mcp.mjs');
  writeFileSync(dummyEntry, 'process.exit(0);\n', 'utf8');

  const entrypoints = [
    {
      label: 'pi-dev',
      script: 'providers/pi-dev/server.mjs',
      env: {
        MCP_DEV_SHELL_MODE: 'allowlist',
        MCP_DEV_PATH_MODE: 'workspace',
        MCP_DEV_WORKSPACE_ROOT: root,
        MCP_DEV_STATE_DIR: root,
      },
    },
    {
      label: 'host',
      script: 'providers/pi-dev/host-server.mjs',
      env: {},
    },
    {
      label: 'local-tools',
      script: 'providers/local-tools/server.mjs',
      env: {
        MCP_LOCAL_INNER_CONFIG: innerConfig,
        MCP_LOCAL_ONE_MCP_ENTRY: dummyEntry,
      },
    },
    {
      label: 'skill-library',
      script: 'providers/skill-library/server.mjs',
      env: {},
    },
    {
      label: 'terminal',
      script: 'providers/terminal/mcp-server.mjs',
      env: {
        MCP_TERMINAL_SOCKET: join(root, 'terminal.sock'),
      },
    },
    {
      label: 'browser',
      script: 'providers/browser/server.mjs',
      env: {
        MCP_BROWSER_DEFAULT_TARGET: 'linux',
      },
    },
    {
      label: 'browser-fast',
      script: 'providers/browser-fast/server.mjs',
      env: {
        MCP_BROWSER_DEFAULT_TARGET: 'linux',
      },
    },
  ];

  for (const item of entrypoints) {
    const child = spawn(process.execPath, [join(repoRoot, item.script)], {
      env: { ...process.env, ...item.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', chunk => stdoutChunks.push(chunk));
    child.stderr.on('data', chunk => stderrChunks.push(chunk));

    child.stdin.write('{"invalid_envelope":true}\n');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      if (stderrText.includes(`${item.label}: stdio error:`)) break;
      if (child.exitCode !== null) break;
      await new Promise(r => setTimeout(r, 40));
    }
    child.stdin.end();
    await Promise.race([
      once(child, 'exit'),
      new Promise(r => setTimeout(() => { child.kill('SIGTERM'); r(); }, 4000)),
    ]);

    const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    assert.equal(stdoutText, '', `${item.label} must not emit diagnostics on stdout`);
    const lines = stderrText.trim().split('\n');
    assert.equal(lines.length, 1, `${item.label} diagnostic must be a single line, got: ${stderrText}`);
    assert.match(lines[0], new RegExp(`^${item.label}: stdio error: .+`), `${item.label} stderr mismatch`);
  }
});
