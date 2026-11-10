import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalDefaultCwd,
  canonicalWorkspaceRoot,
  resolveUserPath,
  resolveWorkspaceEntry,
} from './boundary.mjs';

export const DEFAULT_SEARCH_MAX_RESULTS = 80;
export const MAX_SEARCH_MAX_RESULTS = 500;
export const DEFAULT_SEARCH_MAX_PER_FILE = 20;
export const MAX_SEARCH_MAX_PER_FILE = 200;
export const MAX_SEARCH_OUTPUT_BYTES = 32 * 1024;
export const VENDOR_EXCLUDE_GLOBS = [
  '!skill-library/packs/**',
  '!third_party/**',
  '!node_modules/**',
  '!.git/**',
];

function describePathError(error, requested) {
  const code = error?.code;
  if (code === 'ENOENT') {
    return new Error(`ENOENT: ${requested} does not exist; list the parent directory instead`);
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

function cleanMatchLine(line, singleFilePrefix) {
  let clean = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (clean.startsWith('./')) clean = clean.slice(2);
  if (singleFilePrefix && !clean.includes(':')) return `${singleFilePrefix}:${clean}`;
  if (singleFilePrefix && /^[0-9]+:/.test(clean)) return `${singleFilePrefix}:${clean}`;
  return clean;
}

export async function runSearch({
  pathMode = 'workspace',
  defaultCwd,
  workspaceRoot,
  pattern,
  path: requested,
  globs,
  literal = false,
  case_sensitive: caseSensitive,
  max_results: maxResults,
  max_per_file: maxPerFile,
  include_vendor: includeVendor = false,
}, signal) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('INVALID_ARGUMENT: pattern must be a non-empty string');
  }
  if (pattern.length > 4096 || pattern.includes('\0')) {
    throw new Error('INVALID_ARGUMENT: pattern must be at most 4096 characters without NUL bytes');
  }
  const effectiveMaxResults = maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
  if (!Number.isInteger(effectiveMaxResults) || effectiveMaxResults < 1 || effectiveMaxResults > MAX_SEARCH_MAX_RESULTS) {
    throw new Error(`INVALID_ARGUMENT: max_results must be an integer from 1 to ${MAX_SEARCH_MAX_RESULTS}`);
  }
  const effectiveMaxPerFile = maxPerFile ?? DEFAULT_SEARCH_MAX_PER_FILE;
  if (!Number.isInteger(effectiveMaxPerFile) || effectiveMaxPerFile < 1 || effectiveMaxPerFile > MAX_SEARCH_MAX_PER_FILE) {
    throw new Error(`INVALID_ARGUMENT: max_per_file must be an integer from 1 to ${MAX_SEARCH_MAX_PER_FILE}`);
  }
  const validatedGlobs = [];
  if (globs !== undefined) {
    if (!Array.isArray(globs) || globs.length > 32) {
      throw new Error('INVALID_ARGUMENT: globs must be an array of up to 32 glob strings');
    }
    for (const glob of globs) {
      if (typeof glob !== 'string' || glob.length === 0 || glob.length > 256 || glob.includes('\0')) {
        throw new Error('INVALID_ARGUMENT: each glob must be a non-empty string without NUL bytes');
      }
      validatedGlobs.push(glob);
    }
  }

  const wanted = typeof requested === 'string' && requested.length > 0 ? requested : '.';
  let target;
  let authorityRoot;
  try {
    if (pathMode === 'workspace') {
      authorityRoot = await canonicalWorkspaceRoot(workspaceRoot);
      target = await resolveWorkspaceEntry(authorityRoot, wanted);
    } else if (pathMode === 'user') {
      authorityRoot = await canonicalDefaultCwd(defaultCwd);
      target = await resolveUserPath(authorityRoot, wanted);
    } else {
      throw new Error('MCP_DEV_PATH_MODE must be workspace or user');
    }
  } catch (error) {
    throw describePathError(error, wanted);
  }
  throwIfAborted(signal);

  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    throw describePathError(error, wanted);
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`INVALID_ARGUMENT: ${wanted} must be a regular file or directory`);
  }

  const isDir = stat.isDirectory();
  const spawnCwd = isDir ? target : path.dirname(target);
  const searchTarget = isDir ? '.' : path.basename(target);
  const singleFileLabel = isDir
    ? null
    : (wanted !== '.' ? wanted : path.basename(target));

  const argv = [
    '--line-number',
    '--no-heading',
    '--color=never',
    '--max-columns=240',
    '--max-columns-preview',
    '-m',
    String(effectiveMaxPerFile),
  ];
  if (!includeVendor) {
    for (const exclude of VENDOR_EXCLUDE_GLOBS) argv.push('-g', exclude);
  }
  for (const glob of validatedGlobs) argv.push('-g', glob);
  if (literal === true) argv.push('-F');
  if (caseSensitive === true) argv.push('-s');
  else if (caseSensitive === false) argv.push('-i');
  else argv.push('-S');
  argv.push('--', pattern, searchTarget);

  return new Promise((resolve, reject) => {
    let settled = false;
    let capped = false;
    let byteBytes = 0;
    const matches = [];
    let remainder = '';
    const stderrChunks = [];

    const child = spawn('rg', argv, {
      cwd: spawnCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = () => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      const error = new Error('Operation aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const pushLine = (rawLine) => {
      if (!rawLine) return;
      if (matches.length >= effectiveMaxResults) {
        capped = true;
        child.kill('SIGTERM');
        return;
      }
      const formatted = cleanMatchLine(rawLine, singleFileLabel);
      const nextBytes = Buffer.byteLength(formatted, 'utf8') + 1;
      if (byteBytes + nextBytes > MAX_SEARCH_OUTPUT_BYTES && matches.length > 0) {
        capped = true;
        child.kill('SIGTERM');
        return;
      }
      byteBytes += nextBytes;
      matches.push(formatted);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled || capped) return;
      const combined = remainder + chunk;
      const parts = combined.split('\n');
      remainder = parts.pop() ?? '';
      for (const part of parts) {
        pushLine(part);
        if (capped) break;
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error.code === 'ENOENT' ? new Error('rg (ripgrep) is not installed on host') : error);
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!capped && remainder) pushLine(remainder);
      if (!capped && code !== 0 && code !== 1) {
        const errText = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`INVALID_ARGUMENT: search failed: ${errText || `rg exited with code ${code}`}`));
        return;
      }
      resolve({
        matches,
        truncated: capped,
        maxResults: effectiveMaxResults,
      });
    });
  });
}
