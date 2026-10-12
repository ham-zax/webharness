import path from 'node:path';
import { parseDocument } from 'yaml';
import { digest, failure, MAX_SET_BYTES, readApprovedEntry, utf8 } from './files.mjs';

function metadata(bytes, expectedName) {
  const text = utf8(bytes).replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match || Buffer.byteLength(match[1]) > 16 * 1024) {
    throw failure('INVALID_SKILL', 'SKILL.md requires bounded YAML frontmatter');
  }
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw failure('INVALID_SKILL', 'invalid or duplicate YAML frontmatter');
  let data;
  try { data = document.toJS({ maxAliasCount: 0 }); }
  catch { throw failure('INVALID_SKILL', 'YAML aliases are not supported'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || data.name !== expectedName || typeof data.description !== 'string'
      || data.description.trim().length === 0 || data.description.length > 1024) {
    throw failure('INVALID_SKILL', 'skill name must match its directory; description must contain 1..1024 characters');
  }
  const hints = {};
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== 'boolean') throw failure('INVALID_SKILL', `${key} must be boolean`);
      hints[key] = data[key];
    }
  }
  for (const key of ['allowed-tools', 'compatibility']) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== 'string' || data[key].length > 2048) throw failure('INVALID_SKILL', `invalid ${key} hint`);
      hints[key] = data[key];
    }
  }
  return { name: data.name, description: data.description.trim(), invocationHints: hints };
}

export async function inspectSkill(pack, skill, signal) {
  const files = [];
  const contents = new Map();
  let bytes = 0;
  for (const file of skill.readable) {
    const { bytes: raw, executeBits } = await readApprovedEntry(pack.root, file, undefined, signal);
    utf8(raw);
    bytes += raw.length;
    if (bytes > MAX_SET_BYTES) throw failure('SET_TOO_LARGE', 'readable dependency set exceeds 16 MiB');
    files.push({ file, digest: digest(raw), bytes: raw.length, executeBits });
    contents.set(file, raw);
  }
  const meta = metadata(contents.get(skill.main), path.posix.basename(skill.directory));
  if (skill.adaptation && contents.get(skill.adaptation).length > 4096) {
    throw failure('ADAPTATION_TOO_LARGE', 'host adaptation must fit within 4 KiB');
  }
  // Bound the inventory actually returned to clients, not internal revision
  // hashes and mode bits. Full dependencies still participate in the revision.
  if (Buffer.byteLength(JSON.stringify(files.map(({ file, bytes }) => ({ file, bytes })))) > 16 * 1024) {
    throw failure('DEPENDENCY_METADATA_TOO_LARGE', 'readable file metadata exceeds 16 KiB; narrow the declared dependency set');
  }
  // Policy mappings and all readable bytes participate, not just SKILL.md.
  const revision = digest(JSON.stringify({
    pack: pack.id, source: pack.source, license: pack.license,
    id: skill.id, directory: skill.directory, compatibility: skill.compatibility, adaptation: skill.adaptation ?? null, files,
  }));
  const card = {
    id: `${pack.id}/${skill.id}`, collection: pack.id, ...meta, revision,
    source: pack.source, license: pack.license,
    completeness: { declaredFiles: files.length, status: 'present' },
    compatibility: skill.compatibility,
    ...(skill.adaptation ? { adaptation: skill.adaptation } : {}),
  };
  return { card, files, contents, main: skill.main };
}

export async function compileCatalog(policy, signal) {
  const skills = [];
  let bytes = 0;
  for (const pack of policy.packs) {
    for (const skill of pack.skills) {
      const inspected = await inspectSkill(pack, skill, signal);
      bytes += inspected.files.reduce((sum, file) => sum + file.bytes, 0);
      if (bytes > 64 * 1024 * 1024) throw failure('CATALOG_TOO_LARGE', 'catalog readable content exceeds 64 MiB');
      skills.push({ ...inspected.card, files: inspected.files, main: skill.main });
    }
  }
  skills.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const revision = digest(JSON.stringify({ policy: policy.hash, skills }));
  return { version: 1, revision, skills };
}
