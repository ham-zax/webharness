import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { TerminalError } from '../protocol.mjs';
import * as serverModule from '../mcp-server.mjs';
import {
  makeSandbox,
  startBroker,
  waitFor,
} from './helpers.mjs';

function textOf(result) {
  return (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
}

function recordingBroker() {
  const calls = [];
  const client = {
    async request(op, params = {}) {
      calls.push({ op, params });
      switch (op) {
        case 'session.open':
          return {
            name: params.name,
            panePid: 1234,
            paneDead: false,
            paneDeadStatus: null,
            cols: params.cols ?? 80,
            rows: params.rows ?? 24,
            humanLease: false,
          };
        case 'model.read':
          return params.snapshot
            ? { snapshot: true, text: 'TUI SCREEN\n' }
            : { text: 'UNREAD OUTPUT\n', cursor: params.cursor ?? 7, nextCursor: 21, baseOffset: 0, endOffset: 21 };
        case 'session.send':
          return { name: params.name, paneDead: false, cols: 80, rows: 24 };
        case 'session.resize':
          return { name: params.name, paneDead: false, cols: params.cols, rows: params.rows };
        case 'session.list':
          return {
            sessions: [
              { name: 'live', panePid: 111, paneDead: false, paneDeadStatus: null, cols: 80, rows: 24, humanLease: false },
              { name: 'failed', panePid: 222, paneDead: true, paneDeadStatus: 7, cols: 80, rows: 24, humanLease: false },
            ],
          };
        case 'session.close':
          return { name: params.name, closed: true };
        default:
          throw new Error(`unexpected broker op: ${op}`);
      }
    },
  };
  return { client, calls };
}

async function withInMemoryServer(t, broker, fn, options = {}) {
  const server = serverModule.createTerminalMcpServer({ client: broker, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'terminal-mcp-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return fn(client);
}

test('Terminal MCP exposes exactly seven public tools with the frozen schemas', async (t) => {
  assert.equal(typeof serverModule.createTerminalMcpServer, 'function');
  const { client: broker, calls } = recordingBroker();
  await withInMemoryServer(t, broker, async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'terminal_close',
      'terminal_list',
      'terminal_open',
      'terminal_read',
      'terminal_resize',
      'terminal_send',
      'terminal_yield',
    ]);
    assert.ok(tools.every((tool) => !tool.name.startsWith('lease.')));
    assert.ok(tools.every((tool) => !tool.name.includes('tmux')));
    assert.ok(tools.every((tool) => tool.name !== 'terminal'));

    const open = tools.find((tool) => tool.name === 'terminal_open');
    assert.deepEqual(Object.keys(open.inputSchema.properties).sort(), ['cols', 'command', 'cwd', 'name', 'present', 'rows']);
    assert.deepEqual(open.inputSchema.required, ['name']);
    assert.match(open.description, /durable.*PTY|PTY.*durable/i);
    assert.match(open.description, /survive.*MCP.*broker|MCP.*broker.*restart/i);
    assert.match(open.description, /Bash.*bounded|bounded.*Bash/i);
    assert.match(open.description, /omit.*command.*shell|command.*omit.*shell/i);
    assert.match(open.description, /present.*human|human.*present|visible.*frontend/i);
    assert.match(open.description, /headless.*default|default.*headless/i);

    const send = tools.find((tool) => tool.name === 'terminal_send');
    assert.match(send.description, /exactly one.*text.*key|text.*key.*exactly one/i);
    assert.match(send.description, /does not.*Enter|no.*implicit.*Enter/i);
    assert.match(send.description, /HUMAN_HAS_CONTROL/i);
    assert.match(send.description, /do not.*bypass|must not.*bypass/i);

    const read = tools.find((tool) => tool.name === 'terminal_read');
    assert.deepEqual(Object.keys(read.inputSchema.properties).sort(), ['cursor', 'name', 'snapshot']);
    assert.match(read.description, /persisted.*unread|persisted.*position/i);
    assert.match(read.description, /explicit.*cursor.*replay|replay.*cursor/i);
    assert.match(read.description, /snapshot.*without.*advanc|without.*advanc.*snapshot/i);

    const resize = tools.find((tool) => tool.name === 'terminal_resize');
    assert.deepEqual(Object.keys(resize.inputSchema.properties).sort(), ['cols', 'name', 'rows']);

    const list = tools.find((tool) => tool.name === 'terminal_list');
    assert.match(list.description, /before mutation/i);

    const yieldTool = tools.find((tool) => tool.name === 'terminal_yield');
    assert.deepEqual(Object.keys(yieldTool.inputSchema.properties).sort(), ['name']);
    assert.deepEqual(yieldTool.inputSchema.required, ['name']);
    assert.match(yieldTool.description, /reuse.*attached|attached.*reuse/i);
    assert.match(yieldTool.description, /Kitty|frontend/i);

    const close = tools.find((tool) => tool.name === 'terminal_close');
    assert.match(close.description, /kills.*tmux session|destroy.*PTY.*process/i);
    assert.match(close.description, /force=true.*override/i);

    const both = await client.callTool({
      name: 'terminal_send',
      arguments: { name: 'x', text: 'hello', key: 'ENTER' },
    });
    assert.equal(both.isError, true);
    assert.match(textOf(both), /requires exactly one of text or key/i);
    const neither = await client.callTool({ name: 'terminal_send', arguments: { name: 'x' } });
    assert.equal(neither.isError, true);
    assert.match(textOf(neither), /requires exactly one of text or key/i);
    assert.equal(calls.length, 0);
  });
});

