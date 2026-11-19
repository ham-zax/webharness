import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function createSampleLibrary(t, { extraSkills = 0, includeLargeAsset = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-library-sample-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const write = async (rel, content) => {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  };

  // thinking pack
  await write('packs/thinking/LICENSE', 'MIT License\n');
  await write('packs/thinking/PROVENANCE.md', '# Provenance\nFixture thinking pack.\n');
  await write('packs/thinking/thinking-first-principles/SKILL.md', [
    '---',
    'name: thinking-first-principles',
    'description: Separate physics from convention and rebuild from primitives.',
    'disable-model-invocation: true',
    '---',
    '# First Principles',
    'Strip assumed constraints to independently supported primitives.',
  ].join('\n'));
  await write('packs/thinking/thinking-pre-mortem/SKILL.md', [
    '---',
    'name: thinking-pre-mortem',
    'description: Assume the plan failed and trace concrete causes backward.',
    'disable-model-invocation: true',
    '---',
    '# Pre-Mortem Analysis',
    'Prospective hindsight beats asking what could go wrong.',
  ].join('\n'));
  await write('packs/thinking/thinking-model-router/SKILL.md', [
    '---',
    'name: thinking-model-router',
    'description: Route a problem to the right mental model skill.',
    'disable-model-invocation: true',
    '---',
    '# Thinking Model Router',
    'Invoke thinking-skills:thinking-<slug> when matched.',
  ].join('\n'));
  await write('packs/thinking/thinking-model-router/WEBHARNESS.md', [
    '# WebHarness Tool Mapping',
    'Call `find_skills` and `read_skill` with `thinking/thinking-<slug>`.',
    'This mapping provides no execution authority.',
  ].join('\n'));

  // active pack
  await write('packs/active/LICENSE', 'MIT License\n');
  await write('packs/active/PROVENANCE.md', '# Provenance\nFixture active pack.\n');
  await write('packs/active/using-aegis/SKILL.md', [
    '---',
    'name: using-aegis',
    'description: Canonical Aegis skill routing entry point.',
    '---',
    '# Aegis skill routing',
    'Load only relevant workflow instructions.',
  ].join('\n'));
  await write('packs/active/using-aegis/references/skill-discipline.md', '# Discipline\nVerify before claiming done.\n');

  const activeSkills = [
    {
      id: 'using-aegis',
      directory: 'using-aegis',
      readable: [
        'LICENSE',
        'PROVENANCE.md',
        'using-aegis/SKILL.md',
        'using-aegis/references/skill-discipline.md',
      ],
      compatibility: { kind: 'instruction-only', requires: [], verification: 'reviewed' },
    },
  ];

  if (includeLargeAsset) {
    await write('packs/active/asset-demo/SKILL.md', '---\nname: asset-demo\ndescription: Skill with >1 MiB asset.\n---\nAsset demo.\n');
    await write('packs/active/asset-demo/data/large.json', JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 64) }));
    activeSkills.push({
      id: 'asset-demo',
      directory: 'asset-demo',
      readable: ['LICENSE', 'PROVENANCE.md', 'asset-demo/SKILL.md', 'asset-demo/data/large.json'],
      compatibility: { kind: 'instruction-only', requires: [], verification: 'reviewed' },
    });
  }

  for (let i = 0; i < extraSkills; i += 1) {
    const id = `extra-skill-${i}`;
    await write(`packs/active/${id}/SKILL.md`, `---\nname: ${id}\ndescription: Extra fixture skill ${i}.\n---\nSkill ${i}.\n`);
    activeSkills.push({
      id,
      directory: id,
      readable: ['LICENSE', 'PROVENANCE.md', `${id}/SKILL.md`],
      compatibility: { kind: 'instruction-only', requires: [], verification: 'unverified' },
    });
  }

  // academic pack with shared reference
  await write('packs/academic/LICENSE', 'MIT License\n');
  await write('packs/academic/PROVENANCE.md', '# Provenance\nFixture academic pack.\n');
  await write('packs/academic/academic-paper/SKILL.md', '---\nname: academic-paper\ndescription: Draft and review academic papers.\n---\nSee shared/output_language_pair.md.\n');
  await write('packs/academic/shared/output_language_pair.md', '# Output Language Pair\nKeep terminology consistent.\n');

  const policy = {
    version: 1,
    packs: [
      {
        id: 'thinking',
        root: 'packs/thinking',
        license: 'MIT',
        source: 'fixture',
        skills: [
          {
            id: 'thinking-first-principles',
            directory: 'thinking-first-principles',
            readable: ['LICENSE', 'PROVENANCE.md', 'thinking-first-principles/SKILL.md'],
            compatibility: { kind: 'instruction-only', requires: [], verification: 'reviewed' },
          },
          {
            id: 'thinking-pre-mortem',
            directory: 'thinking-pre-mortem',
            readable: ['LICENSE', 'PROVENANCE.md', 'thinking-pre-mortem/SKILL.md'],
            compatibility: { kind: 'instruction-only', requires: [], verification: 'reviewed' },
          },
          {
            id: 'thinking-model-router',
            directory: 'thinking-model-router',
            readable: [
              'LICENSE',
              'PROVENANCE.md',
              'thinking-model-router/SKILL.md',
              'thinking-model-router/WEBHARNESS.md',
            ],
            adaptation: 'thinking-model-router/WEBHARNESS.md',
            compatibility: {
              kind: 'requires-tools',
              requires: ['skill-library.find_skills', 'skill-library.read_skill'],
              verification: 'reviewed',
            },
          },
        ],
      },
      {
        id: 'active',
        root: 'packs/active',
        license: 'MIT',
        source: 'fixture',
        skills: activeSkills,
      },
      {
        id: 'academic',
        root: 'packs/academic',
        license: 'MIT',
        source: 'fixture',
        skills: [
          {
            id: 'academic-paper',
            directory: 'academic-paper',
            readable: ['LICENSE', 'PROVENANCE.md', 'academic-paper/SKILL.md', 'shared/output_language_pair.md'],
            compatibility: { kind: 'instruction-only', requires: [], verification: 'reviewed' },
          },
        ],
      },
    ],
  };

  const policyPath = path.join(root, 'policy.json');
  await fs.writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  return { root, policyPath, policy };
}
