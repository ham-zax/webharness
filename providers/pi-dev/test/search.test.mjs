import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSearch } from '../search.mjs';
import { renderSearchText } from '../render.mjs';

async function makeTree(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-dev-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'skill-library/packs/demo'), { recursive: true });
  await fs.mkdir(path.join(root, 'third_party/lib'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/alpha.mjs'), 'export function findNeedle() {\n  return "needle-1";\n}\n');
  await fs.writeFile(path.join(root, 'src/beta.txt'), 'line one\nNEEDLE-2(literal)\n');
  await fs.writeFile(path.join(root, 'skill-library/packs/demo/pack.md'), 'needle-in-pack\n');
  await fs.writeFile(path.join(root, 'third_party/lib/vendor.js'), 'needle-in-vendor\n');
  return root;
}

test('search excludes vendored trees by default and includes them when requested', async (t) => {
  const workspaceRoot = await makeTree(t);
  const res = await runSearch({
    pathMode: 'workspace',
    workspaceRoot,
    pattern: 'needle',
  });
  const text = renderSearchText(res);
  assert.match(text, /src\/alpha\.mjs:2:/);
  assert.match(text, /src\/beta\.txt:2:/);
  assert.doesNotMatch(text, /skill-library|third_party/);
  assert.match(text, /\[3 matches\]$/);

  const withVendor = await runSearch({
    pathMode: 'workspace',
    workspaceRoot,
    pattern: 'needle',
    include_vendor: true,
  });
  const fullText = renderSearchText(withVendor);
  assert.match(fullText, /skill-library\/packs\/demo\/pack\.md:1:/);
  assert.match(fullText, /third_party\/lib\/vendor\.js:1:/);
});

test('search supports literal mode, globs, single-file target, max_results cap, and boundary checks', async (t) => {
  const workspaceRoot = await makeTree(t);
  const literalRes = await runSearch({
    pathMode: 'workspace',
    workspaceRoot,
    pattern: 'NEEDLE-2(literal)',
    literal: true,
  });
  assert.equal(literalRes.matches.length, 1);
  assert.match(literalRes.matches[0], /^src\/beta\.txt:2:NEEDLE-2\(literal\)$/);

  const globRes = await runSearch({
    pathMode: 'workspace',
    workspaceRoot,
    pattern: 'needle',
    globs: ['*.mjs'],
  });
  assert.equal(globRes.matches.length, 2);
  assert.match(globRes.matches[0], /^src\/alpha\.mjs:/);

  const singleFile = await runSearch({
    pathMode: 'workspace',
    workspaceRoot,
    pattern: 'needle-1',
    path: 'src/alpha.mjs',
  });
  assert.equal(singleFile.matches.length, 1);
  assert.match(singleFile.matches[0], /^src\/alpha\.mjs:2:/);

  const capped = await runSearch({
    pathMode: 'workspace',
    workspaceRoot,
    pattern: 'needle',
    include_vendor: true,
    max_results: 2,
  });
  assert.equal(capped.matches.length, 2);
  assert.equal(capped.truncated, true);
  assert.match(renderSearchText(capped), /capped at 2/);

  const none = await runSearch({
    pathMode: 'workspace',
    workspaceRoot,
    pattern: 'definitely-not-present-xyz',
  });
  assert.equal(renderSearchText(none), 'No matches.');

  await assert.rejects(
    () => runSearch({ pathMode: 'workspace', workspaceRoot, pattern: 'needle', path: '../outside' }),
    /\.\./
  );
  await assert.rejects(
    () => runSearch({ pathMode: 'workspace', workspaceRoot, pattern: '[unclosed-regex' }),
    /INVALID_ARGUMENT/
  );
});
