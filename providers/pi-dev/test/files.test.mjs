import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createStrictEditOperations, runRead, runEdit, runWrite } from '../files.mjs';
import { withMutationPath } from '../mutation-coordinator.mjs';

const execFileAsync = promisify(execFile);

const tempDir = prefix => fs.mkdtemp(path.join(os.tmpdir(), prefix));

test('read honors Pi offset and limit within workspace', async () => {
  const workspaceRoot = await tempDir('pi-read-');
  await fs.mkdir(path.join(workspaceRoot, 'repo'));
  await fs.writeFile(path.join(workspaceRoot, 'repo', 'x.txt'), 'one\ntwo\nthree\nfour\n');
  const result = await runRead({ workspaceRoot, path: 'repo/x.txt', offset: 2, limit: 2 });
  const text = result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
  assert.match(text, /two/);
  assert.match(text, /three/);
  assert.doesNotMatch(text, /four/);
});

test('user read resolves relative paths from default cwd and accepts harmless absolute paths', async () => {
  const defaultCwd = await tempDir('pi-user-read-');
  await fs.writeFile(path.join(defaultCwd, 'relative.txt'), 'relative\n');
  const relative = await runRead({ pathMode: 'user', defaultCwd, path: 'relative.txt' });
  const relativeText = relative.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
  assert.match(relativeText, /relative/);

  const absolute = await runRead({ pathMode: 'user', defaultCwd, path: '/etc/os-release', limit: 2 });
  const absoluteText = absolute.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
  assert.match(absoluteText, /(NAME|PRETTY_NAME)=/);
});

test('user edit and write keep guarded-edit and create-only mutation safety', async () => {
  const defaultCwd = await tempDir('pi-user-mutate-');
  const existing = path.join(defaultCwd, 'existing.txt');
  await fs.writeFile(existing, 'alpha\nbeta\n');
  await runEdit({
    pathMode: 'user',
    defaultCwd,
    targets: [{ path: 'existing.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }]
  });
  assert.equal(await fs.readFile(existing, 'utf8'), 'ALPHA\nbeta\n');

  const created = path.join(defaultCwd, 'created.txt');
  await runWrite({ pathMode: 'user', defaultCwd, path: created, content: 'first\n' });
  await assert.rejects(
    () => runWrite({ pathMode: 'user', defaultCwd, path: created, content: 'second\n' }),
    /already exists|use edit/i
  );
  assert.equal(await fs.readFile(created, 'utf8'), 'first\n');
});

test('edit performs multiple exact disjoint replacements and returns a diff', async () => {
  const workspaceRoot = await tempDir('pi-edit-');
  await fs.mkdir(path.join(workspaceRoot, 'repo'));
  const file = path.join(workspaceRoot, 'repo', 'x.txt');
  await fs.writeFile(file, 'alpha\nbeta\ngamma\n');
  const result = await runEdit({
    workspaceRoot,
    targets: [{
      path: 'repo/x.txt',
      edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: 'gamma', newText: 'GAMMA' }
      ]
    }]
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'ALPHA\nbeta\nGAMMA\n');
  assert.match(result.details.diff, /ALPHA/);
  assert.match(result.details.diff, /GAMMA/);
});

test('edit v2 applies exact replacements across multiple existing files in one call', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-multi-');
  const a = path.join(workspaceRoot, 'a.txt');
  const b = path.join(workspaceRoot, 'b.txt');
  await fs.writeFile(a, 'alpha\n');
  await fs.writeFile(b, 'beta\n');
  const result = await runEdit({
    workspaceRoot,
    targets: [
      { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] },
      { path: 'b.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] }
    ]
  });
  assert.equal(await fs.readFile(a, 'utf8'), 'ALPHA\n');
  assert.equal(await fs.readFile(b, 'utf8'), 'BETA\n');
  assert.equal(result.targets.length, 2);
});

test('edit v2 preflights every target before mutating any file', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-preflight-');
  const a = path.join(workspaceRoot, 'a.txt');
  const b = path.join(workspaceRoot, 'b.txt');
  await fs.writeFile(a, 'alpha\n');
  await fs.writeFile(b, 'beta\n');
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [
        { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] },
        { path: 'b.txt', edits: [{ oldText: 'missing', newText: 'BETA' }] }
      ]
    }),
    /could not find|not found/i
  );
  assert.equal(await fs.readFile(a, 'utf8'), 'alpha\n');
  assert.equal(await fs.readFile(b, 'utf8'), 'beta\n');
});

