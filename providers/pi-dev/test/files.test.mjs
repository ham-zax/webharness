import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createStrictEditOperations, runRead, runEdit, runWrite } from '../files.mjs';
import { withMutationPath } from '../mutation-coordinator.mjs';

const execFileAsync = promisify(execFile);

const tempDir = prefix => fs.mkdtemp(path.join(os.tmpdir(), prefix));

test('write receipts verify UTF-8 bytes, binary bytes, and intentional empty files', async t => {
  const workspaceRoot = await tempDir('pi-write-receipt-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  for (const [name, bytes, encoding] of [
    ['unicode', Buffer.from('λ雪😀\n'), 'utf8'],
    ['binary', Buffer.from([0, 255, 1]), 'base64'],
    ['empty', Buffer.alloc(0), 'utf8'],
  ]) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const receipt = await runWrite({ workspaceRoot, path: name, content: bytes.toString(encoding), encoding,
      expected_bytes: bytes.length, expected_sha256: digest });
    assert.equal(receipt.bytes_written, bytes.length);
    assert.equal(receipt.sha256, `sha256:${digest}`);
    assert.equal(receipt.outcome, 'created');
    assert.match(receipt.operation_id, /^[a-f0-9-]{36}$/);
    assert.deepEqual(await fs.readFile(path.join(workspaceRoot, name)), bytes);
  }
});

test('write expectation mismatch precedes directory creation and replacement', async t => {
  const workspaceRoot = await tempDir('pi-write-expectation-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspaceRoot, 'existing'), 'keep');
  for (const expectation of [{ expected_bytes: 1 }, { expected_sha256: '0'.repeat(64) }]) {
    for (const target of ['missing/child', 'existing']) {
      await assert.rejects(runWrite({ workspaceRoot, path: target, content: 'new', overwrite: true,
        mkdir_parents: true, ...expectation }), { code: 'WRITE_EXPECTATION_MISMATCH' });
    }
  }
  assert.deepEqual(await fs.readdir(workspaceRoot), ['existing']);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'existing'), 'utf8'), 'keep');
});

test('write refuses a corrupt staged file before create or replace publication', async t => {
  const workspaceRoot = await tempDir('pi-write-corruption-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspaceRoot, 'existing'), 'keep');
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('.tmp')) {
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', data => write(Buffer.alloc(data.length, '!')));
    }
    return handle;
  });
  for (const [target, overwrite] of [['new', false], ['existing', true]]) {
    await assert.rejects(runWrite({ workspaceRoot, path: target, content: 'content', overwrite }),
      { code: 'WRITE_VERIFICATION_FAILED' });
  }
  assert.deepEqual(await fs.readdir(workspaceRoot), ['existing']);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'existing'), 'utf8'), 'keep');
});

test('write cancellation after staging leaves the destination untouched', async t => {
  const workspaceRoot = await tempDir('pi-write-cancel-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const controller = new AbortController();
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('.tmp')) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => { await sync(); controller.abort(); });
    }
    return handle;
  });
  await assert.rejects(runWrite({ workspaceRoot, path: 'new', content: 'content' }, controller.signal), /abort/i);
  assert.deepEqual(await fs.readdir(workspaceRoot), []);
});

test('exclusive write publication cannot replace a competing creator', async t => {
  const workspaceRoot = await tempDir('pi-write-publication-race-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const link = fs.link.bind(fs);
  t.mock.method(fs, 'link', async (source, destination) => {
    await fs.writeFile(destination, 'competing-content', { flag: 'wx' });
    return link(source, destination);
  });
  await assert.rejects(runWrite({ workspaceRoot, path: 'new', content: 'our-content' }), /already exists/);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'new'), 'utf8'), 'competing-content');
  assert.deepEqual(await fs.readdir(workspaceRoot), ['new']);
});

