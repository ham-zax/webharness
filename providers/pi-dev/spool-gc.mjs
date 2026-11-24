import { lstat, readdir, truncate, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const MAX_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_SPOOL_BYTES = 64 * 1024 * 1024;
const MAX_SPOOL_BYTES = 256 * 1024 * 1024;
const DEFAULT_SPOOL_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SPOOL_TTL_SECONDS = 365 * 24 * 60 * 60;
const ORPHAN_JOB_MIN_TTL_SECONDS = 24 * 60 * 60;
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

async function unlinkIfPresent(file) {
  let size = 0;
  try {
    const stats = await lstat(file);
    if (!stats.isFile()) return null;
    size = stats.size;
    await unlink(file);
    return size;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function pruneJobSpools({
  jobsDir,
  ttlSeconds = DEFAULT_SPOOL_TTL_SECONDS,
  orphanMinTtlSeconds = ORPHAN_JOB_MIN_TTL_SECONDS,
  bootTimeMs,
  protectedPaths = [],
  nowMs = Date.now(),
}) {
  if (typeof jobsDir !== 'string' || !path.isAbsolute(jobsDir)) {
    throw new Error('jobsDir must be an absolute path');
  }
  positiveNumber('MCP_DEV_SPOOL_TTL_SECONDS', ttlSeconds, MAX_SPOOL_TTL_SECONDS);
  positiveNumber('orphanMinTtlSeconds', orphanMinTtlSeconds, MAX_SPOOL_TTL_SECONDS);

  const protectedSet = new Set(protectedPaths.map(file => path.resolve(file)));
  const result = { deletedFiles: 0, deletedBytes: 0 };
  let entries;
  try {
    entries = await readdir(jobsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return result;
    throw error;
  }

  const ttlMs = ttlSeconds * 1000;
  const orphanTtlMs = Math.max(ttlSeconds, orphanMinTtlSeconds) * 1000;
  const effectiveBootTimeMs = Number.isFinite(bootTimeMs) ? bootTimeMs : (Date.now() - os.uptime() * 1000);
  const exitJobIds = new Set();
  const exitEntries = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.exit')) {
      exitJobIds.add(entry.name.slice(0, -'.exit'.length));
      exitEntries.push(entry);
    }
  }

  // 1. Prune finished jobs whose .exit file is past TTL (along with sibling .log).
  for (const entry of exitEntries) {
    const exitPath = path.join(jobsDir, entry.name);
    const logPath = `${exitPath.slice(0, -'.exit'.length)}.log`;
    if (protectedSet.has(path.resolve(exitPath)) || protectedSet.has(path.resolve(logPath))) continue;
    let stats;
    try {
      stats = await lstat(exitPath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stats.isFile() || nowMs - stats.mtimeMs <= ttlMs) continue;
    const logBytes = await unlinkIfPresent(logPath);
    if (logBytes !== null) {
      result.deletedFiles += 1;
      result.deletedBytes += logBytes;
    }
    const exitBytes = await unlinkIfPresent(exitPath);
    if (exitBytes !== null) {
      result.deletedFiles += 1;
      result.deletedBytes += exitBytes;
    }
  }

  // 2. Prune stale .exit.tmp files and orphaned .log files (no sibling .exit) that
  // either predate the current OS boot (guaranteed dead) or have been quiet past max(TTL, 24h).
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.exit.tmp')) {
      const tmpPath = path.join(jobsDir, entry.name);
      if (protectedSet.has(path.resolve(tmpPath))) continue;
      let stats;
      try {
        stats = await lstat(tmpPath);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (!stats.isFile() || nowMs - stats.mtimeMs <= ttlMs) continue;
      const bytes = await unlinkIfPresent(tmpPath);
      if (bytes !== null) {
        result.deletedFiles += 1;
        result.deletedBytes += bytes;
      }
      continue;
    }
    if (!entry.name.endsWith('.log')) continue;
    const jobId = entry.name.slice(0, -'.log'.length);
    if (exitJobIds.has(jobId)) continue;
    const logPath = path.join(jobsDir, entry.name);
    if (protectedSet.has(path.resolve(logPath))) continue;
    let stats;
    try {
      stats = await lstat(logPath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stats.isFile()) continue;
    const ageMs = nowMs - stats.mtimeMs;
    const predatesBoot = stats.mtimeMs < effectiveBootTimeMs;
    if (ageMs <= ttlMs || (!predatesBoot && ageMs <= orphanTtlMs)) continue;
    // Re-check sibling .exit to avoid racing a job that just finished.
    try {
      await lstat(path.join(jobsDir, `${jobId}.exit`));
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const bytes = await unlinkIfPresent(logPath);
    if (bytes !== null) {
      result.deletedFiles += 1;
      result.deletedBytes += bytes;
    }
  }

  return result;
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
    if (!/^(?:bash|exec|script)-.*\.log$/.test(entry.name)) continue;
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
  const jobsGc = await pruneJobSpools({
    jobsDir: path.join(stateDir, 'jobs'),
    ttlSeconds,
    protectedPaths,
    nowMs,
  });
  result.deletedFiles += jobsGc.deletedFiles;
  result.deletedBytes += jobsGc.deletedBytes;
  result.deletedJobFiles = jobsGc.deletedFiles;
  result.deletedJobBytes = jobsGc.deletedBytes;
  return result;
}
