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
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent';
import { resolveUserCwd, resolveWorkspaceCwd } from './boundary.mjs';

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
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
  const match = name.match(/^bash-(\d+)-(\d+)-.*\.log\.active$/);
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
    if (!/^bash-.*\.log$/.test(entry.name)) continue;
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

export async function runBash({
  pathMode = 'workspace',
  defaultCwd,
  workspaceRoot,
  command,
  cwd,
  timeout_seconds = DEFAULT_TIMEOUT_SECONDS,
  maxOutputBytes,
  maxSpoolBytes = DEFAULT_MAX_SPOOL_BYTES,
  spoolTtlSeconds = DEFAULT_SPOOL_TTL_SECONDS,
  maxSpoolTotalBytes = DEFAULT_SPOOL_MAX_TOTAL_BYTES,
  stateDir
}, signal) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('command must be a non-empty string');
  }
  positiveNumber('timeout_seconds', timeout_seconds, MAX_TIMEOUT_SECONDS);
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

  let resolvedCwd;
  if (pathMode === 'workspace') resolvedCwd = await resolveWorkspaceCwd(workspaceRoot, cwd);
  else if (pathMode === 'user') resolvedCwd = await resolveUserCwd(defaultCwd, cwd);
  else throw new Error('MCP_DEV_PATH_MODE must be workspace or user');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const spool = path.join(stateDir, `bash-${Date.now()}-${process.pid}-${randomUUID()}.log`);
  const activeSpool = `${spool}.active`;
  const fd = openSync(activeSpool, 'wx', 0o600);

  const ops = createLocalBashOperations();
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
    ({ exitCode } = await ops.exec(command, resolvedCwd, {
      onData,
      signal,
      timeout: timeout_seconds
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
    console.error(`Pi Dev Bash spool GC warning: ${error instanceof Error ? error.message : String(error)}`);
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
    timeout_seconds
  };
}
