import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_POLICY_BYTES = 256 * 1024;
export const MAX_SET_BYTES = 16 * 1024 * 1024;

export function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function checkJevCancellation(signal) {
  if (signal?.aborted) throw failure('JEV_CANCELLED', 'Jev request cancelled or its 30-second deadline expired');
}

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function relativeFile(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
      || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)
      || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw failure('INVALID_PATH', 'file must be a normalized relative path inside the approved pack');
  }
  return value;
}

// Pin the opened regular file. Check ancestors and its Linux descriptor path so
// replacing an ancestor with an escaping symlink cannot bypass the root boundary.
export async function readApprovedEntry(root, file, maxBytes = MAX_FILE_BYTES, signal) {
  checkJevCancellation(signal);
  relativeFile(file);
  const target = path.join(root, file);
  let current = root;
  let handle;
  try {
    for (const part of ['', ...file.split('/')]) {
      if (part) current = path.join(current, part);
      const stat = await fs.lstat(current);
      checkJevCancellation(signal);
      if (stat.isSymbolicLink()) throw failure('UNSAFE_FILE', 'symlinks are not readable skill files');
      if (current !== target && !stat.isDirectory()) throw failure('UNSAFE_FILE', 'file ancestor must be a directory');
    }
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure('UNSAFE_FILE', 'only regular files are readable');
    if (stat.size > maxBytes) throw failure('FILE_TOO_LARGE', 'approved file exceeds its byte limit');
    const executeBits = stat.mode & 0o111;
    const actual = await fs.readlink(`/proc/self/fd/${handle.fd}`);
    if (actual !== target) throw failure('UNSAFE_FILE', 'opened file no longer matches its approved path');
    const chunks = [];
    let size = 0;
    while (true) {
      checkJevCancellation(signal);
      const remaining = maxBytes + 1 - size;
      if (remaining <= 0) throw failure('FILE_TOO_LARGE', 'approved file exceeds its byte limit');
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      checkJevCancellation(signal);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      size += bytesRead;
      if (size > maxBytes) throw failure('FILE_TOO_LARGE', 'approved file exceeds its byte limit');
    }
    return { bytes: Buffer.concat(chunks, size), executeBits };
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('MISSING_DEPENDENCY', `approved file is missing: ${file}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readApproved(root, file, maxBytes = MAX_FILE_BYTES, signal) {
  return (await readApprovedEntry(root, file, maxBytes, signal)).bytes;
}

export function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw failure('UNSUPPORTED_CONTENT', 'readable dependencies must be UTF-8 text'); }
}
