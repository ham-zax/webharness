import { markMutation } from '../pi-dev/call-diagnostics.mjs';
import { explainSchemaViolation, looksLikeSchemaValidationError } from '../../lib/schema-hint.mjs';
import {
  DEV_ROUTE_ARG_HINTS,
  hasUnsuccessfulDevCommandFooter,
  isArgumentSensitiveReadOnlyRoute,
  isKnownReadOnlyRoute,
  normalizeRouteTool,
} from '../../lib/local-route-policy.mjs';
import {
  brokerError,
  causeSummary,
  delay,
  readCachedInnerConfig,
  requiredString,
  withCauseDetail,
} from './stdio-pool.mjs';

export const INNER_TOOL_SEPARATOR = '_1mcp_';
export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_BATCH_CONCURRENCY = 4;
export const MAX_BATCH_CONCURRENCY = 16;
export const MAX_BATCH_CALLS = 32;
export const MAX_BATCH_ID_LENGTH = 128;
export const BROKER_TOOL_NAMES = Object.freeze(['tool_list', 'tool_schema', 'tool_call', 'fallback_dispatch', 'tool_batch']);

const MAX_REPORTED_TOOL_NAME_LENGTH = 128;
const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 4096;
const SCHEMA_HINT_LOOKUP_TIMEOUT_MS = 2_000;
// A restart only restarts the downstream backend. The browser backend boots through
// `cmd.exe` and `npx` into Windows, which measured 11 to 34 seconds on WSL, so a
// shorter budget reports a healthy server as missing and starts a restart loop.
const DEFAULT_DOWNSTREAM_RECOVERY_TIMEOUT_MS = 90_000;
const MAX_DOWNSTREAM_RECOVERY_TIMEOUT_MS = 300_000;
const DEFAULT_DOWNSTREAM_READY_POLL_MS = 1_000;
const MAX_DOWNSTREAM_READY_POLL_MS = 5_000;

function optionalString(value, name) {
  return value === undefined ? undefined : requiredString(value, name);
}

function validateServerName(server, code = 'INVALID_SERVER') {
  requiredString(server, 'server');
  if (server === '1mcp') throw brokerError(code, 'server name 1mcp is reserved');
  if (server.includes(INNER_TOOL_SEPARATOR)) throw brokerError(code, `server names must not contain ${INNER_TOOL_SEPARATOR}`);
  return server;
}

function boundedDuration(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_DOWNSTREAM_RECOVERY_TIMEOUT_MS) {
    throw new TypeError(`${name} must be an integer from 1 to ${MAX_DOWNSTREAM_RECOVERY_TIMEOUT_MS}`);
  }
  return value;
}

function isFailedBatchEntryResult(route, result) {
  if (result?.isError === true) return true;
  if (route.server === 'dev' && (route.tool === 'exec' || route.tool === 'bash')) {
    return hasUnsuccessfulDevCommandFooter(result);
  }
  return false;
}

export function isReadOnlyBrokerCall(toolName, reqArgs, broker = null) {
  if (toolName === 'tool_list' || toolName === 'tool_schema') return true;
  const check = (server, tool, args) => (
    broker && typeof broker.isReadOnlyRoute === 'function'
      ? broker.isReadOnlyRoute(server, tool, args)
      : isKnownReadOnlyRoute(server, tool, args)
  );
  if (toolName === 'tool_call') {
    return check(reqArgs.server, reqArgs.tool, reqArgs.arguments);
  }
  if (toolName === 'fallback_dispatch') {
    if (Array.isArray(reqArgs.calls)) {
      return reqArgs.calls.length > 0 && reqArgs.calls.every(call =>
        call !== null && typeof call === 'object' && !Array.isArray(call)
        && check(call.server ?? reqArgs.server, call.tool ?? reqArgs.tool, call.arguments)
      );
    }
    return check(reqArgs.server, reqArgs.tool, reqArgs.arguments);
  }
  if (toolName === 'tool_batch') {
    return Array.isArray(reqArgs.calls)
      && reqArgs.calls.length > 0
      && reqArgs.calls.every(call =>
        call !== null && typeof call === 'object' && !Array.isArray(call)
        && check(reqArgs.server, reqArgs.tool, call.arguments)
      );
  }
  return false;
}

