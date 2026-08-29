import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureWindowsChrome } from './windows-chrome-runtime.mjs';

export const CHROME_DEVTOOLS_MCP_VERSION = '1.7.0';
export const BROWSER_TARGET_FIELD = 'browser_target';

const OS_TEMP_PATH_FIELDS = new Set([
  'filePath',
  'requestFilePath',
  'responseFilePath',
  'outputDirPath'
]);
const OS_TEMP_PATH_GUIDANCE = 'In this deployment, explicit paths must be inside the selected target\'s OS temporary directory.';

const BASE_CHROME_ARGS = [
  '-y',
  `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
  '--no-usage-statistics',
  '--no-performance-crux'
];

function browserError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function linuxBrowserEnv(env = process.env) {
  const values = {};
  for (const key of ['XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'DISPLAY', 'PULSE_SERVER', 'GALLIUM_DRIVER']) {
    if (env[key] !== undefined) values[key] = env[key];
  }
  return values;
}

export function childConfig(target, env = process.env, extraArgs = [], { browserUrl } = {}) {
  if (!Array.isArray(extraArgs) || extraArgs.some(value => typeof value !== 'string')) throw new TypeError('extraArgs must be a string array');
  if (target === 'linux') {
    return {
      command: 'npx',
      args: [...BASE_CHROME_ARGS, ...extraArgs],
      env: linuxBrowserEnv(env),
      stderr: 'inherit'
    };
  }
  if (target === 'windows') {
    if (typeof browserUrl !== 'string' || browserUrl.length === 0) {
      throw browserError('WINDOWS_BROWSER_URL_REQUIRED', 'dedicated Windows MCP Chrome endpoint is required');
    }
    return {
      command: '/mnt/c/Windows/System32/cmd.exe',
      args: [
        '/d',
        '/c',
        'npx',
        '-y',
        `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
        '--browserUrl', browserUrl,
        '--no-usage-statistics',
        '--no-performance-crux',
        ...extraArgs
      ],
      cwd: '/mnt/c',
      stderr: 'inherit'
    };
  }
  throw browserError('INVALID_BROWSER_TARGET', `expected windows or linux, got ${String(target)}`);
}

export function addBrowserTarget(tool) {
  const inputSchema = tool.inputSchema ?? { type: 'object' };
  if (inputSchema.type !== undefined && inputSchema.type !== 'object') {
    throw browserError('UNSUPPORTED_TOOL_SCHEMA', `${tool.name} does not use an object input schema`);
  }
  if (Object.prototype.hasOwnProperty.call(inputSchema.properties ?? {}, BROWSER_TARGET_FIELD)) {
    throw browserError('TOOL_SCHEMA_COLLISION', `${tool.name} already defines ${BROWSER_TARGET_FIELD}`);
  }
  const properties = Object.fromEntries(
    Object.entries(inputSchema.properties ?? {}).map(([name, property]) => [
      name,
      OS_TEMP_PATH_FIELDS.has(name)
        ? {
            ...property,
            description: [property.description, OS_TEMP_PATH_GUIDANCE].filter(Boolean).join(' ')
          }
        : property
    ])
  );
  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      type: 'object',
      properties: {
        ...properties,
        [BROWSER_TARGET_FIELD]: {
          type: 'string',
          enum: ['windows', 'linux'],
          description: 'Browser locality. Omit for the dedicated persistent Windows MCP Chrome profile; use linux for WSLg Chrome.'
        }
      }
    }
  };
}

export class ChromeChild {
  constructor({ target, transport, client }) {
    this.target = target;
    this.transport = transport;
    this.client = client;
    this.closed = false;
    this.peerClosed = false;
  }

  static async start({ target, env = process.env, config, windowsChromeEnsure = ensureWindowsChrome } = {}) {
    let resolvedConfig = config;
    if (!resolvedConfig) {
      if (target === 'windows') {
        const chrome = await windowsChromeEnsure();
        resolvedConfig = childConfig(target, env, [], { browserUrl: chrome.browserUrl });
      } else {
        resolvedConfig = childConfig(target, env);
      }
    }
    const transport = new StdioClientTransport(resolvedConfig);
    const client = new Client({ name: `mcp-dev-bridge-browser-${target}`, version: '0.1.0' });
    const child = new ChromeChild({ target, transport, client });
    client.onclose = () => { child.peerClosed = true; };
    try {
      await client.connect(transport);
      return child;
    } catch (error) {
      child.closed = true;
      try { await transport.close(); } catch { /* failed startup may already be closed */ }
      throw browserError('BROWSER_CHILD_START_FAILED', `failed to start ${target} Chrome DevTools MCP`, error);
    }
  }