test('edit v2 rejects duplicate canonical aliases before mutation', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-alias-');
  const file = path.join(workspaceRoot, 'a.txt');
  const link = path.join(workspaceRoot, 'alias.txt');
  await fs.writeFile(file, 'alpha\n');
  await fs.symlink(file, link);
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [
        { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] },
        { path: 'alias.txt', edits: [{ oldText: 'alpha', newText: 'OTHER' }] }
      ]
    }),
    /duplicate edit target/i
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'alpha\n');
});

test('edit v2 rejects invalid UTF-8 before mutating earlier targets', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-utf8-');
  const a = path.join(workspaceRoot, 'a.txt');
  const b = path.join(workspaceRoot, 'b.txt');
  await fs.writeFile(a, 'alpha\n');
  await fs.writeFile(b, Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [
        { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] },
        { path: 'b.txt', edits: [{ oldText: 'x', newText: 'y' }] }
      ]
    }),
    /valid UTF-8/i
  );
  assert.equal(await fs.readFile(a, 'utf8'), 'alpha\n');
  assert.deepEqual(await fs.readFile(b), Buffer.from([0xff, 0xfe, 0xfd]));
});

test('edit v2 supports exact substring removal with empty newText', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-remove-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'alpha beta gamma\n');
  await runEdit({
    workspaceRoot,
    targets: [{ path: 'a.txt', edits: [{ oldText: ' beta', newText: '' }] }]
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'alpha gamma\n');
});

test('edit tolerates trailing whitespace and common Unicode punctuation differences', async () => {
  const workspaceRoot = await tempDir('pi-fuzzy-');
  const file = path.join(workspaceRoot, 'x.txt');
  await fs.writeFile(file, 'const label = “keep—this①”; const x = “hello”;   \nuntouched—line   \n');
  await runEdit({
    workspaceRoot,
    targets: [{ path: 'x.txt', edits: [{ oldText: 'const x = "hello";\n', newText: 'const x = "bye";\n' }] }]
  });
  assert.equal(
    await fs.readFile(file, 'utf8'),
    'const label = “keep—this①”; const x = "bye";\nuntouched—line   \n'
  );
});

test('edit does not use broad NFKC compatibility matching', async () => {
  const workspaceRoot = await tempDir('pi-no-nfkc-');
  const file = path.join(workspaceRoot, 'x.txt');
  await fs.writeFile(file, 'const marker = "Ａ①";\n');
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{ path: 'x.txt', edits: [{ oldText: 'const marker = "A1";', newText: 'changed' }] }]
    }),
    /not found.*tolerant normalization/i
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'const marker = "Ａ①";\n');
});

test('a unique exact anchor wins over a normalization-equivalent occurrence', async () => {
  const workspaceRoot = await tempDir('pi-exact-first-');
  const file = path.join(workspaceRoot, 'x.txt');
  await fs.writeFile(file, 'const x = “hello”;\nconst x = "hello";\n');
  await runEdit({
    workspaceRoot,
    targets: [{ path: 'x.txt', edits: [{ oldText: 'const x = "hello";', newText: 'const x = "bye";' }] }]
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'const x = “hello”;\nconst x = "bye";\n');
});

test('edit rejects multiple exact anchors without trying tolerant matching', async () => {
  const workspaceRoot = await tempDir('pi-exact-ambiguous-');
  const file = path.join(workspaceRoot, 'x.txt');
  await fs.writeFile(file, 'same\nsame\n');
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{ path: 'x.txt', edits: [{ oldText: 'same', newText: 'changed' }] }]
    }),
    /exact text is not unique.*2 occurrences/i
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'same\nsame\n');
});

