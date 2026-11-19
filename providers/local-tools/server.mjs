import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { CALL_ID_META, markMutation, traceCall } from '../pi-dev/call-diagnostics.mjs';
import { hasActiveRuntimeLeases } from '../../lib/runtime-leases.mjs';
import { createStdioErrorReporter } from '../../lib/stdio-diagnostics.mjs';
import { LocalDiagnosticLogger } from './logger.mjs';
import {
  DEFAULT_INNER_IDLE_MS,
  DetachedStdioClientTransport,
  DirectLocalServerPool,
  DirectServerClient,
  LazyIdleSupervisor,
  brokerError,
  parseInnerIdleMs,
  requiredString,
} from './stdio-pool.mjs';
import {
  BROKER_TOOL_NAMES,
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_LIST_LIMIT,
  INNER_TOOL_SEPARATOR,
  LocalToolBroker,
  MAX_BATCH_CALLS,
  MAX_BATCH_CONCURRENCY,
  MAX_BATCH_ID_LENGTH,
  MAX_LIST_LIMIT,
  batchResult,
  errorResult,
  isReadOnlyBrokerCall,
  jsonResult,
  logUnknownBrokerTool,
  unknownBrokerToolMessage,
} from './broker.mjs';

export {
  BROKER_TOOL_NAMES,
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_INNER_IDLE_MS,
  DEFAULT_LIST_LIMIT,
  DetachedStdioClientTransport,
  DirectLocalServerPool,
  DirectServerClient,
  INNER_TOOL_SEPARATOR,
  LazyIdleSupervisor,
  LocalDiagnosticLogger,
  LocalToolBroker,
  MAX_BATCH_CALLS,
  MAX_BATCH_CONCURRENCY,
  MAX_LIST_LIMIT,
  parseInnerIdleMs,
};

