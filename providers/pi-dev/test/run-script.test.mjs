import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { renderScriptText } from '../render.mjs';
import { runScript, scriptToolTable, truncateScriptText, withDefaultCwd } from '../run-script.mjs';
import { SCRIPT_EXCLUDED_TOOLS } from '../script-limits.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '..', 'server.mjs');

const tempDir = prefix => fs.mkdtemp(path.join(os.tmpdir(), prefix));

function textResult(text, extra = {}) {
  return { content: [{ type: 'text', text }], ...extra };
}

function scriptFixture(handlers, overrides = {}) {
  return {
    script: '',
    handlers: new Map(Object.entries(handlers)),
    configs: new Map(),
    signal: undefined,
    callId: 'test-call',
    stateDir: overrides.stateDir,
    spoolTtlSeconds: 3600,
    maxSpoolBytes: 1024 * 1024,
    maxSpoolTotalBytes: 4 * 1024 * 1024,
    ...overrides,
  };
}

test('tool table excludes run_script, wait and import_file', () => {
  const handlers = new Map([
    ['read', async () => textResult('r')],
    ['edit', async () => textResult('e')],
    ['run_script', async () => textResult('s')],
    ['wait', async () => textResult('w')],
    ['import_file', async () => textResult('i')],
  ]);
  const table = scriptToolTable({
    handlers,
    configs: new Map(),
    gate: { run: (_readOnly, fn) => fn() },
    limits: { calls: 0, maxCalls: 32, callId: 'x' },
  });
  assert.deepEqual(table.map(tool => tool.name), ['read', 'edit']);
  for (const name of ['run_script', 'wait', 'import_file']) {
    assert.ok(SCRIPT_EXCLUDED_TOOLS.has(name));
  }
});

test('a script cannot reach an excluded tool', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  const result = await runScript(scriptFixture({
    read: async () => textResult('ok'),
  }, {
    stateDir,
    script: 'await tools.run_script({ script: "return 1" });',
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error_kind, 'script');
  assert.match(result.error_message, /tools\.run_script does not exist/);
});

test('max_calls rejects the next call without dispatching it', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  let dispatched = 0;
  const result = await runScript(scriptFixture({
    read: async () => { dispatched += 1; return textResult('ok'); },
  }, {
    stateDir,
    max_calls: 3,
    script: `
      for (let i = 0; i < 10; i += 1) {
        try { await tools.read({}); } catch (error) { text(error.message); }
      }
      return 'done';
    `,
  }));
  assert.equal(result.status, 'completed');
  assert.equal(dispatched, 3);
  assert.match(result.output, /SCRIPT_CALL_LIMIT/);
});

test('nested calls enforce the same input schema as tools/call', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  let dispatched = 0;
  const result = await runScript({
    ...scriptFixture({
      bash: async () => { dispatched += 1; return textResult('ok'); },
    }, { stateDir }),
    configs: new Map([['bash', {
      inputSchema: z.object({
        command: z.string().min(1),
        timeout_seconds: z.number().positive().max(300).optional(),
      }),
    }]]),
    script: `
      const outcomes = [];
      for (const args of [{ command: 'ls', timeout_seconds: 9999 }, { command: '' }, null]) {
        try { await tools.bash(args); outcomes.push('accepted'); }
        catch (error) { outcomes.push(error.message.split(':')[0]); }
      }
      return outcomes;
    `,
  });
  assert.equal(result.status, 'completed');
  assert.equal(dispatched, 0);
  assert.equal(result.output, '["INVALID_ARGUMENTS","INVALID_ARGUMENTS","INVALID_ARGUMENTS"]');
});

