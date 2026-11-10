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

test('depth>1 maps a bounded directory tree without following symlinks or expanding vendor dirs by default', async () => {
  const workspaceRoot = await tempDir('pi-list-tree-');
  const outside = await tempDir('pi-list-tree-outside-');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');
  await fs.mkdir(path.join(workspaceRoot, 'src', 'lib'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'node_modules', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, '.git', 'objects'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'src', 'index.js'), 'abc');
  await fs.writeFile(path.join(workspaceRoot, 'src', 'lib', 'util.js'), 'defg');
  await fs.writeFile(path.join(workspaceRoot, 'node_modules', 'pkg', 'index.js'), 'v');
  await fs.symlink(outside, path.join(workspaceRoot, 'src', 'ext-link'));

  const depth2 = await runListDirectory({ workspaceRoot, path: '.', depth: 2 });
  assert.equal(depth2.skippedVendor, true);
  assert.deepEqual(depth2.entries.map(e => `${e.kind}:${e.name}`), [
    'dir:.git',
    'dir:node_modules',
    'dir:src',
    'link:src/ext-link',
    'file:src/index.js',
    'dir:src/lib',
  ]);
  assert.equal(depth2.entries.find(e => e.name === 'src/index.js').bytes, 3);
  assert.match(textOf(depth2), /vendor\/\.git directories not expanded/);

  const depth3All = await runListDirectory({ workspaceRoot, path: '.', depth: 3, include_vendor: true });
  assert.equal(depth3All.skippedVendor, undefined);
  assert.ok(depth3All.entries.some(e => e.name === 'src/lib/util.js' && e.bytes === 4));
  assert.ok(depth3All.entries.some(e => e.name === 'node_modules/pkg/index.js'));
  assert.equal(depth3All.entries.some(e => e.name.includes('secret.txt')), false);

  for (const badDepth of [0, -1, 5, 1.5]) {
    await assert.rejects(
      () => runListDirectory({ workspaceRoot, path: '.', depth: badDepth }),
      /depth must be an integer from 1 to 4/
    );
  }
});

test('recursive listing bounds traversal early at limit without enumerating entire subtrees or overflowing the stack', async t => {
  // 1. Wide multi-directory tree: limit=1 stops after peeking the first child directory.
  const wideRoot = await tempDir('pi-list-wide-');
  t.after(() => fs.rm(wideRoot, { recursive: true, force: true }));
  for (let i = 0; i < 120; i += 1) {
    const sub = path.join(wideRoot, `d${String(i).padStart(3, '0')}`);
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, 'item.txt'), 'x');
  }
  const origOpen = fs.open.bind(fs);
  let openedCount = 0;
  t.mock.method(fs, 'open', async (...args) => {
    openedCount += 1;
    return origOpen(...args);
  });
  const boundedWide = await runListDirectory({ workspaceRoot: wideRoot, path: '.', depth: 3, limit: 1 });
  assert.equal(boundedWide.entries.length, 1);
  assert.equal(boundedWide.entries[0].name, 'd000');
  assert.equal(boundedWide.truncated, true);
  assert.equal(boundedWide.totalKnown, false);
  assert.ok(openedCount <= 2, `expected at most 2 directory opens for limit=1, got ${openedCount}`);
  assert.match(textOf(boundedWide), /^entries: 1\+$/m);
  assert.match(textOf(boundedWide), /truncated · more than 1 entries/);
  t.mock.restoreAll();

  // 2. Simulated 150,001-entry subtree never overflows the call stack and stops at limit.
  const deepRoot = await tempDir('pi-list-150k-');
  t.after(() => fs.rm(deepRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(deepRoot, 'sub'));
  await fs.writeFile(path.join(deepRoot, 'sub', 'seed.txt'), 'x');
  const fakeDirent = (name, kind) => ({
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'link',
  });
  const origReaddir = fs.readdir.bind(fs);
  let readdirCalls = 0;
  t.mock.method(fs, 'readdir', async (targetPath, options) => {
    readdirCalls += 1;
    if (readdirCalls === 1) return origReaddir(targetPath, options);
    return Array.from({ length: 150_000 }, (_, idx) => fakeDirent(`f${String(idx).padStart(6, '0')}.txt`, 'file'));
  });
  // With limit=1, walk peeks 'sub' via opendir (1 entry) without calling readdir on 150,000 items.
  const limit1 = await runListDirectory({ workspaceRoot: deepRoot, path: '.', depth: 2, limit: 1 });
  assert.equal(limit1.entries.length, 1);
  assert.equal(limit1.truncated, true);
  assert.equal(readdirCalls, 1, 'limit=1 should peek child dir via opendir rather than enumerating 150k dirents');

  // With limit=2, even when 150,000 child dirents are returned, no RangeError occurs and output is capped.
  readdirCalls = 0;
  const limit2 = await runListDirectory({ workspaceRoot: deepRoot, path: '.', depth: 2, limit: 2 });
  assert.equal(limit2.entries.length, 2);
  assert.equal(limit2.entries[0].name, 'sub');
  assert.equal(limit2.entries[1].name, 'sub/f000000.txt');
  assert.equal(limit2.truncated, true);
});

