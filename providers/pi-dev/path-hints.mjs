import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isWithin, resolveWorkspaceEntry } from './boundary.mjs';

function normalizeLookupName(name) {
  return String(name ?? '').toLowerCase().replace(/[-_\s]+/g, '');
}

async function verifySuggestedTarget({ pathMode, baseDir, full, expectDirectory, expectFile }) {
  let resolved = full;
  if (pathMode === 'workspace') {
    const rel = path.relative(baseDir, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    try {
      resolved = await resolveWorkspaceEntry(baseDir, rel);
    } catch {
      return false;
    }
    if (!isWithin(baseDir, resolved)) return false;
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) return false;
  if (expectDirectory && !stat.isDirectory()) return false;
  if (expectFile && !stat.isFile()) return false;
  return true;
}

async function lookupSiblingForCandidate({ pathMode, baseDir, candidate, formatResult, expectDirectory = false, expectFile = false }) {
  const missingSegments = [];
  let ancestor = candidate;
  for (let depth = 0; depth < 3; depth += 1) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    missingSegments.unshift(path.basename(ancestor));
    ancestor = parent;
    if (pathMode === 'workspace' && !isWithin(baseDir, ancestor)) return null;
    try {
      const realAncestor = await fs.realpath(ancestor);
      if (pathMode === 'workspace' && !isWithin(baseDir, realAncestor)) return null;
      const stat = await fs.stat(realAncestor);
      if (!stat.isDirectory()) return null;
      const entries = await fs.readdir(realAncestor);
      if (entries.length === 0 || entries.length > 512) return null;

      // Case 1: first missing segment matches a sibling (e.g. "web-harness" -> "webharness").
      const firstNorm = normalizeLookupName(missingSegments[0]);
      if (firstNorm) {
        for (const entry of entries) {
          if (entry === missingSegments[0] || normalizeLookupName(entry) !== firstNorm) continue;
          const full = path.join(realAncestor, entry, ...missingSegments.slice(1));
          if (await verifySuggestedTarget({ pathMode, baseDir, full, expectDirectory, expectFile })) {
            return formatResult(full);
          }
        }
      }

      // Case 2: joined multi-segment slug matches a sibling (e.g. "My Notes/todo" -> "my-notes-todo").
      if (missingSegments.length === 2) {
        const joinedNorm = normalizeLookupName(missingSegments.join(''));
        if (joinedNorm) {
          for (const entry of entries) {
            if (normalizeLookupName(entry) !== joinedNorm) continue;
            const full = path.join(realAncestor, entry);
            if (await verifySuggestedTarget({ pathMode, baseDir, full, expectDirectory, expectFile })) {
              return formatResult(full);
            }
          }
        }
      }
      return null;
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
    }
  }
  return null;
}

export async function suggestNearestSibling({ pathMode = 'workspace', baseDir, requested, expectDirectory = false, expectFile = false } = {}) {
  if (typeof requested !== 'string' || !requested || requested.includes('\0') || !baseDir) return null;
  let expanded = requested;
  let tildePrefix = false;
  if (pathMode === 'user' && (requested === '~' || requested.startsWith('~/'))) {
    tildePrefix = true;
    expanded = requested === '~' ? os.homedir() : path.join(os.homedir(), requested.slice(2));
  }
  const isAbs = path.isAbsolute(expanded);
  if (pathMode === 'workspace' && isAbs) return null;
  const candidate = isAbs ? path.resolve(expanded) : path.resolve(baseDir, expanded);
  if (pathMode === 'workspace' && !isWithin(baseDir, candidate)) return null;

  const formatResult = resolvedPath => {
    if (tildePrefix) {
      const relHome = path.relative(os.homedir(), resolvedPath);
      return relHome && !relHome.startsWith('..') ? `~/${relHome.split(path.sep).join('/')}` : resolvedPath;
    }
    if (isAbs) return resolvedPath;
    const rel = path.relative(baseDir, resolvedPath);
    return rel.split(path.sep).join('/');
  };

  const direct = await lookupSiblingForCandidate({ pathMode, baseDir, candidate, formatResult, expectDirectory, expectFile });
  if (direct) return direct;

  // In user mode, if a caller wrote an absolute path like "/repo/web-harness" intending
  // a path under baseDir (e.g. "/home/user/repo/webharness"), also probe under baseDir.
  if (pathMode === 'user' && isAbs && !tildePrefix && !isWithin(baseDir, candidate)) {
    const relFromRoot = candidate.replace(/^\/+/, '');
    if (relFromRoot) {
      const underBase = path.resolve(baseDir, relFromRoot);
      const exactOk = await verifySuggestedTarget({ pathMode, baseDir, full: underBase, expectDirectory, expectFile });
      if (exactOk) return underBase;
      const siblingUnderBase = await lookupSiblingForCandidate({
        pathMode,
        baseDir,
        candidate: underBase,
        formatResult: resolvedPath => resolvedPath,
        expectDirectory,
        expectFile,
      });
      if (siblingUnderBase) return siblingUnderBase;
    }
  }
  return null;
}