test('Terminal MCP maps public calls to private broker operations and returns native TextContent', async (t) => {
  const { client: broker, calls } = recordingBroker();
  await withInMemoryServer(t, broker, async (client) => {
    const opened = await client.callTool({
      name: 'terminal_open',
      arguments: { name: 'demo', command: 'cat', cwd: '/tmp', cols: 90, rows: 31 },
    });
    assert.equal(opened.isError, undefined);
    assert.equal(opened.structuredContent, undefined);
    assert.match(textOf(opened), /demo/);
    assert.doesNotThrow(() => assert.ok(opened.content.every((block) => block.type === 'text')));

    const read = await client.callTool({ name: 'terminal_read', arguments: { name: 'demo' } });
    assert.equal(textOf(read), 'UNREAD OUTPUT\n');
    assert.equal(read.structuredContent, undefined);

    const snapshot = await client.callTool({
      name: 'terminal_read', arguments: { name: 'demo', snapshot: true },
    });
    assert.equal(textOf(snapshot), 'TUI SCREEN\n');

    const sentText = await client.callTool({
      name: 'terminal_send', arguments: { name: 'demo', text: 'SECRET_MODEL_TEXT' },
    });
    assert.match(textOf(sentText), /sent.*demo/i);
    assert.doesNotMatch(textOf(sentText), /SECRET_MODEL_TEXT/);

    const sentKey = await client.callTool({
      name: 'terminal_send', arguments: { name: 'demo', key: 'CTRL_C' },
    });
    assert.match(textOf(sentKey), /sent.*demo/i);

    const resized = await client.callTool({
      name: 'terminal_resize', arguments: { name: 'demo', cols: 100, rows: 40 },
    });
    assert.match(textOf(resized), /100x40/);

    const listed = await client.callTool({ name: 'terminal_list', arguments: {} });
    assert.match(textOf(listed), /live/);
    assert.match(textOf(listed), /failed/);
    assert.match(textOf(listed), /exit=7/);

    const closed = await client.callTool({
      name: 'terminal_close', arguments: { name: 'demo', force: true },
    });
    assert.match(textOf(closed), /closed.*demo/i);

    assert.deepEqual(calls, [
      { op: 'session.open', params: { name: 'demo', command: 'cat', cwd: '/tmp', cols: 90, rows: 31 } },
      { op: 'model.read', params: { name: 'demo' } },
      { op: 'model.read', params: { name: 'demo', snapshot: true } },
      { op: 'session.send', params: { name: 'demo', text: 'SECRET_MODEL_TEXT' } },
      { op: 'session.send', params: { name: 'demo', key: 'C-c' } },
      { op: 'session.resize', params: { name: 'demo', cols: 100, rows: 40 } },
      { op: 'session.list', params: {} },
      { op: 'session.close', params: { name: 'demo', force: true } },
    ]);
  });
});