test('nested calls dispatch the parsed value, not the raw arguments', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  let received;
  const result = await runScript({
    ...scriptFixture({
      read: async args => { received = args; return textResult('ok'); },
    }, { stateDir }),
    configs: new Map([['read', {
      inputSchema: z.object({ path: z.string().optional(), limit: z.number().int().positive().optional() }),
    }]]),
    script: `await tools.read({ path: 'a.txt', bogus: 1 });`,
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(received, { path: 'a.txt' });
});

test('withDefaultCwd seeds the base directory into nested call arguments', () => {
  const base = '/work/project';
  assert.deepEqual(withDefaultCwd('bash', { command: 'pwd' }, base), { command: 'pwd', cwd: base });
  assert.deepEqual(withDefaultCwd('bash', { command: 'pwd', cwd: '/elsewhere' }, base), { command: 'pwd', cwd: '/elsewhere' });
  assert.deepEqual(withDefaultCwd('read', { path: 'a.txt' }, base), { path: '/work/project/a.txt' });
  assert.deepEqual(withDefaultCwd('read', { path: '/etc/hosts' }, base), { path: '/etc/hosts' });
  assert.deepEqual(withDefaultCwd('read', { path: '~/notes.txt' }, base), { path: '~/notes.txt' });
  assert.deepEqual(withDefaultCwd('read', { targets: [{ path: 'a.txt' }, { path: '/b.txt' }] }, base), {
    targets: [{ path: '/work/project/a.txt' }, { path: '/b.txt' }],
  });
  assert.deepEqual(withDefaultCwd('search', { pattern: 'x' }, base), { pattern: 'x', path: base });
  assert.deepEqual(withDefaultCwd('list_directory', { path: 'src' }, base), { path: '/work/project/src' });
  // A tool with no path or cwd argument is left untouched, and so is a call with no base.
  assert.deepEqual(withDefaultCwd('edit', { targets: [{ path: 'a.txt', edits: [] }] }, base), {
    targets: [{ path: '/work/project/a.txt', edits: [] }],
  });
  assert.deepEqual(withDefaultCwd('bash', { command: 'pwd' }, undefined), { command: 'pwd' });
  // Workspace mode passes a workspace-relative base, which must stay relative.
  assert.deepEqual(withDefaultCwd('read', { path: 'a.txt' }, 'sub/dir'), { path: 'sub/dir/a.txt' });
});

test('a small timeout_ms bounds the wait for a free slot', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  const handlers = {
    read: async (_args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  };
  const blocker = () => runScript({
    ...scriptFixture(handlers, { stateDir }),
    timeout_ms: 1500,
    script: 'await tools.read({});',
  });
  const first = blocker();
  const second = blocker();
  const started = Date.now();
  const third = await runScript({
    ...scriptFixture(handlers, { stateDir }),
    timeout_ms: 300,
    script: 'return 1;',
  });
  const wall = Date.now() - started;
  assert.equal(third.status, 'failed');
  assert.equal(third.error_kind, 'timeout');
  assert.match(third.error_message, /while waiting for a free script slot/);
  assert.ok(wall < 1200, `slot wait ignored timeout_ms: ${wall}ms`);
  await Promise.allSettled([first, second]);
});

test('read-only calls overlap and a mutation waits for them', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  let activeReads = 0;
  let maxActiveReads = 0;
  let readsAtMutation = -1;
  const result = await runScript(scriptFixture({
    read: async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise(resolve => setTimeout(resolve, 25));
      activeReads -= 1;
      return textResult('ok');
    },
    edit: async () => {
      readsAtMutation = activeReads;
      return textResult('ok');
    },
  }, {
    stateDir,
    script: `
      await Promise.all([tools.read({}), tools.read({}), tools.read({})]);
      await tools.edit({});
      return 'done';
    `,
  }));
  assert.equal(result.status, 'completed');
  assert.ok(maxActiveReads > 1, `expected overlapping reads, saw ${maxActiveReads}`);
  assert.equal(readsAtMutation, 0);
});