test('verified staging supports long destination names and rejects zero-byte corruption', async t => {
  const workspaceRoot = await tempDir('pi-write-staged-size-');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const name = 'x'.repeat(240);
  await runWrite({ workspaceRoot, path: name, content: 'keep' });
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('.tmp')) t.mock.method(handle, 'writeFile', async () => {});
    return handle;
  });
  await assert.rejects(runWrite({ workspaceRoot, path: name, content: 'new', overwrite: true }),
    { code: 'WRITE_VERIFICATION_FAILED' });
  assert.equal(await fs.readFile(path.join(workspaceRoot, name), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(workspaceRoot), [name]);
});

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

test('read byte cap preserves complete UTF-8 lines and gives a lossless continuation', async () => {
  const workspaceRoot = await tempDir('pi-read-bytes-');
  const lines = Array.from({ length: 30 }, (_, i) => `${i}: ${'é'.repeat(500)}`);
  const content = lines.join('\n');
  await fs.writeFile(path.join(workspaceRoot, 'large.txt'), content);
  let offset = 1;
  const recovered = [];
  for (;;) {
    const result = await runRead({ workspaceRoot, path: 'large.txt', offset, limit: 500 });
    const [body, note] = result.content[0].text.split('\n\n[truncated');
    assert.ok(Buffer.byteLength(body) <= 16384);
    assert.doesNotMatch(body, /�/);
    recovered.push(...body.split('\n'));
    if (!note) break;
    assert.match(note, new RegExp(`${Buffer.byteLength(content)} bytes total`));
    const next = Number(note.match(/offset=(\d+)/)[1]);
    assert.ok(next > offset);
    offset = next;
  }
  assert.deepEqual(recovered, lines);
});

test('read advances across blank lines and handles empty or oversized lines explicitly', async () => {
  const workspaceRoot = await tempDir('pi-read-empty-');
  await fs.writeFile(path.join(workspaceRoot, 'blank.txt'), '\nnext');
  const blank = await runRead({ workspaceRoot, path: 'blank.txt', limit: 1 });
  assert.match(blank.content[0].text, /offset=2/);
  const next = await runRead({ workspaceRoot, path: 'blank.txt', offset: 2 });
  assert.equal(next.content[0].text, 'next');
  await fs.writeFile(path.join(workspaceRoot, 'empty.txt'), '');
  assert.equal((await runRead({ workspaceRoot, path: 'empty.txt' })).content[0].text, '');
  await fs.writeFile(path.join(workspaceRoot, 'long.txt'), 'x'.repeat(20000));
  const long = await runRead({ workspaceRoot, path: 'long.txt' });
  assert.match(long.content[0].text, /Line 1 exceeds.*20000 bytes total/);
  assert.match(long.content[0].text, /extractor/);
  await assert.rejects(() => runRead({ workspaceRoot, path: 'blank.txt', offset: 3 }), /beyond end of file/);
});

test('read on a directory reports EISDIR with the listing recovery route', async () => {
  const workspaceRoot = await tempDir('pi-read-dir-');
  await fs.mkdir(path.join(workspaceRoot, 'ahmed-hamza-workout'));
  await assert.rejects(
    () => runRead({ workspaceRoot, path: 'ahmed-hamza-workout' }),
    /^Error: EISDIR: ahmed-hamza-workout is a directory; use list_directory with that path$/
  );
});

test('read rejects binary and invalid UTF-8 instead of returning corrupted text', async () => {
  const workspaceRoot = await tempDir('pi-read-binary-');
  for (const content of [Buffer.from([0xff]), Buffer.from('a\0b')]) {
    await fs.writeFile(path.join(workspaceRoot, 'binary.bin'), content);
    await assert.rejects(() => runRead({ workspaceRoot, path: 'binary.bin' }), /text files only/);
  }
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

test('write overwrite replaces an existing regular file, keeps its mode, and leaves no temp files', async () => {
  const workspaceRoot = await tempDir('pi-overwrite-');
  const target = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(target, 'old\n', { mode: 0o640 });
  await fs.chmod(target, 0o640);
  const result = await runWrite({ workspaceRoot, path: 'a.txt', content: 'new\n', overwrite: true });
  assert.equal(result.replaced, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'new\n');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  assert.deepEqual(await fs.readdir(workspaceRoot), ['a.txt']);
});

test('write overwrite on a missing file creates it and reports not replaced', async () => {
  const workspaceRoot = await tempDir('pi-overwrite-new-');
  const result = await runWrite({ workspaceRoot, path: 'fresh.txt', content: 'hi\n', overwrite: true });
  assert.equal(result.replaced, false);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'fresh.txt'), 'utf8'), 'hi\n');
});

