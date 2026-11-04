import fs from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalDefaultCwd,
  canonicalWorkspaceRoot,
  resolveUserPath,
  resolveWorkspaceEntry,
} from './boundary.mjs';

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;

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
}, signal) {
  const wanted = typeof requested === 'string' && requested.length > 0 ? requested : '.';
  const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(effectiveLimit) || effectiveLimit < 1 || effectiveLimit > MAX_LIST_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
  }

  let target;
  try {
    if (pathMode === 'workspace') {
      target = await resolveWorkspaceEntry(await canonicalWorkspaceRoot(workspaceRoot), wanted);
    } else if (pathMode === 'user') {
      target = await resolveUserPath(await canonicalDefaultCwd(defaultCwd), wanted);
    } else {
      throw new Error('MCP_DEV_PATH_MODE must be workspace or user');
    }
  } catch (error) {
    throw describePathError(error, wanted);
  }
  throwIfAborted(signal);

  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    throw describePathError(error, wanted);
  }
  throwIfAborted(signal);

  const all = dirents
    .map(dirent => ({ name: dirent.name, kind: entryKind(dirent) }))
    .sort(byName);
  const shown = all.slice(0, effectiveLimit);

  for (const entry of shown) {
    if (entry.kind !== 'file') continue;
    try {
      const stat = await fs.stat(path.join(target, entry.name));
      entry.bytes = stat.size;
    } catch {
      // A file that disappears between readdir and stat keeps its name without a size.
    }
  }

  return {
    path: wanted,
    total: all.length,
    limit: effectiveLimit,
    truncated: all.length > shown.length,
    entries: shown,
  };
}