test('timeout fails the script and keeps partial output', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  const result = await runScript(scriptFixture({
    read: async (_args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }, {
    stateDir,
    timeout_ms: 250,
    script: `text('before'); await tools.read({}); text('after');`,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error_kind, 'timeout');
  assert.equal(result.output, 'before');
  assert.deepEqual(result.calls.map(call => call.status), ['cancelled']);
});

test('an aborted caller cancels the script', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const result = await runScript(scriptFixture({
    read: async (_args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }, {
    stateDir,
    signal: controller.signal,
    timeout_ms: 30_000,
    script: `await tools.read({});`,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error_kind, 'aborted');
});

test('a failed script keeps the calls that already ran', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  const result = await runScript(scriptFixture({
    read: async () => textResult('ok'),
    edit: async () => ({ isError: true, content: [{ type: 'text', text: 'EDIT_ANCHOR_NOT_FOUND: no unique match' }] }),
  }, {
    stateDir,
    script: `await tools.read({}); await tools.edit({});`,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error_kind, 'script');
  assert.match(result.error_message, /EDIT_ANCHOR_NOT_FOUND/);
  assert.deepEqual(result.calls.map(call => `${call.name}:${call.status}`), ['read:ok', 'edit:error']);
  const rendered = renderScriptText(result);
  assert.match(rendered, /^Script failed/);
  assert.match(rendered, /- read ok \d+ms/);
  assert.match(rendered, /- edit error \d+ms/);
  assert.match(rendered, /completed calls are not rolled back/);
});

test('structuredContent reaches the script and text is the fallback', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  const result = await runScript(scriptFixture({
    write: async () => textResult('Created a.txt', { structuredContent: { bytes_written: 3 } }),
    read: async () => textResult('line one'),
  }, {
    stateDir,
    script: `
      const written = await tools.write({});
      const read = await tools.read({});
      return { written, read };
    `,
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.output, '{"written":{"bytes_written":3},"read":"line one"}');
});

test('output over the cap is truncated and retained on disk', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  const result = await runScript(scriptFixture({
    read: async () => textResult('ok'),
  }, {
    stateDir,
    maxOutputBytes: 1024,
    script: `text('HEAD' + 'x'.repeat(4000) + 'TAIL');`,
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.truncated, true);
  assert.ok(result.output_bytes > 4000);
  assert.match(result.text, /^Script completed/);
  assert.match(result.text, /HEAD/);
  assert.match(result.text, /TAIL/);
  assert.match(result.text, /bytes omitted/);
  assert.match(result.text, /saved on remote host: /);
  const retained = await fs.readFile(result.full_output_path, 'utf8');
  assert.equal(Buffer.byteLength(retained, 'utf8'), result.output_bytes);
  assert.match(retained, /^Script completed/);
  assert.match(retained, /HEAD/);
  assert.match(retained, /TAIL$/);
  assert.equal((await fs.stat(result.full_output_path)).mode & 0o777, 0o600);
});

test('a generated error message is bounded by the output cap', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  const result = await runScript(scriptFixture({
    read: async () => textResult('ok'),
  }, {
    stateDir,
    maxOutputBytes: 1024,
    script: `throw new Error('E'.repeat(1000000));`,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, 'utf8') < 2048, `text was ${Buffer.byteLength(result.text, 'utf8')} bytes`);
  assert.match(result.text, /bytes omitted/);
  assert.equal(Buffer.byteLength(await fs.readFile(result.full_output_path, 'utf8'), 'utf8'), result.output_bytes);
});

test('a long call list is bounded by the output cap', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  const result = await runScript(scriptFixture({
    read: async () => textResult('ok'),
  }, {
    stateDir,
    maxOutputBytes: 1024,
    max_calls: 1,
    script: `
      for (let i = 0; i < 2000; i += 1) {
        try { await tools.read({}); } catch { /* counted by the sandbox, not dispatched */ }
      }
      return 'done';
    `,
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, 'utf8') < 2048, `text was ${Buffer.byteLength(result.text, 'utf8')} bytes`);
  assert.match(result.text, /bytes omitted/);
});

test('a truncated result survives a state directory that does not exist yet', async () => {
  const parent = await tempDir('pi-dev-script-');
  const stateDir = path.join(parent, 'nested', 'state');
  const result = await runScript(scriptFixture({
    read: async () => textResult('ok'),
  }, {
    stateDir,
    maxOutputBytes: 1024,
    script: `text('HEAD' + 'x'.repeat(4000) + 'TAIL');`,
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.truncated, true);
  assert.ok(result.full_output_path.startsWith(stateDir));
  assert.match(await fs.readFile(result.full_output_path, 'utf8'), /HEAD/);
  assert.equal((await fs.stat(stateDir)).mode & 0o777, 0o700);
});

test('a queued call does not dispatch after the script is cancelled', async () => {
  const stateDir = await tempDir('pi-dev-script-');
  const dispatched = [];
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const result = await runScript(scriptFixture({
    read: async (_args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    edit: async () => { dispatched.push('edit'); return textResult('ok'); },
  }, {
    stateDir,
    signal: controller.signal,
    timeout_ms: 30_000,
    script: `
      const first = tools.read({});
      const second = tools.edit({});
      await Promise.allSettled([first, second]);
    `,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error_kind, 'aborted');
  assert.deepEqual(dispatched, []);
});

test('truncateScriptText keeps UTF-8 boundaries intact', () => {
  const text = `${'é'.repeat(600)}${'ü'.repeat(600)}`;
  const bounded = truncateScriptText(text, 200);
  assert.equal(bounded.truncated, true);
  assert.ok(!bounded.text.includes('\uFFFD'));
  assert.ok(Buffer.byteLength(bounded.text, 'utf8') <= 200 + 64);
});

test('renderScriptText reports a completed script without a rollback note when nothing ran', () => {
  const rendered = renderScriptText({
    status: 'completed',
    error_kind: null,
    error_message: null,
    duration_ms: 1200,
    calls: [],
    call_count: 0,
    call_limit: 32,
    output: 'hello',
    output_bytes: 5,
    truncated: false,
    full_output_path: null,
  });
  assert.equal(rendered, 'Script completed · 1.2s\nOutput:\nhello');
});

test('renderScriptText counts rejected calls in the header', () => {
  // Every call was rejected by the schema, so nothing was dispatched and call_count is 0
  // while the call list is not empty. The header must still report the list it prints.
  const rendered = renderScriptText({
    status: 'completed',
    error_kind: null,
    error_message: null,
    duration_ms: 100,
    calls: [
      { name: 'exec', status: 'error', duration_ms: 0 },
      { name: 'exec', status: 'error', duration_ms: 0 },
    ],
    call_count: 0,
    call_limit: 32,
    output: '',
    output_bytes: 0,
    truncated: false,
    full_output_path: null,
  });
  assert.match(rendered, /^Script completed · 0\.1s · 2 calls\nCalls:/);
});

test('renderScriptText labels a timeout distinctly from a script error', () => {
  const rendered = renderScriptText({
    status: 'failed',
    error_kind: 'timeout',
    error_message: 'Execution timed out after 250 ms',
    duration_ms: 260,
    calls: [{ name: 'read', status: 'cancelled', duration_ms: 40 }],
    call_count: 1,
    call_limit: 32,
    output: '',
    output_bytes: 0,
    truncated: false,
    full_output_path: null,
  });
  assert.match(rendered, /Script error:\ntimeout: Execution timed out/);
});

test('renderScriptText omits the rollback note for a read-only script', () => {
  const rendered = renderScriptText({
    status: 'completed',
    error_kind: null,
    error_message: null,
    duration_ms: 900,
    calls: [{ name: 'read', status: 'ok', duration_ms: 20 }],
    call_count: 1,
    call_limit: 32,
    output: 'x',
    output_bytes: 1,
    truncated: false,
    full_output_path: null,
  });
  assert.doesNotMatch(rendered, /not rolled back/);
});

async function withClient(env, fn) {
  const cleanParentEnv = { ...process.env };
  for (const key of Object.keys(cleanParentEnv)) {
    if (key.startsWith('MCP_') || key.startsWith('BRIDGE_')) delete cleanParentEnv[key];
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: { ...cleanParentEnv, ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'pi-dev-run-script-test', version: '1.0.0' });
  await client.connect(transport);
  try { return await fn(client); }
  finally { await client.close(); }
}

async function fixture() {
  const workspaceRoot = await tempDir('pi-dev-script-workspace-');
  const stateDir = await tempDir('pi-dev-script-state-');
  return {
    workspaceRoot,
    stateDir,
    env: {
      MCP_DEV_SHELL_MODE: 'unrestricted',
      MCP_DEV_PATH_MODE: 'workspace',
      MCP_DEV_WORKSPACE_ROOT: workspaceRoot,
      MCP_DEV_STATE_DIR: stateDir,
      MCP_DEV_MAX_OUTPUT_BYTES: '1048576',
    },
  };
}

test('run_script is advertised as a mutating Dev tool', async () => {
  const { env } = await fixture();
  await withClient(env, async client => {
    const { tools } = await client.listTools();
    const tool = tools.find(item => item.name === 'run_script');
    assert.ok(tool, 'run_script must be listed');
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, true);
    assert.equal(tool.annotations.idempotentHint, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['script', 'cwd', 'timeout_ms', 'max_calls']);
    assert.deepEqual(tool.inputSchema.required, ['script']);
    assert.match(tool.description, /read, list_directory, search, edit, write, exec, bash/);
    assert.doesNotMatch(tool.description, /tools\.run_script/);
  });
});

test('a script reads, edits and verifies in one call', async () => {
  const { workspaceRoot, env } = await fixture();
  await fs.writeFile(path.join(workspaceRoot, 'a.txt'), 'alpha\nbeta\n');
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'run_script',
      arguments: {
        script: `
          const before = await tools.read({ path: 'a.txt' });
          text('before: ' + before.trim());
          await tools.edit({ targets: [{ path: 'a.txt', edits: [{ oldText: 'beta', newText: 'gamma' }] }] });
          const after = await tools.read({ path: 'a.txt' });
          return after.trim();
        `,
      },
    });
    assert.notEqual(result.isError, true);
    const text = result.content.map(block => block.text).join('\n');
    assert.match(text, /^Script completed/);
    assert.match(text, /- read ok \d+ms/);
    assert.match(text, /- edit ok \d+ms/);
    assert.match(text, /before: alpha/);
    assert.match(text, /alpha\ngamma/);
    assert.match(text, /completed calls are not rolled back/);
  });
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf8'), 'alpha\ngamma\n');
});

test('run_script cwd is the base directory for nested calls', async () => {
  const defaultCwd = await tempDir('pi-dev-script-user-');
  const projectDir = path.join(defaultCwd, 'project');
  await fs.mkdir(projectDir);
  await fs.writeFile(path.join(projectDir, 'a.txt'), 'alpha\n');
  const stateDir = await tempDir('pi-dev-script-state-');
  const env = {
    MCP_DEV_SHELL_MODE: 'unrestricted',
    MCP_DEV_PATH_MODE: 'user',
    MCP_DEV_DEFAULT_CWD: defaultCwd,
    MCP_DEV_STATE_DIR: stateDir,
    MCP_DEV_MAX_OUTPUT_BYTES: '1048576',
    MCP_DEV_TERMINAL_SOCKET: path.join(stateDir, 'wsl-agent-terminal.sock'),
  };
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'run_script',
      arguments: {
        cwd: 'project',
        script: `
          const pwd = await tools.bash({ command: 'pwd' });
          text('pwd: ' + pwd.split('\\n')[0]);
          const file = await tools.read({ path: 'a.txt' });
          text('file: ' + file.trim());
        `,
      },
    });
    assert.notEqual(result.isError, true);
    const text = result.content.map(block => block.text).join('\n');
    assert.match(text, /^Script completed/);
    assert.ok(text.includes(`pwd: ${projectDir}`), text);
    assert.match(text, /file: alpha/);
  });
});

test('a failing script surfaces isError and keeps partial output', async () => {
  const { workspaceRoot, env } = await fixture();
  await fs.writeFile(path.join(workspaceRoot, 'a.txt'), 'alpha\n');
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'run_script',
      arguments: {
        script: `
          text('partial');
          await tools.edit({ targets: [{ path: 'a.txt', edits: [{ oldText: 'missing', newText: 'x' }] }] });
        `,
      },
    });
    assert.equal(result.isError, true);
    const text = result.content.map(block => block.text).join('\n');
    assert.match(text, /^Script failed/);
    assert.match(text, /partial/);
    assert.match(text, /- edit error \d+ms/);
    assert.match(text, /Script error:/);
  });
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf8'), 'alpha\n');
});

