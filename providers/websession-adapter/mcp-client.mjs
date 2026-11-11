import { Client, ProtocolError, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PersistentOAuthProvider } from './oauth.mjs';

const TOOL_NAME_TTL_MS = 60_000;

function isRequestTimeout(error) {
  if (error?.code === 'REQUEST_TIMEOUT' || error?.code === -32001) return true;
  return /timed out/i.test(typeof error?.message === 'string' ? error.message : '');
}

// Failures isolated to one request must not cost the other sessions their
// pooled execution connection. Only transport, network, HTTP status
// (SdkHttpError: 401/403/404/5xx) and closed-connection failures evict it.
function shouldEvictAfterError(error, signal, connection) {
  if (signal?.aborted || error?.name === 'AbortError') return false;
  if (error instanceof SdkHttpError) return true;
  if (error instanceof ProtocolError) return !connection.client.transport;
  if (isRequestTimeout(error) && connection.client.transport) return false;
  return true;
}

// Execution connections stay open so repeated tool calls skip the MCP handshake.
// Discovery (listMcpTools) always reconnects: initialize instructions are only
// sent during the handshake, so a pooled client would return stale guidance.
const pools = new Map();

function makeProvider({ stateDir, callbackUrl }) {
  return new PersistentOAuthProvider({
    stateDir,
    redirectUrl: callbackUrl,
    onRedirect: () => {
      throw new Error('adapter OAuth authorization is required; run bin/adapter auth');
    },
  });
}

export async function connectMcp({ mcpUrl, stateDir, callbackUrl, signal, onToolsChanged }) {
  const provider = makeProvider({ stateDir, callbackUrl });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    authProvider: provider,
    requestInit: {
      headers: {
        'user-agent': 'websession-adapter/1',
      },
    },
  });
  // `versionNegotiation.mode: 'auto'` probes server/discover and selects the
  // modern stateless 2026-07-28 era, falling back to the legacy initialize
  // handshake for servers that answer -32601. The SDK default is 'legacy'.
  const client = new Client(
    { name: 'websession-adapter', version: '0.1.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' }, ...(onToolsChanged ? { listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: onToolsChanged } } } : {}) },
  );

  const onAbort = () => { transport.close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    await client.connect(transport, { signal });
  } catch (error) {
    signal?.removeEventListener('abort', onAbort);
    await transport.close().catch(() => {});
    throw error;
  }

  signal?.removeEventListener('abort', onAbort);
  return {
    client,
    inFlight: 0,
    evicted: false,
    async close() {
      signal?.removeEventListener('abort', onAbort);
      await client.close().catch(() => transport.close().catch(() => {}));
    },
  };
}

export async function listMcpTools(options) {
  const connection = await connectMcp(options);
  try {
    const listed = await connection.client.listTools(undefined, { timeout: 15_000, signal: options.signal });
    const instructions = connection.client.getInstructions();
    return { ...listed, ...(instructions ? { instructions } : {}) };
  } finally {
    await connection.close();
  }
}

function poolKey({ mcpUrl, stateDir }) {
  return `${mcpUrl}\0${stateDir}`;
}

function poolEntry(options) {
  const key = poolKey(options);
  let entry = pools.get(key);
  if (!entry) {
    entry = { key, connection: undefined, connecting: undefined, generation: 0, revision: 0, toolNames: undefined, toolNamesAt: 0, closed: false };
    pools.set(key, entry);
  }
  return entry;
}