test('edit rejects a fallback anchor that is ambiguous after tolerant normalization', async () => {
  const workspaceRoot = await tempDir('pi-fuzzy-ambiguous-');
  const file = path.join(workspaceRoot, 'x.txt');
  await fs.writeFile(file, 'const x = “hello”;\nconst x = “hello”;\n');
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{ path: 'x.txt', edits: [{ oldText: 'const x = "hello";', newText: 'const x = "bye";' }] }]
    }),
    /2 occurrences|must be unique/i
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'const x = “hello”;\nconst x = “hello”;\n');
});

test('edit combines exact and tolerant anchors matched against one original snapshot', async () => {
  const workspaceRoot = await tempDir('pi-exact-fuzzy-mixed-');
  const file = path.join(workspaceRoot, 'x.txt');
  await fs.writeFile(file, 'const a = “one”;\nconst a = "one";\nconst b = “two”;   \n');
  await runEdit({
    workspaceRoot,
    targets: [{ path: 'x.txt', edits: [
      { oldText: 'const a = "one";', newText: 'const a = "ONE";' },
      { oldText: 'const b = "two";', newText: 'const b = "TWO";' }
    ] }]
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'const a = “one”;\nconst a = "ONE";\nconst b = "TWO";   \n');
});

test('edit rejects exact and tolerant anchors sharing a line', async () => {
  const workspaceRoot = await tempDir('pi-exact-fuzzy-line-');
  const file = path.join(workspaceRoot, 'x.txt');
  await fs.writeFile(file, 'alpha “beta”\n');
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{ path: 'x.txt', edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: '"beta"', newText: '"BETA"' }
      ] }]
    }),
    /share lines.*merge/i
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'alpha “beta”\n');
});

test('CRLF file accepts LF oldText and preserves CRLF', async () => {
  const workspaceRoot = await tempDir('pi-crlf-');
  const file = path.join(workspaceRoot, 'x.txt');
  await fs.writeFile(file, 'alpha\r\nbeta\r\n');
  await runEdit({
    workspaceRoot,
    targets: [{ path: 'x.txt', edits: [{ oldText: 'alpha\nbeta', newText: 'ALPHA\nbeta' }] }]
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'ALPHA\r\nbeta\r\n');
});

test('exact-first edit preserves a UTF-8 BOM', async () => {
  const workspaceRoot = await tempDir('pi-bom-');
  const file = path.join(workspaceRoot, 'x.txt');
  await fs.writeFile(file, '\uFEFFalpha\n');
  await runEdit({
    workspaceRoot,
    targets: [{ path: 'x.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }]
  });
  assert.equal(await fs.readFile(file, 'utf8'), '\uFEFFALPHA\n');
});

test('edit operation detects a changed snapshot before write', async () => {
  const workspaceRoot = await tempDir('pi-conflict-');
  const file = path.join(workspaceRoot, 'x.txt');
  await fs.writeFile(file, 'alpha\n');
  const ops = createStrictEditOperations([{ oldText: 'alpha', newText: 'ALPHA' }]);
  await ops.access(file);
  await ops.readFile(file);
  await fs.writeFile(file, 'other\n');
  await assert.rejects(() => ops.writeFile(file, 'ALPHA\n'), /changed during edit/i);
  assert.equal(await fs.readFile(file, 'utf8'), 'other\n');
});

test('edit v2 rejects pathname replacement before same-descriptor mutation', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-inode-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'alpha\n');
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{ path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }]
    }, undefined, {
      beforeGuard: async () => {
        await fs.rename(file, path.join(workspaceRoot, 'old.txt'));
        await fs.writeFile(file, 'replacement\n');
      }
    }),
    /changed|identity|inode/i
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'replacement\n');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'old.txt'), 'utf8'), 'alpha\n');
});

test('edit v2 rejects changed bytes before same-descriptor mutation', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-stale-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'alpha\n');
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{ path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }]
    }, undefined, {
      beforeGuard: async () => fs.writeFile(file, 'external\n')
    }),
    /changed|snapshot/i
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'external\n');
});

test('edit v2 reports uncertain state when the first mutating write fails', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-write-fail-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'alpha\n');
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{ path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }]
    }, undefined, {
      openFile: async (target, flags) => {
        const real = await fs.open(target, flags);
        return {
          stat: (...args) => real.stat(...args),
          read: (...args) => real.read(...args),
          write: async () => { throw new Error('injected write failure'); },
          truncate: (...args) => real.truncate(...args),
          close: () => real.close()
        };
      }
    }),
    (error) => error?.code === 'EDIT_PARTIAL' && error?.editPartial?.uncertain?.[0]?.path === 'a.txt'
  );
});

