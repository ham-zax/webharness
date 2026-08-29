#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { BrokerClient } from './broker-client.mjs';
import { createFrontendController } from './frontend.mjs';
import { TerminalError } from './protocol.mjs';

const PUBLIC_KEYS = {
  ENTER: 'Enter',
  CTRL_C: 'C-c',
  CTRL_D: 'C-d',
  CTRL_Z: 'C-z',
  ESC: 'Escape',
  TAB: 'Tab',
  BACKSPACE: 'BSpace',
  UP: 'Up',
  DOWN: 'Down',
  LEFT: 'Left',
  RIGHT: 'Right',
};

function defaultSocketPath() {
  if (process.env.MCP_TERMINAL_SOCKET) return process.env.MCP_TERMINAL_SOCKET;
  if (process.env.XDG_RUNTIME_DIR) return `${process.env.XDG_RUNTIME_DIR}/wsl-agent-terminal.sock`;
  if (typeof process.getuid === 'function') return `/run/user/${process.getuid()}/wsl-agent-terminal.sock`;
  throw new Error('MCP_TERMINAL_SOCKET or XDG_RUNTIME_DIR is required');
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorText(error) {
  const code = typeof error?.code === 'string' ? error.code : 'TERMINAL_ERROR';
  let text = `${code}: ${error instanceof Error ? error.message : String(error)}`;
  const recovery = error?.details?.recovery;
  if (code === 'CURSOR_EXPIRED' && recovery) {
    text += `\nrecovery cursor=${recovery.cursor} nextCursor=${recovery.nextCursor}`;
    if (typeof recovery.text === 'string' && recovery.text.length > 0) text += `\n${recovery.text}`;
  }
  return text;
}

async function invoke(fn) {
  try {
    return await fn();
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: errorText(error) }],
    };
  }
}