async function waitFor(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function ensureConnection(entry, options) {
  options.signal?.throwIfAborted();
  if (entry.closed) throw new Error('MCP pool was closed');
  if (entry.connection) return entry.connection;
  if (!entry.connecting) {
    const generation = (entry.generation = (entry.generation ?? 0) + 1);
    const controller = new AbortController();
    entry.connectController = controller;
    const pending = (async () => {
      let connection;
      connection = await connectMcp({ ...options, signal: controller.signal, onToolsChanged: () => {
        if (entry.connection === connection) {
          entry.revision += 1;
          entry.toolNames = undefined;
          entry.toolNamesAt = 0;
        }
      } });
      if (entry.closed || entry.generation !== generation) {
        await connection.close().catch(() => {});
        throw new Error('MCP connection was replaced while connecting');
      }
      connection.client.onclose = () => {
        if (entry.connection === connection) {
          entry.connection = undefined;
          entry.toolNames = undefined;
          entry.toolNamesAt = 0;
        }
        connection.evicted = true;
      };
      entry.connection = connection;
      entry.toolNames = undefined;
      entry.toolNamesAt = 0;
      return connection;
    })();
    pending.catch(() => {});
    entry.connecting = pending;
  }
  const pending = entry.connecting;
  try {
    return await waitFor(pending, options.signal);
  } finally {
    pending.finally(() => {
      if (entry.connecting === pending) {
        entry.connecting = undefined;
        entry.connectController = undefined;
      }
    }).catch(() => {});
  }
}

async function refreshConnection(entry, options) {
  const previous = entry.connection;
  entry.connection = undefined;
  entry.connecting = undefined;
  entry.listingTools = undefined;
  entry.connectController?.abort();
  entry.generation = (entry.generation ?? 0) + 1;
  entry.toolNames = undefined;
  entry.toolNamesAt = 0;
  if (previous) {
    previous.evicted = true;
    if (!previous.inFlight) await previous.close().catch(() => {});
  }
  return ensureConnection(entry, options);
}

async function ensureToolNames(entry, connection, signal) {
  signal?.throwIfAborted();
  if (entry.toolNames && Date.now() - entry.toolNamesAt < TOOL_NAME_TTL_MS) return entry.toolNames;
  if (!entry.listingTools) {
    const pending = (async () => {
      for (;;) {
        const revision = entry.revision;
        const listed = await connection.client.listTools(undefined, { timeout: 15_000, cacheMode: 'refresh' });
        const names = new Set(listed.tools.map(tool => tool.name));
        if (entry.connection !== connection) throw new Error('MCP connection changed while listing tools');
        if (revision !== entry.revision) continue;
        entry.toolNames = names;
        entry.toolNamesAt = Date.now();
        return names;
      }
    })();
    pending.catch(() => {});
    entry.listingTools = pending;
  }
  const pending = entry.listingTools;
  try {
    return await waitFor(pending, signal);
  } finally {
    pending.finally(() => {
      if (entry.listingTools === pending) entry.listingTools = undefined;
    }).catch(() => {});
  }
}

export async function callMcpTool(options, name, args, hooks = {}) {
  const entry = poolEntry(options);
  let refreshed = false;
  for (;;) {
    let connection;
    let toolNames;
    try {
      connection = await ensureConnection(entry, options);
      toolNames = await ensureToolNames(entry, connection, options.signal);
    } catch (error) {
      if (options.signal?.aborted || entry.closed) throw error;
      if (refreshed) throw error;
      refreshed = true;
      await refreshConnection(entry, options).catch(() => {});
      continue;
    }
    options.signal?.throwIfAborted();
    if (!toolNames.has(name)) {
      if (refreshed) throw new Error(`MCP tool is unavailable: ${name}`);
      refreshed = true;
      await refreshConnection(entry, options).catch(() => {});
      continue;
    }
    // Dispatch intent is persisted, so exactly one callTool attempt follows.
    // No error text or error code ever replays it: a duplicate mutation is
    // worse than an unknown outcome. Modern 2026-07-28 HTTP has no legacy
    // single-flight admission lease to wait on either.
    connection.inFlight = (connection.inFlight ?? 0) + 1;
    let invoked = false;
    try {
      if (hooks.onBeforeDispatch) await hooks.onBeforeDispatch();
      invoked = true;
      return await connection.client.callTool(
        { name, arguments: args },
        { timeout: options.timeoutMs ?? 120_000, ...(options.signal ? { signal: options.signal } : {}) },
      );
    } catch (error) {
      if (invoked && shouldEvictAfterError(error, options.signal, connection)) {
        if (entry.connection === connection) {
          entry.connection = undefined;
          entry.connecting = undefined;
          entry.toolNames = undefined;
          entry.toolNamesAt = 0;
        }
        connection.evicted = true;
      }
      throw error;
    } finally {
      connection.inFlight = Math.max(0, (connection.inFlight ?? 1) - 1);
      if (connection.evicted && connection.inFlight === 0) {
        connection.close().catch(() => {});
      }
    }
  }
}

export async function closeMcpPools() {
  const entries = [...pools.values()];
  pools.clear();
  const pending = [];
  for (const entry of entries) {
    const connection = entry.connection;
    entry.closed = true;
    entry.connectController?.abort();
    if (entry.connecting) pending.push(entry.connecting.catch(() => {}));
    entry.generation = (entry.generation ?? 0) + 1;
    entry.connection = undefined;
    entry.connecting = undefined;
    entry.toolNames = undefined;
    entry.toolNamesAt = 0;
    if (connection) pending.push(connection.close().catch(() => {}));
  }
  await Promise.all(pending);
}
