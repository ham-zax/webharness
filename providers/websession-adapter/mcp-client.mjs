import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { PersistentOAuthProvider } from './oauth.mjs';

const TOOL_NAME_TTL_MS = 60_000;

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

export async function connectMcp({ mcpUrl, stateDir, callbackUrl }) {
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

  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }

  return {
    client,
    async close() {
      await client.close().catch(() => transport.close().catch(() => {}));
    },
  };
}

export async function listMcpTools(options) {
  const connection = await connectMcp(options);
  try {
    const listed = await connection.client.listTools(undefined, { timeout: 15_000 });
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
      connection.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
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
  if (previous) await previous.close().catch(() => {});
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
    // Dispatch is never retried: the caller has already persisted dispatch intent.
    // If callTool fails, evict the pooled connection so subsequent calls reconnect cleanly.
    try {
      return await connection.client.callTool({ name, arguments: args }, undefined, { timeout: options.timeoutMs ?? 120_000 });
    } catch (error) {
      if (entry.connection === connection) {
        entry.connection = undefined;
        entry.connecting = undefined;
        entry.toolNames = undefined;
        entry.toolNamesAt = 0;
        connection.close().catch(() => {});
      }
      throw error;
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
