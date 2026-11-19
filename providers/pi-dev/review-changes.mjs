import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveUserCwd } from './boundary.mjs';

const MAX_PATCH_BYTES = 256 * 1024;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

function abortError() {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function runGit(cwd, args, signal, {
  maxStdoutBytes = MAX_GIT_OUTPUT_BYTES,
  truncate = false,
  okExitCodes = [0],
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      finish(reject, abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();

    child.stdout.on('data', chunk => {
      if (truncated) return;
      const remaining = maxStdoutBytes - stdoutBytes;
      if (chunk.length <= remaining) {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
        return;
      }
      if (!truncate) {
        child.kill('SIGTERM');
        finish(reject, new Error('review_changes Git output exceeded the internal limit; narrow paths'));
        return;
      }
      if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
      stdoutBytes = maxStdoutBytes;
      truncated = true;
      child.kill('SIGTERM');
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.on('error', error => finish(reject, error));
    child.on('close', code => {
      const output = Buffer.concat(stdout).toString('utf8');
      if (truncated) {
        finish(resolve, { output, truncated: true });
        return;
      }
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (okExitCodes.includes(code)) finish(resolve, { output, truncated: false });
      else finish(reject, new Error(err || `git ${args[0]} failed with exit ${code}`));
    });
  });
}

const SINGLE_REV_PATTERN = /^[A-Za-z0-9_@][A-Za-z0-9._/@^~+{}-]*$/;

function validateRevEndpoint(part, original) {
  if (!part || part.startsWith('-') || part.includes('..') || !SINGLE_REV_PATTERN.test(part)) {
    throw new Error(`INVALID_ARGUMENT: invalid Git revision or range: ${original}`);
  }
}

function validateRev(rev) {
  if (typeof rev !== 'string' || rev.length === 0 || rev.length > 256) {
    throw new Error('INVALID_ARGUMENT: rev must be a non-empty revision or range (e.g. HEAD~3..HEAD)');
  }
  const rangeMatch = /^(.+?)(\.{2,3})(.+)$/.exec(rev);
  if (rangeMatch) {
    const [, left, sep, right] = rangeMatch;
    validateRevEndpoint(left, rev);
    validateRevEndpoint(right, rev);
    return { raw: rev, isRange: true, left, sep, right };
  }
  validateRevEndpoint(rev, rev);
  return { raw: rev, isRange: false };
}

function parseNameStatus(output) {
  const fields = output.split('\0');
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++];
    if (!rawStatus) continue;
    const code = rawStatus[0];
    if (code === 'R' || code === 'C') {
      const previousPath = fields[index++];
      const currentPath = fields[index++];
      if (currentPath) entries.push({ status: code, path: currentPath, previousPath });
    } else {
      const currentPath = fields[index++];
      if (currentPath) entries.push({ status: code, path: currentPath, previousPath: undefined });
    }
  }
  return entries;
}

function parseStatus(output) {
  const fields = output.split('\0');
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const field = fields[index++];
    if (!field) continue;
    const status = field.slice(0, 2);
    const currentPath = field.slice(3);
    if (!currentPath) continue;
    let previousPath;
    if (status.includes('R') || status.includes('C')) previousPath = fields[index++] || undefined;
    entries.push({ status, path: currentPath, previousPath });
  }
  return entries;
}

function parseNumstat(output) {
  const fields = output.split('\0').filter(Boolean);
  const stats = new Map();
  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? '';
    const parts = header.split('\t');
    const additions = parts[0] === '-' ? 0 : Number(parts[0] ?? 0);
    const removals = parts[1] === '-' ? 0 : Number(parts[1] ?? 0);
    if (parts.length >= 3 && parts[2]) {
      stats.set(parts[2], { additions, removals });
      continue;
    }
    index += 1;
    const file = fields[index++];
    if (file) stats.set(file, { additions, removals });
  }
  return stats;
}

function relativeToGitRoot(gitRoot, file) {
  const relative = path.relative(gitRoot, file);
  if (relative === '') return '.';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`review_changes path is outside repository: ${file}`);
  }
  return relative;
}

function normalizePaths(gitRoot, cwd, paths) {
  if (paths === undefined) return [];
  const seen = new Set();
  const normalized = [];
  for (const value of paths) {
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
    const relative = relativeToGitRoot(gitRoot, absolute).split(path.sep).join('/');
    if (!seen.has(relative)) {
      seen.add(relative);
      normalized.push(relative);
    }
  }
  return normalized;
}

async function reviewBaseline(gitRoot, signal) {
  const head = await runGit(
    gitRoot,
    ['rev-parse', '--verify', '--quiet', 'HEAD'],
    signal,
    { okExitCodes: [0, 1] },
  );
  const headRef = head.output.trim();
  if (headRef) return headRef;

  const emptyTree = await runGit(gitRoot, ['hash-object', '-t', 'tree', '--stdin'], signal);
  return emptyTree.output.trim();
}