test('a script cannot reach Local broker tools', async () => {
  const { env } = await fixture();
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'run_script',
      arguments: { script: 'await tools.tool_call({ server: "terminal", tool: "terminal_open", args: {} });' },
    });
    assert.equal(result.isError, true);
    const text = result.content.map(block => block.text).join('\n');
    assert.match(text, /tools\.tool_call does not exist/);
  });
});

test('a failed script reports a bounded diagnostic error code', async () => {
  const { env } = await fixture();
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'run_script',
      arguments: { script: 'throw new Error("boom");' },
    });
    assert.equal(result.isError, true);
    assert.equal(result._meta?.['webharness/error-code'], 'SCRIPT_FAILED');
  });
});

test('a script cannot exceed the exec timeout bound that tools/call enforces', async () => {
  const { env } = await fixture();
  await withClient(env, async client => {
    const result = await client.callTool({
      name: 'run_script',
      arguments: {
        script: `
          try { await tools.exec({ argv: ['true'], timeout_seconds: 9999 }); return 'accepted'; }
          catch (error) { return error.message; }
        `,
      },
    });
    assert.notEqual(result.isError, true);
    const text = result.content.map(block => block.text).join('\n');
    assert.match(text, /INVALID_ARGUMENTS: exec: timeout_seconds/);
    assert.doesNotMatch(text, /accepted/);
  });
});