function routeSchemaHint(server, tool) {
  if (server === 'dev' && Object.hasOwn(DEV_ROUTE_ARG_HINTS, tool)) {
    return `${DEV_ROUTE_ARG_HINTS[tool]} Inspect full schema with tool_schema(server="${server}", tool="${tool}").`;
  }
  return `Inspect required fields with tool_schema(server="${server}", tool="${tool}").`;
}

function formatSchemaValidationHint(server, tool, detail) {
  const baseHint = routeSchemaHint(server, tool);
  return detail ? `Schema mismatch for ${server}/${tool}: ${detail}. ${baseHint}` : baseHint;
}

function enrichSchemaValidationResult(server, tool, result, detail = null) {
  if (!result || typeof result !== 'object' || result.isError !== true || !Array.isArray(result.content)) {
    return result;
  }
  const idx = result.content.findIndex(item => item?.type === 'text' && looksLikeSchemaValidationError(item.text));
  if (idx === -1) return result;
  const hint = formatSchemaValidationHint(server, tool, detail);
  if (result.content[idx].text.includes(hint)) return result;
  const nextContent = result.content.slice();
  nextContent[idx] = { ...nextContent[idx], text: `${nextContent[idx].text}\n${hint}` };
  return { ...result, content: nextContent };
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

// Parameter names at a glance, required ones starred ("name*, cols, rows"), so a caller
// can usually make the call straight from tool_list without a tool_schema round trip.
function paramSignature(inputSchema) {
  const properties = inputSchema && typeof inputSchema === 'object' ? inputSchema.properties : undefined;
  if (!properties || typeof properties !== 'object') return undefined;
  const names = Object.keys(properties);
  if (names.length === 0) return undefined;
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  return names.map(name => (required.has(name) ? `${name}*` : name)).join(', ');
}

function conciseTool(tool, server, name) {
  const params = paramSignature(tool.inputSchema);
  return {
    server,
    tool: name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(params !== undefined ? { params } : {}),
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

function conciseServer(server, backendState) {
  // Configured capability is known; per-server readiness and counts require waking it.
  return { server, available: null, toolCount: null, backendState };
}

function matchesServerQuery(item, query) {
  if (query === undefined) return true;
  return item.server.toLowerCase().includes(query.toLowerCase());
}

export function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function errorDetails(error) {
  const code = typeof error?.code === 'string' ? error.code : 'LOCAL_BROKER_FAILED';
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.startsWith(`${code}: `) ? raw.slice(code.length + 2) : raw;
  return { code, message };
}

function boundedToolName(name) {
  const text = typeof name === 'string' ? name : String(name);
  return { text, shown: text.length > MAX_REPORTED_TOOL_NAME_LENGTH ? `${text.slice(0, MAX_REPORTED_TOOL_NAME_LENGTH)}...` : text };
}

// The error goes back only to the caller, so nothing else records which name a client really
// sent. JSON.stringify keeps even a hostile name on one log line; the length is bounded.
export function logUnknownBrokerTool(name) {
  process.stderr.write(`local-tools: UNKNOWN_BROKER_TOOL name=${JSON.stringify(boundedToolName(name).shown)}\n`);
}

export function unknownBrokerToolMessage(name) {
  const { text, shown } = boundedToolName(name);
  const valid = `valid broker tools: ${BROKER_TOOL_NAMES.join(', ')}`;
  // Server names never contain the separator, but downstream tool names may, so split at the first one.
  const at = text.indexOf(INNER_TOOL_SEPARATOR);
  if (at > 0 && at + INNER_TOOL_SEPARATOR.length < text.length && text.length <= MAX_REPORTED_TOOL_NAME_LENGTH) {
    const server = JSON.stringify(text.slice(0, at));
    const tool = JSON.stringify(text.slice(at + INNER_TOOL_SEPARATOR.length));
    return `unknown broker tool: ${shown}; downstream tools are not broker tools, call tool_call with {"server":${server},"tool":${tool},"arguments":{...}}; ${valid}`;
  }
  return `unknown broker tool: ${shown}; ${valid}; reach downstream tools with tool_call {server, tool, arguments}`;
}

export function errorResult(error) {
  const { code, message } = errorDetails(error);
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } }
  };
}