export async function runReviewChanges({ defaultCwd, cwd, paths, rev }, signal) {
  const resolvedCwd = await resolveUserCwd(defaultCwd, cwd);
  const rootResult = await runGit(resolvedCwd, ['rev-parse', '--show-toplevel'], signal);
  const gitRoot = rootResult.output.trim();
  if (!gitRoot) throw new Error('review_changes requires a Git working tree');

  const pathArgs = normalizePaths(gitRoot, resolvedCwd, paths);
  const pathspec = pathArgs.length ? ['--', ...pathArgs.map(value => `:(literal)${value}`)] : [];

  if (rev !== undefined) {
    const parsedRev = validateRev(rev);
    const safeRev = parsedRev.raw;
    let diffSpec;
    if (parsedRev.isRange) {
      const [leftRes, rightRes] = await Promise.all([
        runGit(gitRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${parsedRev.left}^{commit}`], signal, { okExitCodes: [0, 1] }),
        runGit(gitRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${parsedRev.right}^{commit}`], signal, { okExitCodes: [0, 1] }),
      ]);
      const leftHash = leftRes.output.trim();
      const rightHash = rightRes.output.trim();
      if (!leftHash || !rightHash) {
        throw new Error(`INVALID_ARGUMENT: unknown Git revision in range: ${safeRev}`);
      }
      diffSpec = [`${leftHash}${parsedRev.sep}${rightHash}`];
    } else {
      const commitRes = await runGit(gitRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${safeRev}^{commit}`], signal, { okExitCodes: [0, 1] });
      const commitHash = commitRes.output.trim();
      if (!commitHash) {
        throw new Error(`INVALID_ARGUMENT: unknown Git revision: ${safeRev}`);
      }
      const parentRes = await runGit(gitRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${commitHash}^`], signal, { okExitCodes: [0, 1] });
      let parentHash = parentRes.output.trim();
      if (!parentHash) {
        const emptyTree = await runGit(gitRoot, ['hash-object', '-t', 'tree', '--stdin'], signal);
        parentHash = emptyTree.output.trim();
      }
      diffSpec = [parentHash, commitHash];
    }
    const revPathspec = pathArgs.length ? ['--', ...pathArgs.map(value => `:(literal)${value}`)] : ['--'];
    const [nameStatusResult, numstatResult, trackedPatch] = await Promise.all([
      runGit(gitRoot, ['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', ...diffSpec, ...revPathspec], signal),
      runGit(gitRoot, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', ...diffSpec, ...revPathspec], signal),
      runGit(
        gitRoot,
        ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', ...diffSpec, ...revPathspec],
        signal,
        { maxStdoutBytes: MAX_PATCH_BYTES, truncate: true },
      ),
    ]);
    const entries = parseNameStatus(nameStatusResult.output);
    const stats = parseNumstat(numstatResult.output);
    const files = entries.map(entry => {
      const stat = stats.get(entry.path) ?? { additions: 0, removals: 0 };
      return { ...entry, ...stat };
    });
    const summary = files.reduce((result, file) => {
      result.trackedAdditions += file.additions;
      result.trackedRemovals += file.removals;
      return result;
    }, { files: files.length, trackedAdditions: 0, trackedRemovals: 0, untracked: 0 });
    return {
      root: gitRoot,
      rev: safeRev,
      summary,
      files,
      patch: trackedPatch.output,
      patchTruncated: trackedPatch.truncated,
    };
  }

  const baseline = await reviewBaseline(gitRoot, signal);
  const [statusResult, numstatResult, trackedPatch] = await Promise.all([
    runGit(gitRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...pathspec], signal),
    runGit(gitRoot, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', baseline, ...pathspec], signal),
    runGit(
      gitRoot,
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', baseline, ...pathspec],
      signal,
      { maxStdoutBytes: MAX_PATCH_BYTES, truncate: true },
    ),
  ]);

  const entries = parseStatus(statusResult.output);
  const stats = parseNumstat(numstatResult.output);
  const files = entries.map(entry => {
    const stat = stats.get(entry.path) ?? { additions: 0, removals: 0 };
    return { ...entry, ...stat };
  });
  const summary = files.reduce((result, file) => {
    result.trackedAdditions += file.additions;
    result.trackedRemovals += file.removals;
    if (file.status === '??') result.untracked += 1;
    return result;
  }, { files: files.length, trackedAdditions: 0, trackedRemovals: 0, untracked: 0 });

  let patch = trackedPatch.output;
  let patchTruncated = trackedPatch.truncated;
  if (!patchTruncated) {
    for (const entry of entries.filter(item => item.status === '??')) {
      const usedBytes = Buffer.byteLength(patch, 'utf8');
      const remaining = MAX_PATCH_BYTES - usedBytes;
      if (remaining <= 0) {
        patchTruncated = true;
        break;
      }
      const untrackedPatch = await runGit(
        gitRoot,
        ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--', '/dev/null', entry.path],
        signal,
        { maxStdoutBytes: remaining, truncate: true, okExitCodes: [0, 1] },
      );
      if (patch && untrackedPatch.output) patch += patch.endsWith('\n') ? '' : '\n';
      patch += untrackedPatch.output;
      if (untrackedPatch.truncated) {
        patchTruncated = true;
        break;
      }
    }
  }

  return {
    root: gitRoot,
    summary,
    files,
    patch,
    patchTruncated,
  };
}