test('recursive listing refuses directories swapped into symlinks before recursion', async t => {
  const workspaceRoot = await tempDir('pi-list-race-ws-');
  const outside = await tempDir('pi-list-race-outside-');
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(workspaceRoot, 'victim'));
  await fs.writeFile(path.join(workspaceRoot, 'victim', 'safe.txt'), 'ok');
  await fs.writeFile(path.join(outside, 'outside-secret.txt'), 'secret');

  // Deterministically swap 'victim' from a real directory to a symlink pointing outside
  // right after the root directory readdir classifies 'victim' as a directory.
  const origReaddir = fs.readdir.bind(fs);
  let swapped = false;
  t.mock.method(fs, 'readdir', async (targetPath, options) => {
    const dirents = await origReaddir(targetPath, options);
    if (!swapped && dirents.some(d => d.name === 'victim')) {
      swapped = true;
      await fs.rm(path.join(workspaceRoot, 'victim'), { recursive: true, force: true });
      await fs.symlink(outside, path.join(workspaceRoot, 'victim'));
    }
    return dirents;
  });

  const result = await runListDirectory({ workspaceRoot, path: '.', depth: 3 });
  assert.equal(swapped, true);
  assert.equal(
    result.entries.some(entry => entry.name.includes('outside-secret.txt')),
    false,
    'entries outside workspace must never be listed after directory->symlink swap',
  );
  const victimEntry = result.entries.find(entry => entry.name === 'victim');
  assert.equal(victimEntry?.kind, 'link');
  assert.match(textOf(result), /\[symlinks are listed and not followed\]/);
  t.mock.restoreAll();

  // Also verify ancestor swap: if 'parent' is swapped to a symlink to an outside tree
  // containing a real 'nested' directory right before descending into 'parent/nested'.
  const ws2 = await tempDir('pi-list-anc-ws-');
  const outsideParent = await tempDir('pi-list-anc-out-');
  t.after(async () => {
    await fs.rm(ws2, { recursive: true, force: true });
    await fs.rm(outsideParent, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(ws2, 'parent', 'nested'), { recursive: true });
  await fs.writeFile(path.join(ws2, 'parent', 'nested', 'inside.txt'), 'ok');
  await fs.mkdir(path.join(outsideParent, 'nested'), { recursive: true });
  await fs.writeFile(path.join(outsideParent, 'nested', 'ancestor-secret.txt'), 'secret');

  let ancestorSwapped = false;
  t.mock.method(fs, 'readdir', async (targetPath, options) => {
    const dirents = await origReaddir(targetPath, options);
    if (!ancestorSwapped && dirents.some(d => d.name === 'nested')) {
      ancestorSwapped = true;
      await fs.rm(path.join(ws2, 'parent'), { recursive: true, force: true });
      await fs.symlink(outsideParent, path.join(ws2, 'parent'));
    }
    return dirents;
  });

  const ancResult = await runListDirectory({ workspaceRoot: ws2, path: '.', depth: 4 });
  assert.equal(ancestorSwapped, true);
  assert.equal(
    ancResult.entries.some(entry => entry.name.includes('ancestor-secret.txt')),
    false,
    'ancestor symlink swap must not leak nested outside filenames',
  );
  t.mock.restoreAll();

  // Also verify user mode never follows a child or ancestor swapped into a symlink.
  const userRoot = await tempDir('pi-list-user-race-');
  t.after(() => fs.rm(userRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(userRoot, 'parent', 'nested'), { recursive: true });
  let userSwapped = false;
  t.mock.method(fs, 'readdir', async (targetPath, options) => {
    const dirents = await origReaddir(targetPath, options);
    if (!userSwapped && dirents.some(d => d.name === 'nested')) {
      userSwapped = true;
      await fs.rm(path.join(userRoot, 'parent'), { recursive: true, force: true });
      await fs.symlink(outsideParent, path.join(userRoot, 'parent'));
    }
    return dirents;
  });
  const userResult = await runListDirectory({ pathMode: 'user', defaultCwd: userRoot, path: '.', depth: 4 });
  assert.equal(userSwapped, true);
  assert.equal(userResult.entries.some(entry => entry.name.includes('ancestor-secret.txt')), false);
});

test('listing fails closed when pinned directory access is unavailable, without pathname fallback', async t => {
  const workspaceRoot = await tempDir('pi-list-no-proc-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, 'child'));
  await fs.writeFile(path.join(workspaceRoot, 'child', 'safe.txt'), 'ok');
  const originalReaddir = fs.readdir.bind(fs);
  let calls = 0;
  let denyAt = 1;
  t.mock.method(fs, 'readdir', async (target, options) => {
    assert.ok(String(target).startsWith('/proc/self/fd/'), 'must never read a mutable pathname');
    calls += 1;
    if (calls === denyAt) throw Object.assign(new Error('proc denied'), { code: 'EACCES' });
    return originalReaddir(target, options);
  });
  await assert.rejects(() => runListDirectory({ workspaceRoot, path: '.', depth: 1 }), /Pinned directory access is unavailable/);
  calls = 0;
  denyAt = 2;
  await assert.rejects(() => runListDirectory({ workspaceRoot, path: '.', depth: 2 }), /Pinned directory access is unavailable/);
  t.mock.restoreAll();
  t.mock.method(fs, 'opendir', async () => {
    throw Object.assign(new Error('proc unavailable'), { code: 'ENOENT' });
  });
  await assert.rejects(() => runListDirectory({ workspaceRoot, path: '.', depth: 2, limit: 1 }), /Pinned directory access is unavailable/);
});