test('edit v2 reports uncertain state when truncate fails after writing', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-truncate-fail-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'alphabet\n');
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{ path: 'a.txt', edits: [{ oldText: 'alphabet', newText: 'A' }] }]
    }, undefined, {
      openFile: async (target, flags) => {
        const real = await fs.open(target, flags);
        return {
          stat: (...args) => real.stat(...args),
          read: (...args) => real.read(...args),
          write: (...args) => real.write(...args),
          truncate: async () => { throw new Error('injected truncate failure'); },
          close: () => real.close()
        };
      }
    }),
    (error) => error?.code === 'EDIT_PARTIAL' && error?.editPartial?.uncertain?.[0]?.path === 'a.txt'
  );
});

test('edit v2 rejects a zero-progress positional write as uncertain', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-zero-write-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'alpha\n');
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{ path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }]
    }, undefined, {
      openFile: async (target, flags) => {
        const real = await fs.open(target, flags);
        return {
          stat: (...args) => real.stat(...args),
          read: (...args) => real.read(...args),
          write: async () => ({ bytesWritten: 0 }),
          truncate: (...args) => real.truncate(...args),
          close: () => real.close()
        };
      }
    }),
    (error) => error?.code === 'EDIT_PARTIAL' && error?.editPartial?.uncertain?.[0]?.path === 'a.txt'
  );
});

test('edit v2 reports applied failed and unattempted targets after a later stale guard', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-partial-');
  for (const [name, text] of [['a.txt', 'alpha\n'], ['b.txt', 'beta\n'], ['c.txt', 'gamma\n']]) {
    await fs.writeFile(path.join(workspaceRoot, name), text);
  }
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [
        { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] },
        { path: 'b.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] },
        { path: 'c.txt', edits: [{ oldText: 'gamma', newText: 'GAMMA' }] }
      ]
    }, undefined, {
      beforeGuard: async (plan) => {
        if (plan.requestedPath === 'b.txt') await fs.writeFile(plan.canonicalPath, 'external\n');
      }
    }),
    (error) => {
      assert.equal(error.code, 'EDIT_PARTIAL');
      assert.deepEqual(error.editPartial.applied, ['a.txt']);
      assert.equal(error.editPartial.failed[0].path, 'b.txt');
      assert.deepEqual(error.editPartial.unattempted, ['c.txt']);
      return true;
    }
  );
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf8'), 'ALPHA\n');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'b.txt'), 'utf8'), 'external\n');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'c.txt'), 'utf8'), 'gamma\n');
});



test('edit v2 partial filesystem diagnostics sanitize canonical paths to requested labels', async () => {
  const defaultCwd = await tempDir('pi-edit-v2-partial-path-');
  const a = path.join(defaultCwd, 'a.txt');
  const b = path.join(defaultCwd, 'b.txt');
  await fs.writeFile(a, 'alpha\n');
  await fs.writeFile(b, 'beta\n');
  await assert.rejects(
    () => runEdit({
      pathMode: 'user', defaultCwd,
      targets: [
        { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] },
        { path: 'b.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] }
      ]
    }, undefined, {
      beforeGuard: async (plan) => {
        if (plan.requestedPath === 'b.txt') await fs.unlink(plan.canonicalPath);
      }
    }),
    (error) => {
      assert.equal(error.code, 'EDIT_PARTIAL');
      const message = error.editPartial.failed[0].message;
      assert.match(message, /b\.txt/);
      assert.doesNotMatch(message, new RegExp(defaultCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    }
  );
});



test('edit v2 does not turn a completed mutation into a retryable failure when close fails', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-close-after-apply-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'alpha\n');
  const result = await runEdit({
    workspaceRoot,
    targets: [{ path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }]
  }, undefined, {
    openFile: async (target, flags) => {
      const real = await fs.open(target, flags);
      return {
        stat: (...args) => real.stat(...args),
        read: (...args) => real.read(...args),
        write: (...args) => real.write(...args),
        truncate: (...args) => real.truncate(...args),
        close: async () => {
          await real.close();
          throw new Error('injected close failure');
        }
      };
    }
  });
  assert.equal(result.targets.length, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'ALPHA\n');
});