test('write without overwrite still refuses and now points at the flag', async () => {
  const workspaceRoot = await tempDir('pi-no-overwrite-');
  await fs.writeFile(path.join(workspaceRoot, 'a.txt'), 'keep\n');
  await assert.rejects(
    () => runWrite({ workspaceRoot, path: 'a.txt', content: 'x\n' }),
    /already exists.*overwrite: true/
  );
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf8'), 'keep\n');
});

test('write overwrite refuses symlinks and directories and never writes through a link', async () => {
  const workspaceRoot = await tempDir('pi-overwrite-unsafe-');
  const outside = await tempDir('pi-overwrite-outside-');
  await fs.writeFile(path.join(outside, 'victim.txt'), 'victim\n');
  await fs.symlink(path.join(outside, 'victim.txt'), path.join(workspaceRoot, 'link.txt'));
  await fs.mkdir(path.join(workspaceRoot, 'dir'));
  await assert.rejects(
    () => runWrite({ workspaceRoot, path: 'link.txt', content: 'pwn\n', overwrite: true }),
    /regular file/
  );
  await assert.rejects(
    () => runWrite({ workspaceRoot, path: 'dir', content: 'x\n', overwrite: true }),
    /regular file/
  );
  assert.equal(await fs.readFile(path.join(outside, 'victim.txt'), 'utf8'), 'victim\n');
  assert.equal((await fs.readdir(workspaceRoot)).sort().join(','), 'dir,link.txt');
});

test('concurrent overwrites serialize and leave one complete winner', async () => {
  const workspaceRoot = await tempDir('pi-overwrite-race-');
  const target = path.join(workspaceRoot, 'a.txt');
  await fs.writeFile(target, 'seed\n');
  const bodies = Array.from({ length: 8 }, (_, index) => `${String(index).repeat(5000)}\n`);
  await Promise.all(bodies.map(content => runWrite({ workspaceRoot, path: 'a.txt', content, overwrite: true })));
  assert.ok(bodies.includes(await fs.readFile(target, 'utf8')));
  assert.deepEqual(await fs.readdir(workspaceRoot), ['a.txt']);
});


test('user-mode write supports overwrite and keeps create-only as the default', async () => {
  const defaultCwd = await tempDir('pi-user-write-');
  await runWrite({ pathMode: 'user', defaultCwd, path: 'f.txt', content: '1\n' });
  await assert.rejects(
    () => runWrite({ pathMode: 'user', defaultCwd, path: 'f.txt', content: '2\n' }),
    /already exists.*overwrite: true/
  );
  const replaced = await runWrite({ pathMode: 'user', defaultCwd, path: 'f.txt', content: '2\n', overwrite: true });
  assert.equal(replaced.replaced, true);
  assert.equal(await fs.readFile(path.join(defaultCwd, 'f.txt'), 'utf8'), '2\n');
  await assert.rejects(
    () => runWrite({ pathMode: 'user', defaultCwd, path: 'missing/dir/f.txt', content: '3\n' }),
    /ENOENT|no such file|not exist|parent/i
  );
});

