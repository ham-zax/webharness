import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRepoRoot } from '../repo-root.mjs';

const execFileAsync = promisify(execFile);

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function initRepo(dir) {
  await execFileAsync('git', ['-C', dir, 'init', '-q']);
  return fs.realpath(dir);
}

test('resolves the canonical containing Git repository from a nested cwd', async t => {
  const repo = await tempDir(t, 'code-router-root-');
  const canonicalRepo = await initRepo(repo);
  const cwd = path.join(repo, 'src', 'feature');
  await fs.mkdir(cwd, { recursive: true });

  assert.equal(await resolveRepoRoot(cwd), canonicalRepo);
});

test('nearest nested Git root wins over an outer containing repository', async t => {
  const outer = await tempDir(t, 'code-router-nested-');
  await initRepo(outer);
  const nested = path.join(outer, 'vendor', 'nested');
  await fs.mkdir(nested, { recursive: true });
  const canonicalNested = await initRepo(nested);
  const cwd = path.join(nested, 'src');
  await fs.mkdir(cwd);

  assert.equal(await resolveRepoRoot(cwd), canonicalNested);
});

test('resolves through a symlinked cwd to one canonical repository key', async t => {
  const base = await tempDir(t, 'code-router-symlink-');
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  const canonicalRepo = await initRepo(repo);
  await fs.mkdir(path.join(repo, 'src'));
  const link = path.join(base, 'linked-repo');
  await fs.symlink(repo, link, 'dir');

  assert.equal(await resolveRepoRoot(path.join(link, 'src')), canonicalRepo);
});

test('outside a repository rejects with explicit NO_REPOSITORY', async t => {
  const cwd = await tempDir(t, 'code-router-no-repo-');

  await assert.rejects(
    () => resolveRepoRoot(cwd),
    error => {
      assert.equal(error.code, 'NO_REPOSITORY');
      assert.match(error.message, /NO_REPOSITORY.*no Git repository contains/i);
      return true;
    }
  );
});