test('edit v2 writes longer output completely through the guarded descriptor', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-longer-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'a\n');
  await runEdit({
    workspaceRoot,
    targets: [{ path: 'a.txt', edits: [{ oldText: 'a', newText: 'alpha-beta-gamma' }] }]
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'alpha-beta-gamma\n');
});

test('edit v2 handles whole-file removal without stale tail bytes', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-empty-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'alpha\n');
  await runEdit({
    workspaceRoot,
    targets: [{ path: 'a.txt', edits: [{ oldText: 'alpha\n', newText: '' }] }]
  });
  assert.deepEqual(await fs.readFile(file), Buffer.alloc(0));
});

test('edit v2 target disappearance before first mutation is a zero-mutation error', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-disappear-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'alpha\n');
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{ path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }]
    }, undefined, {
      beforeGuard: async () => fs.unlink(file)
    }),
    (error) => {
      assert.doesNotMatch(error.message, /EDIT_PARTIAL/);
      return true;
    }
  );
  await assert.rejects(() => fs.stat(file), (error) => error?.code === 'ENOENT');
});

test('write creates a new file and refuses an existing path', async () => {
  const workspaceRoot = await tempDir('pi-write-');
  await runWrite({ workspaceRoot, path: 'new.txt', content: 'first\n' });
  await assert.rejects(
    () => runWrite({ workspaceRoot, path: 'new.txt', content: 'second\n' }),
    /already exists|use edit/i
  );
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'new.txt'), 'utf8'), 'first\n');
});

test('two concurrent creates for one absent path yield exactly one success', async () => {
  const workspaceRoot = await tempDir('pi-write-race-');
  const settled = await Promise.allSettled([
    runWrite({ workspaceRoot, path: 'race.txt', content: 'A\n' }),
    runWrite({ workspaceRoot, path: 'race.txt', content: 'B\n' })
  ]);
  assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(x => x.status === 'rejected').length, 1);
  assert.match(await fs.readFile(path.join(workspaceRoot, 'race.txt'), 'utf8'), /^(A|B)\n$/);
});

test('personal concurrent creates keep create-only semantics', async () => {
  const defaultCwd = await tempDir('pi-user-write-race-');
  const settled = await Promise.allSettled([
    runWrite({ pathMode: 'user', defaultCwd, path: 'race.txt', content: 'A\n' }),
    runWrite({ pathMode: 'user', defaultCwd, path: 'race.txt', content: 'B\n' })
  ]);
  assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(x => x.status === 'rejected').length, 1);
  assert.match(await fs.readFile(path.join(defaultCwd, 'race.txt'), 'utf8'), /^(A|B)\n$/);
});

test('two personal edits of the same exact region produce one safe conflict', async () => {
  const defaultCwd = await tempDir('pi-user-edit-same-region-');
  const file = path.join(defaultCwd, 'x.txt');
  await fs.writeFile(file, `alpha\n${'middle\n'.repeat(12000)}`);

  const settled = await Promise.allSettled([
    runEdit({
      pathMode: 'user',
      defaultCwd,
      targets: [{ path: 'x.txt', edits: [{ oldText: 'alpha', newText: 'ACTOR_A' }] }]
    }),
    runEdit({
      pathMode: 'user',
      defaultCwd,
      targets: [{ path: 'x.txt', edits: [{ oldText: 'alpha', newText: 'ACTOR_B' }] }]
    })
  ]);

  assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(x => x.status === 'rejected').length, 1);
  assert.match(await fs.readFile(file, 'utf8'), /^(ACTOR_A|ACTOR_B)\n/);
});