test('write decodes base64 content, applies an explicit mode, and creates parents', async () => {
  const workspaceRoot = await tempDir('pi-write-binary-');
  const bytes = Buffer.from([0, 1, 2, 255, 10, 0xc3]);
  const result = await runWrite({
    workspaceRoot,
    path: 'bin/sub/tool',
    content: bytes.toString('base64'),
    encoding: 'base64',
    mode: '0755',
    mkdir_parents: true,
  });
  assert.equal(result.replaced, false);
  const target = path.join(workspaceRoot, 'bin', 'sub', 'tool');
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o755);

  await runWrite({ workspaceRoot, path: 'bin/sub/tool', content: 'echo hi\n', overwrite: true, mode: '600' });
  assert.equal(await fs.readFile(target, 'utf8'), 'echo hi\n');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
});

test('write rejects invalid base64 and modes before touching the filesystem', async () => {
  const workspaceRoot = await tempDir('pi-write-invalid-');
  await assert.rejects(
    () => runWrite({ workspaceRoot, path: 'x/a.bin', content: 'not base64!', encoding: 'base64', mkdir_parents: true }),
    /not valid base64/,
  );
  await assert.rejects(
    () => runWrite({ workspaceRoot, path: 'x/a.bin', content: 'x', mode: '4755', mkdir_parents: true }),
    /mode must be/,
  );
  assert.deepEqual(await fs.readdir(workspaceRoot), []);
});