function compactParams(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function renderSession(session) {
  const state = session.paneDead
    ? `dead exit=${session.paneDeadStatus ?? 'unknown'}`
    : 'live';
  return [
    session.name,
    state,
    `pid=${session.panePid}`,
    `${session.cols}x${session.rows}`,
    `human=${session.humanLease ? 'yes' : 'no'}`,
  ].join(' ');
}

export function createTerminalMcpServer({ client, frontend } = {}) {
  if (!client || typeof client.request !== 'function') {
    throw new TypeError('client with request() is required');
  }
  const frontendController = frontend ?? createFrontendController({ client });

  const server = new McpServer({ name: 'terminal', version: '0.1.0' });
  const name = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
  const dimension = z.number().int().positive().max(1000);

  server.registerTool('terminal_open', {
    description: 'Open one model-owned durable tmux PTY/process in the WebHarness tmux namespace (production default wsl-agent), not the user\'s default tmux server. Use this for interactive or persistent work that should survive MCP or broker restart; prefer Dev Bash for bounded noninteractive commands. Omitting command starts the normal interactive shell. Headless is the default; set present=true only when the human should see a visible collaborative frontend from the start.',
    inputSchema: {
      name,
      command: z.string().optional(),
      cwd: z.string().min(1).optional(),
      cols: dimension.optional(),
      rows: dimension.optional(),
      present: z.boolean().optional(),
    },
  }, async (args) => invoke(async () => {
    const { present = false, ...openArgs } = args;
    const result = await client.request('session.open', compactParams(openArgs));
    if (!present) {
      return textResult(`opened ${result.name} pid=${result.panePid} ${result.cols}x${result.rows}`);
    }
    try {
      await frontendController.ensurePresented(result.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TerminalError(
        'TERMINAL_FRONTEND_PARTIAL',
        `session ${result.name} is already live headless, but frontend presentation failed: ${message}`,
      );
    }
    return textResult(`opened ${result.name} pid=${result.panePid} ${result.cols}x${result.rows} presented`);
  }));

  server.registerTool('terminal_read', {
    description: 'Read a WebHarness Terminal session. Normally omit cursor to consume from the broker-owned persisted model unread position; successful reads advance that position. An explicit cursor intentionally replays/repositions from that offset and advances the persisted position to the returned point. snapshot=true captures the current tmux screen/TUI without advancing transcript position; use explicit cursors only for replay or recovery.',
    inputSchema: {
      name,
      cursor: z.number().int().nonnegative().optional(),
      snapshot: z.boolean().optional(),
    },
  }, async (args) => invoke(async () => {
    const result = await client.request('model.read', compactParams(args));
    return textResult(result.text);
  }));

  const sendSchema = z.object({
    name,
    text: z.string().optional(),
    key: z.enum(Object.keys(PUBLIC_KEYS)).optional(),
  }).superRefine((value, ctx) => {
    const hasText = value.text !== undefined;
    const hasKey = value.key !== undefined;
    if (hasText === hasKey) {
      ctx.addIssue({
        code: 'custom',
        message: 'terminal_send requires exactly one of text or key',
      });
    }
  });

  server.registerTool('terminal_send', {
    description: 'Send exactly one of literal text or one recognized control/navigation key to a WebHarness Terminal session. text is literal and does not append Enter, so executing a shell command normally requires a text send followed by key=ENTER. Writable human ownership blocks model mutation with HUMAN_HAS_CONTROL; do not bypass ownership through Dev Bash, raw tmux, or operator wsl-term commands.',
    inputSchema: sendSchema,
  }, async (args) => invoke(async () => {
    const params = args.key === undefined
      ? { name: args.name, text: args.text }
      : { name: args.name, key: PUBLIC_KEYS[args.key] };
    await client.request('session.send', params);
    return textResult(`sent to ${args.name}`);
  }));

  server.registerTool('terminal_resize', {
    description: 'Resize an existing WebHarness PTY while the model owns it; changing dimensions may cause terminal applications to observe resize/SIGWINCH behavior. Writable human control blocks model resize.',
    inputSchema: { name, cols: dimension, rows: dimension },
  }, async (args) => invoke(async () => {
    const result = await client.request('session.resize', args);
    return textResult(`resized ${result.name} ${result.cols}x${result.rows}`);
  }));

  server.registerTool('terminal_list', {
    description: 'List durable sessions in the WebHarness tmux namespace, including dead exit status, dimensions, and whether writable human control currently blocks model mutation; use this to resolve session identity and state before mutation.',
    inputSchema: {},
  }, async () => invoke(async () => {
    const result = await client.request('session.list', {});
    return textResult(result.sessions.map(renderSession).join('\n'));
  }));

  server.registerTool('terminal_yield', {
    description: 'Yield a model-owned collaborative Terminal session to human control. Reuse an already attached designated human frontend when present; if none is attached, ensure the configured personal frontend for the exact tmux PTY and then yield. After success, model send/resize/ordinary close is blocked until the human gives control back.',
    inputSchema: { name },
  }, async (args) => invoke(async () => {
    let result;
    try {
      result = await client.request('control.take_human', { name: args.name });
    } catch (error) {
      if (error?.code !== 'HUMAN_CLIENT_NOT_FOUND') throw error;
      await frontendController.ensurePresented(args.name);
      result = await client.request('control.take_human', { name: args.name });
    }
    return textResult(`yielded ${result.name} to human control`);
  }));

  server.registerTool('terminal_close', {
    description: 'Destructively close a WebHarness Terminal session by killing its tmux session, which destroys that session\'s PTY/process lifetime. Ordinary close is blocked while a human owns the session; force=true explicitly overrides human ownership and destroys the session anyway.',
    inputSchema: { name, force: z.boolean().optional() },
  }, async (args) => invoke(async () => {
    const result = await client.request('session.close', compactParams(args));
    return textResult(`closed ${result.name}`);
  }));

  return server;
}

export async function runTerminalMcpStdio({ socketPath = defaultSocketPath() } = {}) {
  const client = new BrokerClient({ socketPath });
  const server = createTerminalMcpServer({ client });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}

async function main() {
  const runtime = await runTerminalMcpStdio();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await runtime.server.close();
  };
  process.stdin.once('end', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`terminal MCP failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
