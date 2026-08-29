import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function codedError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export async function resolveRepoRoot(cwd, { gitBin = 'git' } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw codedError('INVALID_CWD', 'cwd must be a non-empty path');
  }

  let canonicalCwd;
  try {
    canonicalCwd = await fs.realpath(cwd);
    const stat = await fs.stat(canonicalCwd);
    if (!stat.isDirectory()) throw codedError('INVALID_CWD', 'cwd must resolve to a directory');
  } catch (error) {
    if (error?.code === 'INVALID_CWD') throw error;
    throw codedError('CWD_UNAVAILABLE', `cannot resolve cwd ${cwd}`, error);
  }

  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      gitBin,
      ['-C', canonicalCwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8' }
    ));
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    if (/not a git repository/i.test(stderr)) {
      throw codedError('NO_REPOSITORY', `no Git repository contains ${canonicalCwd}`, error);
    }
    throw codedError('GIT_DISCOVERY_FAILED', `git root discovery failed for ${canonicalCwd}`, error);
  }

  const discovered = stdout.trim();
  if (!discovered) {
    throw codedError('GIT_DISCOVERY_FAILED', `git returned an empty repository root for ${canonicalCwd}`);
  }

  try {
    return await fs.realpath(discovered);
  } catch (error) {
    throw codedError('REPOSITORY_DISAPPEARED', `discovered repository root is unavailable: ${discovered}`, error);
  }
}