test('write mkdir_parents refuses parents routed outside the workspace', async () => {
  const workspaceRoot = await tempDir('pi-write-parents-root-');
  const outside = await tempDir('pi-write-parents-outside-');
  await fs.symlink(outside, path.join(workspaceRoot, 'link'));
  await assert.rejects(
    () => runWrite({ workspaceRoot, path: 'link/new/a.txt', content: 'x', mkdir_parents: true }),
    /outside workspace/,
  );
  await assert.rejects(
    () => runWrite({ workspaceRoot, path: '../escape/a.txt', content: 'x', mkdir_parents: true }),
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test('user write mkdir_parents creates absolute parents', async () => {
  const defaultCwd = await tempDir('pi-write-user-parents-');
  const target = path.join(defaultCwd, 'deep', 'er', 'a.txt');
  await runWrite({ pathMode: 'user', defaultCwd, path: target, content: 'ok\n', mkdir_parents: true });
  assert.equal(await fs.readFile(target, 'utf8'), 'ok\n');
});

test('user mode expands leading tilde paths against HOME', async (t) => {
  const fakeHome = await tempDir('pi-tilde-home-');
  const otherCwd = await tempDir('pi-tilde-cwd-');
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });
  await fs.mkdir(path.join(fakeHome, 'repo'), { recursive: true });
  await fs.writeFile(path.join(fakeHome, 'repo', 'hello.txt'), 'tilde-ok\n');
  const readRes = await runRead({ pathMode: 'user', defaultCwd: otherCwd, path: '~/repo/hello.txt' });
  assert.equal(readRes.content[0].text, 'tilde-ok\n');
});

test('read mode outline returns compact structural landmarks for JavaScript', async () => {
  const workspaceRoot = await tempDir('pi-read-outline-js-');
  const content = [
    'export function alpha() {',
    '  return 1;',
    '}',
    '',
    'export class Beta {',
    '  run() {',
    '    return 2;',
    '  }',
    '}',
    '',
    'const gamma = async () => 3;',
    ''
  ].join('\n');
  await fs.writeFile(path.join(workspaceRoot, 'mod.mjs'), content);
  const text = (await runRead({ workspaceRoot, path: 'mod.mjs', mode: 'outline' })).content[0].text;
  assert.match(text, new RegExp(`^\\[outline · 12 lines · ${Buffer.byteLength(content)} bytes\\]`));
  assert.match(text, /L1: export function alpha\(\) \{/);
  assert.match(text, /L5: export class Beta \{/);
  assert.match(text, /L6: run\(\) \{/);
  assert.match(text, /L11: const gamma = async \(\) => 3;/);
  assert.doesNotMatch(text, /L2: return 1;/);
  assert.doesNotMatch(text, /�/);
});

test('read mode outline lists Markdown headings and falls back to a bounded head', async () => {
  const workspaceRoot = await tempDir('pi-read-outline-md-');
  const markdown = '# Title\n\nintro\n\n## Section\n\nbody\n\n### Detail\n';
  await fs.writeFile(path.join(workspaceRoot, 'notes.md'), markdown);
  const outline = (await runRead({ workspaceRoot, path: 'notes.md', mode: 'outline' })).content[0].text;
  assert.match(outline, /L1: # Title/);
  assert.match(outline, /L5: ## Section/);
  assert.match(outline, /L9: ### Detail/);
  assert.doesNotMatch(outline, /intro/);

  await fs.writeFile(path.join(workspaceRoot, 'plain.txt'), 'alpha\nbeta\ngamma\n');
  const plain = (await runRead({ workspaceRoot, path: 'plain.txt', mode: 'outline' })).content[0].text;
  assert.match(plain, /^\[outline · 4 lines · 17 bytes · no structural symbols matched; first 30 lines:\]/);
  assert.match(plain, /L1: alpha/);
  assert.match(plain, /L3: gamma/);

  const limited = (await runRead({
    workspaceRoot, path: 'notes.md', mode: 'outline', offset: 5, limit: 1
  })).content[0].text;
  assert.match(limited, /L5: ## Section/);
  assert.doesNotMatch(limited, /L9: ### Detail/);
  assert.match(limited, /use offset=6/);
});

test('read accepts targets and rejects both or neither path and targets', async () => {
  const workspaceRoot = await tempDir('pi-read-targets-');
  await fs.writeFile(path.join(workspaceRoot, 'a.txt'), 'one\ntwo\n');
  await fs.writeFile(path.join(workspaceRoot, 'b.txt'), 'three\n');
  const text = (await runRead({
    workspaceRoot,
    targets: [{ path: 'a.txt', limit: 1 }, { path: 'b.txt' }]
  })).content[0].text;
  assert.match(text, /^=== a\.txt ===\none\n/);
  assert.match(text, /\n=== b\.txt ===\nthree\n$/);
  assert.doesNotMatch(text, /two/);

  const outlineBatch = (await runRead({
    workspaceRoot,
    mode: 'outline',
    targets: [{ path: 'a.txt', mode: 'lines' }, { path: 'b.txt' }]
  })).content[0].text;
  assert.match(outlineBatch, /=== a\.txt ===\none\ntwo/);
  assert.match(outlineBatch, /=== b\.txt ===\n\[outline · /);

  const expected = /INVALID_ARGUMENT: read requires either path or targets, not both/;
  await assert.rejects(() => runRead({ workspaceRoot, path: 'a.txt', targets: [{ path: 'b.txt' }] }), expected);
  await assert.rejects(() => runRead({ workspaceRoot }), expected);
});

test('edit anchor miss reports the closest numbered file lines', async () => {
  const workspaceRoot = await tempDir('pi-edit-anchor-');
  const file = path.join(workspaceRoot, 'anchor.txt');
  await fs.writeFile(file, [
    'const alpha = 1;',
    'export function computeTotal(items) {',
    '  return items.length;',
    '}',
    'const omega = 2;'
  ].join('\n'));
  await assert.rejects(
    () => runEdit({
      workspaceRoot,
      targets: [{
        path: 'anchor.txt',
        edits: [{
          oldText: 'export function computeTotals(items) {\n  return items.length;\n}',
          newText: 'export function computeTotal(items) {\n  return items.length + 1;\n}'
        }]
      }]
    }),
    (error) => {
      assert.match(error.message, /edits\[0\] text was not found, including tolerant normalization/);
      assert.match(error.message, /Closest match in file \(lines \d+-\d+\):/);
      assert.match(error.message, /  L2: export function computeTotal\(items\) \{/);
      assert.doesNotMatch(error.message, /�/);
      return true;
    }
  );
});
