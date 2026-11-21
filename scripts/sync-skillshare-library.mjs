#!/usr/bin/env node
// Sync an operator's local Skillshare skills (+ optional extra packs) directly
// into gitignored skill-library/packs/<pack>/ and generate gitignored
// skill-library/policy.json alongside the tracked starter packs
// (anthropic, critical-thinking, lateral-thinking).
//
// Tracked starter packs are never overwritten during normal sync so `git status`
// stays clean. Pass --build-starter-policy only to regenerate tracked
// skill-library/policy.example.json from the three starter pack directories.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillLibrary } from '../providers/skill-library/library.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'skill-library');
const DEFAULT_SKILLSHARE_DIR = process.env.SKILLSHARE_SKILLS_DIR
  || path.join(os.homedir(), '.config', 'skillshare', 'skills');
const DEFAULT_EXTRA_PACKS_DIR = process.env.WEBHARNESS_EXTRA_SKILL_PACKS_DIR
  || path.join(os.homedir(), '.config', 'mcp-dev-bridge', 'skill-packs');
const DEFAULT_AGENTS_SKILLS_DIR = path.join(os.homedir(), '.agents', 'skills');

const STARTER_PACK_META = [
  {
    id: 'critical-thinking',
    license: 'MIT',
    source: 'https://github.com/tjboudreaux/cc-thinking-skills',
    verification: 'reviewed',
  },
  {
    id: 'lateral-thinking',
    license: 'Upstream terms retained (https://github.com/danium/lateral-thinking)',
    source: 'https://github.com/danium/lateral-thinking',
    verification: 'reviewed',
  },
  {
    id: 'anthropic',
    license: 'Apache License 2.0',
    source: 'https://github.com/anthropics/skills',
    verification: 'reviewed',
  },
];
const STARTER_PACK_IDS = new Set(STARTER_PACK_META.map(p => p.id));

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.pytest_cache']);
const SKIP_FILES = new Set(['.DS_Store', '.skillshare-manifest.json', '.metadata.json', '.gitignore']);
// JevShelf CLI router shims are redundant when the real underlying packs are synced directly.
const SHIM_TOP_LEVEL = new Set([
  'academic-research',
  'code-specialists',
  'ui-craft',
  'routed-academic',
  'routed-sentry',
]);
const ANTHROPIC_SKILLS = new Set(['frontend-design', 'canvas-design', 'theme-factory']);
const VAULT_PACK_MAP = new Map([
  ['vault-academic', 'academic'],
  ['vault-addy-review', 'addy-review'],
  ['vault-emil', 'emil'],
  ['vault-lateral', 'lateral-thinking'],
  ['vault-matt-review', 'matt-review'],
  ['vault-sentry', 'sentry'],
  ['vault-lassejlv', 'sentry'],
  ['vault-writing', 'writing'],
  ['aegis', 'active'],
  ['vault-aegis', 'active'],
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_BYTES = 14 * 1024 * 1024;
const MAX_SKILL_FILES = 240;
const MAX_INVENTORY_JSON_BYTES = 14 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function parseArgs(argv) {
  const opts = {
    sourceDir: DEFAULT_SKILLSHARE_DIR,
    extraPacksDir: DEFAULT_EXTRA_PACKS_DIR,
    outDir: DEFAULT_OUT_DIR,
    includeShims: false,
    buildStarterPolicy: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') opts.sourceDir = path.resolve(argv[++i]);
    else if (arg === '--extra-packs') opts.extraPacksDir = path.resolve(argv[++i]);
    else if (arg === '--out') opts.outDir = path.resolve(argv[++i]);
    else if (arg === '--include-shims') opts.includeShims = true;
    else if (arg === '--build-starter-policy') opts.buildStarterPolicy = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/sync-skillshare-library.mjs [--source DIR] [--extra-packs DIR] [--out DIR] [--include-shims] [--build-starter-policy]\n'
        + 'Syncs ~/.config/skillshare/skills (+ optional extra packs) into gitignored skill-library/packs/ and skill-library/policy.json\n'
        + 'while preserving the tracked starter packs (anthropic, critical-thinking, lateral-thinking).\n',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function slugify(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function isValidUtf8Text(buf) {
  if (buf.includes(0)) return false;
  try {
    UTF8_DECODER.decode(buf);
    return true;
  } catch {
    return false;
  }
}

async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function listRegularUtf8Files(rootDir, relBase = '') {
  const found = [];
  let totalBytes = 0;

  async function walk(curDir, curRel) {
    const entries = await fs.readdir(curDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name) || entry.name.startsWith('.skillshare')) continue;
      const full = path.join(curDir, entry.name);
      const rel = curRel ? `${curRel}/${entry.name}` : entry.name;
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(full, rel);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) continue;
        if (found.length >= MAX_SKILL_FILES) continue;
        if (totalBytes + stat.size > MAX_SKILL_BYTES) continue;
        const buf = await fs.readFile(full);
        if (!isValidUtf8Text(buf)) continue;
        found.push(rel);
        totalBytes += stat.size;
      }
    }
  }

  await walk(rootDir, relBase);
  return found;
}

async function copyTreeRegularFiles(srcDir, dstDir, relBase = '') {
  const copied = [];
  let totalBytes = 0;

  async function walk(curSrc, curDst, curRel) {
    const entries = await fs.readdir(curSrc, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    await fs.mkdir(curDst, { recursive: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name) || entry.name.startsWith('.skillshare')) {
        continue;
      }
      const nextSrc = path.join(curSrc, entry.name);
      const nextDst = path.join(curDst, entry.name);
      const nextRel = curRel ? `${curRel}/${entry.name}` : entry.name;
      let stat;
      try {
        stat = await fs.stat(nextSrc);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(nextSrc, nextDst, nextRel);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) continue;
        if (copied.length >= MAX_SKILL_FILES) continue;
        if (totalBytes + stat.size > MAX_SKILL_BYTES) continue;
        const buf = await fs.readFile(nextSrc);
        if (!isValidUtf8Text(buf)) continue;
        await fs.writeFile(nextDst, buf);
        const mode = stat.mode & 0o777;
        await fs.chmod(nextDst, (mode & 0o111) ? 0o755 : 0o644);
        copied.push(nextRel);
        totalBytes += stat.size;
      }
    }
  }

  await walk(srcDir, dstDir, relBase);
  return copied;
}

