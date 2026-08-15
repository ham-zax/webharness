import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '..', 'server.mjs');
const tempDir = prefix => fs.mkdtemp(path.join(os.tmpdir(), prefix));

async function fixture(mode = 'unrestricted', maxBytes = '1048576') {
  const workspaceRoot = await tempDir('pi-dev-workspace-');
  const stateDir = await tempDir('pi-dev-state-');
  const env = {
    MCP_DEV_SHELL_MODE: mode,
    MCP_DEV_WORKSPACE_ROOT: workspaceRoot,
    MCP_DEV_STATE_DIR: stateDir,
    MCP_DEV_MAX_OUTPUT_BYTES: maxBytes
  };
  return { workspaceRoot, stateDir, env };
}

async function withClient(env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: { ...process.env, ...env },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'pi-dev-test', version: '1.0.0' });
  await client.connect(transport);
  try { return await fn(client); }
  finally { await client.close(); }
}

function textOf(result) {
  assert.equal(result.structuredContent, undefined);
  assert.ok(result.content.every(block => block.type === 'text'));
  return result.content.map(block => block.text).join('\n');
}

test('trusted-dev exposes four tools and minimal schemas', async () => {
  const { env } = await fixture('unrestricted');
  await withClient(env, async client => {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(x => x.name).sort(), ['bash', 'edit', 'read', 'write']);
    const bash = listed.tools.find(x => x.name === 'bash');
    assert.deepEqual(Object.keys(bash.inputSchema.properties).sort(), ['command', 'cwd', 'timeout_seconds']);
    const read = listed.tools.find(x => x.name === 'read');
    assert.deepEqual(Object.keys(read.inputSchema.properties).sort(), ['limit', 'offset', 'path']);
    for (const tool of listed.tools) {
      assert.equal(JSON.stringify(tool.inputSchema).includes('max_output_bytes'), false);
      assert.equal(JSON.stringify(tool.inputSchema).includes('workspaceRoot'), false);
    }
  });
});

test('restricted omits unrestricted Pi bash', async () => {
  const { env } = await fixture('disabled');
  await withClient(env, async client => {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(x => x.name).sort(), ['edit', 'read', 'write']);
  });
});

test('read returns plain text and rejects absolute paths', async () => {
  const { workspaceRoot, env } = await fixture();
  await fs.writeFile(path.join(workspaceRoot, 'x.txt'), 'alpha\nbeta\n');
  await withClient(env, async client => {
    const ok = await client.callTool({ name: 'read', arguments: { path: 'x.txt', offset: 1, limit: 1 } });
    assert.match(textOf(ok), /alpha/);
    const denied = await client.callTool({ name: 'read', arguments: { path: '/etc/passwd' } });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /relative/);
  });
});

test('edit returns one diff artifact without generic success prose', async () => {
  const { workspaceRoot, env } = await fixture();
  await fs.writeFile(path.join(workspaceRoot, 'x.txt'), 'alpha\nbeta\n');
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'edit',
      arguments: { path: 'x.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }
    });
    const text = textOf(result);
    assert.match(text, /^x\.txt\n/);
    assert.match(text, /ALPHA/);
    assert.doesNotMatch(text, /Successfully replaced|Done!/);
  });
});

test('write returns a short acknowledgement', async () => {
  const { workspaceRoot, env } = await fixture();
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'write',
      arguments: { path: 'new.txt', content: 'new\n' }
    });
    assert.equal(textOf(result), 'Created new.txt');
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'new.txt'), 'utf8'), 'new\n');
  });
});

test('bash returns terminal text rather than JSON record', async () => {
  const { workspaceRoot, env } = await fixture();
  await fs.mkdir(path.join(workspaceRoot, 'repo'));
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'bash',
      arguments: { cwd: 'repo', command: "printf ' M src/foo.ts\\n'; exit 1" }
    });
    const text = textOf(result);
    assert.equal(text, ' M src/foo.ts\n[exit 1]');
    assert.throws(() => JSON.parse(text));
  });
});

test('bash cwd parameter rejects absolute and traversal values', async () => {
  const { env } = await fixture();
  await withClient(env, async client => {
    for (const cwd of ['/tmp', '../outside']) {
      const result = await client.callTool({
        name: 'bash',
        arguments: { cwd, command: 'pwd' }
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /relative|\.\./);
    }
  });
});

test('trusted-dev command body remains unrestricted outside workspace', async () => {
  const { env } = await fixture();
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'bash',
      arguments: { command: "head -1 /etc/os-release" }
    });
    assert.match(textOf(result), /^(NAME|PRETTY_NAME)=/);
  });
});

test('deployment output limit is applied without appearing in schema', async () => {
  const { env } = await fixture('unrestricted', '1024');
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'bash',
      arguments: { command: `node -e "process.stdout.write('x'.repeat(5000))"` }
    });
    const text = textOf(result);
    assert.match(text, /\[truncated · full: .*\]/);
    assert.ok(Buffer.byteLength(text) < 1300);
  });
});

test('edit diagnostics keep model-facing paths workspace-relative', async () => {
  const { workspaceRoot, env } = await fixture();
  await fs.writeFile(path.join(workspaceRoot, 'x.txt'), 'abcdef\n');
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'edit',
      arguments: {
        path: 'x.txt',
        edits: [
          { oldText: 'abc', newText: 'ABC' },
          { oldText: 'bcd', newText: 'BCD' }
        ]
      }
    });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /overlap.*x\.txt/i);
    assert.doesNotMatch(text, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
