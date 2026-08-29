import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import { promisify } from 'node:util';

import { resolveUserPath } from './boundary.mjs';

const execFileAsync = promisify(execFile);
const LOCAL_KINDS = new Set([
  'process_exit',
  'tcp_listen',
  'file_exists',
  'file_changed',
  'http_ready',
  'systemd_user',
  'timer',
]);
const SYSTEMD_UNIT_RE = /^[A-Za-z0-9@_.:-]{1,256}$/;
const SYSTEMD_STATES = new Set(['active', 'inactive', 'failed']);
const SYSTEMD_PROBE_TIMEOUT_MS = 2000;
const MAX_TIMER_AFTER_SECONDS = 86399;
const TIMER_ZONE_RE = /T.*(?:Z|[+-]\d{2}:\d{2})$/i;

function waitError(code, message, details) {
  const error = new Error(message);
  error.name = 'WaitSourceError';
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw waitError('WAIT_ABORTED', 'wait request was aborted');
}

export function parseProcStatStartTime(line) {
  if (typeof line !== 'string') throw waitError('WAIT_SOURCE_ERROR', 'invalid /proc stat payload');
  const close = line.lastIndexOf(')');
  if (close === -1 || close + 2 >= line.length) {
    throw waitError('WAIT_SOURCE_ERROR', 'invalid /proc stat payload');
  }
  const fields = line.slice(close + 2).trim().split(/\s+/);
  const startTimeTicks = fields[19];
  if (!/^\d+$/.test(startTimeTicks ?? '')) {
    throw waitError('WAIT_SOURCE_ERROR', 'invalid /proc stat start time');
  }
  return startTimeTicks;
}

