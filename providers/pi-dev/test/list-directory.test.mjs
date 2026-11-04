import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_LIST_LIMIT, runListDirectory } from '../list-directory.mjs';
import { renderListDirectoryText } from '../render.mjs';

const tempDir = prefix => fs.mkdtemp(path.join(os.tmpdir(), prefix));

function textOf(result) {
  return renderListDirectoryText(result);
}

test('workspace listing reports kind, size, hidden entries and sorts by name', async () => {
  const workspaceRoot = await tempDir('pi-list-workspace-');
  await fs.mkdir(path.join(workspaceRoot, 'ahmed-hamza-workout'));
  await fs.mkdir(path.join(workspaceRoot, '.github'));
  await fs.writeFile(path.join(workspaceRoot, 'README.md'), 'x'.repeat(42));
  await fs.writeFile(path.join(workspaceRoot, 'notes.txt'), '');

  const result = await runListDirectory({ workspaceRoot, path: '.' });
  assert.equal(result.path, '.');
  assert.equal(result.total, 4);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.entries.map(entry => entry.name), ['.github', 'README.md', 'ahmed-hamza-workout', 'notes.txt']);
  assert.deepEqual(result.entries.map(entry => entry.kind), ['dir', 'file', 'dir', 'file']);
  assert.equal(result.entries[1].bytes, 42);
  assert.equal(result.entries[3].bytes, 0);

  const text = textOf(result);
  assert.match(text, /^dir: \.$/m);
  assert.match(text, /^entries: 4$/m);
  assert.match(text, /^file README\.md 42B$/m);
});

test('listing caps entries and reports the total when truncated', async () => {
  const workspaceRoot = await tempDir('pi-list-cap-');
  for (let index = 0; index < 5; index += 1) {
    await fs.writeFile(path.join(workspaceRoot, `f${index}.txt`), 'x');
  }
  const result = await runListDirectory({ workspaceRoot, path: '.', limit: 2 });
  assert.equal(result.total, 5);
  assert.equal(result.entries.length, 2);
  assert.equal(result.truncated, true);
  assert.match(textOf(result), /truncated · 5 entries total · raise limit above 2/);

  for (const bad of [0, -1, MAX_LIST_LIMIT + 1, 1.5]) {
    await assert.rejects(
      () => runListDirectory({ workspaceRoot, path: '.', limit: bad }),
      /limit must be an integer from 1 to 1000/,
      String(bad)
    );
  }
});

test('listing names an empty directory explicitly', async () => {
  const workspaceRoot = await tempDir('pi-list-empty-');
  await fs.mkdir(path.join(workspaceRoot, 'empty'));
  const result = await runListDirectory({ workspaceRoot, path: 'empty' });
  assert.equal(result.total, 0);
  assert.match(textOf(result), /\[empty directory\]/);
});

test('listing lists symlinks without following them', async () => {
  const workspaceRoot = await tempDir('pi-list-link-');
  await fs.writeFile(path.join(workspaceRoot, 'target.txt'), 'x');
  await fs.symlink('target.txt', path.join(workspaceRoot, 'shortcut'));

  const result = await runListDirectory({ workspaceRoot, path: '.' });
  const link = result.entries.find(entry => entry.name === 'shortcut');
  assert.equal(link.kind, 'link');
  assert.equal(link.bytes, undefined);
  assert.match(textOf(result), /\[symlinks are listed and not followed\]/);
});

test('listing rejects a file target, a missing path and a symlinked escape', async () => {
  const workspaceRoot = await tempDir('pi-list-errors-');
  const outside = await tempDir('pi-list-outside-');
  await fs.writeFile(path.join(workspaceRoot, 'README.md'), 'x');
  await fs.symlink(outside, path.join(workspaceRoot, 'escape'));

  await assert.rejects(
    () => runListDirectory({ workspaceRoot, path: 'README.md' }),
    /^Error: ENOTDIR: README\.md is not a directory; use read for a file$/
  );
  await assert.rejects(
    () => runListDirectory({ workspaceRoot, path: 'Ahmed Hamza/workout' }),
    (error) => {
      assert.match(error.message, /^ENOENT: Ahmed Hamza\/workout does not exist; list the parent directory instead$/);
      assert.equal(error.message.includes(workspaceRoot), false);
      return true;
    }
  );
  await assert.rejects(
    () => runListDirectory({ workspaceRoot, path: 'escape' }),
    /path resolves outside workspace/
  );
});

test('user listing resolves relative paths from the default cwd and accepts absolute paths', async () => {
  const defaultCwd = await tempDir('pi-list-user-');
  await fs.mkdir(path.join(defaultCwd, 'repo'));
  await fs.mkdir(path.join(defaultCwd, 'repo', 'ahmed-hamza-workout'));

  const root = await runListDirectory({ pathMode: 'user', defaultCwd });
  assert.equal(root.path, '.');
  assert.deepEqual(root.entries.map(entry => entry.name), ['repo']);

  const nested = await runListDirectory({ pathMode: 'user', defaultCwd, path: 'repo' });
  assert.deepEqual(nested.entries.map(entry => entry.name), ['ahmed-hamza-workout']);

  const absolute = await runListDirectory({
    pathMode: 'user',
    defaultCwd,
    path: path.join(defaultCwd, 'repo'),
  });
  assert.deepEqual(absolute.entries.map(entry => entry.name), ['ahmed-hamza-workout']);
});

test('listing makes control characters in names visible without breaking one entry per line', async () => {
  const workspaceRoot = await tempDir('pi-list-control-');
  await fs.writeFile(path.join(workspaceRoot, 'a\nb.txt'), 'x');
  const result = await runListDirectory({ workspaceRoot, path: '.' });
  const text = textOf(result);
  assert.equal(result.entries[0].name, 'a\nb.txt');
  assert.match(text, /^file a\?b\.txt 1B$/m);
});