test('a stale exact edit rejects after another actor changes the observed region', async () => {
  const defaultCwd = await tempDir('pi-user-edit-stale-region-');
  const file = path.join(defaultCwd, 'x.txt');
  await fs.writeFile(file, 'alpha\nbeta\n');

  const observed = await runRead({ pathMode: 'user', defaultCwd, path: 'x.txt' });
  assert.match(observed.content.map(block => block.text ?? '').join('\n'), /alpha/);

  await runEdit({
    pathMode: 'user',
    defaultCwd,
    targets: [{ path: 'x.txt', edits: [{ oldText: 'alpha', newText: 'ACTOR_B' }] }]
  });
  await assert.rejects(
    () => runEdit({
      pathMode: 'user',
      defaultCwd,
      targets: [{ path: 'x.txt', edits: [{ oldText: 'alpha', newText: 'ACTOR_A' }] }]
    }),
    /could not find|not found|changed during edit/i
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'ACTOR_B\nbeta\n');
});

test('independent personal edits in different files both succeed', async () => {
  const defaultCwd = await tempDir('pi-user-edit-independent-');
  await fs.writeFile(path.join(defaultCwd, 'a.txt'), 'alpha\n');
  await fs.writeFile(path.join(defaultCwd, 'b.txt'), 'beta\n');

  const settled = await Promise.allSettled([
    runEdit({
      pathMode: 'user',
      defaultCwd,
      targets: [{ path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }]
    }),
    runEdit({
      pathMode: 'user',
      defaultCwd,
      targets: [{ path: 'b.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] }]
    })
  ]);

  assert.ok(settled.every(x => x.status === 'fulfilled'));
  assert.equal(await fs.readFile(path.join(defaultCwd, 'a.txt'), 'utf8'), 'ALPHA\n');
  assert.equal(await fs.readFile(path.join(defaultCwd, 'b.txt'), 'utf8'), 'BETA\n');
});

test('edit v2 opposite-order overlapping batches finish without deadlock and preserve explicit outcomes', async () => {
  const defaultCwd = await tempDir('pi-edit-v2-overlap-');
  const a = path.join(defaultCwd, 'a.txt');
  const b = path.join(defaultCwd, 'b.txt');
  const c = path.join(defaultCwd, 'c.txt');
  await fs.writeFile(a, 'a0\n');
  await fs.writeFile(b, 'b0\n');
  await fs.writeFile(c, 'c0\n');

  const first = runEdit({
    pathMode: 'user', defaultCwd,
    targets: [
      { path: 'a.txt', edits: [{ oldText: 'a0', newText: 'a1' }] },
      { path: 'b.txt', edits: [{ oldText: 'b0', newText: 'b1' }] }
    ]
  });
  const second = runEdit({
    pathMode: 'user', defaultCwd,
    targets: [
      { path: 'c.txt', edits: [{ oldText: 'c0', newText: 'c2' }] },
      { path: 'b.txt', edits: [{ oldText: 'b0', newText: 'b2' }] }
    ]
  });

  const settled = await Promise.race([
    Promise.allSettled([first, second]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('edit v2 overlap deadlocked')), 1000))
  ]);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
  const bFinal = await fs.readFile(b, 'utf8');
  assert.match(bFinal, /^b[12]\n$/);
});

test('edit v2 disjoint multi-target batches remain concurrent', async () => {
  const defaultCwd = await tempDir('pi-edit-v2-disjoint-batches-');
  for (const [name, text] of [['a.txt','a\n'],['b.txt','b\n'],['c.txt','c\n'],['d.txt','d\n']]) {
    await fs.writeFile(path.join(defaultCwd, name), text);
  }
  let entered = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const beforeGuard = async () => {
    entered += 1;
    if (entered < 2) await gate;
    else release();
  };
  const [one, two] = await Promise.all([
    runEdit({ pathMode: 'user', defaultCwd, targets: [
      { path: 'a.txt', edits: [{ oldText: 'a', newText: 'A' }] },
      { path: 'b.txt', edits: [{ oldText: 'b', newText: 'B' }] }
    ] }, undefined, { beforeGuard }),
    runEdit({ pathMode: 'user', defaultCwd, targets: [
      { path: 'c.txt', edits: [{ oldText: 'c', newText: 'C' }] },
      { path: 'd.txt', edits: [{ oldText: 'd', newText: 'D' }] }
    ] }, undefined, { beforeGuard })
  ]);
  assert.equal(one.targets.length, 2);
  assert.equal(two.targets.length, 2);
  assert.ok(entered >= 2);
});

