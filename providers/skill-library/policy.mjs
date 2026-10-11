import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, failure, MAX_POLICY_BYTES, readApproved, relativeFile } from './files.mjs';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) {
    throw failure('INVALID_POLICY', `invalid ${label} fields`);
  }
}

function name(value, label) {
  if (typeof value !== 'string' || value.length > 64 || !NAME.test(value)) {
    throw failure('INVALID_POLICY', `invalid ${label}`);
  }
}

export async function loadPolicy(policyPath) {
  const supplied = path.resolve(policyPath);
  // Configuration must itself be a real file; roots are relative to this file,
  // so an exported library remains relocatable without host-specific paths.
  const root = await fs.realpath(path.dirname(supplied));
  const file = path.basename(supplied);
  const bytes = await readApproved(root, file, MAX_POLICY_BYTES);
  let policy;
  try { policy = JSON.parse(bytes); }
  catch { throw failure('INVALID_POLICY', 'policy must be valid JSON'); }
  object(policy, ['version', 'packs'], 'policy');
  if (policy.version !== 1 || !Array.isArray(policy.packs) || policy.packs.length > 64) {
    throw failure('INVALID_POLICY', 'policy requires version 1 and at most 64 packs');
  }
  const packs = [];
  const seen = new Set();
  let count = 0;
  for (const pack of policy.packs) {
    object(pack, ['id', 'root', 'license', 'source', 'skills'], 'pack');
    name(pack.id, 'pack id');
    relativeFile(pack.root);
    if (seen.has(pack.id)) throw failure('INVALID_POLICY', 'duplicate pack id');
    seen.add(pack.id);
    if (typeof pack.license !== 'string' || pack.license.length > 200
        || typeof pack.source !== 'string' || pack.source.length > 512
        || !Array.isArray(pack.skills)) throw failure('INVALID_POLICY', 'pack requires license, source and skills');
    // Every component, including the configured root, must be a real directory.
    let packRoot = root;
    for (const part of pack.root.split('/')) {
      packRoot = path.join(packRoot, part);
      const stat = await fs.lstat(packRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_FILE', 'pack root must be a real directory');
    }
    const ids = new Set();
    const skills = [];
    for (const skill of pack.skills) {
      if (++count > 2048) throw failure('INVALID_POLICY', 'policy has too many skills');
      object(skill, ['id', 'directory', 'readable', 'compatibility'], 'skill');
      name(skill.id, 'skill id');
      relativeFile(skill.directory);
      if (ids.has(skill.id)) throw failure('INVALID_POLICY', 'duplicate skill id');
      ids.add(skill.id);
      if (!Array.isArray(skill.readable) || skill.readable.length === 0 || skill.readable.length > 128) {
        throw failure('INVALID_POLICY', 'readable must declare 1..128 pack-relative files');
      }
      const readable = [...new Set(skill.readable.map(relativeFile))].sort();
      const main = `${skill.directory}/SKILL.md`;
      if (!readable.includes(main)) throw failure('INVALID_POLICY', 'readable must include the skill SKILL.md');
      object(skill.compatibility, ['kind', 'requires', 'verification'], 'compatibility');
      if (!['instruction-only', 'requires-tools', 'host-specific'].includes(skill.compatibility.kind)
          || !['unverified', 'reviewed', 'tested'].includes(skill.compatibility.verification)
          || !Array.isArray(skill.compatibility.requires) || skill.compatibility.requires.length > 32
          || skill.compatibility.requires.some(item => typeof item !== 'string' || item.length > 200)) {
        throw failure('INVALID_POLICY', 'invalid compatibility declaration');
      }
      skills.push({ ...skill, readable, main });
    }
    packs.push({ ...pack, root: packRoot, skills });
  }
  return { root, file, fileHash: digest(bytes), hash: digest(JSON.stringify(policy)), packs, raw: policy };
}