test('Terminal MCP optionally presents an opened session and reports partial frontend failure without reopening', async (t) => {
  const { client: broker, calls } = recordingBroker();
  const frontendCalls = [];
  const frontend = {
    async ensurePresented(name) {
      frontendCalls.push(name);
      return { name, status: 'launch-attempted' };
    },
  };
  await withInMemoryServer(t, broker, async (client) => {
    const presented = await client.callTool({
      name: 'terminal_open',
      arguments: { name: 'visible', command: 'cat', present: true },
    });
    assert.equal(presented.isError, undefined, textOf(presented));
    assert.match(textOf(presented), /presented|frontend/i);
  }, { frontend });
  assert.deepEqual(frontendCalls, ['visible']);
  assert.deepEqual(calls, [
    { op: 'session.open', params: { name: 'visible', command: 'cat' } },
  ]);

  const { client: failingBroker, calls: failingCalls } = recordingBroker();
  const failingFrontend = {
    async ensurePresented() {
      throw new TerminalError('FRONTEND_UNAVAILABLE', 'attach manually with /repo/bin/wsl-term attach partial');
    },
  };
  await withInMemoryServer(t, failingBroker, async (client) => {
    const partial = await client.callTool({
      name: 'terminal_open',
      arguments: { name: 'partial', present: true },
    });
    assert.equal(partial.isError, true);
    assert.match(textOf(partial), /^TERMINAL_FRONTEND_PARTIAL:/);
    assert.match(textOf(partial), /already live|live.*headless|headless.*live/i);
    assert.match(textOf(partial), /wsl-term attach partial/);
  }, { frontend: failingFrontend });
  assert.deepEqual(failingCalls, [
    { op: 'session.open', params: { name: 'partial' } },
  ]);
});

test('terminal_yield reuses an attached client and only ensures a frontend when none is attached', async (t) => {
  const existingCalls = [];
  const existingBroker = {
    async request(op, params) {
      existingCalls.push({ op, params });
      if (op === 'control.take_human') return { name: params.name, humanHasControl: true };
      throw new Error(`unexpected broker op: ${op}`);
    },
  };
  let existingFrontendCalls = 0;
  await withInMemoryServer(t, existingBroker, async (client) => {
    const result = await client.callTool({ name: 'terminal_yield', arguments: { name: 'existing' } });
    assert.equal(result.isError, undefined, textOf(result));
    assert.match(textOf(result), /yielded.*existing/i);
  }, {
    frontend: { async ensurePresented() { existingFrontendCalls += 1; } },
  });
  assert.equal(existingFrontendCalls, 0);
  assert.deepEqual(existingCalls, [
    { op: 'control.take_human', params: { name: 'existing' } },
  ]);

  const launchedCalls = [];
  let takeAttempts = 0;
  const launchedBroker = {
    async request(op, params) {
      launchedCalls.push({ op, params });
      if (op !== 'control.take_human') throw new Error(`unexpected broker op: ${op}`);
      takeAttempts += 1;
      if (takeAttempts === 1) {
        throw new TerminalError('HUMAN_CLIENT_NOT_FOUND', 'no collaborative human client is attached');
      }
      return { name: params.name, humanHasControl: true };
    },
  };
  const launchedFrontendCalls = [];
  await withInMemoryServer(t, launchedBroker, async (client) => {
    const result = await client.callTool({ name: 'terminal_yield', arguments: { name: 'launched' } });
    assert.equal(result.isError, undefined, textOf(result));
    assert.match(textOf(result), /yielded.*launched/i);
  }, {
    frontend: {
      async ensurePresented(name) {
        launchedFrontendCalls.push(name);
        return { name, status: 'launch-attempted' };
      },
    },
  });
  assert.deepEqual(launchedFrontendCalls, ['launched']);
  assert.deepEqual(launchedCalls, [
    { op: 'control.take_human', params: { name: 'launched' } },
    { op: 'control.take_human', params: { name: 'launched' } },
  ]);
});