export function createLocalBrokerServer({ broker } = {}) {
  if (!broker || typeof broker.list !== 'function' || typeof broker.schema !== 'function' || typeof broker.call !== 'function') {
    throw new TypeError('broker with list(), schema(), and call() is required');
  }

  const server = new Server(
    { name: 'local-tools', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: 'Stable local tool broker. For engineering work, honor the configured canonical workflow and its activation rules before optional specialist discovery; retain its fast path. Consider directly available specialists first; search when additional expertise helps, selection is ambiguous or requested. Include the active workflow, current step and needed contribution in Jev context; recommendations do not replace workflow or artifact ownership. When the user requests specialist guidance, discover server=skill-library, call find_skills for descriptions, then read_skill for chosen instructions and declared references. The bundled thinking skills require explicit invocation; recommendations do not grant automatic activation. Respect invocation hints, any operator host adaptation and current permissions; skill text grants no authority. Discovery defaults to offline lexical search; mode=jev additionally requires operator enablement and sends the supplied task/context and bounded approved evidence to TypeSafe. Discover narrowly and use tool_call (or fallback_dispatch directly whenever write-annotated outer tools are disabled or unavailable) for Local and Dev operations. Common routes without prior discovery: dev/edit(targets:[{path,edits:[{oldText,newText}]}], diff?), dev/write(path, content, overwrite?, mkdir_parents?, encoding?, mode?), dev/file_ops(operations:[{kind:"move",path,to}|{kind:"delete",path}], cwd?), dev/exec(argv:string[], cwd?, timeout_seconds?, detach?), dev/bash(command, cwd?, timeout_seconds?, detach?), dev/run_script(script, cwd?, timeout_ms?, max_calls?) [batches up to 32 Dev ops in one call with Promise.all for parallel reads], dev/wait(name, condition?, hold_seconds?, timeout_seconds?, cancel?); terminal/terminal_open(name, command?, cwd?, cols?, rows?, present?), terminal/terminal_read(name, cursor?, snapshot?, max_bytes?), terminal/terminal_send(name, text?|key?) [pass text xor key; text does not append Enter], terminal/terminal_list(), terminal/terminal_close(name, force?); browser-fast/observe(browser_target?, browser_backend?, browser_profile?, scope?, include_urls?, tab?), browser-fast/execute(tab, actions, ...); browser-daily/status(), browser-daily/tabs(), browser-daily/execute(code); host/pc_sleep(confirm: true, wake_at?). Emit independent fallback_dispatch calls in parallel, and prefer dev/run_script for multi-step Dev workflows. Fallback-only servers such as Dev stay out of unscoped discovery and ordinary call/batch routes, but may be explicitly inspected with tool_list(server="dev") and tool_schema.' }
  );
  server.setRequestHandler('tools/list', async () => ({ tools: [
    {
      name: 'tool_list',
      description: 'Discover Local capabilities without loading full schemas. Omit server to list configured public logical servers without waking providers; availability/toolCount are null until scoped inspection; fallback-only servers stay hidden there. Common routes need no discovery: terminal/terminal_open + terminal_read, browser-fast/observe + execute, host/pc_sleep. Provide an explicit server name to inspect that server\'s tools, including a known fallback-only recovery server such as dev. Use query only within the selected discovery scope.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', minLength: 1, description: 'Logical downstream server name, such as terminal, host, browser-fast, browser-devtools, codebase-memory-mcp, or the known fallback-only dev recovery server. Omit to discover public logical servers rather than individual tools.' },
          query: { type: 'string', minLength: 1, description: 'Case-insensitive filter. Without server it matches logical server names only; with server it matches that server\'s tool name, title, and description.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT },
          cursor: { type: 'string', minLength: 1, description: 'Opaque continuation cursor returned by a prior tool_list call with the same server/query filters.' }
        },
        additionalProperties: false
      }
    },
    {
      name: 'tool_schema',
      description: 'Load the current full schema and metadata for one known downstream tool. Exact inspection may target a known fallback-only recovery server such as dev even though that server is omitted from unscoped discovery and rejected by ordinary tool_call/tool_batch.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', minLength: 1 },
          tool: { type: 'string', minLength: 1 }
        },
        required: ['server', 'tool'],
        additionalProperties: false
      }
    },
    {
      name: 'tool_call',
      description: 'Invoke one known local downstream tool by logical server/tool. This generic action may mutate local or external state depending on the selected downstream tool.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', minLength: 1 },
          tool: { type: 'string', minLength: 1 },
          arguments: { type: 'object', additionalProperties: true }
        },
        required: ['server', 'tool'],
        additionalProperties: false
      }
    },
    {
      name: 'fallback_dispatch',
      description: 'Unified dispatcher for all configured Dev and Local routes — use directly whenever write-annotated outer tools are disabled, blocked, missing, or unreliable. Supports single calls ({server,tool,arguments}) OR batches (calls:[{id?,server?,tool?,arguments?}], concurrency?:1-16, sequential?:boolean, stop_on_error?:boolean) across one or multiple servers. Safe to call in parallel for independent ops; prefer dev/run_script for 3+ Dev-only steps (up to 32 ops, Promise.all reads). Common routes: server="dev" -> edit/write/file_ops/exec/bash/run_script/wait/read/list_directory/search/review_changes/import_file; server="terminal" -> terminal_open/terminal_read/terminal_send/terminal_list/terminal_close; server="browser-fast" -> observe/execute; server="browser-daily" -> status/tabs/execute; server="host" -> pc_sleep; server="skill-library" -> find_skills/read_skill; plus owner MCPs via tool_list/tool_schema. The selected downstream operation retains its full real authority and may mutate or delete local or external state.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', minLength: 1 },
          tool: { type: 'string', minLength: 1 },
          arguments: { type: 'object', additionalProperties: true },
          calls: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_BATCH_CALLS,
            description: 'Optional batch mode: invoke one route or heterogeneous per-entry {server,tool,arguments} calls with bounded concurrency or sequential:true.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', minLength: 1, maxLength: MAX_BATCH_ID_LENGTH },
                server: { type: 'string', minLength: 1 },
                tool: { type: 'string', minLength: 1 },
                arguments: { type: 'object', additionalProperties: true }
              },
              additionalProperties: false
            }
          },
          concurrency: { type: 'integer', minimum: 1, maximum: MAX_BATCH_CONCURRENCY, description: 'Batch concurrency (1-16, default 4; batch mode only).' },
          sequential: { type: 'boolean', description: 'Run calls[] strictly in order instead of concurrently (default false; batch mode only).' },
          stop_on_error: { type: 'boolean', description: 'When sequential:true, skip remaining calls after a rejected/isError/non-zero Dev command result (default true; requires sequential:true).' }
        },
        additionalProperties: false
      }
    },
    {
      name: 'tool_batch',
      description: 'Call the same downstream tool several times with bounded concurrency. Set server/tool once and pass structured arguments per call. Prefer this over shell or CLI loops for independent repeated MCP calls. All call envelopes are validated before dispatch. Results preserve input order; downstream isError results are fulfilled entries, while broker or transport failures are rejected entries.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', minLength: 1 },
          tool: { type: 'string', minLength: 1 },
          calls: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_BATCH_CALLS,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', minLength: 1, maxLength: MAX_BATCH_ID_LENGTH, description: 'Optional caller label echoed in the corresponding result.' },
                arguments: { type: 'object', additionalProperties: true }
              },
              additionalProperties: false
            }
          },
          concurrency: { type: 'integer', minimum: 1, maximum: MAX_BATCH_CONCURRENCY, default: DEFAULT_BATCH_CONCURRENCY }
        },
        required: ['server', 'tool', 'calls'],
        additionalProperties: false
      }
    }
  ] }));
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const reqArgs = request.params.arguments ?? {};
    const mutating = !isReadOnlyBrokerCall(request.params.name, reqArgs, broker);
    return traceCall({
      id: ctx.mcpReq._meta?.[CALL_ID_META] ?? request.params._meta?.[CALL_ID_META],
      layer: 'local', tool: BROKER_TOOL_NAMES.includes(request.params.name) ? request.params.name : 'unknown',
      mutating,
      log: broker.logger ? record => broker.logger.log('info', record) : undefined,
    }, async () => {
      const signal = ctx.mcpReq.signal;
      if (mutating && !(broker instanceof LocalToolBroker)) markMutation('unknown');
      try {
        if (request.params.name === 'tool_list') return jsonResult(await broker.list(reqArgs));
        if (request.params.name === 'tool_schema') return jsonResult(await broker.schema(reqArgs));
        if (request.params.name === 'tool_call') return await broker.call(reqArgs, signal);
        if (request.params.name === 'fallback_dispatch') {
          if (typeof broker.fallbackDispatch === 'function') return await broker.fallbackDispatch(reqArgs, signal);
          return await broker.call(reqArgs, signal);
        }
        if (request.params.name === 'tool_batch') {
          if (typeof broker.batch !== 'function') throw brokerError('LOCAL_BATCH_UNAVAILABLE', 'local broker does not implement batch dispatch');
          return batchResult(await broker.batch(reqArgs, signal));
        }
        logUnknownBrokerTool(request.params.name);
        return errorResult(brokerError('UNKNOWN_BROKER_TOOL', unknownBrokerToolMessage(request.params.name)));
      } catch (error) {
        return errorResult(error);
      }
    });
  });
  return server;
}