function trimInventoryForBudget(files, requiredFiles) {
  const unique = [...new Set(files)].sort();
  const reqSet = new Set(requiredFiles.filter(f => unique.includes(f)));
  const prioritized = [...reqSet, ...unique.filter(f => !reqSet.has(f))];
  const kept = [];
  let budget = 256;
  for (const rel of prioritized) {
    const est = Buffer.byteLength(JSON.stringify({ file: rel, bytes: 999999 })) + 2;
    if (kept.length > 0 && !reqSet.has(rel) && budget + est > MAX_INVENTORY_JSON_BYTES) break;
    kept.push(rel);
    budget += est;
  }
  return kept.sort();
}

function buildSkillDescriptor(skillId, files, verification = 'unverified') {
  const mainFile = `${skillId}/SKILL.md`;
  if (!files.includes(mainFile)) return null;
  const adaptationFile = `${skillId}/WEBHARNESS.md`;
  const hasAdaptation = files.includes(adaptationFile);
  const required = [mainFile, 'LICENSE', 'PROVENANCE.md', ...(hasAdaptation ? [adaptationFile] : [])];
  const readable = trimInventoryForBudget([...files, 'LICENSE', 'PROVENANCE.md'], required);
  const record = {
    id: skillId,
    directory: skillId,
    readable,
    compatibility: hasAdaptation
      ? { kind: 'requires-tools', requires: ['skill-library.find_skills', 'skill-library.read_skill'], verification: 'reviewed' }
      : { kind: 'instruction-only', requires: [], verification },
  };
  if (hasAdaptation) record.adaptation = adaptationFile;
  return record;
}

