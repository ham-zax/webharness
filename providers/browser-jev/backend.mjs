import path from 'node:path';

import { ensureWindowsChrome } from '../browser/windows-chrome-runtime.mjs';
import { resolveLinuxBrowserBackend } from '../browser-fast/browser-backend-config.mjs';
import {
  DEFAULT_CLEARCOTE_STATE_ROOT,
  readClearcoteEndpoint
} from '../browser-fast/clearcote-runtime.mjs';
import { AgentBrowserRunner } from '../browser-fast/server.mjs';

function backendError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function extractAgentBrowserCdpUrl(item) {
  if (!item || item.success !== true) {
    throw backendError('LINUX_BROWSER_CDP_UNAVAILABLE', 'Agent Browser did not return a successful CDP URL result');
  }
  const result = item.result;
  if (typeof result === 'string' && result.length > 0) return result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    for (const key of ['url', 'cdpUrl', 'cdp_url', 'wsEndpoint']) {
      if (typeof result[key] === 'string' && result[key].length > 0) return result[key];
    }
  }
  throw backendError('LINUX_BROWSER_CDP_UNAVAILABLE', 'Agent Browser result did not contain a CDP URL');
}

export function toLoopbackBrowserUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw backendError('BROWSER_CDP_INVALID', 'CDP URL must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw backendError('BROWSER_CDP_INVALID', 'CDP URL is invalid', error);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw backendError('BROWSER_CDP_INVALID', 'CDP URL uses an unsupported scheme');
  }
  if (parsed.username || parsed.password) {
    throw backendError('BROWSER_CDP_INVALID', 'CDP URL must not contain embedded credentials');
  }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) {
    throw backendError('BROWSER_CDP_INVALID', 'CDP URL must use a loopback host');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw backendError('BROWSER_CDP_INVALID', 'CDP URL must contain a valid explicit port');
  }
  const protocol = parsed.protocol === 'ws:'
    ? 'http:'
    : parsed.protocol === 'wss:'
      ? 'https:'
      : parsed.protocol;
  return `${protocol}//${parsed.host}`;
}

export class BrowserJevBackendResolver {
  constructor({
    ensureWindows = ensureWindowsChrome,
    resolveLinux = resolveLinuxBrowserBackend,
    readEndpoint = readClearcoteEndpoint,
    stateRoot = DEFAULT_CLEARCOTE_STATE_ROOT,
    runnerFactory = () => new AgentBrowserRunner()
  } = {}) {
    this.ensureWindows = ensureWindows;
    this.resolveLinux = resolveLinux;
    this.readEndpoint = readEndpoint;
    this.stateRoot = stateRoot;
    this.runnerFactory = runnerFactory;
  }

  async resolve(selection) {
    const target = selection.browser_target;
    const requestedProfile = selection.browser_profile;
    if (target === 'windows') {
      const runtime = await this.ensureWindows({ profile: requestedProfile });
      const browserUrl = toLoopbackBrowserUrl(runtime.browserUrl);
      return {
        browserTarget: 'windows',
        browserBackend: 'chrome',
        browserProfile: requestedProfile,
        browserUrl,
        queueKey: `windows:chrome:${requestedProfile ?? '-'}`
      };
    }

    const backend = await this.resolveLinux({
      browser: selection.browser_backend,
      profile: requestedProfile
    });
    if (backend.browser === 'clearcote') {
      if (backend.managed !== true || typeof backend.profileName !== 'string') {
        throw backendError('CLEARCOTE_BACKEND_INVALID', 'browser-fast did not resolve a managed Clearcote profile');
      }
      const profilesRoot = path.resolve(this.stateRoot, 'profiles');
      const profileDir = path.resolve(profilesRoot, backend.profileName);
      if (path.dirname(profileDir) !== profilesRoot) {
        throw backendError('CLEARCOTE_PROFILE_INVALID', 'managed Clearcote profile must resolve beneath its profiles root');
      }
      const endpoint = await this.readEndpoint(profileDir, { allowMissing: true });
      if (!endpoint) {
        throw backendError(
          'LINUX_BROWSER_NOT_RUNNING',
          `managed Clearcote profile ${backend.profileName} is not active; initialize it once through browser-fast before starting browser-jev`
        );
      }
      return {
        browserTarget: 'linux',
        browserBackend: 'clearcote',
        browserProfile: backend.profileName,
        browserUrl: toLoopbackBrowserUrl(endpoint.browserUrl),
        queueKey: `linux:clearcote:${backend.profileName}`
      };
    }
    if (backend.browser !== 'chrome') {
      throw backendError('UNSUPPORTED_BROWSER_BACKEND', `browser-jev cannot use Linux backend ${String(backend.browser)}`);
    }

    const runner = this.runnerFactory();
    const batch = await runner.linuxBatch([['get', 'cdp-url']], {
      bail: true,
      browserBackend: 'chrome',
      browserProfile: backend.profileName
    });
    if (!Array.isArray(batch?.items) || batch.items.length !== 1 || batch.items[0]?.success !== true) {
      throw backendError('LINUX_BROWSER_CDP_UNAVAILABLE', 'Agent Browser must return exactly one successful CDP URL result');
    }
    const browserUrl = toLoopbackBrowserUrl(extractAgentBrowserCdpUrl(batch.items[0]));
    return {
      browserTarget: 'linux',
      browserBackend: 'chrome',
      browserProfile: backend.profileName,
      browserUrl,
      queueKey: `linux:chrome:${backend.profileName ?? '-'}`
    };
  }
}

