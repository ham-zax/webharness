import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PersistentOAuthProvider } from './oauth.mjs';

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
    return await connection.client.listTools(undefined, { timeout: 15_000 });
  } finally {
    await connection.close();
  }
}

export async function callMcpTool(options, name, args, hooks = {}) {
  const connection = await connectMcp(options);
  try {
    const listed = await connection.client.listTools(undefined, { timeout: 15_000 });
    if (!listed.tools.some(tool => tool.name === name)) throw new Error(`MCP tool is unavailable: ${name}`);
    if (hooks.onBeforeDispatch) await hooks.onBeforeDispatch();
    return await connection.client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  } finally {
    await connection.close();
  }
}
