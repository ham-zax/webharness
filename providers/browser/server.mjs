import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveLinuxBrowserBackend } from '../browser-fast/browser-backend-config.mjs';
import { DEFAULT_CLEARCOTE_STATE_ROOT, readClearcoteEndpoint } from '../browser-fast/clearcote-runtime.mjs';
import { ensureWindowsChrome } from './windows-chrome-runtime.mjs';

export const CHROME_DEVTOOLS_MCP_VERSION = '1.8.0';
export const BROWSER_TARGET_FIELD = 'browser_target';
export const BROWSER_BACKEND_FIELD = 'browser_backend';
export const BROWSER_PROFILE_FIELD = 'browser_profile';

const STATE_BASE = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
const DEFAULT_LINUX_CHROME_PROFILES_ROOT = path.join(STATE_BASE, 'mcp-dev-bridge', 'chrome-profiles');

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

export function childConfig(target, env = process.env, extraArgs = [], { browserUrl, userDataDir } = {}) {
  if (!Array.isArray(extraArgs) || extraArgs.some(value => typeof value !== 'string')) throw new TypeError('extraArgs must be a string array');
  if (target === 'linux') {
    if (browserUrl !== undefined && userDataDir !== undefined) {
      throw browserError('LINUX_BROWSER_CONFIG_INVALID', 'browserUrl and userDataDir are mutually exclusive');
    }
    return {
      command: 'npx',
      args: [
        ...BASE_CHROME_ARGS,
        ...(browserUrl === undefined ? [] : ['--browserUrl', browserUrl]),
        ...(userDataDir === undefined ? [] : ['--userDataDir', userDataDir]),
        ...extraArgs
      ],
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

function browserProfileName(value) {
  if (value === undefined) return undefined;
  const validName = new RegExp('^[A-Za-z0-9._-]+$');
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 64
    || value === '.'
    || value === '..'
    || !validName.test(value)
  ) {
    throw browserError('INVALID_ARGUMENT', 'browser_profile must be 1-64 characters using only letters, numbers, dot, underscore, or hyphen, and cannot be . or ..');
  }
  return value;
}

async function resolveClearcoteEndpoint(profileName) {
  const profilesRoot = path.resolve(DEFAULT_CLEARCOTE_STATE_ROOT, 'profiles');
  const userDataDir = path.resolve(profilesRoot, profileName);
  if (path.dirname(userDataDir) !== profilesRoot) {
    throw browserError('INVALID_ARGUMENT', `invalid Clearcote profile: ${profileName}`);
  }
  const endpoint = await readClearcoteEndpoint(userDataDir, { allowMissing: true });
  if (!endpoint) {
    throw browserError(
      'LINUX_BROWSER_NOT_RUNNING',
      `managed Clearcote profile ${profileName} is not active; initialize it once through browser-fast, then retry browser-devtools with the same backend/profile`
    );
  }
  return endpoint;
}

export function addBrowserTarget(tool) {
  const inputSchema = tool.inputSchema ?? { type: 'object' };
  if (inputSchema.type !== undefined && inputSchema.type !== 'object') {
    throw browserError('UNSUPPORTED_TOOL_SCHEMA', `${tool.name} does not use an object input schema`);
  }
  for (const field of [BROWSER_TARGET_FIELD, BROWSER_BACKEND_FIELD, BROWSER_PROFILE_FIELD]) {
    if (Object.prototype.hasOwnProperty.call(inputSchema.properties ?? {}, field)) {
      throw browserError('TOOL_SCHEMA_COLLISION', `${tool.name} already defines ${field}`);
    }
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
          description: 'Browser locality. Omit for the dedicated persistent Windows MCP Chrome profile; use linux for the configured Linux browser.'
        },
        [BROWSER_BACKEND_FIELD]: {
          type: 'string',
          enum: ['chrome', 'clearcote'],
          description: 'Linux only. Omit to use browser-fast.json; set explicitly to select Chrome or Clearcote.'
        },
        [BROWSER_PROFILE_FIELD]: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Linux only. Named persistent profile; browser_backend must be explicit when this field is set.'
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
  constructor({
    childFactory = (target, config) => ChromeChild.start({ target, config }),
    env = process.env,
    linuxBackendResolve = resolveLinuxBrowserBackend,
    clearcoteEndpointResolve = resolveClearcoteEndpoint,
    linuxChromeProfilesRoot = DEFAULT_LINUX_CHROME_PROFILES_ROOT
  } = {}) {
    if (typeof childFactory !== 'function') throw new TypeError('childFactory must be a function');
    this.childFactory = childFactory;
    this.env = env;
    this.linuxBackendResolve = linuxBackendResolve;
    this.clearcoteEndpointResolve = clearcoteEndpointResolve;
    this.linuxChromeProfilesRoot = linuxChromeProfilesRoot;
    this.children = new Map();
    this.childIdentities = new Map();
    this.starts = new Map();
    this.toolsPromise = null;
    this.closed = false;
  }

  async child(target, { key = target, config, identity = key } = {}) {
    if (this.closed) throw browserError('BROWSER_ROUTER_CLOSED', 'browser router is shut down');
    const existing = this.children.get(key);
    if (existing?.alive && this.childIdentities.get(key) === identity) return existing;
    if (existing) {
      this.children.delete(key);
      this.childIdentities.delete(key);
      await existing.close().catch(() => {});
      if (this.closed) throw browserError('BROWSER_ROUTER_CLOSED', 'browser router is shut down');
    }

    let starting = this.starts.get(key);
    if (!starting) {
      starting = Promise.resolve().then(() => {
        if (this.closed) throw browserError('BROWSER_ROUTER_CLOSED', 'browser router is shut down');
        return this.childFactory(target, config);
      }).then(async child => {
        if (this.closed) {
          await child.close().catch(() => {});
          throw browserError('BROWSER_ROUTER_CLOSED', 'browser router is shut down');
        }
        this.children.set(key, child);
        this.childIdentities.set(key, identity);
        return child;
      }).finally(() => {
        this.starts.delete(key);
      });
      this.starts.set(key, starting);
    }
    return starting;
  }

  async linuxRoute(browserBackend, browserProfile) {
    const profile = browserProfileName(browserProfile);
    if (profile !== undefined && browserBackend === undefined) {
      throw browserError('INVALID_ARGUMENT', 'browser_profile requires an explicit browser_backend for Linux');
    }

    const selected = await this.linuxBackendResolve({ browser: browserBackend, profile });
    if (selected.browser === 'clearcote') {
      const endpoint = await this.clearcoteEndpointResolve(selected.profileName);
      return {
        key: `linux:clearcote:${selected.profileName}`,
        identity: endpoint.browserUrl,
        config: childConfig('linux', this.env, [], { browserUrl: endpoint.browserUrl })
      };
    }
    if (selected.browser !== 'chrome') {
      throw browserError('UNSUPPORTED_BROWSER_BACKEND', `unsupported Linux browser backend: ${String(selected.browser)}`);
    }
    if (selected.profileName === undefined) {
      return { key: 'linux:chrome:default', config: childConfig('linux', this.env) };
    }

    const profilesRoot = path.resolve(this.linuxChromeProfilesRoot);
    const userDataDir = path.resolve(profilesRoot, selected.profileName);
    if (path.dirname(userDataDir) !== profilesRoot) {
      throw browserError('INVALID_ARGUMENT', `invalid Chrome profile: ${selected.profileName}`);
    }
    return {
      key: `linux:chrome:${selected.profileName}`,
      config: childConfig('linux', this.env, [], { userDataDir })
    };
  }

  async listTools() {
    if (!this.toolsPromise) {
      this.toolsPromise = (async () => {
        const child = await this.childFactory('linux');
        try {
          const { tools } = await child.listTools();
          return tools.map(addBrowserTarget);
        } finally {
          await child.close().catch(() => {});
        }
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
    const browserBackend = upstreamArgs[BROWSER_BACKEND_FIELD];
    const browserProfile = upstreamArgs[BROWSER_PROFILE_FIELD];
    delete upstreamArgs[BROWSER_TARGET_FIELD];
    delete upstreamArgs[BROWSER_BACKEND_FIELD];
    delete upstreamArgs[BROWSER_PROFILE_FIELD];
    if (target !== 'windows' && target !== 'linux') {
      throw browserError('INVALID_BROWSER_TARGET', `expected windows or linux, got ${String(target)}`);
    }
    if (target === 'windows' && (browserBackend !== undefined || browserProfile !== undefined)) {
      throw browserError('INVALID_ARGUMENT', 'browser_backend and browser_profile are Linux-only for browser-devtools');
    }

    const route = target === 'linux'
      ? await this.linuxRoute(browserBackend, browserProfile)
      : { key: 'windows' };
    const child = await this.child(target, route);
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
    this.childIdentities.clear();
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
      instructions: 'One resource-local DevTools surface. Tools default to the dedicated persistent Windows MCP Chrome profile. Pass browser_target=linux to use the configured Linux browser; browser_backend and browser_profile select the same Linux identity used by browser-fast. Managed Clearcote is attached through its live CDP endpoint. Path arguments are OS-temp-only.'
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
