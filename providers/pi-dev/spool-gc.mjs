import { lstat, readdir, truncate, unlink } from 'node:fs/promises';
import path from 'node:path';
const MAX_TIMEOUT_SECONDS = 300;
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
