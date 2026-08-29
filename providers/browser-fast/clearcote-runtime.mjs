import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchPersistentContext } from 'clearcote';

const STARTUP_TIMEOUT_MS = 30000;
const STATE_BASE = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
export const DEFAULT_CLEARCOTE_STATE_ROOT = path.join(STATE_BASE, 'mcp-dev-bridge', 'clearcote');

function runtimeError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function readEndpoint(userDataDir, { allowMissing = false } = {}) {
  let text;
  try {
    text = await fs.readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8');
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  const [rawPort, wsPath] = text.trim().split(/\r?\n/);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof wsPath !== 'string' || wsPath.length === 0) {
    if (allowMissing) return null;
    throw runtimeError('CLEARCOTE_DEVTOOLS_ENDPOINT_INVALID', `invalid DevToolsActivePort in ${userDataDir}`);
  }
  const browserUrl = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${browserUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const version = await response.json();
    if (typeof version.webSocketDebuggerUrl !== 'string') return null;
    return { port, cdp: String(port), browserUrl, wsEndpoint: version.webSocketDebuggerUrl };
  } catch {
    return null;
  }
}

async function waitForEndpoint(userDataDir) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const endpoint = await readEndpoint(userDataDir, { allowMissing: true });
    if (endpoint) return endpoint;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw runtimeError('CLEARCOTE_START_TIMEOUT', `Clearcote did not expose DevToolsActivePort within ${STARTUP_TIMEOUT_MS}ms`);
}

function runtimeHealthy(runtime) {
  if (!runtime?.context) return false;
  try {
    return runtime.context.browser()?.isConnected() === true;
  } catch {
    return false;
  }
}

export class ManagedClearcoteRuntime {
  constructor({ stateRoot = DEFAULT_CLEARCOTE_STATE_ROOT, launch = launchPersistentContext } = {}) {
    this.stateRoot = stateRoot;
    this.launch = launch;
    this.current = null;
  }

  async ensure(backend) {
    if (backend?.browser !== 'clearcote' || backend?.managed !== true) {
      throw runtimeError('CLEARCOTE_BACKEND_INVALID', 'managed Clearcote backend configuration is required');
    }

    const key = JSON.stringify([backend.profileName, backend.profile]);
    if (this.current?.key === key && runtimeHealthy(this.current)) return this.current;
    if (this.current) await this.close();

    const profilesRoot = path.resolve(this.stateRoot, 'profiles');
    const userDataDir = path.resolve(profilesRoot, backend.profileName);
    if (path.dirname(userDataDir) !== profilesRoot) {
      throw runtimeError('CLEARCOTE_PROFILE_INVALID', `managed Clearcote profile must resolve beneath ${profilesRoot}`);
    }
    await fs.mkdir(userDataDir, { recursive: true });

    const live = await readEndpoint(userDataDir, { allowMissing: true });
    if (live) {
      throw runtimeError(
        'CLEARCOTE_PROFILE_IN_USE',
        `managed Clearcote profile ${backend.profileName} already has a live DevTools endpoint at ${live.browserUrl}`
      );
    }
    await fs.rm(path.join(userDataDir, 'DevToolsActivePort'), { force: true });

    let context;
    try {
      context = await this.launch(userDataDir, {
        ...backend.profile,
        quiet: true,
        chromiumSandbox: true,
        args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']
      });
      const endpoint = await waitForEndpoint(userDataDir);
      const runtime = {
        key,
        profileName: backend.profileName,
        userDataDir,
        context,
        ...endpoint
      };
      this.current = runtime;
      context.on('close', () => {
        if (this.current === runtime) this.current = null;
      });
      return runtime;
    } catch (error) {
      try { await context?.close(); } catch {}
      throw error?.code
        ? error
        : runtimeError('CLEARCOTE_START_FAILED', `could not start managed Clearcote profile ${backend.profileName}`, error);
    }
  }

  async pageForTarget(targetId) {
    const runtime = this.current;
    if (!runtimeHealthy(runtime)) throw runtimeError('CLEARCOTE_RUNTIME_UNAVAILABLE', 'managed Clearcote runtime is not active');
    for (const page of runtime.context.pages()) {
      const session = await runtime.context.newCDPSession(page);
      try {
        const info = await session.send('Target.getTargetInfo');
        if (info?.targetInfo?.targetId === targetId) return page;
      } finally {
        await session.detach().catch(() => {});
      }
    }
    throw runtimeError('CLEARCOTE_TARGET_NOT_FOUND', `Clearcote page not found for target ${targetId}`);
  }

  async close() {
    const runtime = this.current;
    this.current = null;
    if (!runtime?.context) return;
    try { await runtime.context.close(); } catch {}
  }
}
