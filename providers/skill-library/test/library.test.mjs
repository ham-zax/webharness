import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillLibrary } from '../library.mjs';
import { runCli } from '../cli.mjs';
import { DEFAULT_POLICY } from '../server.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-library-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pack = path.join(root, 'packs', 'test');
  await fs.mkdir(path.join(pack, 'one'), { recursive: true });
  await fs.mkdir(path.join(pack, 'two'), { recursive: true });
  await fs.mkdir(path.join(pack, 'shared'), { recursive: true });
  const body = '😀 café 漢字\n'.repeat(400);
  const main = `---\nname: one\ndescription: Diagnose bottlenecks and slow requests.\ndisable-model-invocation: true\nallowed-tools: Bash(*)\nreadable: [secrets.txt]\n---\nUse shared/reference.md when needed.\n${body}`;
  await fs.writeFile(path.join(pack, 'one/SKILL.md'), main);
  await fs.writeFile(path.join(pack, 'two/SKILL.md'), '---\nname: two\ndescription: Compare architecture decisions.\n---\nChoose a method.\n');
  await fs.writeFile(path.join(pack, 'shared/reference.md'), 'Working reference.\n');
  await fs.writeFile(path.join(pack, 'LICENSE'), 'Fixture license\n');
  await fs.writeFile(path.join(pack, 'PROVENANCE.md'), 'Fixture provenance\n');
  await fs.writeFile(path.join(pack, 'secrets.txt'), 'must not be exposed');
  const policy = { version: 1, packs: [{ id: 'test', root: 'packs/test', license: 'MIT', source: 'fixture', skills: [
    { id: 'one', directory: 'one', readable: ['one/SKILL.md', 'shared/reference.md', 'LICENSE', 'PROVENANCE.md'],
      compatibility: { kind: 'requires-tools', requires: ['example-tool'], verification: 'unverified' } },
    { id: 'two', directory: 'two', readable: ['two/SKILL.md'],
      compatibility: { kind: 'instruction-only', requires: [], verification: 'reviewed' } },
  ] }] };
  const policyPath = path.join(root, 'policy.json');
  await fs.writeFile(policyPath, JSON.stringify(policy));
  return { root, pack, policy, policyPath, main, library: await SkillLibrary.open(policyPath) };
}

test('bundled corpus works without external installations and preserves source invocation flags', async () => {
  const library = await SkillLibrary.open(DEFAULT_POLICY);
  const catalog = await library.catalog();
  assert.equal(catalog.skills.length, 150);
  assert.ok(catalog.skills.every(card => card.collection !== 'decision-reflection'));
  assert.deepEqual(catalog.skills.filter(card => card.collection === 'writing').map(card => card.id), ['writing/asd-ste100']);
  assert.equal(catalog.skills.filter(card => card.collection === 'sentry').length, 6);
  for (const id of ['decision-reflection/grilling', 'writing/writing-for-agents',
    'sentry/improve-codebase-architecture', 'sentry/constraint-driven-development']) {
    assert.ok(!catalog.skills.some(card => card.id === id));
    await assert.rejects(library.read({ id, revision: catalog.skills[0].revision }), { code: 'UNKNOWN_SKILL' });
  }
  const browse = await library.find({ limit: 1 });
  assert.deepEqual(browse.collections.map(item => item.id).sort(),
    ['academic', 'active', 'emil', 'lateral-thinking',
      'marketing', 'sentry', 'thinking', 'writing']);
  // Jev evaluates one collection at a time; every collection must stay scannable.
  for (const { count } of browse.collections) assert.ok(count <= 64, `collection of ${count} exceeds the Jev scope`);
  const result = await library.find({ query: 'thinking-pre-mortem', collection: 'thinking' });
  assert.equal(result.mode, 'lexical');
  assert.equal(result.candidates.length, 1);
  const card = result.candidates[0];
  assert.equal(card.invocationHints['disable-model-invocation'], true);
  const read = await library.read({ id: card.id, revision: card.revision });
  assert.equal(read.complete, true);
  assert.match(read.content, /Prospective hindsight/);
  assert.equal(read.readableFiles.length, 3);
});

test('every collection is discoverable and its bundled Aegis instructions read', async () => {
  const library = await SkillLibrary.open(DEFAULT_POLICY);
  for (const { id } of (await library.find({ limit: 1 })).collections) {
    const browse = await library.find({ collection: id, limit: 20 });
    assert.ok(browse.candidates.length > 0, `collection ${id} has no discoverable skills`);
    for (const card of browse.candidates) assert.ok(card.id.startsWith(`${id}/`));
  }
  const aegis = await library.find({ collection: 'active', query: 'using-aegis' });
  assert.equal(aegis.candidates[0].id, 'active/using-aegis');
  const card = aegis.candidates[0];
  const read = await library.read({ id: card.id, revision: card.revision });
  assert.equal(read.complete, true);
  assert.match(read.content, /Aegis skill routing/);
  assert.ok(read.readableFiles.some(item => item.file === 'using-aegis/references/skill-discipline.md'));
});

