import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { lstat, readdir, truncate, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent';
import { resolveUserCwd, resolveWorkspaceCwd } from './boundary.mjs';

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const EXIT_STDIO_GRACE_MS = 100;
const MAX_POLICY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SPOOL_BYTES = 64 * 1024 * 1024;
const MAX_SPOOL_BYTES = 256 * 1024 * 1024;
const DEFAULT_SPOOL_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SPOOL_TTL_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_SPOOL_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_SPOOL_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ACTIVE_SPOOL_AGE_MS = (MAX_TIMEOUT_SECONDS + 60) * 1000;
const PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;

function positiveNumber(name, value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be > 0 and <= ${max}`);
  }
}

function boundedTail(current, chunk, limit) {
  if (chunk.length >= limit) return Buffer.from(chunk.subarray(chunk.length - limit));
  if (current.length + chunk.length <= limit) return Buffer.concat([current, chunk]);
  const keep = limit - chunk.length;
  return Buffer.concat([current.subarray(current.length - keep), chunk]);
}

function decodeBoundedUtf8Tail(buffer, limit) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;

  const decoded = buffer.subarray(start).toString('utf8');
  const encoded = Buffer.from(decoded, 'utf8');
  if (encoded.length <= limit) return decoded;

  let encodedStart = encoded.length - limit;
  while (encodedStart < encoded.length && (encoded[encodedStart] & 0xc0) === 0x80) encodedStart += 1;
  return encoded.subarray(encodedStart).toString('utf8');
}

function activeSpoolIdentity(name) {
  const match = name.match(/^(?:bash|exec)-(\d+)-(\d+)-.*\.log\.active$/);
  if (!match) return null;
  return { createdAtMs: Number(match[1]), pid: Number(match[2]) };
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function pruneBashSpools({
  stateDir,
  maxSpoolBytes = DEFAULT_MAX_SPOOL_BYTES,
  ttlSeconds = DEFAULT_SPOOL_TTL_SECONDS,
  maxTotalBytes = DEFAULT_SPOOL_MAX_TOTAL_BYTES,
  protectedPaths = [],
  nowMs = Date.now(),
}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    throw new Error('MCP_DEV_STATE_DIR must be an absolute path');
  }
  positiveNumber('MCP_DEV_MAX_SPOOL_BYTES', maxSpoolBytes, MAX_SPOOL_BYTES);
  positiveNumber('MCP_DEV_SPOOL_TTL_SECONDS', ttlSeconds, MAX_SPOOL_TTL_SECONDS);
  positiveNumber('MCP_DEV_SPOOL_MAX_TOTAL_BYTES', maxTotalBytes, MAX_SPOOL_TOTAL_BYTES);
  if (maxTotalBytes < maxSpoolBytes) {
    throw new Error('MCP_DEV_SPOOL_MAX_TOTAL_BYTES must be >= MCP_DEV_MAX_SPOOL_BYTES');
  }

  const protectedSet = new Set(protectedPaths.map(file => path.resolve(file)));
  const result = {
    deletedFiles: 0,
    deletedBytes: 0,
    deletedActiveFiles: 0,
    deletedActiveBytes: 0,
    truncatedFiles: 0,
    truncatedBytes: 0,
    retainedFiles: 0,
    retainedBytes: 0,
  };
  const retained = [];
  let entries;
  try {
    entries = await readdir(stateDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const active = activeSpoolIdentity(entry.name);
    if (active !== null) {
      const ownerIsCurrentProcess = active.pid === process.pid;
      const predatesCurrentProcess = ownerIsCurrentProcess
        && active.createdAtMs < PROCESS_STARTED_AT_MS - 5000;
      const staleByAge = !ownerIsCurrentProcess
        && Number.isFinite(active.createdAtMs)
        && nowMs - active.createdAtMs > MAX_ACTIVE_SPOOL_AGE_MS;
      if (!pidIsAlive(active.pid) || predatesCurrentProcess || staleByAge) {
        const file = path.join(stateDir, entry.name);
        try {
          const stats = await lstat(file);
          await unlink(file);
          result.deletedActiveFiles += 1;
          result.deletedActiveBytes += stats.size;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      continue;
    }
    if (!/^(?:bash|exec)-.*\.log$/.test(entry.name)) continue;
    const file = path.join(stateDir, entry.name);
    let stats;
    try {
      stats = await lstat(file);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stats.isFile()) continue;

    if (nowMs - stats.mtimeMs > ttlSeconds * 1000) {
      try {
        await unlink(file);
        result.deletedFiles += 1;
        result.deletedBytes += stats.size;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      continue;
    }

    let size = stats.size;
    if (size > maxSpoolBytes) {
      try {
        await truncate(file, maxSpoolBytes);
        result.truncatedFiles += 1;
        result.truncatedBytes += size - maxSpoolBytes;
        size = maxSpoolBytes;
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }
    retained.push({
      file,
      size,
      mtimeMs: stats.mtimeMs,
      protected: protectedSet.has(path.resolve(file)),
    });
  }

  retained.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
  let retainedBytes = retained.reduce((total, item) => total + item.size, 0);
  let retainedFiles = retained.length;
  for (const item of retained) {
    if (retainedBytes <= maxTotalBytes) break;
    if (item.protected) continue;
    try {
      await unlink(item.file);
      retainedBytes -= item.size;
      retainedFiles -= 1;
      result.deletedFiles += 1;
      result.deletedBytes += item.size;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      retainedBytes -= item.size;
      retainedFiles -= 1;
    }
  }

  result.retainedFiles = retainedFiles;
  result.retainedBytes = retainedBytes;
  return result;
}

async function resolveExecutionCwd({ pathMode, defaultCwd, workspaceRoot, cwd }) {
  if (pathMode === 'workspace') return resolveWorkspaceCwd(workspaceRoot, cwd);
  if (pathMode === 'user') return resolveUserCwd(defaultCwd, cwd);
  throw new Error('MCP_DEV_PATH_MODE must be workspace or user');
}

function validateCapturePolicy({
  timeoutSeconds,
  maxOutputBytes,
  maxSpoolBytes,
  spoolTtlSeconds,
  maxSpoolTotalBytes,
  stateDir,
}) {
  positiveNumber('timeout_seconds', timeoutSeconds, MAX_TIMEOUT_SECONDS);
  positiveNumber('MCP_DEV_MAX_OUTPUT_BYTES', maxOutputBytes, MAX_POLICY_BYTES);
  positiveNumber('MCP_DEV_MAX_SPOOL_BYTES', maxSpoolBytes, MAX_SPOOL_BYTES);
  positiveNumber('MCP_DEV_SPOOL_TTL_SECONDS', spoolTtlSeconds, MAX_SPOOL_TTL_SECONDS);
  positiveNumber('MCP_DEV_SPOOL_MAX_TOTAL_BYTES', maxSpoolTotalBytes, MAX_SPOOL_TOTAL_BYTES);
  if (maxSpoolTotalBytes < maxSpoolBytes) {
    throw new Error('MCP_DEV_SPOOL_MAX_TOTAL_BYTES must be >= MCP_DEV_MAX_SPOOL_BYTES');
  }
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    throw new Error('MCP_DEV_STATE_DIR must be an absolute path');
  }
}

function killProcessTree(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
    return;
  } catch {
    // The process may have exited before its group was signalled, or may not own a group.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function executeArgv(file, args, cwd, { onData, signal, timeout }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }

    let settled = false;
    let exited = false;
    let exitCode = null;
    let termination = null;
    let deadlineTimer = null;
    let postExitTimer = null;
    let stdoutEnded = false;
    let stderrEnded = false;
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    stdoutEnded = child.stdout === null;
    stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (postExitTimer !== null) clearTimeout(postExitTimer);
      signal?.removeEventListener('abort', abort);
      child.removeListener('error', handleError);
      child.removeListener('exit', handleExit);
      child.removeListener('close', handleClose);
      child.stdout?.removeListener('data', handleData);
      child.stdout?.removeListener('end', handleStdoutEnd);
      child.stderr?.removeListener('data', handleData);
      child.stderr?.removeListener('end', handleStderrEnd);
    };
    const finish = (error, code = exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve({ exitCode: code });
    };
    const finishAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) {
        finish(termination === null ? null : new Error(termination));
      }
    };
    const armPostExitTimer = () => {
      if (postExitTimer !== null) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(
        () => finish(termination === null ? null : new Error(termination)),
        EXIT_STDIO_GRACE_MS
      );
    };
    const terminate = reason => {
      if (settled || termination !== null) return;
      termination = reason;
      killProcessTree(child);
    };
    const abort = () => terminate('aborted');
    const handleData = data => {
      onData(data);
      if (exited && !settled) armPostExitTimer();
    };
    const handleStdoutEnd = () => {
      stdoutEnded = true;
      finishAfterExit();
    };
    const handleStderrEnd = () => {
      stderrEnded = true;
      finishAfterExit();
    };
    const handleError = error => finish(error);
    const handleExit = code => {
      exited = true;
      exitCode = code;
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      finishAfterExit();
      if (!settled) armPostExitTimer();
    };
    const handleClose = code => finish(termination === null ? null : new Error(termination), code);

    child.stdout?.on('data', handleData);
    child.stdout?.once('end', handleStdoutEnd);
    child.stderr?.on('data', handleData);
    child.stderr?.once('end', handleStderrEnd);
    child.once('error', handleError);
    child.once('exit', handleExit);
    child.once('close', handleClose);
    deadlineTimer = setTimeout(() => terminate(`timeout: ${timeout}`), timeout * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function runCaptured({
  spoolPrefix,
  pathMode = 'workspace',
  defaultCwd,
  workspaceRoot,
  cwd,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  maxOutputBytes,
  maxSpoolBytes = DEFAULT_MAX_SPOOL_BYTES,
  spoolTtlSeconds = DEFAULT_SPOOL_TTL_SECONDS,
  maxSpoolTotalBytes = DEFAULT_SPOOL_MAX_TOTAL_BYTES,
  stateDir,
}, signal, execute) {
  validateCapturePolicy({
    timeoutSeconds,
    maxOutputBytes,
    maxSpoolBytes,
    spoolTtlSeconds,
    maxSpoolTotalBytes,
    stateDir,
  });

  const resolvedCwd = await resolveExecutionCwd({ pathMode, defaultCwd, workspaceRoot, cwd });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const spool = path.join(stateDir, `${spoolPrefix}-${Date.now()}-${process.pid}-${randomUUID()}.log`);
  const activeSpool = `${spool}.active`;
  const fd = openSync(activeSpool, 'wx', 0o600);
  const started = process.hrtime.bigint();
  let tail = Buffer.alloc(0);
  let outputBytes = 0;
  let spoolBytes = 0;
  let exitCode = null;
  let timedOut = false;
  let cancelled = false;
  let unexpected = null;

  const onData = data => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const remainingSpoolBytes = Math.max(0, maxSpoolBytes - spoolBytes);
    if (remainingSpoolBytes > 0) {
      const retained = chunk.length <= remainingSpoolBytes
        ? chunk
        : chunk.subarray(0, remainingSpoolBytes);
      writeSync(fd, retained);
      spoolBytes += retained.length;
    }
    outputBytes += chunk.length;
    tail = boundedTail(tail, chunk, maxOutputBytes);
  };

  try {
    ({ exitCode } = await execute({
      cwd: resolvedCwd,
      onData,
      signal,
      timeout: timeoutSeconds,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'aborted') cancelled = true;
    else if (message.startsWith('timeout:')) timedOut = true;
    else unexpected = error;
  } finally {
    closeSync(fd);
  }

  if (unexpected) {
    try { unlinkSync(activeSpool); } catch {}
    throw unexpected;
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const truncated = outputBytes > maxOutputBytes;
  const spoolTruncated = outputBytes > maxSpoolBytes;
  if (truncated) {
    renameSync(activeSpool, spool);
  } else {
    try { unlinkSync(activeSpool); } catch {}
  }
  try {
    await pruneBashSpools({
      stateDir,
      maxSpoolBytes,
      ttlSeconds: spoolTtlSeconds,
      maxTotalBytes: maxSpoolTotalBytes,
      protectedPaths: truncated ? [spool] : [],
    });
  } catch (error) {
    console.error(`Pi Dev command spool GC warning: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    cwd: resolvedCwd,
    exit_code: timedOut || cancelled ? null : exitCode,
    output: decodeBoundedUtf8Tail(tail, maxOutputBytes),
    output_bytes: outputBytes,
    duration_ms: Math.round(durationMs),
    timed_out: timedOut,
    cancelled,
    truncated,
    spool_truncated: spoolTruncated,
    full_output_path: truncated ? spool : null,
    timeout_seconds: timeoutSeconds,
  };
}

export async function runBash({
  command,
  timeout_seconds = DEFAULT_TIMEOUT_SECONDS,
  ...options
}, signal) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('command must be a non-empty string');
  }
  const ops = createLocalBashOperations();
  return runCaptured({
    ...options,
    spoolPrefix: 'bash',
    timeoutSeconds: timeout_seconds,
  }, signal, ({ cwd, onData, signal: executionSignal, timeout }) => ops.exec(command, cwd, {
    onData,
    signal: executionSignal,
    timeout,
  }));
}

export async function runExec({
  argv,
  timeout_seconds = DEFAULT_TIMEOUT_SECONDS,
  ...options
}, signal) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 256) {
    throw new Error('argv must contain from 1 to 256 strings');
  }
  if (argv.some(value => typeof value !== 'string' || value.includes('\0')) || argv[0].length === 0) {
    throw new Error('argv must contain strings without null bytes and argv[0] must be non-empty');
  }
  const [file, ...args] = argv;
  return runCaptured({
    ...options,
    spoolPrefix: 'exec',
    timeoutSeconds: timeout_seconds,
  }, signal, ({ cwd, onData, signal: executionSignal, timeout }) => executeArgv(file, args, cwd, {
    onData,
    signal: executionSignal,
    timeout,
  }));
}