async function readProcessIdentity(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return parseProcStatStartTime(stat);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function fingerprint(file) {
  try {
    const info = await fs.stat(file, { bigint: true });
    return {
      exists: true,
      dev: String(info.dev),
      ino: String(info.ino),
      size: String(info.size),
      mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

function sameFingerprint(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseTimerAt(value) {
  if (typeof value !== 'string' || !TIMER_ZONE_RE.test(value)) {
    throw waitError('INVALID_WAIT_CONDITION', 'timer at must include a timezone');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw waitError('INVALID_WAIT_CONDITION', 'timer at must be a valid RFC3339/ISO-8601 instant');
  }
  return parsed;
}

function systemdUserEnvironment(baseEnv) {
  const env = { ...baseEnv };
  let runtimeDir = typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR.length > 0
    ? env.XDG_RUNTIME_DIR
    : null;
  if (!runtimeDir) {
    if (typeof process.getuid !== 'function') {
      throw waitError('WAIT_SOURCE_UNAVAILABLE', 'cannot derive user runtime directory on this platform');
    }
    runtimeDir = `/run/user/${process.getuid()}`;
    env.XDG_RUNTIME_DIR = runtimeDir;
  }
  if (typeof env.DBUS_SESSION_BUS_ADDRESS !== 'string' || env.DBUS_SESSION_BUS_ADDRESS.length === 0) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
  }
  return env;
}

function tcpProbe(host, port, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      reject(waitError('WAIT_ABORTED', 'wait request was aborted'));
    };
    const timer = setTimeout(() => finish(false), 500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function validateCondition(condition) {
  if (!condition || typeof condition !== 'object' || !LOCAL_KINDS.has(condition.kind)) {
    throw waitError('INVALID_WAIT_CONDITION', `unsupported local wait condition: ${String(condition?.kind)}`);
  }
  if (condition.kind === 'process_exit') {
    if (!Number.isSafeInteger(condition.pid) || condition.pid <= 0) {
      throw waitError('INVALID_WAIT_CONDITION', 'process_exit pid must be a positive integer');
    }
  }
  if (condition.kind === 'tcp_listen') {
    if (condition.host !== undefined && (typeof condition.host !== 'string' || condition.host.length === 0)) {
      throw waitError('INVALID_WAIT_CONDITION', 'tcp_listen host must be a non-empty string');
    }
    if (!Number.isSafeInteger(condition.port) || condition.port < 1 || condition.port > 65535) {
      throw waitError('INVALID_WAIT_CONDITION', 'tcp_listen port must be an integer from 1 to 65535');
    }
  }
  if ((condition.kind === 'file_exists' || condition.kind === 'file_changed')
      && (typeof condition.path !== 'string' || condition.path.length === 0)) {
    throw waitError('INVALID_WAIT_CONDITION', `${condition.kind} path must be non-empty`);
  }
  if (condition.kind === 'http_ready') {
    if (typeof condition.url !== 'string' || condition.url.length === 0) {
      throw waitError('INVALID_WAIT_CONDITION', 'http_ready url must be non-empty');
    }
    let parsed;
    try {
      parsed = new URL(condition.url);
    } catch {
      throw waitError('INVALID_WAIT_CONDITION', 'http_ready url must be valid');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw waitError('INVALID_WAIT_CONDITION', 'http_ready supports only http and https URLs');
    }
    if (parsed.username || parsed.password) {
      throw waitError('INVALID_WAIT_CONDITION', 'http_ready URL credentials are not allowed');
    }
    if (condition.status !== undefined
        && (!Number.isSafeInteger(condition.status) || condition.status < 100 || condition.status > 599)) {
      throw waitError('INVALID_WAIT_CONDITION', 'http_ready status must be an integer from 100 to 599');
    }
  }
  if (condition.kind === 'systemd_user') {
    if (typeof condition.unit !== 'string' || !SYSTEMD_UNIT_RE.test(condition.unit)) {
      throw waitError('INVALID_WAIT_CONDITION', 'systemd_user unit is invalid');
    }
    if (condition.state !== undefined && !SYSTEMD_STATES.has(condition.state)) {
      throw waitError('INVALID_WAIT_CONDITION', 'systemd_user state must be active, inactive, or failed');
    }
  }
  if (condition.kind === 'timer') {
    const hasAfter = condition.after_seconds !== undefined;
    const hasAt = condition.at !== undefined;
    if (hasAfter === hasAt) {
      throw waitError('INVALID_WAIT_CONDITION', 'timer requires exactly one of after_seconds or at');
    }
    if (hasAfter
        && (!Number.isSafeInteger(condition.after_seconds)
          || condition.after_seconds < 1
          || condition.after_seconds > MAX_TIMER_AFTER_SECONDS)) {
      throw waitError(
        'INVALID_WAIT_CONDITION',
        `timer after_seconds must be an integer from 1 to ${MAX_TIMER_AFTER_SECONDS}`,
      );
    }
    if (hasAt) parseTimerAt(condition.at);
  }
  return condition;
}

export class LocalWaitSources {
  constructor({
    defaultCwd,
    fetchImpl = globalThis.fetch,
    systemctlBin = 'systemctl',
    execFileImpl = execFileAsync,
    env = process.env,
    now = () => Date.now(),
  } = {}) {
    if (typeof defaultCwd !== 'string' || defaultCwd.length === 0) {
      throw new TypeError('defaultCwd is required');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    if (typeof systemctlBin !== 'string' || systemctlBin.length === 0) throw new TypeError('systemctlBin is required');
    if (typeof execFileImpl !== 'function') throw new TypeError('execFileImpl is required');
    this.defaultCwd = defaultCwd;
    this.fetchImpl = fetchImpl;
    this.systemctlBin = systemctlBin;
    this.execFileImpl = execFileImpl;
    this.env = env;
    this.now = now;
  }

  pollIntervalMs(condition) {
    return condition?.kind === 'http_ready' ? 500 : 250;
  }

  async arm(condition, signal) {
    const validated = validateCondition(condition);
    throwIfAborted(signal);
    if (validated.kind === 'process_exit') {
      const startTimeTicks = await readProcessIdentity(validated.pid);
      throwIfAborted(signal);
      const baseline = { pid: validated.pid, startTimeTicks };
      if (startTimeTicks === null) {
        return { status: 'matched', baseline, evidence: `pid=${validated.pid} already-exited` };
      }
      return { status: 'pending', baseline };
    }
    if (validated.kind === 'tcp_listen') {
      return { status: 'pending', baseline: { host: validated.host ?? '127.0.0.1', port: validated.port } };
    }
    if (validated.kind === 'http_ready') {
      return {
        status: 'pending',
        baseline: { url: new URL(validated.url).href, status: validated.status ?? null },
      };
    }
    if (validated.kind === 'systemd_user') {
      return {
        status: 'pending',
        baseline: { unit: validated.unit, state: validated.state ?? 'active' },
      };
    }
    if (validated.kind === 'timer') {
      const nowMs = this.now();
      const targetAtMs = validated.after_seconds !== undefined
        ? nowMs + validated.after_seconds * 1000
        : parseTimerAt(validated.at);
      const baseline = {
        targetAtMs,
        targetIso: new Date(targetAtMs).toISOString(),
      };
      return nowMs >= targetAtMs
        ? { status: 'matched', baseline, evidence: `timer=${baseline.targetIso} reached` }
        : { status: 'pending', baseline };
    }
    const resolved = await resolveUserPath(this.defaultCwd, validated.path, { mustExist: false });
    throwIfAborted(signal);
    if (validated.kind === 'file_exists') {
      return { status: 'pending', baseline: { path: resolved } };
    }
    return { status: 'pending', baseline: { path: resolved, fingerprint: await fingerprint(resolved) } };
  }

  async check(record, signal) {
    const condition = validateCondition(record?.condition);
    const baseline = record?.baseline;
    if (!baseline || typeof baseline !== 'object') {
      throw waitError('WAIT_STATE_CORRUPT', 'local wait baseline is invalid');
    }
    throwIfAborted(signal);

    if (condition.kind === 'process_exit') {
      if (baseline.pid !== condition.pid) throw waitError('WAIT_STATE_CORRUPT', 'process wait baseline is invalid');
      if (baseline.startTimeTicks === null) {
        return { status: 'matched', baseline, evidence: `pid=${condition.pid} already-exited` };
      }
      const current = await readProcessIdentity(condition.pid);
      throwIfAborted(signal);
      if (current === null || current !== baseline.startTimeTicks) {
        return { status: 'matched', baseline, evidence: `pid=${condition.pid} exited` };
      }
      return { status: 'pending', baseline };
    }

    if (condition.kind === 'tcp_listen') {
      const host = condition.host ?? '127.0.0.1';
      if (baseline.host !== host || baseline.port !== condition.port) {
        throw waitError('WAIT_STATE_CORRUPT', 'tcp wait baseline is invalid');
      }
      const listening = await tcpProbe(host, condition.port, signal);
      return listening
        ? { status: 'matched', baseline, evidence: `tcp=${host}:${condition.port} listening` }
        : { status: 'pending', baseline };
    }

    if (condition.kind === 'http_ready') {
      const normalizedUrl = new URL(condition.url).href;
      const expectedStatus = condition.status ?? null;
      if (baseline.url !== normalizedUrl || baseline.status !== expectedStatus) {
        throw waitError('WAIT_STATE_CORRUPT', 'http wait baseline is invalid');
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await this.fetchImpl(normalizedUrl, {
          redirect: 'manual',
          signal: controller.signal,
        });
        await response.body?.cancel?.();
        const matched = expectedStatus === null
          ? response.status >= 200 && response.status <= 399
          : response.status === expectedStatus;
        return matched
          ? { status: 'matched', baseline, evidence: `http=${normalizedUrl} status=${response.status}` }
          : { status: 'pending', baseline };
      } catch (error) {
        if (signal?.aborted) throw waitError('WAIT_ABORTED', 'wait request was aborted');
        return { status: 'pending', baseline };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }

    if (condition.kind === 'systemd_user') {
      const expectedState = condition.state ?? 'active';
      if (baseline.unit !== condition.unit || baseline.state !== expectedState) {
        throw waitError('WAIT_STATE_CORRUPT', 'systemd wait baseline is invalid');
      }
      try {
        const { stdout } = await this.execFileImpl(this.systemctlBin, [
          '--user',
          'show',
          condition.unit,
          '--property=ActiveState',
          '--property=SubState',
          '--value',
        ], {
          encoding: 'utf8',
          env: systemdUserEnvironment(this.env),
          signal,
          timeout: SYSTEMD_PROBE_TIMEOUT_MS,
        });
        const [activeState = '', subState = ''] = String(stdout).trimEnd().split('\n');
        return activeState === expectedState
          ? { status: 'matched', baseline, evidence: `systemd_user=${condition.unit} state=${activeState} sub=${subState}` }
          : { status: 'pending', baseline };
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
          throw waitError('WAIT_ABORTED', 'wait request was aborted');
        }
        if (error?.code === 'WAIT_SOURCE_UNAVAILABLE') throw error;
        throw waitError(
          'WAIT_SOURCE_UNAVAILABLE',
          `systemd user source unavailable: ${error?.message ?? String(error)}`,
          { message: error?.message ?? String(error) },
        );
      }
    }

    if (condition.kind === 'timer') {
      if (!Number.isSafeInteger(baseline.targetAtMs)
          || typeof baseline.targetIso !== 'string'
          || baseline.targetIso !== new Date(baseline.targetAtMs).toISOString()) {
        throw waitError('WAIT_STATE_CORRUPT', 'timer wait baseline is invalid');
      }
      if (condition.at !== undefined && baseline.targetAtMs !== parseTimerAt(condition.at)) {
        throw waitError('WAIT_STATE_CORRUPT', 'timer wait baseline does not match the absolute target');
      }
      return this.now() >= baseline.targetAtMs
        ? { status: 'matched', baseline, evidence: `timer=${baseline.targetIso} reached` }
        : { status: 'pending', baseline };
    }

    if (typeof baseline.path !== 'string') throw waitError('WAIT_STATE_CORRUPT', 'file wait baseline is invalid');
    const current = await fingerprint(baseline.path);
    throwIfAborted(signal);
    if (condition.kind === 'file_exists') {
      return current.exists
        ? { status: 'matched', baseline, evidence: `file=${baseline.path} exists` }
        : { status: 'pending', baseline };
    }
    if (!baseline.fingerprint || typeof baseline.fingerprint !== 'object') {
      throw waitError('WAIT_STATE_CORRUPT', 'file_changed baseline fingerprint is invalid');
    }
    return sameFingerprint(current, baseline.fingerprint)
      ? { status: 'pending', baseline }
      : { status: 'matched', baseline, evidence: `file=${baseline.path} changed` };
  }
}