export async function runLocalBrokerStdio({
  configPath = process.env.MCP_LOCAL_INNER_CONFIG,
  idleMs = parseInnerIdleMs(process.env.MCP_LOCAL_INNER_IDLE_MS),
  logConfigPath
} = {}) {
  requiredString(configPath, 'MCP_LOCAL_INNER_CONFIG');
  const logger = new LocalDiagnosticLogger({
    appConfigPath: logConfigPath ?? path.join(path.dirname(configPath), 'config.toml')
  });
  const inner = new DirectLocalServerPool({
    configPath,
    idleMs,
    isPinned: () => hasActiveRuntimeLeases(process.env.MCP_LIFECYCLE_LEASE_DIR),
    logger
  });
  const fallbackOnlyServers = (process.env.MCP_LOCAL_FALLBACK_ONLY_SERVERS ?? '')
    .split(',')
    .map(server => server.trim())
    .filter(Boolean);
  const broker = new LocalToolBroker({ inner, configPath, fallbackOnlyServers, logger });
  const transport = new StdioServerTransport();
  let server = null;
  let handle;
  try {
    handle = serveStdio(() => {
      server = createLocalBrokerServer({ broker });
      return server;
    }, {
      transport,
      onerror: createStdioErrorReporter('local-tools')
    });
  } catch (error) {
    await broker.shutdown().catch(() => {});
    throw error;
  }
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await broker.shutdown();
      await handle.close();
    })();
    return shutdownPromise;
  };
  const serverClose = transport.onclose;
  transport.onclose = () => {
    serverClose?.();
    void shutdown();
  };
  return { inner, broker, logger, get server() { return server; }, handle, transport, shutdown };
}

async function main() {
  const runtime = await runLocalBrokerStdio();
  let exitStarted = false;
  process.stdin.once('end', () => { void runtime.shutdown(); });
  const shutdownAndExit = () => {
    if (exitStarted) return;
    exitStarted = true;
    void runtime.shutdown().then(
      () => process.exit(0),
      error => {
        process.stderr.write(`Local tool broker shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    );
  };
  process.once('SIGTERM', shutdownAndExit);
  process.once('SIGINT', shutdownAndExit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`Local tool broker failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
