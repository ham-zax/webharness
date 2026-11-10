import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalDefaultCwd,
  canonicalWorkspaceRoot,
  isWithin,
  requirePiStablePath,
  resolveUserPath,
  resolveWorkspaceEntry,
} from './boundary.mjs';

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;
export const MAX_LIST_DEPTH = 4;

const VENDOR_SKIP_NAMES = new Set(['.git', 'node_modules', 'third_party']);
const OPEN_DIR_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_DIRECTORY ?? 0);

function isSkippedVendorDir(baseName, relPath) {
  return VENDOR_SKIP_NAMES.has(baseName)
    || relPath === 'skill-library/packs'
    || relPath.endsWith('/skill-library/packs');
}

function entryKind(dirent) {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) return 'link';
  return 'other';
}

function byName(a, b) {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

// A path problem must stay distinguishable after the client wraps the message.
function describePathError(error, requested) {
  const code = error?.code;
  if (code === 'ENOENT') {
    return new Error(`ENOENT: ${requested} does not exist; list the parent directory instead`);
  }
  if (code === 'ENOTDIR') {
    return new Error(`ENOTDIR: ${requested} is not a directory; use read for a file`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new Error(`EACCES: permission denied for ${requested}`);
  }
  if (code === 'ELOOP') {
    return new Error(`ELOOP: too many symbolic links at ${requested}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  throw error;
}

export async function runListDirectory({
  pathMode = 'workspace',
  defaultCwd,
  workspaceRoot,
  path: requested,
  limit,
  depth,
  include_vendor: includeVendor = false,
}, signal) {
  const wanted = typeof requested === 'string' && requested.length > 0 ? requested : '.';
  const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(effectiveLimit) || effectiveLimit < 1 || effectiveLimit > MAX_LIST_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
  }
  const effectiveDepth = depth ?? 1;
  if (!Number.isInteger(effectiveDepth) || effectiveDepth < 1 || effectiveDepth > MAX_LIST_DEPTH) {
    throw new Error(`depth must be an integer from 1 to ${MAX_LIST_DEPTH}`);
  }
  if (typeof includeVendor !== 'boolean') {
    throw new Error('include_vendor must be a boolean');
  }

  let canonicalBoundaryRoot = null;
  let target;
  try {
    if (pathMode === 'workspace') {
      canonicalBoundaryRoot = await canonicalWorkspaceRoot(workspaceRoot);
      target = await resolveWorkspaceEntry(canonicalBoundaryRoot, wanted);
    } else if (pathMode === 'user') {
      target = await resolveUserPath(await canonicalDefaultCwd(defaultCwd), wanted);
    } else {
      throw new Error('MCP_DEV_PATH_MODE must be workspace or user');
    }
  } catch (error) {
    throw describePathError(error, wanted);
  }
  throwIfAborted(signal);

  async function classifyReplacedEntry(probePath) {
    try {
      const afterStat = await fs.lstat(probePath);
      if (afterStat.isSymbolicLink()) return 'link';
      if (afterStat.isFile()) return 'file';
      return 'other';
    } catch {
      return null;
    }
  }

  async function withVerifiedDirectory(dirPath, isRoot, fn, pinnedOpenPath = null) {
    const openTarget = pinnedOpenPath ?? dirPath;
    let linkStat;
    try {
      linkStat = await fs.lstat(openTarget);
    } catch (error) {
      if (isRoot) throw describePathError(error, wanted);
      return { replacedKind: null };
    }
    if (linkStat.isSymbolicLink()) {
      if (isRoot) {
        const err = Object.assign(new Error(`ELOOP: too many symbolic links at ${wanted}`), { code: 'ELOOP' });
        throw describePathError(err, wanted);
      }
      return { replacedKind: 'link' };
    }
    if (!linkStat.isDirectory()) {
      if (isRoot) {
        const err = Object.assign(new Error(`ENOTDIR: ${wanted}`), { code: 'ENOTDIR' });
        throw describePathError(err, wanted);
      }
      return { replacedKind: linkStat.isFile() ? 'file' : 'other' };
    }

    let handle;
    try {
      handle = await fs.open(openTarget, OPEN_DIR_FLAGS);
    } catch (error) {
      if (isRoot) throw describePathError(error, wanted);
      if (error?.code === 'ELOOP' || error?.code === 'EMLINK') return { replacedKind: 'link' };
      if (error?.code === 'ENOTDIR') {
        return { replacedKind: (await classifyReplacedEntry(openTarget)) ?? 'other' };
      }
      return { replacedKind: null };
    }

    try {
      const fdStat = await handle.stat();
      if (!fdStat.isDirectory() || fdStat.dev !== linkStat.dev || fdStat.ino !== linkStat.ino) {
        if (isRoot) {
          const err = Object.assign(new Error(`ELOOP: concurrent path change at ${wanted}`), { code: 'ELOOP' });
          throw describePathError(err, wanted);
        }
        return { replacedKind: (await classifyReplacedEntry(openTarget)) ?? 'other' };
      }

      let verifiedPath = dirPath;
      if (canonicalBoundaryRoot !== null) {
        let realDir;
        let realStat;
        try {
          realDir = await fs.realpath(dirPath);
          requirePiStablePath(realDir, 'path');
          realStat = await fs.lstat(realDir);
        } catch (error) {
          if (isRoot) throw describePathError(error, wanted);
          return { replacedKind: null };
        }
        if (realStat.dev !== fdStat.dev || realStat.ino !== fdStat.ino) {
          if (isRoot) throw new Error('path changed concurrently during workspace listing');
          return { replacedKind: null };
        }
        if (!isWithin(canonicalBoundaryRoot, realDir)) {
          if (isRoot) throw new Error('path resolves outside workspace');
          return { replacedKind: 'link' };
        }
        verifiedPath = realDir;
      }

      const procFdPath = `/proc/self/fd/${handle.fd}`;
      await fn({ handle, fdStat, verifiedPath, procFdPath });
      return { replacedKind: undefined };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function readPinnedDirents({ procFdPath }) {
    try {
      return await fs.readdir(procFdPath, { withFileTypes: true });
    } catch (error) {
      throw new Error('Pinned directory access is unavailable; /proc/self/fd must be readable', { cause: error });
    }
  }

  async function hasAnyPinnedEntry({ procFdPath }) {
    let dir;
    try {
      dir = await fs.opendir(procFdPath);
    } catch (error) {
      throw new Error('Pinned directory access is unavailable; /proc/self/fd must be readable', { cause: error });
    }
    try {
      return await dir.read() !== null;
    } finally {
      await dir.close().catch(() => {});
    }
  }

  async function populateFileBytes(entryObj, baseName, { procFdPath }) {
    try {
      const stat = await fs.lstat(`${procFdPath}/${baseName}`);
      if (stat.isSymbolicLink()) {
        entryObj.kind = 'link';
      } else if (stat.isFile()) {
        entryObj.bytes = stat.size;
      }
    } catch {
      // A file that disappears between readdir and lstat keeps its name without a size.
    }
  }

  if (effectiveDepth === 1) {
    let total = 0;
    const shown = [];
    await withVerifiedDirectory(target, true, async (ctx) => {
      throwIfAborted(signal);
      const dirents = await readPinnedDirents(ctx);
      throwIfAborted(signal);
      const sorted = [...dirents].sort(byName);
      total = sorted.length;
      const count = Math.min(total, effectiveLimit);
      for (let index = 0; index < count; index += 1) {
        const dirent = sorted[index];
        const entryObj = { name: dirent.name, kind: entryKind(dirent) };
        if (entryObj.kind === 'file') {
          await populateFileBytes(entryObj, dirent.name, ctx);
        }
        shown.push(entryObj);
      }
    });
    return {
      path: wanted,
      total,
      totalKnown: true,
      limit: effectiveLimit,
      depth: effectiveDepth,
      truncated: total > shown.length,
      entries: shown,
    };
  }

  let skippedVendor = false;
  let truncated = false;
  const shown = [];

  async function walk(absDir, relPrefix, currentDepth, parentEntry = null, pinnedOpenPath = null) {
    if (truncated) return;
    throwIfAborted(signal);
    const outcome = await withVerifiedDirectory(absDir, currentDepth === 1, async (ctx) => {
      throwIfAborted(signal);
      if (shown.length >= effectiveLimit) {
        if (await hasAnyPinnedEntry(ctx)) truncated = true;
        return;
      }
      const dirents = await readPinnedDirents(ctx);
      throwIfAborted(signal);
      const sorted = [...dirents].sort(byName);
      for (let index = 0; index < sorted.length; index += 1) {
        if (truncated) break;
        throwIfAborted(signal);
        if (shown.length >= effectiveLimit) {
          truncated = true;
          break;
        }
        const dirent = sorted[index];
        const relName = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
        const entryObj = { name: relName, kind: entryKind(dirent) };
        if (entryObj.kind === 'file') {
          await populateFileBytes(entryObj, dirent.name, ctx);
        }
        shown.push(entryObj);
        if (entryObj.kind === 'dir' && currentDepth < effectiveDepth) {
          if (!includeVendor && isSkippedVendorDir(dirent.name, relName)) {
            skippedVendor = true;
            continue;
          }
          if (shown.length >= effectiveLimit && index + 1 < sorted.length) {
            truncated = true;
            break;
          }
          const childPinned = `${ctx.procFdPath}/${dirent.name}`;
          await walk(path.join(ctx.verifiedPath, dirent.name), relName, currentDepth + 1, entryObj, childPinned);
        }
      }
    }, pinnedOpenPath);
    if (parentEntry && outcome.replacedKind) {
      parentEntry.kind = outcome.replacedKind;
    }
  }

  await walk(target, '', 1);

  return {
    path: wanted,
    total: shown.length,
    totalKnown: !truncated,
    limit: effectiveLimit,
    depth: effectiveDepth,
    truncated,
    ...(skippedVendor ? { skippedVendor: true } : {}),
    entries: shown,
  };
}
