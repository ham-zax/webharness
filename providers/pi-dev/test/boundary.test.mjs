import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalWorkspaceRoot,
  resolveExistingWorkspacePath,
  resolveNewWorkspacePath,
  resolveWorkspaceCwd
} from '../boundary.mjs';

const tempDir = prefix => fs.mkdtemp(path.join(os.tmpdir(), prefix));

test('workspace root must be an absolute existing directory', async () => {
  await assert.rejects(() => canonicalWorkspaceRoot('relative/root'), /absolute/);
  const root = await tempDir('pi-boundary-root-');
  assert.equal(await canonicalWorkspaceRoot(root), await fs.realpath(root));
});

test('existing path is workspace-relative and canonicalized inside root', async () => {
  const root = await tempDir('pi-boundary-existing-');
  await fs.mkdir(path.join(root, 'repo'));
  await fs.writeFile(path.join(root, 'repo', 'x.txt'), 'x');
  assert.equal(
    await resolveExistingWorkspacePath(root, 'repo/x.txt'),
    await fs.realpath(path.join(root, 'repo', 'x.txt'))
  );
});

test('absolute file path is rejected even when it exists', async () => {
  const root = await tempDir('pi-boundary-absolute-');
  const outside = path.join(await tempDir('pi-boundary-outside-'), 'x.txt');
  await fs.writeFile(outside, 'outside');
  await assert.rejects(() => resolveExistingWorkspacePath(root, outside), /relative/);
});

test('parent traversal is rejected before filesystem access', async () => {
  const root = await tempDir('pi-boundary-traversal-');
  await assert.rejects(() => resolveExistingWorkspacePath(root, '../outside.txt'), /\.\./);
  await assert.rejects(() => resolveNewWorkspacePath(root, 'repo/../../outside.txt'), /\.\./);
});

test('existing symlink escape is rejected', async () => {
  const root = await tempDir('pi-boundary-symlink-');
  const outside = await tempDir('pi-boundary-symlink-outside-');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'secret-link'));
  await assert.rejects(() => resolveExistingWorkspacePath(root, 'secret-link'), /outside workspace/);
});

test('new file through symlinked outside parent is rejected', async () => {
  const root = await tempDir('pi-boundary-write-link-');
  const outside = await tempDir('pi-boundary-write-outside-');
  await fs.symlink(outside, path.join(root, 'outside-parent'));
  await assert.rejects(() => resolveNewWorkspacePath(root, 'outside-parent/new.txt'), /outside workspace/);
});

test('new file requires an existing canonical parent inside workspace', async () => {
  const root = await tempDir('pi-boundary-write-parent-');
  await fs.mkdir(path.join(root, 'repo'));
  assert.equal(
    await resolveNewWorkspacePath(root, 'repo/new.txt'),
    path.join(await fs.realpath(path.join(root, 'repo')), 'new.txt')
  );
  await assert.rejects(() => resolveNewWorkspacePath(root, 'missing/new.txt'), /parent.*exist/i);
});

test('bash cwd defaults to root and accepts only relative inside directories', async () => {
  const root = await tempDir('pi-boundary-cwd-');
  await fs.mkdir(path.join(root, 'repo'));
  assert.equal(await resolveWorkspaceCwd(root), await fs.realpath(root));
  assert.equal(await resolveWorkspaceCwd(root, 'repo'), await fs.realpath(path.join(root, 'repo')));
  await assert.rejects(() => resolveWorkspaceCwd(root, '/tmp'), /relative/);
  await assert.rejects(() => resolveWorkspaceCwd(root, '../outside'), /\.\./);
});

test('workspace rejects Unicode space characters that Pi would normalize after validation', async () => {
  const root = await tempDir('pi-boundary-unicode-space-');
  await fs.writeFile(path.join(root, 'a\u00a0b.txt'), 'weird');
  await assert.rejects(
    () => resolveExistingWorkspacePath(root, 'a\u00a0b.txt'),
    /Unicode space.*not supported/i
  );

  const unicodeRoot = path.join(await tempDir('pi-boundary-unicode-parent-'), 'root\u00a0dir');
  await fs.mkdir(unicodeRoot);
  await assert.rejects(
    () => canonicalWorkspaceRoot(unicodeRoot),
    /Unicode space.*not supported/i
  );
});