  get alive() {
    return !this.closed && !this.peerClosed && this.transport.pid !== null;
  }

  async listTools() {
    if (!this.alive) throw browserError('BROWSER_CHILD_CLOSED', `${this.target} browser child is not running`);
    return this.client.listTools();
  }

  async callTool(name, args = {}) {
    if (!this.alive) throw browserError('BROWSER_CHILD_CLOSED', `${this.target} browser child is not running`);
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

export class BrowserRouter {
  constructor({ childFactory = target => ChromeChild.start({ target }) } = {}) {
    if (typeof childFactory !== 'function') throw new TypeError('childFactory must be a function');
    this.childFactory = childFactory;
    this.children = new Map();
    this.starts = new Map();
    this.toolsPromise = null;
    this.closed = false;
  }

  async child(target) {
    if (this.closed) throw browserError('BROWSER_ROUTER_CLOSED', 'browser router is shut down');
    const existing = this.children.get(target);
    if (existing?.alive) return existing;
    if (existing) {
      this.children.delete(target);
      await existing.close().catch(() => {});
      if (this.closed) throw browserError('BROWSER_ROUTER_CLOSED', 'browser router is shut down');
    }

    let starting = this.starts.get(target);
    if (!starting) {
      starting = Promise.resolve().then(() => {
        if (this.closed) throw browserError('BROWSER_ROUTER_CLOSED', 'browser router is shut down');
        return this.childFactory(target);
      }).then(async child => {
        if (this.closed) {
          await child.close().catch(() => {});
          throw browserError('BROWSER_ROUTER_CLOSED', 'browser router is shut down');
        }
        this.children.set(target, child);
        return child;
      }).finally(() => {
        this.starts.delete(target);
      });
      this.starts.set(target, starting);
    }
    return starting;
  }

  async listTools() {
    if (!this.toolsPromise) {
      this.toolsPromise = (async () => {
        const child = await this.child('linux');
        const { tools } = await child.listTools();
        return tools.map(addBrowserTarget);
      })().catch(error => {
        this.toolsPromise = null;
        throw error;
      });
    }
    return this.toolsPromise;
  }

  async call({ tool, arguments: args = {} } = {}) {
    if (typeof tool !== 'string' || tool.length === 0) throw new TypeError('tool is required');
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('tool arguments must be an object');

    const upstreamArgs = { ...args };
    const target = upstreamArgs[BROWSER_TARGET_FIELD] ?? 'windows';
    delete upstreamArgs[BROWSER_TARGET_FIELD];
    if (target !== 'windows' && target !== 'linux') {
      throw browserError('INVALID_BROWSER_TARGET', `expected windows or linux, got ${String(target)}`);
    }

    const child = await this.child(target);
    return child.callTool(tool, upstreamArgs);
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    const pending = await Promise.allSettled(this.starts.values());
    const children = new Set(this.children.values());
    for (const result of pending) if (result.status === 'fulfilled') children.add(result.value);
    await Promise.allSettled([...children].map(child => child.close()));
    this.children.clear();
  }
}

export function createBrowserFacadeServer({ router } = {}) {
  if (!router || typeof router.listTools !== 'function' || typeof router.call !== 'function') {
    throw new TypeError('router with listTools() and call() is required');
  }
  const server = new Server(
    { name: 'browser', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: 'One resource-local Chrome surface. Tools default to the dedicated persistent Windows MCP Chrome profile; pass browser_target=linux for WSLg Chrome. Path arguments are OS-temp-only.'
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await router.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async request => router.call({
    tool: request.params.name,
    arguments: request.params.arguments ?? {}
  }));
  return server;
}

export async function runBrowserFacadeStdio() {
  const router = new BrowserRouter();
  const server = createBrowserFacadeServer({ router });
  const transport = new StdioServerTransport();
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await router.shutdown();
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

  return { router, server, transport, shutdown };
}

async function main() {
  const runtime = await runBrowserFacadeStdio();
  let exitStarted = false;

  process.stdin.once('end', () => {
    void runtime.shutdown();
  });

  const shutdownAndExit = () => {
    if (exitStarted) return;
    exitStarted = true;
    void runtime.shutdown().then(
      () => process.exit(0),
      error => {
        process.stderr.write(`Browser facade shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    );
  };

  process.once('SIGTERM', shutdownAndExit);
  process.once('SIGINT', shutdownAndExit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
