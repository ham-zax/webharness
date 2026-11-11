import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PersistentOAuthProvider } from './oauth.mjs';

const TOOL_NAME_TTL_MS = 60_000;
const CAPACITY_RETRY_INITIAL_MS = 20;
const CAPACITY_RETRY_MAX_MS = 250;

function isInteractionCapacityExceeded(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (!message.includes('interaction_capacity_exceeded')) return false;
  return error?.code === -32000 || message.includes('-32000');
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

export async function connectMcp({ mcpUrl, stateDir, callbackUrl, signal }) {
  const provider = makeProvider({ stateDir, callbackUrl });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    authProvider: provider,
    requestInit: {
      headers: {
        'user-agent': 'websession-adapter/1',
      },
    },
  });
  const client = new Client({ name: 'websession-adapter', version: '0.1.0' }, { capabilities: {} });

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
    entry = { key, connection: undefined, connecting: undefined, generation: 0, toolNames: undefined, toolNamesAt: 0 };
    pools.set(key, entry);
  }
  return entry;
}

async function ensureConnection(entry, options) {
  if (entry.connection) return entry.connection;
  if (!entry.connecting) {
    const generation = (entry.generation = (entry.generation ?? 0) + 1);
    const pending = (async () => {
      const connection = await connectMcp(options);
      if (entry.generation !== generation) {
        await connection.close().catch(() => {});
        throw new Error('MCP connection was replaced while connecting');
      }
      connection.client.setNotificationHandler('notifications/tools/list_changed', () => {
        if (entry.connection === connection) {
          entry.toolNames = undefined;
          entry.toolNamesAt = 0;
        }
      });
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
    return await pending;
  } finally {
    if (entry.connecting === pending) entry.connecting = undefined;
  }
}

async function refreshConnection(entry, options) {
  const previous = entry.connection;
  entry.connection = undefined;
  entry.connecting = undefined;
  entry.listingTools = undefined;
  entry.generation = (entry.generation ?? 0) + 1;
  entry.toolNames = undefined;
  entry.toolNamesAt = 0;
  if (previous) {
    previous.evicted = true;
    if (!previous.inFlight) await previous.close().catch(() => {});
  }
  return ensureConnection(entry, options);
}

async function ensureToolNames(entry, connection) {
  if (entry.toolNames && Date.now() - entry.toolNamesAt < TOOL_NAME_TTL_MS) return entry.toolNames;
  if (!entry.listingTools) {
    const pending = (async () => {
      const listed = await connection.client.listTools(undefined, { timeout: 15_000 });
      const names = new Set(listed.tools.map(tool => tool.name));
      if (entry.connection === connection) {
        entry.toolNames = names;
        entry.toolNamesAt = Date.now();
      }
      return names;
    })();
    pending.catch(() => {});
    entry.listingTools = pending;
  }
  const pending = entry.listingTools;
  try {
    return await pending;
  } finally {
    if (entry.listingTools === pending) entry.listingTools = undefined;
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
      toolNames = await ensureToolNames(entry, connection);
    } catch (error) {
      if (refreshed) throw error;
      refreshed = true;
      await refreshConnection(entry, options).catch(() => {});
      continue;
    }
    if (!toolNames.has(name)) {
      if (refreshed) throw new Error(`MCP tool is unavailable: ${name}`);
      refreshed = true;
      await refreshConnection(entry, options).catch(() => {});
      continue;
    }
    if (hooks.onBeforeDispatch) await hooks.onBeforeDispatch();
    // Real backend failures are never retried once dispatch intent is persisted.
    // Upstream 1MCP 0.39+ rejects concurrent legacy-era calls to the same backend
    // provider at gateway admission (-32000 interaction_capacity_exceeded) before
    // invoking the backend tool; wait briefly on the healthy pooled connection.
    const totalTimeoutMs = options.timeoutMs ?? 120_000;
    const deadline = Date.now() + totalTimeoutMs;
    let backoffMs = CAPACITY_RETRY_INITIAL_MS;
    connection.inFlight = (connection.inFlight ?? 0) + 1;
    try {
      for (;;) {
        const remainingMs = Math.max(1, deadline - Date.now());
        try {
          return await connection.client.callTool({ name, arguments: args }, { timeout: remainingMs });
        } catch (error) {
          if (isInteractionCapacityExceeded(error)) {
            const waitMs = Math.min(backoffMs, deadline - Date.now());
            if (waitMs > 5) {
              backoffMs = Math.min(CAPACITY_RETRY_MAX_MS, backoffMs * 2);
              await sleepMs(waitMs);
              continue;
            }
            error.beforeBackendDispatch = true;
            throw error;
          }
          if (entry.connection === connection) {
            entry.connection = undefined;
            entry.connecting = undefined;
            entry.toolNames = undefined;
            entry.toolNamesAt = 0;
          }
          connection.evicted = true;
          throw error;
        }
      }
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
    entry.generation = (entry.generation ?? 0) + 1;
    entry.connection = undefined;
    entry.connecting = undefined;
    entry.toolNames = undefined;
    entry.toolNamesAt = 0;
    if (connection) pending.push(connection.close().catch(() => {}));
  }
  await Promise.all(pending);
}
