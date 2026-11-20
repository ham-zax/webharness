import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { Client, DEFAULT_REQUEST_TIMEOUT_MSEC, ReadBuffer, STDIO_DEFAULT_MAX_BUFFER_SIZE, SdkError, SdkErrorCode, serializeMessage } from '@modelcontextprotocol/client';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { CALL_ID_META, RPC_BUDGET_META, currentCall } from '../pi-dev/call-diagnostics.mjs';

const MAX_STDERR_LINE_BYTES = 2048;
const MAX_CAUSE_SUMMARY_LENGTH = 512;
const MAX_CONFIG_CACHE_ENTRIES = 64;

export function brokerError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function causeSummary(error, maxLen = MAX_CAUSE_SUMMARY_LENGTH) {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const clean = raw.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}...` : clean;
}

export function withCauseDetail(prefix, error) {
  const detail = causeSummary(error);
  return detail ? `${prefix}: ${detail}` : prefix;
}

export function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw brokerError('INVALID_ARGUMENT', `${name} must be a non-empty string`);
  return value;
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitWithTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(false), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Stat-validated cache for inner mcp-local.json so hot calls avoid double-reading
// and re-parsing the config file while picking up any modification immediately.
const innerConfigCache = new Map();

export async function readCachedInnerConfig(configPath) {
  let stat;
  try {
    stat = await fs.stat(configPath);
  } catch (error) {
    innerConfigCache.delete(configPath);
    throw brokerError('INNER_CONFIG_INVALID', `cannot read inner config ${configPath}`, error);
  }
  const sig = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = innerConfigCache.get(configPath);
  if (cached && cached.sig === sig) return cached;

  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    innerConfigCache.delete(configPath);
    throw brokerError('INNER_CONFIG_INVALID', `cannot read inner config ${configPath}`, error);
  }
  const rawServers = config?.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};
  const servers = Object.keys(rawServers);
  const entry = { sig, rawServers, servers, definitions: new Map() };
  if (innerConfigCache.size >= MAX_CONFIG_CACHE_ENTRIES) {
    innerConfigCache.delete(innerConfigCache.keys().next().value);
  }
  innerConfigCache.set(configPath, entry);
  return entry;
}

function isProcessGroupAlive(pid, proc) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    return proc.exitCode === null && proc.signalCode === null;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function signalOwnedProcessGroup(pid, proc, signal) {
  if (!pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, signal);
    } else if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill(signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForGroupExit(pid, proc, closedPromise, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(pid, proc)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  const remaining = Math.max(1, deadline - Date.now());
  return waitWithTimeout(closedPromise, remaining);
}

// Stdio client transport that places each spawned downstream MCP server in its own
// POSIX process group (`detached: true`), captures bounded stderr lines without
// polluting stdout, and reaps the entire owned process group on close/dispose.
export class DetachedStdioClientTransport {
  _process;
  _pid = null;
  _procClosed = true;
  _procClosePromise = Promise.resolve();
  _closingPromise = null;
  _intentionalClose = false;
  _readBuffer;
  _spawnConfig;
  _serverParams;
  onclose;
  onerror;
  onmessage;

  constructor(server) {
    this._spawnConfig = server;
    // Expose `_serverParams` only when `disposableProbe: true` (`protocolVersion: 'auto'`)
    // so `pin: '2026-07-28'` negotiates in-place on one process without spawning a sibling.
    this._serverParams = server.disposableProbe ? server : undefined;
    this._readBuffer = new ReadBuffer({ maxBufferSize: server.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE });
  }

  get pid() {
    return this._process?.pid ?? null;
  }

  get stderr() {
    return this._process?.stderr ?? null;
  }

  async start() {
    if (this._process) {
      throw new Error('DetachedStdioClientTransport already started');
    }
    const stderrMode = this._spawnConfig.stderr === 'ignore' ? 'ignore' : 'pipe';
    return new Promise((resolve, reject) => {
      const proc = spawn(this._spawnConfig.command, this._spawnConfig.args ?? [], {
        env: {
          ...getDefaultEnvironment(),
          ...this._spawnConfig.env
        },
        stdio: ['pipe', 'pipe', stderrMode],
        shell: false,
        windowsHide: process.platform === 'win32',
        detached: process.platform !== 'win32',
        cwd: this._spawnConfig.cwd
      });
      this._process = proc;
      this._pid = proc.pid ?? null;
      this._procClosed = false;
      let settledStart = false;

      let stderrRemainder = '';
      const emitStderrLine = rawLine => {
        if (typeof this._spawnConfig.onStderrLine !== 'function') return;
        const trimmed = rawLine.replace(/\r$/, '');
        if (!trimmed) return;
        this._spawnConfig.onStderrLine(trimmed);
      };

      if (proc.stderr) {
        proc.stderr.on('data', chunk => {
          stderrRemainder += chunk.toString('utf8');
          while (true) {
            const nl = stderrRemainder.indexOf('\n');
            if (nl === -1) {
              if (stderrRemainder.length > MAX_STDERR_LINE_BYTES) {
                emitStderrLine(`${stderrRemainder.slice(0, MAX_STDERR_LINE_BYTES)}...`);
                stderrRemainder = '';
              }
              break;
            }
            const line = stderrRemainder.slice(0, nl);
            stderrRemainder = stderrRemainder.slice(nl + 1);
            emitStderrLine(line.length > MAX_STDERR_LINE_BYTES ? `${line.slice(0, MAX_STDERR_LINE_BYTES)}...` : line);
          }
        });
        proc.stderr.on('error', () => {});
      }

      this._procClosePromise = new Promise(resolveClose => {
        proc.once('close', (code, signal) => {
          if (stderrRemainder) {
            emitStderrLine(stderrRemainder.length > MAX_STDERR_LINE_BYTES ? `${stderrRemainder.slice(0, MAX_STDERR_LINE_BYTES)}...` : stderrRemainder);
            stderrRemainder = '';
          }
          this._procClosed = true;
          this._process = undefined;
          if (stderrMode !== 'ignore') {
            this._spawnConfig.onExit?.({ pid: this._pid, code, signal, intentional: this._intentionalClose });
          }
          this.onclose?.();
          resolveClose();
        });
      });

      proc.once('error', error => {
        this._procClosed = true;
        this._process = undefined;
        if (!settledStart) {
          settledStart = true;
          reject(error);
        }
        this.onerror?.(error);
      });

      proc.once('spawn', () => {
        this._pid = proc.pid ?? null;
        if (!settledStart) {
          settledStart = true;
          resolve();
        }
      });

      proc.stdin?.on('error', error => {
        if (!this._intentionalClose) this.onerror?.(error);
      });
      proc.stdout?.on('data', chunk => {
        try {
          this._readBuffer.append(chunk);
          this._processReadBuffer();
        } catch (error) {
          this.onerror?.(error);
          void this.close().catch(() => {});
        }
      });
      proc.stdout?.on('error', error => {
        if (!this._intentionalClose) this.onerror?.(error);
      });
    });
  }

  _processReadBuffer() {
    while (true) {
      try {
        const message = this._readBuffer.readMessage();
        if (message === null) break;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error);
      }
    }
  }

  async _reap({ gracefulStdinMs, sigtermMs, sigkillMs }) {
    if (this._closingPromise) return this._closingPromise;
    this._intentionalClose = true;
    this._closingPromise = (async () => {
      const proc = this._process;
      const pid = this._pid;
      const closedPromise = this._procClosePromise;
      this._process = undefined;
      try {
        if (proc && !this._procClosed && gracefulStdinMs > 0) {
          try { proc.stdin?.end(); } catch { /* ignore closed stdin */ }
          await waitWithTimeout(closedPromise, gracefulStdinMs);
        }
        if (pid && (!this._procClosed || isProcessGroupAlive(pid, proc ?? { exitCode: 0, signalCode: null }))) {
          signalOwnedProcessGroup(pid, proc ?? { exitCode: 0, signalCode: null }, 'SIGTERM');
          await waitForGroupExit(pid, proc ?? { exitCode: 0, signalCode: null }, closedPromise, sigtermMs);
        }
        if (pid && (!this._procClosed || isProcessGroupAlive(pid, proc ?? { exitCode: 0, signalCode: null }))) {
          signalOwnedProcessGroup(pid, proc ?? { exitCode: 0, signalCode: null }, 'SIGKILL');
          await waitForGroupExit(pid, proc ?? { exitCode: 0, signalCode: null }, closedPromise, sigkillMs);
        }
      } finally {
        try { proc?.stdin?.destroy(); } catch { /* ignore */ }
        try { proc?.stdout?.destroy(); } catch { /* ignore */ }
        try { proc?.stderr?.destroy(); } catch { /* ignore */ }
        this._readBuffer.clear();
      }
    })();
    return this._closingPromise;
  }

  // Used by @modelcontextprotocol/client when `versionNegotiation: { mode: 'auto' }`
  // spawns a short-lived probe sibling over stdio.
  async _dispose() {
    await this._reap({ gracefulStdinMs: 0, sigtermMs: 1000, sigkillMs: 500 });
  }

  async close() {
    await this._reap({ gracefulStdinMs: 1000, sigtermMs: 1500, sigkillMs: 1000 });
  }

  send(message) {
    return new Promise(resolve => {
      if (!this._process?.stdin) throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
      const json = serializeMessage(message);
      if (this._process.stdin.write(json)) resolve();
      else this._process.stdin.once('drain', resolve);
    });
  }
}

function clientNegotiationOptions(protocolVersion) {
  if (protocolVersion === '2026-07-28') {
    return { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } };
  }
  if (protocolVersion === 'auto') {
    return { capabilities: {}, versionNegotiation: { mode: 'auto' } };
  }
  return { capabilities: {}, versionNegotiation: { mode: 'legacy' } };
}

function parseServerDefinition(serverName, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw brokerError('INNER_CONFIG_INVALID', `local server ${serverName} definition must be an object`);
  }
  if (raw.type !== undefined && raw.type !== 'stdio') {
    throw brokerError('INNER_CONFIG_INVALID', `local server ${serverName} type must be stdio`);
  }
  if (typeof raw.command !== 'string' || raw.command.length === 0) {
    throw brokerError('INNER_CONFIG_INVALID', `local server ${serverName} command must be a non-empty string`);
  }
  if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(arg => typeof arg !== 'string'))) {
    throw brokerError('INNER_CONFIG_INVALID', `local server ${serverName} args must be an array of strings`);
  }
  if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || raw.cwd.length === 0)) {
    throw brokerError('INNER_CONFIG_INVALID', `local server ${serverName} cwd must be a non-empty string`);
  }
  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env)) {
      throw brokerError('INNER_CONFIG_INVALID', `local server ${serverName} env must be an object`);
    }
    for (const [key, val] of Object.entries(raw.env)) {
      if (typeof val !== 'string') {
        throw brokerError('INNER_CONFIG_INVALID', `local server ${serverName} env.${key} must be a string`);
      }
    }
  }
  if (raw.protocolVersion !== undefined && !['auto', 'legacy', '2026-07-28'].includes(raw.protocolVersion)) {
    throw brokerError('INNER_CONFIG_INVALID', `local server ${serverName} protocolVersion is invalid: ${String(raw.protocolVersion)}`);
  }
  let requestTimeout;
  if (raw.requestTimeout !== undefined) {
    if (!Number.isSafeInteger(raw.requestTimeout) || raw.requestTimeout < 1) {
      throw brokerError('INNER_CONFIG_INVALID', `local server ${serverName} requestTimeout must be a positive integer`);
    }
    requestTimeout = raw.requestTimeout;
  }
  if (raw.restartOnExit !== undefined && typeof raw.restartOnExit !== 'boolean') {
    throw brokerError('INNER_CONFIG_INVALID', `local server ${serverName} restartOnExit must be a boolean`);
  }
  return {
    command: raw.command,
    args: raw.args ?? [],
    cwd: raw.cwd,
    env: raw.env,
    protocolVersion: raw.protocolVersion ?? 'legacy',
    requestTimeout,
    restartOnExit: raw.restartOnExit ?? true
  };
}

function extractIsErrorText(result) {
  if (!Array.isArray(result?.content)) return 'downstream tool returned isError=true';
  const textItem = result.content.find(item => item?.type === 'text' && typeof item.text === 'string');
  return causeSummary(textItem?.text ?? 'downstream tool returned isError=true');
}

export class DirectServerClient {
  constructor({ serverName, definition, transport, client, logger }) {
    this.serverName = serverName;
    this.definition = definition;
    this.transport = transport;
    this.client = client;
    this.logger = logger;
    this.closed = false;
    this.peerClosed = false;
  }

  static async start({ serverName, definition, signal, logger, onUnexpectedExit } = {}) {
    requiredString(serverName, 'serverName');
    if (signal?.aborted) {
      throw brokerError('INNER_START_FAILED', `startup aborted for local server ${serverName}`);
    }
    const startedAt = Date.now();
    let instance = null;
    const transport = new DetachedStdioClientTransport({
      command: definition.command,
      args: definition.args,
      cwd: definition.cwd,
      env: definition.env,
      disposableProbe: definition.protocolVersion === 'auto',
      stderr: 'pipe',
      onStderrLine: line => {
        logger?.log('warn', { event: 'server_stderr', server: serverName, stderr: line });
      },
      onExit: ({ pid, code, signal: exitSignal, intentional }) => {
        if (!intentional && instance && !instance.closed) {
          logger?.log('warn', {
            event: 'server_exited',
            server: serverName,
            pid: pid ?? undefined,
            code: code ?? undefined,
            signal: exitSignal ?? undefined
          });
          onUnexpectedExit?.();
        }
      }
    });
    const client = new Client(
      { name: 'mcp-dev-bridge-local', version: '0.1.0' },
      clientNegotiationOptions(definition.protocolVersion)
    );
    instance = new DirectServerClient({ serverName, definition, transport, client, logger });
    client.onclose = () => { instance.peerClosed = true; };
    const onAbort = () => { void transport.close().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      const connectTimeout = definition.requestTimeout !== undefined && definition.requestTimeout > DEFAULT_REQUEST_TIMEOUT_MSEC
        ? definition.requestTimeout
        : undefined;
      await client.connect(
        transport,
        connectTimeout ? { timeout: connectTimeout } : undefined
      );
      logger?.log('info', {
        event: 'server_started',
        server: serverName,
        pid: transport.pid ?? undefined,
        protocol: client.protocolVersion ?? definition.protocolVersion,
        duration_ms: Date.now() - startedAt
      });
      return instance;
    } catch (error) {
      instance.closed = true;
      try { await transport.close(); } catch { /* failed startup may already be closed */ }
      logger?.log('error', {
        event: 'server_start_failed',
        server: serverName,
        duration_ms: Date.now() - startedAt,
        error: causeSummary(error)
      });
      throw brokerError('INNER_START_FAILED', withCauseDetail(`failed to start local server ${serverName}`, error), error);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  get alive() {
    return !this.closed && !this.peerClosed && this.transport.pid !== null;
  }

  _requestOptions(signal, timeoutOverride) {
    const timeout = timeoutOverride ?? this.definition.requestTimeout;
    if (signal === undefined && timeout === undefined) return undefined;
    return {
      ...(signal === undefined ? {} : { signal }),
      ...(timeout === undefined ? {} : { timeout })
    };
  }

  async listTools(cursor, { signal, timeout } = {}) {
    if (!this.alive) throw brokerError('INNER_UNAVAILABLE', `local server ${this.serverName} is not running`);
    return this.client.listTools(
      cursor === undefined ? undefined : { cursor },
      this._requestOptions(signal, timeout)
    );
  }

  async callTool(name, args = {}, signal, metaOverrides = null) {
    if (!this.alive) throw brokerError('INNER_UNAVAILABLE', `local server ${this.serverName} is not running`);
    const startedAt = Date.now();
    const call = currentCall();
    const rpcBudgetMs = metaOverrides?.rpcBudgetMs ?? call?.rpcBudgetMs;
    const meta = {
      ...(call ? { [CALL_ID_META]: call.id } : {}),
      ...(rpcBudgetMs !== undefined ? { [RPC_BUDGET_META]: rpcBudgetMs } : {}),
    };
    try {
      const result = await this.client.callTool(
        { name, arguments: args, ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}) },
        this._requestOptions(signal)
      );
      if (result?.isError === true) {
        this.logger?.log('warn', {
          event: 'tool_call_error_result',
          server: this.serverName,
          tool: name,
          duration_ms: Date.now() - startedAt,
          error: extractIsErrorText(result)
        });
      }
      return result;
    } catch (error) {
      this.logger?.log('error', {
        event: 'tool_call_failed',
        server: this.serverName,
        tool: name,
        duration_ms: Date.now() - startedAt,
        error: causeSummary(error)
      });
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      /* fall through to transport close */
    }
    try {
      await this.transport.close();
    } catch {
      /* already closed */
    }
  }
}

export const DEFAULT_INNER_IDLE_MS = 30 * 60 * 1000;
const MAX_INNER_IDLE_MS = 2 ** 31 - 1;

export function parseInnerIdleMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_INNER_IDLE_MS;
  const text = String(value).trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed > MAX_INNER_IDLE_MS) {
    throw new Error(`MCP_LOCAL_INNER_IDLE_MS must be an integer from 0 to ${MAX_INNER_IDLE_MS}`);
  }
  return parsed;
}

// Lazy client lifecycle state machine: starts a client on first use and stops it
// after `idleMs` without in-flight operations unless pinned by an active runtime lease.
export class LazyIdleSupervisor {
  constructor({ start, idleMs = DEFAULT_INNER_IDLE_MS, isPinned = async () => false } = {}) {
    if (typeof start !== 'function') throw new TypeError('start function is required');
    if (!Number.isSafeInteger(idleMs) || idleMs < 0 || idleMs > MAX_INNER_IDLE_MS) {
      throw new TypeError(`idleMs must be an integer from 0 to ${MAX_INNER_IDLE_MS}`);
    }
    if (typeof isPinned !== 'function') throw new TypeError('isPinned function is required');
    this.isPinned = isPinned;
    this.startFn = start;
    this.idleMs = idleMs;
    this.inner = null;
    this.startPromise = null;
    this.startAbortController = null;
    this.closePromise = null;
    this.inFlight = 0;
    this.timer = null;
    this.shutdownPromise = null;
    this.closed = false;
  }

  get alive() {
    return !this.closed;
  }

  get state() {
    if (this.closed) return 'closed';
    if (this.startPromise) return 'starting';
    if (this.closePromise) return 'stopping';
    return this.inner?.alive ? 'running' : 'asleep';
  }

  clearTimer() {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  armTimer() {
    this.clearTimer();
    if (this.closed || this.idleMs === 0 || this.inFlight > 0 || !this.inner) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (this.closed || this.inFlight > 0 || this.startPromise || !this.inner) return;
      let pinned;
      try { pinned = await this.isPinned(); } catch { pinned = true; }
      if (this.closed || this.inFlight > 0 || this.startPromise || !this.inner) return;
      if (pinned) { this.armTimer(); return; }
      const idle = this.inner;
      this.inner = null;
      this.closePromise = Promise.resolve()
        .then(() => idle.close())
        .catch(() => {})
        .finally(() => { this.closePromise = null; });
    }, this.idleMs);
    this.timer.unref?.();
  }

  ensureInner() {
    if (this.inner?.alive) return Promise.resolve(this.inner);
    if (!this.startPromise) {
      const starting = (async () => {
        const stale = this.inner;
        this.inner = null;
        if (stale) await Promise.resolve().then(() => stale.close()).catch(() => {});
        if (this.closePromise) await this.closePromise;
        if (this.closed) throw brokerError('INNER_UNAVAILABLE', 'local backend is shut down');
        const controller = new AbortController();
        this.startAbortController = controller;
        let inner;
        try {
          inner = await this.startFn({ signal: controller.signal });
        } finally {
          if (this.startAbortController === controller) this.startAbortController = null;
        }
        if (this.closed) {
          await Promise.resolve().then(() => inner.close()).catch(() => {});
          throw brokerError('INNER_UNAVAILABLE', 'local backend is shut down');
        }
        this.inner = inner;
        return inner;
      })();
      this.startPromise = starting;
      const clear = () => { if (this.startPromise === starting) this.startPromise = null; };
      starting.then(clear, clear);
    }
    return this.startPromise;
  }

  async run(operation) {
    if (this.closed) throw brokerError('INNER_UNAVAILABLE', 'local backend is shut down');
    this.inFlight += 1;
    this.clearTimer();
    try {
      const inner = await this.ensureInner();
      return await operation(inner);
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) this.armTimer();
    }
  }

  listTools(cursor, options) {
    return this.run(inner => inner.listTools(cursor, options));
  }

  callTool(name, args = {}, signal, metaOverrides = null) {
    return this.run(inner => inner.callTool(name, args, signal, metaOverrides));
  }

  async evict() {
    this.clearTimer();
    this.startAbortController?.abort();
    if (this.startPromise) await this.startPromise.catch(() => {});
    if (this.closePromise) await this.closePromise;
    const active = this.inner;
    this.inner = null;
    if (active) await Promise.resolve().then(() => active.close()).catch(() => {});
  }

  close() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = this.evict();
    return this.shutdownPromise;
  }
}

// Direct per-server supervisor pool replacing the ~240 MB inner 1MCP process.
// Each configured stdio server wakes independently on demand, negotiates its own
// MCP protocol revision, and idles out independently.
export class DirectLocalServerPool {
  constructor({
    configPath,
    idleMs = DEFAULT_INNER_IDLE_MS,
    isPinned = async () => false,
    logger = null,
    clientFactory = opts => DirectServerClient.start(opts)
  } = {}) {
    requiredString(configPath, 'configPath');
    if (typeof clientFactory !== 'function') throw new TypeError('clientFactory must be a function');
    this.configPath = configPath;
    this.idleMs = idleMs;
    this.isPinned = isPinned;
    this.logger = logger;
    this.clientFactory = clientFactory;
    this.entries = new Map();
    this.entryUpdates = new Map();
    this.closePromise = null;
    this.closed = false;
  }

  get state() {
    if (this.closed) return 'closed';
    let hasStarting = false;
    let hasStopping = false;
    for (const entry of this.entries.values()) {
      const st = entry.supervisor.state;
      if (st === 'running') return 'running';
      if (st === 'starting') hasStarting = true;
      if (st === 'stopping') hasStopping = true;
    }
    if (hasStarting) return 'starting';
    if (hasStopping) return 'stopping';
    return 'asleep';
  }

  serverState(server) {
    if (this.closed) return 'closed';
    const entry = this.entries.get(server);
    if (!entry) return 'asleep';
    if (entry.permanentlyExited) return 'stopped';
    return entry.supervisor.state;
  }

  isServerLive(server) {
    const entry = this.entries.get(server);
    return Boolean(entry && !entry.permanentlyExited && entry.supervisor.inner?.alive);
  }

  async _readServerDefinition(server) {
    const entry = await readCachedInnerConfig(this.configPath);
    const cached = entry.definitions.get(server);
    if (cached) return cached;
    if (!Object.hasOwn(entry.rawServers, server)) {
      throw brokerError('UNKNOWN_SERVER', `unknown local server: ${server}`);
    }
    const raw = entry.rawServers[server];
    const parsed = { definition: parseServerDefinition(server, raw), fingerprint: JSON.stringify(raw) };
    entry.definitions.set(server, parsed);
    return parsed;
  }

  async canAutoRecover(server) {
    try {
      const { definition } = await this._readServerDefinition(server);
      return definition.restartOnExit !== false;
    } catch {
      return false;
    }
  }

  async _ensureEntry(server) {
    if (this.closed) throw brokerError('INNER_UNAVAILABLE', 'local backend is shut down');
    let pending = this.entryUpdates.get(server);
    if (!pending) {
      pending = this._updateEntry(server);
      this.entryUpdates.set(server, pending);
      const clear = () => {
        if (this.entryUpdates.get(server) === pending) this.entryUpdates.delete(server);
      };
      pending.then(clear, clear);
    }
    return pending;
  }

  async _updateEntry(server) {
    const { definition, fingerprint } = await this._readServerDefinition(server);
    if (this.closed) throw brokerError('INNER_UNAVAILABLE', 'local backend is shut down');
    let entry = this.entries.get(server);
    if (entry && entry.fingerprint !== fingerprint && entry.supervisor.inFlight === 0) {
      await entry.supervisor.close();
      if (this.closed) throw brokerError('INNER_UNAVAILABLE', 'local backend is shut down');
      this.entries.delete(server);
      entry = undefined;
    }
    if (!entry) {
      const record = {
        server,
        fingerprint,
        definition,
        permanentlyExited: false,
        supervisor: null
      };
      record.supervisor = new LazyIdleSupervisor({
        idleMs: this.idleMs,
        isPinned: this.isPinned,
        start: async ({ signal } = {}) => {
          if (record.permanentlyExited) {
            throw brokerError('DOWNSTREAM_UNAVAILABLE', `local server exited and restartOnExit is false: ${server}`);
          }
          const latest = await this._readServerDefinition(server);
          signal?.throwIfAborted();
          if (this.closed) throw brokerError('INNER_UNAVAILABLE', 'local backend is shut down');
          record.definition = latest.definition;
          record.fingerprint = latest.fingerprint;
          return this.clientFactory({
            serverName: server,
            definition: latest.definition,
            signal,
            logger: this.logger,
            onUnexpectedExit: () => {
              if (record.definition.restartOnExit === false) {
                record.permanentlyExited = true;
              }
            }
          });
        }
      });
      this.entries.set(server, record);
      entry = record;
    }
    if (entry.permanentlyExited) {
      throw brokerError('DOWNSTREAM_UNAVAILABLE', `local server exited and restartOnExit is false: ${server}`);
    }
    return entry;
  }

  async listServerTools(server, cursor, options) {
    const entry = await this._ensureEntry(server);
    if (this.closed) throw brokerError('INNER_UNAVAILABLE', 'local backend is shut down');
    return entry.supervisor.listTools(cursor, options);
  }

  // Read-only live-server listing for diagnostic schema hints: never wakes,
  // respawns, or pins idle eviction of a sleeping or dead server.
  async listLiveServerTools(server, cursor, options) {
    if (this.closed) return null;
    const entry = this.entries.get(server);
    const liveInner = entry && !entry.permanentlyExited ? entry.supervisor.inner : null;
    if (!liveInner?.alive) return null;
    return liveInner.listTools(cursor, options);
  }

  async callServerTool(server, tool, args = {}, signal, metaOverrides = null) {
    const entry = await this._ensureEntry(server);
    if (this.closed) throw brokerError('INNER_UNAVAILABLE', 'local backend is shut down');
    return entry.supervisor.callTool(tool, args, signal, metaOverrides);
  }

  async restartServer(server, { timeoutMs } = {}) {
    if (this.closed) throw brokerError('INNER_UNAVAILABLE', 'local backend is shut down');
    const existing = this.entries.get(server);
    if (existing) {
      await existing.supervisor.evict();
      existing.permanentlyExited = false;
    }
    const entry = await this._ensureEntry(server);
    const controller = new AbortController();
    let timer;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => controller.abort(new Error(`restart timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }
    try {
      await entry.supervisor.listTools(undefined, { signal: controller.signal, timeout: timeoutMs });
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const all = [...this.entries.values()];
    this.entries.clear();
    this.closePromise = Promise.allSettled([
      ...all.map(entry => entry.supervisor.close()),
      ...this.entryUpdates.values()
    ]).then(() => {});
    return this.closePromise;
  }
}