test('discovery ranks metadata, supports exact names, abstains on unrelated terms and pages descriptions', async t => {
  const { library } = await fixture(t);
  assert.equal((await library.find({ query: 'bottlenecks' })).candidates[0].id, 'test/one');
  assert.equal((await library.find({ query: 'one' })).candidates.length, 1);
  assert.equal((await library.find({ query: 'unfindablezzzz' })).total, 0);
  const first = await library.find({ limit: 1 });
  assert.equal(first.hasMore, true);
  const second = await library.find({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.hasMore, false);
  assert.notEqual(first.candidates[0].id, second.candidates[0].id);
  await assert.rejects(library.find({ query: 'one', cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
  await assert.rejects(library.find({ collection: 'missing' }), { code: 'UNKNOWN_COLLECTION' });
});

test('source metadata cannot approve files or grant tools; selected reads expose compatibility', async t => {
  const { library } = await fixture(t);
  const card = (await library.find({ query: 'one' })).candidates[0];
  assert.deepEqual(Object.keys(card).sort(), ['description', 'id', 'invocationHints', 'revision']);
  const selected = await library.read({ id: card.id, revision: card.revision });
  assert.equal(selected.compatibility.verification, 'unverified');
  assert.deepEqual(selected.compatibility.requires, ['example-tool']);
  assert.equal(selected.invocationHints['allowed-tools'], 'Bash(*)');
  await assert.rejects(library.read({ id: card.id, revision: card.revision, file: 'secrets.txt' }), { code: 'FILE_NOT_APPROVED' });
  await assert.rejects(library.read({ id: card.id, revision: card.revision, file: '../secrets.txt' }), { code: 'FILE_NOT_APPROVED' });
  const reference = await library.read({ id: card.id, revision: card.revision, file: 'shared/reference.md' });
  assert.equal(reference.content, 'Working reference.\n');
});

test('changing only a readable reference invalidates reads and discovery cursors', async t => {
  const { library, pack } = await fixture(t);
  const page = await library.find({ limit: 1 });
  const card = page.candidates[0];
  await fs.writeFile(path.join(pack, 'shared/reference.md'), 'Changed reference.\n');
  await assert.rejects(library.read({ id: card.id, revision: card.revision }), { code: 'STALE_REVISION' });
  await assert.rejects(library.find({ limit: 1, cursor: page.nextCursor }), { code: 'STALE_CURSOR' });
  const refreshed = (await library.find({ query: 'one' })).candidates[0];
  assert.notEqual(refreshed.revision, card.revision);
  assert.equal((await library.read({ id: refreshed.id, revision: refreshed.revision })).id, card.id);
});

test('changed operator policy requires restart rather than silently expanding access', async t => {
  const { library, policy, policyPath } = await fixture(t);
  policy.packs[0].skills[0].readable.push('secrets.txt');
  await fs.writeFile(policyPath, JSON.stringify(policy));
  await assert.rejects(library.find(), { code: 'POLICY_CHANGED' });
});

test('missing dependencies, traversal, duplicate ids and symlink escapes fail closed', async t => {
  const { library, pack, root, policy, policyPath } = await fixture(t);
  await fs.rm(path.join(pack, 'shared/reference.md'));
  await assert.rejects(library.catalog(), { code: 'MISSING_DEPENDENCY' });
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside');
  await fs.symlink(path.join(root, 'outside.txt'), path.join(pack, 'shared/reference.md'));
  await assert.rejects(library.catalog(), { code: 'UNSAFE_FILE' });
  policy.packs[0].skills[0].readable.push('../outside.txt');
  await fs.writeFile(policyPath, JSON.stringify(policy));
  await assert.rejects(SkillLibrary.open(policyPath), { code: 'INVALID_PATH' });
  policy.packs[0].skills[0].readable.pop();
  policy.packs[0].skills.push(policy.packs[0].skills[0]);
  await fs.writeFile(policyPath, JSON.stringify(policy));
  await assert.rejects(SkillLibrary.open(policyPath), { code: 'INVALID_POLICY' });
});

test('ancestor and pack-root symlinks cannot escape the approved directory', async t => {
  const { library, pack, root, policyPath } = await fixture(t);
  await fs.rename(path.join(pack, 'shared'), path.join(root, 'moved'));
  await fs.symlink(path.join(root, 'moved'), path.join(pack, 'shared'));
  await assert.rejects(library.catalog(), { code: 'UNSAFE_FILE' });
  await fs.rename(pack, path.join(root, 'other-pack'));
  await fs.symlink(path.join(root, 'other-pack'), pack);
  await assert.rejects(SkillLibrary.open(policyPath), { code: 'UNSAFE_FILE' });
});

test('bounded UTF-8 pages reconstruct the complete original and reject cross-file cursors', async t => {
  const { library, main } = await fixture(t);
  const card = (await library.find({ query: 'one' })).candidates[0];
  let cursor;
  let combined = '';
  let first;
  do {
    const page = await library.read({ id: card.id, revision: card.revision, max_bytes: 257, cursor });
    first ??= page;
    assert.ok(page.bytes <= 257);
    assert.ok(!page.content.includes('�'));
    assert.equal(Object.hasOwn(page, 'readableFiles'), cursor === undefined);
    assert.equal(Object.hasOwn(page, 'compatibility'), cursor === undefined);
    assert.equal(Object.hasOwn(page, 'invocationHints'), cursor === undefined);
    combined += page.content;
    cursor = page.nextCursor;
    if (!cursor) assert.equal(page.complete, true);
  } while (cursor);
  assert.equal(combined, main);
  await assert.rejects(library.read({ id: card.id, revision: card.revision, file: 'shared/reference.md', cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
  await assert.rejects(library.read({ id: card.id, revision: card.revision, max_bytes: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.read({ id: card.id, revision: card.revision, file: null }), { code: 'INVALID_ARGUMENT' });
});

test('JSON escaping remains bounded and oversized or binary dependencies are rejected', async t => {
  const { library, pack } = await fixture(t);
  await fs.writeFile(path.join(pack, 'shared/reference.md'), '\u0001'.repeat(20000));
  let card = (await library.find({ query: 'one' })).candidates[0];
  const page = await library.read({ id: card.id, revision: card.revision, file: 'shared/reference.md', max_bytes: 16384 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 24 * 1024);
  assert.ok(page.bytes > 0);
  assert.equal(page.complete, false);
  await fs.writeFile(path.join(pack, 'shared/reference.md'), Buffer.from([0xff]));
  await assert.rejects(library.catalog(), { code: 'UNSUPPORTED_CONTENT' });
  await fs.writeFile(path.join(pack, 'shared/reference.md'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(library.catalog(), { code: 'FILE_TOO_LARGE' });
});

test('YAML duplicate keys and aliases are rejected rather than interpreting ambiguous instructions', async t => {
  const { library, pack } = await fixture(t);
  await fs.writeFile(path.join(pack, 'one/SKILL.md'), '---\nname: one\nname: changed\ndescription: test\n---\n');
  await assert.rejects(library.catalog(), { code: 'INVALID_SKILL' });
  await fs.writeFile(path.join(pack, 'one/SKILL.md'), '---\nname: one\nx: &x test\ndescription: *x\n---\n');
  await assert.rejects(library.catalog(), { code: 'INVALID_SKILL' });
});

test('approved packages validate and export without saved metadata, undeclared files or host paths', async t => {
  const { policyPath, root } = await fixture(t);
  assert.equal((await runCli(['check', '--policy', policyPath])).status, 'ok');
  await assert.rejects(fs.stat(path.join(root, 'catalog.json')), { code: 'ENOENT' });
  const destination = path.join(root, 'export');
  const result = await runCli(['export', '--policy', policyPath, '--destination', destination]);
  assert.equal(result.status, 'exported');
  await assert.rejects(fs.stat(path.join(destination, 'packs/test/secrets.txt')), { code: 'ENOENT' });
  assert.equal((await runCli(['check', '--policy', path.join(destination, 'policy.json')])).status, 'ok');
  await assert.rejects(fs.stat(path.join(destination, 'catalog.json')), { code: 'ENOENT' });
  const exported = await SkillLibrary.open(path.join(destination, 'policy.json'));
  assert.equal((await exported.find({ query: 'one' })).candidates.length, 1);
  await assert.rejects(runCli(['export', '--policy', policyPath, '--destination', destination]), { code: 'EEXIST' });
  await assert.rejects(runCli(['compile', '--policy', policyPath, '--query', 'ignored']), /does not apply/);
});

test('unapproved metadata files never change runtime permissions or discovery', async t => {
  const { library, root, policyPath } = await fixture(t);
  await fs.writeFile(path.join(root, 'unapproved-index.json'), JSON.stringify({ skills: [{ id: 'test/secret' }] }));
  assert.equal((await library.find({ query: 'secret' })).total, 0);
  assert.equal((await runCli(['check', '--policy', policyPath])).status, 'ok');
});

test('compatibility changes participate in the skill revision after an explicit policy reload', async t => {
  const { library, policy, policyPath } = await fixture(t);
  const previous = (await library.find({ query: 'one' })).candidates[0];
  policy.packs[0].skills[0].compatibility.requires = ['different-tool'];
  await fs.writeFile(policyPath, JSON.stringify(policy));
  const reloaded = await SkillLibrary.open(policyPath);
  const current = (await reloaded.find({ query: 'one' })).candidates[0];
  assert.notEqual(current.revision, previous.revision);
  await assert.rejects(reloaded.read({ id: current.id, revision: previous.revision }), { code: 'STALE_REVISION' });
});