test('terminal_yield preserves frontend failure and does not retry control', async (t) => {
  const calls = [];
  const broker = {
    async request(op, params) {
      calls.push({ op, params });
      throw new TerminalError('HUMAN_CLIENT_NOT_FOUND', 'no collaborative human client is attached');
    },
  };
  const frontend = {
    async ensurePresented() {
      throw new TerminalError('FRONTEND_UNAVAILABLE', 'attach manually with /repo/bin/wsl-term attach demo');
    },
  };
  await withInMemoryServer(t, broker, async (client) => {
    const result = await client.callTool({ name: 'terminal_yield', arguments: { name: 'demo' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^FRONTEND_UNAVAILABLE:/);
    assert.match(textOf(result), /wsl-term attach demo/);
  }, { frontend });
  assert.deepEqual(calls, [
    { op: 'control.take_human', params: { name: 'demo' } },
  ]);
});

test('Terminal MCP supports the frozen control-key vocabulary', async (t) => {
  const expected = new Map([
    ['ENTER', 'Enter'],
    ['CTRL_C', 'C-c'],
    ['CTRL_D', 'C-d'],
    ['CTRL_Z', 'C-z'],
    ['ESC', 'Escape'],
    ['TAB', 'Tab'],
    ['BACKSPACE', 'BSpace'],
    ['UP', 'Up'],
    ['DOWN', 'Down'],
    ['LEFT', 'Left'],
    ['RIGHT', 'Right'],
  ]);
  const { client: broker, calls } = recordingBroker();
  await withInMemoryServer(t, broker, async (client) => {
    for (const key of expected.keys()) {
      await client.callTool({ name: 'terminal_send', arguments: { name: 'keys', key } });
    }
  });
  assert.deepEqual(
    calls.map((call) => [call.params.key, call.op]),
    [...expected.values()].map((key) => [key, 'session.send']),
  );
});

test('Terminal MCP preserves Terminal errors and bounded cursor recovery as native error TextContent', async (t) => {
  const broker = {
    async request(op) {
      if (op === 'model.read') {
        throw new TerminalError(
          'CURSOR_EXPIRED',
          'cursor 0 has expired; retained transcript starts at 100',
          {
            baseOffset: 100,
            endOffset: 120,
            recovery: { cursor: 112, text: 'bounded tail\n', nextCursor: 120 },
          },
        );
      }
      throw new TerminalError('HUMAN_HAS_CONTROL', 'human has control of session demo');
    },
  };
  await withInMemoryServer(t, broker, async (client) => {
    const expired = await client.callTool({ name: 'terminal_read', arguments: { name: 'demo' } });
    assert.equal(expired.isError, true);
    assert.match(textOf(expired), /^CURSOR_EXPIRED:/);
    assert.match(textOf(expired), /bounded tail/);
    assert.match(textOf(expired), /cursor=112/);
    assert.match(textOf(expired), /nextCursor=120/);
    assert.equal(expired.structuredContent, undefined);

    const blocked = await client.callTool({
      name: 'terminal_send', arguments: { name: 'demo', text: 'x' },
    });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /^HUMAN_HAS_CONTROL:/);
  });
});

test('Terminal stdio provider exposes the seven tools and preserves incremental reads plus exact exit status', async (t) => {
  const sandbox = await makeSandbox(t);
  await startBroker(t, sandbox);
  const serverPath = path.resolve('mcp-server.mjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...sandbox.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'terminal-stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'terminal_close', 'terminal_list', 'terminal_open',
    'terminal_read', 'terminal_resize', 'terminal_send', 'terminal_yield',
  ]);

  const finiteOpen = await client.callTool({
    name: 'terminal_open',
    arguments: { name: 'mcp-exit-seven', command: "printf 'MCP_EXIT_SEVEN\\n'; exit 7" },
  });
  assert.equal(finiteOpen.isError, undefined, textOf(finiteOpen));

  let finiteText = '';
  await waitFor(async () => {
    const read = await client.callTool({ name: 'terminal_read', arguments: { name: 'mcp-exit-seven' } });
    if (read.isError) return false;
    finiteText += textOf(read);
    return finiteText.includes('MCP_EXIT_SEVEN');
  }, { description: 'MCP finite output' });

  await waitFor(async () => {
    const listed = await client.callTool({ name: 'terminal_list', arguments: {} });
    return !listed.isError && /mcp-exit-seven.*exit=7/.test(textOf(listed));
  }, { description: 'MCP exact exit status' });

  const catOpen = await client.callTool({
    name: 'terminal_open', arguments: { name: 'mcp-incremental', command: 'stty -echo; exec cat' },
  });
  assert.equal(catOpen.isError, undefined, textOf(catOpen));
  await client.callTool({
    name: 'terminal_send', arguments: { name: 'mcp-incremental', text: 'MCP_INCREMENTAL' },
  });
  await client.callTool({
    name: 'terminal_send', arguments: { name: 'mcp-incremental', key: 'ENTER' },
  });

  let first = '';
  await waitFor(async () => {
    const read = await client.callTool({ name: 'terminal_read', arguments: { name: 'mcp-incremental' } });
    if (read.isError) return false;
    first += textOf(read);
    return first.includes('MCP_INCREMENTAL');
  }, { description: 'MCP incremental first read' });
  const duplicate = await client.callTool({ name: 'terminal_read', arguments: { name: 'mcp-incremental' } });
  assert.equal(duplicate.isError, undefined);
  assert.equal(textOf(duplicate), '');
});
