import fs from 'node:fs/promises';
import path from 'node:path';

// Pi's resolveToCwd() normalizes these Unicode space characters to ASCII space.
// Reject them at our boundary so a path validated here cannot silently become a
// different filesystem path inside Pi after validation.
const PI_NORMALIZED_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/u;

function requirePiStablePath(value, label) {
  if (PI_NORMALIZED_UNICODE_SPACES.test(value)) {
    throw new Error(`${label} contains a Unicode space character not supported by the Pi path backend`);
  }
  return value;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function requireRelative(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty workspace-relative path`);
  }
  if (value.includes('\0')) throw new Error(`${label} contains a NUL byte`);
  requirePiStablePath(value, label);
  if (path.isAbsolute(value)) throw new Error(`${label} must be workspace-relative`);
  if (value.split('/').includes('..')) throw new Error(`${label} must not contain .. segments`);
  return value;
}

export async function canonicalWorkspaceRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('MCP_DEV_WORKSPACE_ROOT must be an absolute path');
  }
  requirePiStablePath(root, 'MCP_DEV_WORKSPACE_ROOT');
  const real = await fs.realpath(root);
  requirePiStablePath(real, 'MCP_DEV_WORKSPACE_ROOT');
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new Error('MCP_DEV_WORKSPACE_ROOT must be a directory');
  return real;
}

export async function resolveExistingWorkspacePath(root, relativePath) {
  const canonicalRoot = await canonicalWorkspaceRoot(root);
  requireRelative(relativePath, 'path');
  const target = await fs.realpath(path.resolve(canonicalRoot, relativePath));
  requirePiStablePath(target, 'path');
  if (!isWithin(canonicalRoot, target)) throw new Error('path resolves outside workspace');
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('path must resolve to a file');
  return target;
}

export async function resolveNewWorkspacePath(root, relativePath) {
  const canonicalRoot = await canonicalWorkspaceRoot(root);
  requireRelative(relativePath, 'path');
  const unresolved = path.resolve(canonicalRoot, relativePath);
  let parent;
  try {
    parent = await fs.realpath(path.dirname(unresolved));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('write parent must already exist');
    throw error;
  }
  requirePiStablePath(parent, 'write parent');
  const stat = await fs.stat(parent);
  if (!stat.isDirectory()) throw new Error('write parent must be a directory');
  if (!isWithin(canonicalRoot, parent)) throw new Error('write parent resolves outside workspace');
  return path.join(parent, path.basename(unresolved));
}

export async function resolveWorkspaceCwd(root, relativeCwd) {
  const canonicalRoot = await canonicalWorkspaceRoot(root);
  if (relativeCwd === undefined || relativeCwd === '') return canonicalRoot;
  requireRelative(relativeCwd, 'cwd');
  const target = await fs.realpath(path.resolve(canonicalRoot, relativeCwd));
  requirePiStablePath(target, 'cwd');
  if (!isWithin(canonicalRoot, target)) throw new Error('cwd resolves outside workspace');
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error('cwd must resolve to a directory');
  return target;
}