async function ensurePackNotices(packDir, packId, sourceDesc, licenseDesc) {
  const lic = path.join(packDir, 'LICENSE');
  const prov = path.join(packDir, 'PROVENANCE.md');
  if (!await exists(lic)) {
    await fs.writeFile(lic, `${licenseDesc}\n`, 'utf8');
  }
  if (!await exists(prov)) {
    await fs.writeFile(
      prov,
      `# Provenance (${packId})\n\nLocal operator sync generated by scripts/sync-skillshare-library.mjs from ${sourceDesc}.\nGitignored and excluded from public WebHarness staging.\n`,
      'utf8',
    );
  }
}

async function buildStarterPolicy(outDir) {
  const packs = [];
  for (const meta of STARTER_PACK_META) {
    const packDir = path.join(outDir, 'packs', meta.id);
    if (!await exists(packDir)) {
      throw new Error(`missing starter pack directory: ${packDir}`);
    }
    const entries = await fs.readdir(packDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const skillDir = path.join(packDir, entry.name);
      if (!await exists(path.join(skillDir, 'SKILL.md'))) continue;
      const skillId = slugify(entry.name);
      const files = await listRegularUtf8Files(skillDir, entry.name);
      const rec = buildSkillDescriptor(skillId, files, meta.verification);
      if (rec) skills.push(rec);
    }
    packs.push({
      id: meta.id,
      root: `packs/${meta.id}`,
      license: meta.license,
      source: meta.source,
      skills,
    });
  }
  const starterPath = path.join(outDir, 'policy.example.json');
  await fs.writeFile(starterPath, `${JSON.stringify({ version: 1, packs }, null, 2)}\n`, 'utf8');
  const lib = await SkillLibrary.open(starterPath);
  const catalog = await lib.catalog();
  const summary = packs.map(p => `${p.id}=${p.skills.length}`).join(', ');
  process.stdout.write(
    `Built starter policy: ${catalog.skills.length} skills across ${packs.length} collections (${summary}) -> ${starterPath}\n`,
  );
}