function isPlainTextBlock(block) {
  return block !== null
    && typeof block === 'object'
    && block.type === 'text'
    && typeof block.text === 'string'
    && Object.keys(block).every(key => key === 'type' || key === 'text');
}

export function batchResult(value) {
  const content = [];
  const pushBlock = block => {
    if (isPlainTextBlock(block) && content.length > 0 && isPlainTextBlock(content[content.length - 1])) {
      content[content.length - 1] = {
        type: 'text',
        text: `${content[content.length - 1].text}\n${block.text}`,
      };
      return;
    }
    content.push(block);
  };
  for (const entry of value.results) {
    const baseLabel = entry.id === undefined ? String(entry.index) : `${entry.index} (${entry.id})`;
    const routeTag = value.server === undefined && entry.server && entry.tool ? ` [${entry.server}/${entry.tool}]` : '';
    const label = `${baseLabel}${routeTag}`;
    if (entry.status === 'rejected') {
      pushBlock({ type: 'text', text: `call ${label}: rejected ${entry.error.code}: ${entry.error.message}` });
      continue;
    }
    pushBlock({
      type: 'text',
      text: `call ${label}: fulfilled${entry.result?.isError === true ? ' (downstream isError)' : ''}`
    });
    if (Array.isArray(entry.result?.content)) {
      for (const block of entry.result.content) pushBlock(block);
    }
  }
  return { content, structuredContent: value };
}

function normalizeBatchConcurrency(value, callCount) {
  const concurrency = value === undefined ? DEFAULT_BATCH_CONCURRENCY : value;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_BATCH_CONCURRENCY) {
    throw brokerError('INVALID_ARGUMENT', `concurrency must be an integer from 1 to ${MAX_BATCH_CONCURRENCY}`);
  }
  return Math.min(concurrency, callCount);
}

export class LocalToolBroker {
  constructor({ inner, configPath, fallbackOnlyServers = [], recovery = {}, logger = null }) {
    if (
      !inner
      || typeof inner.listServerTools !== 'function'
      || typeof inner.callServerTool !== 'function'
      || typeof inner.close !== 'function'
    ) {
      throw new TypeError('inner with listServerTools(), callServerTool(), and close() is required');
    }
    requiredString(configPath, 'configPath');
    if (!Array.isArray(fallbackOnlyServers)) throw new TypeError('fallbackOnlyServers must be an array');
    this.inner = inner;
    this.configPath = configPath;
    this.logger = logger;
    this.fallbackOnlyServers = new Set();
    for (const server of fallbackOnlyServers) {
      validateServerName(server, 'INVALID_FALLBACK_SERVER_NAME');
      this.fallbackOnlyServers.add(server);
    }
    if (recovery === null || typeof recovery !== 'object' || Array.isArray(recovery)) {
      throw new TypeError('recovery must be an object');
    }
    this.recoveryTimeoutMs = boundedDuration(recovery.timeoutMs, DEFAULT_DOWNSTREAM_RECOVERY_TIMEOUT_MS, 'recovery.timeoutMs');
    this.recoveryPollMs = boundedDuration(recovery.pollMs, DEFAULT_DOWNSTREAM_READY_POLL_MS, 'recovery.pollMs');
    this.closed = false;
    this.recoveryPromises = new Map();
    this.learnedReadOnlyTools = new Map();
  }

