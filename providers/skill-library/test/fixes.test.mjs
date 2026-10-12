import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../cli.mjs';
import { SkillLibrary } from '../library.mjs';

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const defaultPolicy = path.join(repositoryRoot, 'skill-library/policy.json');

async function fixture(t, definitions) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-library-fixes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packRoot = path.join(root, 'packs/test');
  await fs.mkdir(packRoot, { recursive: true });
  await fs.writeFile(path.join(packRoot, 'LICENSE'), 'Fixture license\n');
  await fs.writeFile(path.join(packRoot, 'PROVENANCE.md'), 'Fixture provenance\n');

  const skills = [];
  for (const definition of definitions) {
    const { id } = definition;
    const directory = id;
    const skillRoot = path.join(packRoot, directory);
    await fs.mkdir(skillRoot, { recursive: true });
    const hints = Object.entries(definition.hints ?? {})
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
    const frontmatter = [
      '---',
      `name: ${id}`,
      `description: ${JSON.stringify(definition.description ?? `Guidance for ${id}.`)}`,
      ...(hints ? [hints] : []),
      '---',
      `Instructions for ${id}.\n`,
    ].join('\n');
    const main = `${directory}/SKILL.md`;
    await fs.writeFile(path.join(packRoot, main), frontmatter);

    const extraFiles = Object.entries(definition.files ?? {});
    for (const [file, content] of extraFiles) {
      const target = path.join(packRoot, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    skills.push({
      id,
      directory,
      readable: [main, ...extraFiles.map(([file]) => file), 'LICENSE', 'PROVENANCE.md'],
      compatibility: definition.compatibility ?? {
        kind: 'instruction-only', requires: [], verification: 'reviewed',
      },
    });
  }

  const policyPath = path.join(root, 'policy.json');
  await fs.writeFile(policyPath, `${JSON.stringify({ version: 1, packs: [{
    id: 'test', root: 'packs/test', license: 'MIT', source: 'fixture', skills,
  }] })}\n`);
  return { root, packRoot, policyPath, library: await SkillLibrary.open(policyPath) };
}

test('router exposes and versions its WebHarness tool mapping', async t => {
  const bundled = await SkillLibrary.open(defaultPolicy);
  const card = (await bundled.find({ query: 'thinking-model-router' })).candidates[0];
  assert.equal(card.id, 'thinking/thinking-model-router');
  assert.equal(card.compatibility.kind, 'requires-tools');
  assert.deepEqual(card.compatibility.requires, [
    'skill-library.find_skills',
    'skill-library.read_skill',
  ]);
  assert.equal(card.adaptation, 'thinking-model-router/WEBHARNESS.md');

  const router = await bundled.read({ id: card.id, revision: card.revision });
  assert.match(router.adaptation.content, /find_skills/);
  assert.match(router.adaptation.content, /read_skill/);
  const adaptationFile = 'thinking-model-router/WEBHARNESS.md';
  assert.ok(router.readableFiles.some(entry => entry.file === adaptationFile));
  const adaptation = await bundled.read({ id: card.id, revision: card.revision, file: adaptationFile });
  assert.match(adaptation.content, /find_skills/);
  assert.match(adaptation.content, /read_skill/);
  assert.match(adaptation.content, /provides no execution authority/);
  assert.doesNotMatch(adaptation.content, /thinking-skills:thinking-/);

  const policy = JSON.parse(await fs.readFile(defaultPolicy, 'utf8'));
  const thinking = policy.packs.find(pack => pack.id === 'thinking');
  const routerPolicy = thinking.skills.find(skill => skill.id === 'thinking-model-router');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-router-revision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packRoot = path.join(root, thinking.root);
  for (const file of routerPolicy.readable) {
    const source = path.join(repositoryRoot, 'skill-library', thinking.root, file);
    const target = path.join(packRoot, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  const isolatedPolicy = path.join(root, 'policy.json');
  await fs.writeFile(isolatedPolicy, JSON.stringify({
    version: policy.version,
    packs: [{ ...thinking, skills: [routerPolicy] }],
  }));
  const before = await SkillLibrary.open(isolatedPolicy);
  const beforeRevision = (await before.find({ query: 'thinking-model-router' })).candidates[0].revision;
  await fs.appendFile(path.join(packRoot, adaptationFile), '\nRevision fixture change.\n');
  const after = await SkillLibrary.open(isolatedPolicy);
  const afterRevision = (await after.find({ query: 'thinking-model-router' })).candidates[0].revision;
  assert.notEqual(afterRevision, beforeRevision);
});

test('oversized first discovery candidate returns a typed error instead of a repeated cursor', async t => {
  const { library } = await fixture(t, [{
    id: 'giant',
    description: 'Large but policy-valid metadata.',
    hints: { 'allowed-tools': '工'.repeat(2048) },
    compatibility: {
      kind: 'requires-tools',
      requires: Array.from({ length: 32 }, (_, index) => `${index}${'依'.repeat(198)}`),
      verification: 'unverified',
    },
  }]);

  await assert.rejects(library.find({ query: 'giant', limit: 1 }), error => {
    assert.equal(error.code, 'RESPONSE_TOO_LARGE');
    assert.match(error.message, /candidate metadata exceeds the find response budget/);
    return true;
  });
});

test('export preserves approved execute bits without special permissions and versions mode changes', async t => {
  const helper = "#!/bin/sh\nprintf 'helper-ran\\n'\n";
  const { root, packRoot, policyPath, library } = await fixture(t, [{
    id: 'one',
    files: { 'one/helper': helper },
    compatibility: { kind: 'requires-tools', requires: ['node'], verification: 'reviewed' },
  }]);
  const sourceHelper = path.join(packRoot, 'one/helper');
  await fs.chmod(sourceHelper, 0o6755);

  const originalCatalog = await library.catalog();
  assert.equal(originalCatalog.skills[0].files.find(file => file.file === 'one/helper').executeBits, 0o111);
  const destination = path.join(root, 'export');
  await runCli(['export', '--policy', policyPath, '--destination', destination]);
  const exportedHelper = path.join(destination, 'packs/test/one/helper');
  const exportedMode = (await fs.stat(exportedHelper)).mode;
  assert.equal(exportedMode & 0o111, 0o111);
  assert.equal(exportedMode & 0o6000, 0);
  assert.equal((await execFile(exportedHelper)).stdout, 'helper-ran\n');
  assert.equal((await runCli(['check', '--policy', path.join(destination, 'policy.json')])).status, 'ok');

  await fs.chmod(sourceHelper, 0o644);
  const changedCatalog = await library.catalog();
  assert.notEqual(changedCatalog.revision, originalCatalog.revision);
});

test('large libraries validate without a generated catalog file or its one MiB cap', async t => {
  const definitions = Array.from({ length: 650 }, (_, index) => ({
    id: `skill-${String(index).padStart(4, '0')}`,
    description: 'x'.repeat(1024),
  }));
  const { policyPath, root, library } = await fixture(t, definitions);
  assert.ok(Buffer.byteLength(JSON.stringify(await library.catalog(), null, 2)) > 1024 * 1024);
  await assert.rejects(fs.stat(path.join(root, 'catalog.json')), { code: 'ENOENT' });
  const checked = await runCli(['check', '--policy', policyPath]);
  assert.equal(checked.status, 'ok');
  assert.equal(checked.skills, 650);
});