test('edit v2 cancellation after one target applies reports remaining targets unattempted', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-cancel-after-first-');
  const a = path.join(workspaceRoot, 'a.txt');
  const b = path.join(workspaceRoot, 'b.txt');
  await fs.writeFile(a, 'alpha\n');
  await fs.writeFile(b, 'beta\n');
  const controller = new AbortController();
  let opens = 0;
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [
        { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] },
        { path: 'b.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] }
      ]
    }, controller.signal, {
      openFile: async (target, flags) => {
        const real = await fs.open(target, flags);
        opens += 1;
        const ordinal = opens;
        return {
          stat: (...args) => real.stat(...args),
          read: (...args) => real.read(...args),
          write: (...args) => real.write(...args),
          truncate: async (...args) => {
            const result = await real.truncate(...args);
            if (ordinal === 1) controller.abort();
            return result;
          },
          close: () => real.close()
        };
      }
    }),
    (error) => {
      assert.equal(error.code, 'EDIT_PARTIAL');
      assert.deepEqual(error.editPartial.applied, ['a.txt']);
      assert.equal(error.editPartial.reason, 'cancelled');
      assert.deepEqual(error.editPartial.unattempted, ['b.txt']);
      return true;
    }
  );
  assert.equal(await fs.readFile(a, 'utf8'), 'ALPHA\n');
  assert.equal(await fs.readFile(b, 'utf8'), 'beta\n');
});

test('edit v2 cancellation during the final target mutation lets that target settle successfully', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-cancel-final-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'alpha\n');
  const controller = new AbortController();
  const result = await runEdit({
    workspaceRoot,
    targets: [{ path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA-LONGER' }] }]
  }, controller.signal, {
    openFile: async (target, flags) => {
      const real = await fs.open(target, flags);
      return {
        stat: (...args) => real.stat(...args),
        read: (...args) => real.read(...args),
        write: async (...args) => {
          const written = await real.write(...args);
          controller.abort();
          return written;
        },
        truncate: (...args) => real.truncate(...args),
        close: () => real.close()
      };
    }
  });
  assert.equal(result.targets.length, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'ALPHA-LONGER\n');
});

test('edit v2 cancellation before the mutation barrier leaves the target untouched', async () => {
  const workspaceRoot = await tempDir('pi-edit-v2-cancel-prebarrier-');
  const file = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(file, 'alpha\n');
  const controller = new AbortController();
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{ path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] }]
    }, controller.signal, {
      beforeGuard: async () => controller.abort()
    }),
    /abort/i
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'alpha\n');
});

test('edit snapshot rejects a native Bash mutation before write', async () => {
  const defaultCwd = await tempDir('pi-user-edit-native-race-');
  const file = path.join(defaultCwd, 'x.txt');
  await fs.writeFile(file, 'alpha\n');

  const ops = createStrictEditOperations([{ oldText: 'alpha', newText: 'ALPHA' }]);
  await ops.access(file);
  await ops.readFile(file);
  await execFileAsync('bash', ['-c', 'printf "%s\\n" external > "$1"', 'bash', file]);

  await assert.rejects(() => ops.writeFile(file, 'ALPHA\n'), /changed during edit/i);
  assert.equal(await fs.readFile(file, 'utf8'), 'external\n');
});

test('edit canceled while queued for its target lease rejects without mutating', async () => {
  const defaultCwd = await tempDir('pi-user-edit-cancel-queued-');
  const file = path.join(defaultCwd, 'x.txt');
  await fs.writeFile(file, 'alpha\n');

  let releaseHolder;
  let holderEntered;
  const holderGate = new Promise(resolve => { releaseHolder = resolve; });
  const holderReady = new Promise(resolve => { holderEntered = resolve; });
  const holder = withMutationPath(file, async () => {
    holderEntered();
    await holderGate;
  });
  await holderReady;

  const controller = new AbortController();
  const pending = runEdit({
    pathMode: 'user',
    defaultCwd,
    targets: [{ path: 'x.txt', edits: [{ oldText: 'alpha', newText: 'EDITED' }] }]
  }, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 25));
  controller.abort();
  releaseHolder();

  await assert.rejects(pending, /abort/i);
  await holder;
  assert.equal(await fs.readFile(file, 'utf8'), 'alpha\n');
});