  _recordToolAnnotations(server, tools) {
    if (typeof server !== 'string' || !Array.isArray(tools) || tools.length === 0) return;
    let map = this.learnedReadOnlyTools.get(server);
    if (!map) {
      map = new Map();
      this.learnedReadOnlyTools.set(server, map);
    }
    for (const toolDef of tools) {
      if (typeof toolDef?.name !== 'string' || !toolDef.name) continue;
      if (typeof toolDef.annotations?.readOnlyHint === 'boolean') {
        map.set(toolDef.name, toolDef.annotations.readOnlyHint);
      }
    }
  }

  isReadOnlyRoute(server, tool, args) {
    if (typeof server !== 'string' || typeof tool !== 'string') return false;
    const normalized = normalizeRouteTool(server, tool);
    if (isArgumentSensitiveReadOnlyRoute(server, normalized)) {
      return isKnownReadOnlyRoute(server, normalized, args);
    }
    const learned = this.learnedReadOnlyTools.get(server)?.get(normalized);
    if (typeof learned === 'boolean') return learned;
    return isKnownReadOnlyRoute(server, normalized, args);
  }

  async configuredServers() {
    const entry = await readCachedInnerConfig(this.configPath);
    for (const server of entry.servers) validateServerName(server, 'INVALID_INNER_SERVER_NAME');
    return new Set(entry.servers);
  }

  async publicServers() {
    const servers = await this.configuredServers();
    for (const server of this.fallbackOnlyServers) servers.delete(server);
    return servers;
  }

  _passthroughBackendError(error) {
    return error?.code === 'INNER_UNAVAILABLE'
      || error?.code === 'DOWNSTREAM_UNAVAILABLE'
      || error?.code === 'INNER_CONFIG_INVALID'
      || error?.code === 'UNKNOWN_SERVER';
  }

  async serverPage(server, cursor, options) {
    if (this.closed) throw brokerError('LOCAL_BROKER_CLOSED', 'local tool broker is shut down');
    try {
      const page = await this.inner.listServerTools(server, cursor, options);
      this._recordToolAnnotations(server, page?.tools);
      return page;
    } catch (error) {
      if (this._passthroughBackendError(error)) throw error;
      throw brokerError('INNER_LIST_FAILED', withCauseDetail(`failed to list tools for ${server}`, error), error);
    }
  }

  async hasServerTools(server) {
    let cursor;
    const seenCursors = new Set();
    while (true) {
      const cursorKey = cursor ?? '';
      if (seenCursors.has(cursorKey)) throw brokerError('INNER_LIST_FAILED', 'inner tools/list cursor repeated');
      seenCursors.add(cursorKey);
      const page = await this.serverPage(server, cursor);
      for (const toolDef of page.tools ?? []) {
        if (typeof toolDef?.name === 'string' && toolDef.name.length > 0) return true;
      }
      if (page.nextCursor === undefined) return false;
      cursor = page.nextCursor;
    }
  }