async function discoverSkillshareEntries(sourceDir, includeShims) {
  const byPack = new Map();
  const addSkill = (packId, skillId, skillDir) => {
    // Starter packs are owned by tracked skill-library/packs/{anthropic,critical-thinking,lateral-thinking}.
    if (STARTER_PACK_IDS.has(packId)) return;
    const id = slugify(skillId);
    if (!id) return;
    if (!byPack.has(packId)) byPack.set(packId, new Map());
    byPack.get(packId).set(id, skillDir);
  };

  if (await exists(sourceDir)) {
    const topEntries = await fs.readdir(sourceDir, { withFileTypes: true });
    topEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of topEntries) {
      const name = entry.name;
      if (SKIP_DIRS.has(name) || SKIP_FILES.has(name) || name.startsWith('.')) continue;
      if (!includeShims && (SHIM_TOP_LEVEL.has(name) || name.startsWith('jevshelf-'))) continue;

      const fullPath = path.join(sourceDir, name);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      if (VAULT_PACK_MAP.has(name)) {
        const targetPack = VAULT_PACK_MAP.get(name);
        const children = await fs.readdir(fullPath, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (child.name.startsWith('.') || SKIP_DIRS.has(child.name)) continue;
          const childPath = path.join(fullPath, child.name);
          if (await exists(path.join(childPath, 'SKILL.md'))) {
            const id = child.name.endsWith('-skill') ? child.name.slice(0, -6) : child.name;
            addSkill(targetPack, id, childPath);
          }
        }
        continue;
      }

      if (await exists(path.join(fullPath, 'SKILL.md'))) {
        const targetPack = ANTHROPIC_SKILLS.has(name) ? 'anthropic' : 'active';
        addSkill(targetPack, name, fullPath);
      }
    }
  }

  // Pick up non-symlinked local skills in ~/.agents/skills (e.g. satori) not already present.
  if (await exists(DEFAULT_AGENTS_SKILLS_DIR)) {
    const localEntries = await fs.readdir(DEFAULT_AGENTS_SKILLS_DIR, { withFileTypes: true });
    for (const entry of localEntries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const fullPath = path.join(DEFAULT_AGENTS_SKILLS_DIR, entry.name);
      if (await exists(path.join(fullPath, 'SKILL.md'))) {
        const id = slugify(entry.name);
        const activeMap = byPack.get('active');
        if (id && (!activeMap || !activeMap.has(id))) {
          addSkill('active', id, fullPath);
        }
      }
    }
  }

  return byPack;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.buildStarterPolicy) {
    await buildStarterPolicy(opts.outDir);
    return;
  }

  const starterPolicyPath = path.join(opts.outDir, 'policy.example.json');
  const starterPolicy = await exists(starterPolicyPath)
    ? JSON.parse(await fs.readFile(starterPolicyPath, 'utf8'))
    : { version: 1, packs: [] };

  const outPacksDir = path.join(opts.outDir, 'packs');
  await fs.mkdir(outPacksDir, { recursive: true });

  // Publish synced packs into a fresh generation directory under skill-library/packs/
  // and validate a temporary policy against the real final paths before atomically
  // swapping policy.json. Old packs stay completely intact if sync fails or aborts.
  const genToken = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const genName = `sync-${genToken}`;
  const tempGenDir = path.join(outPacksDir, `.tmp-${genName}`);
  const finalGenDir = path.join(outPacksDir, genName);
  const tempPolicyPath = path.join(opts.outDir, `.policy.${genToken}.tmp`);
  let published = false;
  let movedGenIntoPlace = false;
  let hasSyncedPacks = false;

  try {
    await fs.rm(tempGenDir, { recursive: true, force: true });
    await fs.mkdir(tempGenDir, { recursive: true });

    const packs = [];
    for (const starterPack of starterPolicy.packs || []) {
      const srcPack = path.join(opts.outDir, starterPack.root);
      if (!await exists(srcPack)) continue;
      packs.push(starterPack);
    }
    const existingIds = new Set(packs.map(p => p.id));

    // 1. Sync Skillshare skills into gitignored per-collection packs under the new generation.
    const discovered = await discoverSkillshareEntries(opts.sourceDir, opts.includeShims);
    for (const packId of [...discovered.keys()].sort()) {
      if (existingIds.has(packId)) continue;
      const skillMap = discovered.get(packId);
      if (!skillMap || skillMap.size === 0) continue;
      const packDir = path.join(tempGenDir, packId);
      await fs.mkdir(packDir, { recursive: true });
      const license = 'Local operator Skillshare sync; upstream per-skill terms retained';
      const source = `local Skillshare (${opts.sourceDir})`;
      await ensurePackNotices(packDir, packId, source, license);

      const skills = [];
      for (const skillId of [...skillMap.keys()].sort()) {
        const files = await copyTreeRegularFiles(skillMap.get(skillId), path.join(packDir, skillId), skillId);
        const rec = buildSkillDescriptor(skillId, files, 'unverified');
        if (rec) skills.push(rec);
      }
      if (skills.length > 0) {
        packs.push({ id: packId, root: `packs/${genName}/${packId}`, license, source, skills });
        existingIds.add(packId);
        hasSyncedPacks = true;
      }
    }

    // 2. Sync optional operator extra packs (e.g. ~/.config/mcp-dev-bridge/skill-packs/marketing).
    if (await exists(opts.extraPacksDir)) {
      const extras = await fs.readdir(opts.extraPacksDir, { withFileTypes: true });
      extras.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of extras) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const packId = slugify(entry.name);
        if (!packId || existingIds.has(packId)) continue;
        const srcPackDir = path.join(opts.extraPacksDir, entry.name);
        const stat = await fs.stat(srcPackDir).catch(() => null);
        if (!stat || !stat.isDirectory()) continue;

        const dstPackDir = path.join(tempGenDir, packId);
        await fs.mkdir(dstPackDir, { recursive: true });
        const license = 'Local operator extra pack; upstream per-skill terms retained';
        const source = `local extra packs (${opts.extraPacksDir}/${entry.name})`;
        for (const notice of ['LICENSE', 'PROVENANCE.md']) {
          if (await exists(path.join(srcPackDir, notice))) {
            await fs.copyFile(path.join(srcPackDir, notice), path.join(dstPackDir, notice));
          }
        }
        await ensurePackNotices(dstPackDir, packId, source, license);

        const sharedFiles = [];
        if (await exists(path.join(srcPackDir, 'shared'))) {
          const copied = await copyTreeRegularFiles(path.join(srcPackDir, 'shared'), path.join(dstPackDir, 'shared'), 'shared');
          sharedFiles.push(...copied);
        }

        const children = await fs.readdir(srcPackDir, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name));
        const skills = [];
        for (const child of children) {
          if (child.name.startsWith('.') || SKIP_DIRS.has(child.name) || child.name === 'shared') continue;
          const childSrc = path.join(srcPackDir, child.name);
          if (!await exists(path.join(childSrc, 'SKILL.md'))) continue;
          const skillId = slugify(child.name);
          if (!skillId) continue;
          const files = await copyTreeRegularFiles(childSrc, path.join(dstPackDir, skillId), skillId);
          const rec = buildSkillDescriptor(skillId, files, 'unverified');
          if (rec) {
            if (sharedFiles.length) {
              rec.readable = trimInventoryForBudget([...rec.readable, ...sharedFiles], [
                `${skillId}/SKILL.md`, 'LICENSE', 'PROVENANCE.md',
                ...(rec.adaptation ? [rec.adaptation] : []),
              ]);
            }
            skills.push(rec);
          }
        }
        if (skills.length > 0) {
          packs.push({ id: packId, root: `packs/${genName}/${packId}`, license, source, skills });
          existingIds.add(packId);
          hasSyncedPacks = true;
        }
      }
    }

    if (hasSyncedPacks) {
      await fs.rename(tempGenDir, finalGenDir);
      movedGenIntoPlace = true;
    } else {
      await fs.rm(tempGenDir, { recursive: true, force: true });
    }

    await fs.writeFile(tempPolicyPath, `${JSON.stringify({ version: 1, packs }, null, 2)}\n`, 'utf8');

    // Validate the staged policy against the real final pack directories before swapping.
    const lib = await SkillLibrary.open(tempPolicyPath);
    const catalog = await lib.catalog();

    // Atomic publish: previous policy.json and its pack set remain untouched until this rename succeeds.
    await fs.rename(tempPolicyPath, path.join(opts.outDir, 'policy.json'));
    published = true;

    // Post-publish cleanup: remove superseded non-starter generations and legacy top-level synced packs.
    for (const old of await fs.readdir(outPacksDir)) {
      if (STARTER_PACK_IDS.has(old) || (hasSyncedPacks && old === genName) || old.startsWith('.tmp-')) continue;
      await fs.rm(path.join(outPacksDir, old), { recursive: true, force: true });
    }

    const summary = packs.map(p => `${p.id}=${p.skills.length}`).join(', ');
    process.stdout.write(
      `Synced ${catalog.skills.length} skills across ${packs.length} collections (${summary}) -> ${path.join(opts.outDir, 'policy.json')}\n`,
    );
  } finally {
    if (!published) {
      await fs.rm(tempPolicyPath, { force: true }).catch(() => {});
      await fs.rm(tempGenDir, { recursive: true, force: true }).catch(() => {});
      if (movedGenIntoPlace) {
        await fs.rm(finalGenDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

main().catch(err => {
  process.stderr.write(`sync-skillshare-library failed: ${err?.message || err}\n`);
  process.exit(1);
});
