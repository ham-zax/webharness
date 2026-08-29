import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const INNER_TOOL_SEPARATOR = '_1mcp_';
export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 4096;

function brokerError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw brokerError('INVALID_ARGUMENT', `${name} must be a non-empty string`);
  return value;
}

function optionalString(value, name) {
  return value === undefined ? undefined : requiredString(value, name);
}

function validateServerName(server, code = 'INVALID_SERVER') {
  requiredString(server, 'server');
  if (server === '1mcp') throw brokerError(code, 'server name 1mcp is reserved');
  if (server.includes(INNER_TOOL_SEPARATOR)) throw brokerError(code, `server names must not contain ${INNER_TOOL_SEPARATOR}`);
  return server;
}

function normalizeLimit(value) {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw brokerError('INVALID_ARGUMENT', `limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
  }
  return value;
}

function encodeCursor({ pageCursor, offset, server, query }) {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    p: pageCursor ?? null,
    o: offset,
    s: server ?? null,
    q: query ?? null
  }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  requiredString(cursor, 'cursor');
  if (cursor.length > MAX_CURSOR_LENGTH) throw brokerError('INVALID_CURSOR', 'cursor is too long');
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (error) {
    throw brokerError('INVALID_CURSOR', 'cursor is not valid', error);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== CURSOR_VERSION) {
    throw brokerError('INVALID_CURSOR', 'cursor version is invalid');
  }
  if (value.p !== null && typeof value.p !== 'string') throw brokerError('INVALID_CURSOR', 'cursor page token is invalid');
  if (!Number.isInteger(value.o) || value.o < 0) throw brokerError('INVALID_CURSOR', 'cursor offset is invalid');
  if (value.s !== null && (typeof value.s !== 'string' || value.s.length === 0)) throw brokerError('INVALID_CURSOR', 'cursor server filter is invalid');
  if (value.q !== null && (typeof value.q !== 'string' || value.q.length === 0)) throw brokerError('INVALID_CURSOR', 'cursor query filter is invalid');
  return {
    pageCursor: value.p ?? undefined,
    offset: value.o,
    server: value.s ?? undefined,
    query: value.q ?? undefined
  };
}

function parseQualifiedName(name) {
  if (typeof name !== 'string') return null;
  const split = name.indexOf(INNER_TOOL_SEPARATOR);
  if (split <= 0) return null;
  const server = name.slice(0, split);
  const tool = name.slice(split + INNER_TOOL_SEPARATOR.length);
  return tool ? { server, tool } : null;
}

function qualifiedName(server, tool) {
  return `${server}${INNER_TOOL_SEPARATOR}${tool}`;
}

function conciseTool(tool, server, name) {
  return {
    server,
    tool: name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {})
  };
}

function matchesQuery(item, query) {
  if (query === undefined) return true;
  const needle = query.toLowerCase();
  return [item.server, item.tool, item.title, item.description]
    .filter(value => typeof value === 'string')
    .some(value => value.toLowerCase().includes(needle));
}

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function errorResult(error) {
  const code = typeof error?.code === 'string' ? error.code : 'LOCAL_BROKER_FAILED';
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.startsWith(`${code}: `) ? raw.slice(code.length + 2) : raw;
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } }
  };
}

export class InnerDirect1Mcp {
  constructor({ transport, client }) {
    this.transport = transport;
    this.client = client;
    this.closed = false;
    this.peerClosed = false;
  }

  static async start({ configPath, oneMcpEntry } = {}) {
    requiredString(configPath, 'configPath');
    requiredString(oneMcpEntry, 'oneMcpEntry');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [oneMcpEntry, 'serve', '--transport=stdio', '--pagination', '--config', configPath],
      stderr: 'inherit'
    });
    const client = new Client({ name: 'mcp-dev-bridge-local-inner', version: '0.1.0' });
    const inner = new InnerDirect1Mcp({ transport, client });
    client.onclose = () => { inner.peerClosed = true; };
    try {
      await client.connect(transport);
      return inner;
    } catch (error) {
      inner.closed = true;
      try { await transport.close(); } catch { /* failed startup may already be closed */ }
      throw brokerError('INNER_START_FAILED', 'failed to start inner 1MCP', error);
    }
  }

  get alive() {
    return !this.closed && !this.peerClosed && this.transport.pid !== null;
  }

  async listTools(cursor) {
    if (!this.alive) throw brokerError('INNER_UNAVAILABLE', 'inner 1MCP is not running');
    return this.client.listTools(cursor === undefined ? undefined : { cursor });
  }

  async callTool(name, args = {}) {
    if (!this.alive) throw brokerError('INNER_UNAVAILABLE', 'inner 1MCP is not running');
    return this.client.callTool({ name, arguments: args });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      try { await this.transport.close(); } catch { /* already closed */ }
    }
  }
}

export class LocalToolBroker {
  constructor({ inner, configPath }) {
    if (!inner || typeof inner.listTools !== 'function' || typeof inner.callTool !== 'function' || typeof inner.close !== 'function') {
      throw new TypeError('inner with listTools(), callTool(), and close() is required');
    }
    requiredString(configPath, 'configPath');
    this.inner = inner;
    this.configPath = configPath;
    this.closed = false;
  }

  async configuredServers() {
    let config;
    try {
      config = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
    } catch (error) {
      throw brokerError('INNER_CONFIG_INVALID', `cannot read inner config ${this.configPath}`, error);
    }
    const servers = Object.keys(config?.mcpServers ?? {});
    for (const server of servers) validateServerName(server, 'INVALID_INNER_SERVER_NAME');
    return new Set(servers);
  }

  async page(cursor) {
    if (this.closed) throw brokerError('LOCAL_BROKER_CLOSED', 'local tool broker is shut down');
    try {
      return await this.inner.listTools(cursor);
    } catch (error) {
      if (error?.code === 'INNER_UNAVAILABLE') throw error;
      throw brokerError('INNER_LIST_FAILED', 'failed to list inner tools', error);
    }
  }

  async list({ server, query, limit, cursor } = {}) {
    const selectedServer = optionalString(server, 'server');
    const selectedQuery = optionalString(query, 'query');
    if (selectedServer !== undefined) validateServerName(selectedServer);
    const selectedLimit = normalizeLimit(limit);
    const allowedServers = await this.configuredServers();
    if (selectedServer !== undefined && !allowedServers.has(selectedServer)) {
      throw brokerError('UNKNOWN_SERVER', `unknown local server: ${selectedServer}`);
    }

    let pageCursor;
    let offset = 0;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor);
      if (decoded.server !== selectedServer || decoded.query !== selectedQuery) {
        throw brokerError('INVALID_CURSOR', 'cursor filters do not match server/query');
      }
      pageCursor = decoded.pageCursor;
      offset = decoded.offset;
    }

    const tools = [];
    const seenCursors = new Set();
    while (true) {
      const cursorKey = pageCursor ?? '';
      if (seenCursors.has(cursorKey)) throw brokerError('INNER_LIST_FAILED', 'inner tools/list cursor repeated');
      seenCursors.add(cursorKey);

      const page = await this.page(pageCursor);
      const innerTools = Array.isArray(page.tools) ? page.tools : [];
      const start = Math.min(offset, innerTools.length);
      for (let index = start; index < innerTools.length; index += 1) {
        const innerTool = innerTools[index];
        const parsed = parseQualifiedName(innerTool?.name);
        if (!parsed || parsed.server === '1mcp' || !allowedServers.has(parsed.server)) continue;
        if (selectedServer !== undefined && parsed.server !== selectedServer) continue;
        const item = conciseTool(innerTool, parsed.server, parsed.tool);
        if (!matchesQuery(item, selectedQuery)) continue;
        if (tools.length === selectedLimit) {
          return {
            tools,
            hasMore: true,
            nextCursor: encodeCursor({ pageCursor, offset: index, server: selectedServer, query: selectedQuery })
          };
        }
        tools.push(item);
      }

      if (page.nextCursor === undefined) return { tools, hasMore: false };
      pageCursor = page.nextCursor;
      offset = 0;
    }
  }

  async schema({ server, tool } = {}) {
    const selectedServer = validateServerName(server);
    const selectedTool = requiredString(tool, 'tool');
    const allowedServers = await this.configuredServers();
    if (!allowedServers.has(selectedServer)) throw brokerError('UNKNOWN_SERVER', `unknown local server: ${selectedServer}`);

    const target = qualifiedName(selectedServer, selectedTool);
    let cursor;
    const seenCursors = new Set();
    while (true) {
      const cursorKey = cursor ?? '';
      if (seenCursors.has(cursorKey)) throw brokerError('INNER_LIST_FAILED', 'inner tools/list cursor repeated');
      seenCursors.add(cursorKey);
      const page = await this.page(cursor);
      const found = (page.tools ?? []).find(toolDef => toolDef?.name === target);
      if (found) return { server: selectedServer, tool: selectedTool, definition: { ...found, name: selectedTool } };
      if (page.nextCursor === undefined) throw brokerError('UNKNOWN_TOOL', `unknown tool ${selectedServer}/${selectedTool}`);
      cursor = page.nextCursor;
    }
  }

  async call({ server, tool, arguments: args = {} } = {}) {
    if (this.closed) throw brokerError('LOCAL_BROKER_CLOSED', 'local tool broker is shut down');
    const selectedServer = validateServerName(server);
    const selectedTool = requiredString(tool, 'tool');
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw brokerError('INVALID_ARGUMENT', 'arguments must be an object');
    const allowedServers = await this.configuredServers();
    if (!allowedServers.has(selectedServer)) throw brokerError('UNKNOWN_SERVER', `unknown local server: ${selectedServer}`);
    try {
      return await this.inner.callTool(qualifiedName(selectedServer, selectedTool), args);
    } catch (error) {
      if (error?.code === 'INNER_UNAVAILABLE') throw error;
      throw brokerError('INNER_CALL_FAILED', `failed to call ${selectedServer}/${selectedTool}`, error);
    }
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    await this.inner.close();
  }
}

export function createLocalBrokerServer({ broker } = {}) {
  if (!broker || typeof broker.list !== 'function' || typeof broker.schema !== 'function' || typeof broker.call !== 'function') {
    throw new TypeError('broker with list(), schema(), and call() is required');
  }

  const server = new Server(
    { name: 'local-tools', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: 'Stable local tool broker. Discover narrowly, load one schema when needed, then call by logical server/tool.' }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    {
      name: 'tool_list',
      description: 'Discover a bounded page of local downstream tools without loading their full schemas. Use a narrow server/query when possible.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', minLength: 1, description: 'Logical downstream server name, such as browser. Omit to search all servers in this broker security domain.' },
          query: { type: 'string', minLength: 1, description: 'Case-insensitive filter over server, tool name, title, and description.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT },
          cursor: { type: 'string', minLength: 1, description: 'Opaque continuation cursor returned by a prior tool_list call with the same server/query filters.' }
        },
        additionalProperties: false
      }
    },
    {
      name: 'tool_schema',
      description: 'Load the current full schema and metadata for one known local downstream tool.',
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
    }
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.name === 'tool_list') return jsonResult(await broker.list(request.params.arguments ?? {}));
      if (request.params.name === 'tool_schema') return jsonResult(await broker.schema(request.params.arguments ?? {}));
      if (request.params.name === 'tool_call') return broker.call(request.params.arguments ?? {});
      return errorResult(brokerError('UNKNOWN_BROKER_TOOL', `unknown broker tool: ${request.params.name}`));
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}

export async function runLocalBrokerStdio({
  configPath = process.env.MCP_LOCAL_INNER_CONFIG,
  oneMcpEntry = process.env.MCP_LOCAL_ONE_MCP_ENTRY
} = {}) {
  requiredString(configPath, 'MCP_LOCAL_INNER_CONFIG');
  requiredString(oneMcpEntry, 'MCP_LOCAL_ONE_MCP_ENTRY');
  const inner = await InnerDirect1Mcp.start({ configPath, oneMcpEntry });
  const broker = new LocalToolBroker({ inner, configPath });
  const server = createLocalBrokerServer({ broker });
  const transport = new StdioServerTransport();
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await broker.shutdown();
      await server.close();
    })();
    return shutdownPromise;
  };
  try {
    await server.connect(transport);
  } catch (error) {
    await broker.shutdown().catch(() => {});
    throw error;
  }
  const serverClose = transport.onclose;
  transport.onclose = () => {
    serverClose?.();
    void shutdown();
  };
  return { inner, broker, server, transport, shutdown };
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