  // A cold backend can take time to register tools after starting/restarting,
  // so poll with bounded backoff up to the recovery deadline.
  async waitForServerTools(server, deadline = Date.now() + this.recoveryTimeoutMs) {
    let interval = this.recoveryPollMs;
    while (true) {
      try {
        if (await this.hasServerTools(server)) return true;
      } catch (error) {
        if (this._passthroughBackendError(error)) throw error;
        // Transient startup/listing error while recovering: keep polling until deadline.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(interval, remaining));
      interval = Math.min(interval * 2, MAX_DOWNSTREAM_READY_POLL_MS);
    }
  }

  async recoverServer(server) {
    const active = this.recoveryPromises.get(server);
    if (active) return active;
    this.learnedReadOnlyTools.delete(server);
    const recovery = (async () => {
      const startedAt = Date.now();
      const deadline = startedAt + this.recoveryTimeoutMs;
      if (typeof this.inner.restartServer !== 'function') {
        throw brokerError('DOWNSTREAM_RECOVERY_FAILED', `local backend cannot restart server: ${server}`);
      }
      try {
        await this.inner.restartServer(server, { timeoutMs: this.recoveryTimeoutMs });
      } catch (error) {
        if (this._passthroughBackendError(error)) throw error;
        this.logger?.log('error', {
          event: 'server_recovery_failed',
          server,
          duration_ms: Date.now() - startedAt,
          error: causeSummary(error)
        });
        throw brokerError('DOWNSTREAM_RECOVERY_FAILED', withCauseDetail(`failed to restart local server: ${server}`, error), error);
      }
      if (!await this.waitForServerTools(server, deadline)) {
        const waited = ((Date.now() - startedAt) / 1000).toFixed(1);
        throw brokerError('DOWNSTREAM_UNAVAILABLE', `local server is configured but unavailable after ${waited}s: ${server}`);
      }
      this.logger?.log('info', {
        event: 'server_recovered',
        server,
        duration_ms: Date.now() - startedAt
      });
    })();
    this.recoveryPromises.set(server, recovery);
    try {
      return await recovery;
    } finally {
      if (this.recoveryPromises.get(server) === recovery) this.recoveryPromises.delete(server);
    }
  }

  async ensureServerAvailable(server) {
    // Do not swallow an initial startup error behind a blind restart unless the
    // server actually started with zero tools or died.
    let initialOk = false;
    try {
      initialOk = await this.hasServerTools(server);
    } catch (error) {
      if (this._passthroughBackendError(error)) throw error;
      if (typeof this.inner.canAutoRecover === 'function' && !await this.inner.canAutoRecover(server)) {
        throw error;
      }
    }
    if (initialOk) return;
    if (typeof this.inner.canAutoRecover === 'function' && !await this.inner.canAutoRecover(server)) {
      throw brokerError('DOWNSTREAM_UNAVAILABLE', `local server is unavailable and restartOnExit is false: ${server}`);
    }
    if (await this.waitForServerTools(server, Date.now() + this.recoveryPollMs)) return;
    await this.recoverServer(server);
  }

  async list({ server, query, limit, cursor } = {}) {
    if (this.closed) throw brokerError('LOCAL_BROKER_CLOSED', 'local tool broker is shut down');
    const selectedServer = optionalString(server, 'server');
    const selectedQuery = optionalString(query, 'query');
    if (selectedServer !== undefined) validateServerName(selectedServer);
    const selectedLimit = normalizeLimit(limit);
    const publicServers = await this.publicServers();
    const inspectableServers = selectedServer === undefined ? publicServers : await this.configuredServers();
    if (selectedServer !== undefined && !inspectableServers.has(selectedServer)) {
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

    if (selectedServer === undefined) {
      if (pageCursor !== undefined) throw brokerError('INVALID_CURSOR', 'unscoped server discovery cursor is invalid');
      const serverStateFor = name => (
        typeof this.inner.serverState === 'function'
          ? this.inner.serverState(name)
          : (this.inner.state ?? 'unknown')
      );
      const matching = Array.from(publicServers)
        .map(name => conciseServer(name, serverStateFor(name)))
        .filter(item => matchesServerQuery(item, selectedQuery));
      const servers = matching.slice(offset, offset + selectedLimit);
      const nextOffset = offset + servers.length;
      const hasMore = nextOffset < matching.length;
      return {
        servers,
        hasMore,
        ...(hasMore ? { nextCursor: encodeCursor({ offset: nextOffset, query: selectedQuery }) } : {})
      };
    }

    await this.ensureServerAvailable(selectedServer);
    const tools = [];
    const seenCursors = new Set();
    while (true) {
      const cursorKey = pageCursor ?? '';
      if (seenCursors.has(cursorKey)) throw brokerError('INNER_LIST_FAILED', 'inner tools/list cursor repeated');
      seenCursors.add(cursorKey);

      const page = await this.serverPage(selectedServer, pageCursor);
      const serverTools = Array.isArray(page.tools) ? page.tools : [];
      const start = Math.min(offset, serverTools.length);
      for (let index = start; index < serverTools.length; index += 1) {
        const toolDef = serverTools[index];
        if (typeof toolDef?.name !== 'string' || toolDef.name.length === 0) continue;
        const item = conciseTool(toolDef, selectedServer, toolDef.name);
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
    const selectedTool = normalizeRouteTool(selectedServer, requiredString(tool, 'tool'));
    const inspectableServers = await this.configuredServers();
    if (!inspectableServers.has(selectedServer)) throw brokerError('UNKNOWN_SERVER', `unknown local server: ${selectedServer}`);
    await this.ensureServerAvailable(selectedServer);

    let cursor;
    const seenCursors = new Set();
    while (true) {
      const cursorKey = cursor ?? '';
      if (seenCursors.has(cursorKey)) throw brokerError('INNER_LIST_FAILED', 'inner tools/list cursor repeated');
      seenCursors.add(cursorKey);
      const page = await this.serverPage(selectedServer, cursor);
      const found = (page.tools ?? []).find(toolDef => toolDef?.name === selectedTool);
      if (found) return { server: selectedServer, tool: selectedTool, definition: { ...found, name: selectedTool } };
      if (page.nextCursor === undefined) throw brokerError('UNKNOWN_TOOL', `unknown tool ${selectedServer}/${selectedTool}`);
      cursor = page.nextCursor;
    }
  }

  prepareRoute({ server, tool } = {}, allowedServers) {
    const selectedServer = validateServerName(server);
    const selectedTool = normalizeRouteTool(selectedServer, requiredString(tool, 'tool'));
    if (!allowedServers.has(selectedServer)) throw brokerError('UNKNOWN_SERVER', `unknown local server: ${selectedServer}`);
    return { server: selectedServer, tool: selectedTool };
  }

  prepareArguments(args = {}) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw brokerError('INVALID_ARGUMENT', 'arguments must be an object');
    }
    return args;
  }

  async _lookupSchemaViolation(server, tool, args, signal, { timeoutMs = SCHEMA_HINT_LOOKUP_TIMEOUT_MS } = {}) {
    if (this.closed || signal?.aborted) return null;
    // Never trigger downstream wake/recovery/restart merely to format a schema hint.
    if (typeof this.inner.isServerLive === 'function' && !this.inner.isServerLive(server)) return null;
    const lookupController = new AbortController();
    const onCallerAbort = () => lookupController.abort(signal?.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => lookupController.abort(new Error('schema hint lookup timed out')), timeoutMs);
    timer.unref?.();
    const lookupOptions = { signal: lookupController.signal, timeout: timeoutMs };

    const fetchSchema = async () => {
      let cursor;
      const seen = new Set();
      while (true) {
        if (lookupController.signal.aborted) return null;
        const key = cursor ?? '';
        if (seen.has(key)) return null;
        seen.add(key);
        const page = typeof this.inner.listLiveServerTools === 'function'
          ? await this.inner.listLiveServerTools(server, cursor, lookupOptions)
          : (typeof this.inner.isServerLive === 'function' && !this.inner.isServerLive(server)
            ? null
            : await this.serverPage(server, cursor, lookupOptions));
        if (!page) return null;
        const found = (page.tools ?? []).find(t => t?.name === tool);
        if (found) return found.inputSchema ?? null;
        if (page.nextCursor === undefined) return null;
        cursor = page.nextCursor;
      }
    };
    const abortWait = new Promise(resolve => {
      if (lookupController.signal.aborted) { resolve(null); return; }
      lookupController.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    const fetchPromise = fetchSchema().catch(() => null);
    try {
      const inputSchema = await Promise.race([fetchPromise, abortWait]);
      return explainSchemaViolation(inputSchema, args);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
      lookupController.abort();
    }
  }

  async dispatch({ server, tool }, args, signal) {
    if (!this.isReadOnlyRoute(server, tool, args)) markMutation('unknown');
    try {
      const result = await this.inner.callServerTool(server, tool, args, signal);
      if (
        result?.isError === true
        && Array.isArray(result.content)
        && result.content.some(item => item?.type === 'text' && looksLikeSchemaValidationError(item.text))
      ) {
        const detail = await this._lookupSchemaViolation(server, tool, args, signal);
        return enrichSchemaValidationResult(server, tool, result, detail);
      }
      return result;
    } catch (error) {
      if (this._passthroughBackendError(error)) throw error;
      const baseMsg = withCauseDetail(`failed to call ${server}/${tool}`, error);
      const isSchemaErr = error?.code === -32602 || looksLikeSchemaValidationError(baseMsg);
      if (isSchemaErr) {
        const detail = await this._lookupSchemaViolation(server, tool, args, signal);
        const hint = formatSchemaValidationHint(server, tool, detail);
        throw brokerError('INNER_CALL_FAILED', `${baseMsg}\n${hint}`, error);
      }
      throw brokerError('INNER_CALL_FAILED', baseMsg, error);
    }
  }

  async callWithAllowedServers({ server, tool, arguments: args = {} } = {}, allowedServers, signal) {
    if (this.closed) throw brokerError('LOCAL_BROKER_CLOSED', 'local tool broker is shut down');
    const route = this.prepareRoute({ server, tool }, allowedServers);
    try {
      return await this.dispatch(route, this.prepareArguments(args), signal);
    } catch (error) {
      if (error?.code !== 'INNER_CALL_FAILED' || error?.cause?.code === 'INNER_START_FAILED' || signal?.aborted) throw error;
      const stillLive = typeof this.inner.isServerLive === 'function' ? this.inner.isServerLive(route.server) : true;
      if (stillLive) throw error;
      if (typeof this.inner.canAutoRecover === 'function' && !await this.inner.canAutoRecover(route.server)) {
        throw error;
      }
      await this.recoverServer(route.server);
      throw brokerError(
        'DOWNSTREAM_RECOVERED_RETRY_REQUIRED',
        `local server ${route.server} was unavailable and has been recovered; the original call outcome is unknown, so inspect state before retrying consequential work`,
        error
      );
    }
  }

  async call(args = {}, signal) {
    return this.callWithAllowedServers(args, await this.publicServers(), signal);
  }

  async fallbackDispatch(args = {}, signal) {
    if (args && typeof args === 'object' && !Array.isArray(args) && args.calls !== undefined) {
      if (args.arguments !== undefined) {
        throw brokerError('INVALID_ARGUMENT', 'pass either arguments (single call) or calls (batch), not both');
      }
      return batchResult(await this.batchWithAllowedServers(args, await this.configuredServers(), signal, { allowHeterogeneous: true }));
    }
    if (args && typeof args === 'object' && !Array.isArray(args) && (args.concurrency !== undefined || args.sequential !== undefined || args.stop_on_error !== undefined)) {
      throw brokerError('INVALID_ARGUMENT', 'concurrency, sequential, and stop_on_error require calls (batch mode)');
    }
    return this.callWithAllowedServers(args, await this.configuredServers(), signal);
  }

  async batch(args = {}, signal) {
    return this.batchWithAllowedServers(args, await this.publicServers(), signal, { allowHeterogeneous: false });
  }

  async batchWithAllowedServers({ server, tool, calls, concurrency, sequential = false, stop_on_error: stopOnError } = {}, allowedServers, signal, { allowHeterogeneous = false } = {}) {
    if (this.closed) throw brokerError('LOCAL_BROKER_CLOSED', 'local tool broker is shut down');
    if (!Array.isArray(calls) || calls.length < 1 || calls.length > MAX_BATCH_CALLS) {
      throw brokerError('INVALID_ARGUMENT', `calls must contain from 1 to ${MAX_BATCH_CALLS} entries`);
    }
    if (typeof sequential !== 'boolean') {
      throw brokerError('INVALID_ARGUMENT', 'sequential must be a boolean');
    }
    if (stopOnError !== undefined && typeof stopOnError !== 'boolean') {
      throw brokerError('INVALID_ARGUMENT', 'stop_on_error must be a boolean');
    }
    if (stopOnError !== undefined && !sequential) {
      throw brokerError('INVALID_ARGUMENT', 'stop_on_error requires sequential: true');
    }
    const effectiveStopOnError = sequential ? (stopOnError ?? true) : false;
    if (concurrency !== undefined) normalizeBatchConcurrency(concurrency, calls.length);
    if (sequential && concurrency !== undefined && concurrency > 1) {
      throw brokerError('INVALID_ARGUMENT', 'concurrency > 1 cannot be combined with sequential: true');
    }

    const defaultRoute = allowHeterogeneous
      ? null
      : this.prepareRoute({ server, tool }, allowedServers);
    const prepared = calls.map((call, index) => {
      if (call === null || typeof call !== 'object' || Array.isArray(call)) {
        throw brokerError('INVALID_ARGUMENT', `calls[${index}] must be an object`);
      }
      const { id, arguments: args = {} } = call;
      if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > MAX_BATCH_ID_LENGTH)) {
        throw brokerError('INVALID_ARGUMENT', `id must be a non-empty string up to ${MAX_BATCH_ID_LENGTH} characters`);
      }
      const route = defaultRoute ?? this.prepareRoute(
        { server: call.server ?? server, tool: call.tool ?? tool },
        allowedServers
      );
      return {
        ...(id === undefined ? {} : { id }),
        route,
        arguments: this.prepareArguments(args),
      };
    });

    if (!sequential) {
      const uniqueServers = [...new Set(prepared.map(item => item.route.server))];
      await Promise.all(uniqueServers.map(serverName => this.ensureServerAvailable(serverName)));
    }

    const homogeneous = prepared.every(
      item => item.route.server === prepared[0].route.server && item.route.tool === prepared[0].route.tool
    );
    const results = new Array(prepared.length);

    if (sequential) {
      let failedPrior = false;
      for (let index = 0; index < prepared.length; index += 1) {
        if (signal?.aborted) break;
        const call = prepared[index];
        const identity = {
          index,
          ...(call.id === undefined ? {} : { id: call.id }),
          ...(homogeneous ? {} : { server: call.route.server, tool: call.route.tool }),
        };
        if (failedPrior && effectiveStopOnError) {
          results[index] = {
            ...identity,
            status: 'rejected',
            error: { code: 'SKIPPED_AFTER_PRIOR_FAILURE', message: 'skipped after prior failure in sequential batch' },
          };
          continue;
        }
        try {
          await this.ensureServerAvailable(call.route.server);
          const result = await this.dispatch(call.route, call.arguments, signal);
          results[index] = { ...identity, status: 'fulfilled', result };
          if (effectiveStopOnError && isFailedBatchEntryResult(call.route, result)) {
            failedPrior = true;
          }
        } catch (error) {
          if (signal?.aborted) break;
          results[index] = { ...identity, status: 'rejected', error: errorDetails(error) };
          if (effectiveStopOnError) failedPrior = true;
        }
      }
    } else {
      const workerCount = normalizeBatchConcurrency(concurrency, prepared.length);
      let nextIndex = 0;

      const runWorker = async () => {
        while (true) {
          if (signal?.aborted) return;
          const index = nextIndex;
          nextIndex += 1;
          if (index >= prepared.length) return;
          if (signal?.aborted) return;
          const call = prepared[index];
          const identity = {
            index,
            ...(call.id === undefined ? {} : { id: call.id }),
            ...(homogeneous ? {} : { server: call.route.server, tool: call.route.tool }),
          };
          try {
            results[index] = { ...identity, status: 'fulfilled', result: await this.dispatch(call.route, call.arguments, signal) };
          } catch (error) {
            if (signal?.aborted) return;
            results[index] = { ...identity, status: 'rejected', error: errorDetails(error) };
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    }

    if (signal?.aborted) throw signal.reason ?? brokerError('REQUEST_CANCELLED', 'tool batch was cancelled');
    return homogeneous
      ? { server: prepared[0].route.server, tool: prepared[0].route.tool, ...(sequential ? { sequential: true } : {}), results }
      : { ...(sequential ? { sequential: true } : {}), results };
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    await this.inner.close();
    await this.logger?.flush();
  }
}
