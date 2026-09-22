import { pathToFileURL } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { validateRunId } from './contracts.mjs';
import { BrowserJevRunManager } from './run-manager.mjs';

function serverError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function errorResult(error) {
  const code = typeof error?.code === 'string' ? error.code : 'BROWSER_JEV_FAILED';
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.startsWith(`${code}: `) ? raw.slice(code.length + 2) : raw;
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } }
  };
}

const STRING_CHECK = {
  type: 'array',
  minItems: 1,
  items: { type: 'string', minLength: 1 }
};

const COLLECTION_SCHEMA = {
  type: 'object',
  properties: {
    start_prefix: { type: 'string', minLength: 1, maxLength: 200, description: 'Start a text record when a visible line begins with this prefix.' },
    end_exact: { type: 'string', minLength: 1, maxLength: 200, description: 'Finish a text record when this exact visible line is reached.' },
    min_unique: { type: 'integer', minimum: 1, maximum: 200, description: 'Minimum unique records required before collection can complete.' },
    stable_observations: { type: 'integer', minimum: 1, maximum: 10, description: 'Settled no-new-record WAIT observations required after no-new traversal steps before collection is considered stable.' },
    max_items: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum unique records retained and returned.' }
  },
  required: ['start_prefix', 'end_exact'],
  additionalProperties: false
};

const SUCCESS_SCHEMA = {
  type: 'object',
  minProperties: 1,
  properties: {
    url_contains: STRING_CHECK,
    title_contains: STRING_CHECK,
    text_contains: STRING_CHECK,
    required_operations: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: ['CLICK', 'TYPE_TEXT', 'SELECT', 'WAIT'] }
    },
    collection_complete: { type: 'boolean', const: true, description: 'Require the configured text-record collection to reach its deterministic completion rule.' },
    scroll_exhausted: { type: 'boolean', const: true, description: 'Require the current document to have no further downward scroll action.' }
  },
  additionalProperties: false
};

const RUN_SCHEMA = {
  type: 'object',
  properties: { run_id: { type: 'string', minLength: 1 } },
  required: ['run_id'],
  additionalProperties: false
};

const START_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', minLength: 1, description: 'Initial HTTP or HTTPS page.' },
    goal: { type: 'string', minLength: 1, description: 'Natural-language goal for this run.' },
    scenario: {
      type: 'object',
      properties: {
        browser_target: { type: 'string', enum: ['windows', 'linux'], description: 'Omit for Windows Chrome; use linux for managed Linux Chrome or Clearcote.' },
        browser_backend: { type: 'string', enum: ['chrome', 'clearcote'], description: 'Linux browser backend. Windows accepts only chrome.' },
        browser_profile: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$', description: 'Optional managed browser profile name.' },
        collection: { ...COLLECTION_SCHEMA, description: 'Optional bounded cross-observation text-record collection. Requires at least one url_contains, title_contains, or text_contains success check to identify the intended document; collection_complete is then enforced automatically.' },
        success: SUCCESS_SCHEMA
      },
      required: ['success'],
      additionalProperties: false
    }
  },
  required: ['url', 'goal', 'scenario'],
  additionalProperties: false
};

const TOOLS = [
  {
    name: 'jev_run',
    description: 'Run one Jev browser-agent task autonomously inside this single MCP call until deterministic success checks pass or the bounded agent blocks/fails. Optional collection accumulates unique visible text records across virtualized/infinite-scroll observations. The run-owned target/helper is cleaned before the final sanitized state is returned.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: START_INPUT_SCHEMA
  },
  {
    name: 'jev_start',
    description: 'Start one Jev browser-agent run in its own background target and return the first observed state. Completion is accepted only when every declared success check passes.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: START_INPUT_SCHEMA
  },
  {
    name: 'jev_tick',
    description: 'Perform exactly one Jev decision and execution cycle. Mutations are never replayed after an error.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: RUN_SCHEMA
  },
  {
    name: 'jev_state',
    description: 'Return the latest sanitized state for a live Jev run without a model call or browser mutation.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: RUN_SCHEMA
  },
  {
    name: 'jev_stop',
    description: 'Close the run-owned background target and its namespaced helper process without closing the shared browser.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: RUN_SCHEMA
  }
];

export function createBrowserJevServer({ manager } = {}) {
  if (
    !manager
    || typeof manager.runToTerminal !== 'function'
    || typeof manager.start !== 'function'
    || typeof manager.tick !== 'function'
    || typeof manager.state !== 'function'
    || typeof manager.stop !== 'function'
  ) {
    throw new TypeError('manager with runToTerminal(), start(), tick(), state(), and stop() is required');
  }
  const server = new Server(
    { name: 'browser-jev', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Jev browser-agent runs on WebHarness-managed browsers. Use jev_run for one-call autonomous execution with deterministic success checks, optional cross-observation text-record collection, and automatic cleanup; use start/tick/state/stop for interactive control.'
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const args = request.params.arguments ?? {};
      if (request.params.name === 'jev_run') {
        return jsonResult(await manager.runToTerminal(args, { signal: extra?.signal }));
      }
      if (request.params.name === 'jev_start') return jsonResult(await manager.start(args));
      if (request.params.name === 'jev_tick') return jsonResult(await manager.tick(validateRunId(args)));
      if (request.params.name === 'jev_state') return jsonResult(manager.state(validateRunId(args)));
      if (request.params.name === 'jev_stop') return jsonResult(await manager.stop(validateRunId(args)));
      return errorResult(serverError('UNKNOWN_BROWSER_JEV_TOOL', `unknown tool: ${request.params.name}`));
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}

export async function runBrowserJevStdio() {
  const manager = new BrowserJevRunManager();
  const server = createBrowserJevServer({ manager });
  const transport = new StdioServerTransport();
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await manager.close();
      await server.close();
    })();
    return shutdownPromise;
  };
  await server.connect(transport);
  const serverClose = transport.onclose;
  transport.onclose = () => {
    serverClose?.();
    void shutdown();
  };
  return { manager, server, transport, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await runBrowserJevStdio();
  process.stdin.once('end', () => { void runtime.shutdown(); });
  const shutdownAndExit = () => {
    void runtime.shutdown().then(
      () => process.exit(0),
      error => {
        process.stderr.write(`Browser Jev shutdown failed: ${error?.code ?? 'unknown error'}\n`);
        process.exit(1);
      }
    );
  };
  process.once('SIGTERM', shutdownAndExit);
  process.once('SIGINT', shutdownAndExit);
}

