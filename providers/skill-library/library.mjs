import { checkJevCancellation, digest, failure, MAX_POLICY_BYTES, readApproved, utf8 } from './files.mjs';
import { loadPolicy } from './policy.mjs';
import { compileCatalog, inspectSkill } from './catalog.mjs';
import { search } from './search.mjs';
import { JevSelector } from './jev-selection.mjs';

const RESPONSE_BYTES = 24 * 1024;

function integer(value, fallback, min, max, label) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) {
    throw failure('INVALID_ARGUMENT', `${label} must be an integer from ${min} to ${max}`);
  }
  return selected;
}

function optionalString(value, label, max = 512) {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0 || value.length > max)) {
    throw failure('INVALID_ARGUMENT', `${label} must be a non-empty bounded string`);
  }
  return value?.trim();
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
        || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
    return cursor;
  } catch { throw failure('INVALID_CURSOR', 'invalid continuation cursor'); }
}

export class SkillLibrary {
  static async open(policyPath, options) { return new SkillLibrary(await loadPolicy(policyPath), options); }
  constructor(policy, { jevSelector = new JevSelector() } = {}) { this.policy = policy; this.jevSelector = jevSelector; }

  async checkPolicy(signal) {
    const bytes = await readApproved(this.policy.root, this.policy.file, MAX_POLICY_BYTES, signal);
    if (digest(bytes) !== this.policy.fileHash) {
      throw failure('POLICY_CHANGED', 'approved policy changed; restart the provider to apply it');
    }
  }

  async catalog(signal) {
    await this.checkPolicy(signal);
    const result = await compileCatalog(this.policy, signal);
    await this.checkPolicy(signal);
    return result;
  }

  async find({ query, collection, limit, cursor, mode = 'lexical', context, signal } = {}) {
    if (!['lexical', 'jev'].includes(mode)) throw failure('INVALID_ARGUMENT', 'mode must be lexical or jev');
    query = optionalString(query, 'query');
    collection = optionalString(collection, 'collection', 64);
    context = optionalString(context, 'context', 4096);
    if (mode === 'lexical' && context !== undefined) throw failure('INVALID_ARGUMENT', 'context applies only to mode=jev');
    if (mode === 'jev' && (!query || cursor !== undefined)) throw failure('INVALID_ARGUMENT', 'mode=jev requires a task query and does not accept cursors');
    const size = integer(limit, 3, 1, 20, 'limit');
    // Cover catalog inspection and the final revision check as well as HTTP.
    const routeSignal = mode === 'jev' ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]) : undefined;
    const catalog = await this.catalog(routeSignal);
    const collections = this.policy.packs.map(pack => ({ id: pack.id, count: pack.skills.length }));
    if (collection && !collections.some(item => item.id === collection)) throw failure('UNKNOWN_COLLECTION', 'unknown collection');
    if (mode === 'jev') {
      const cards = catalog.skills.filter(card => !collection || card.collection === collection);
      const selection = await this.jevSelector.select({ cards, task: query, context, limit: size, signal: routeSignal,
        readBody: async card => {
          const pack = this.policy.packs.find(item => item.id === card.collection);
          const skill = pack.skills.find(item => `${pack.id}/${item.id}` === card.id);
          await this.checkPolicy(routeSignal);
          const inspected = await inspectSkill(pack, skill, routeSignal);
          await this.checkPolicy(routeSignal);
          if (inspected.card.revision !== card.revision) throw failure('STALE_REVISION', 'skill changed during Jev selection; rediscover');
          // The operator adaptation is already approved and revision-bound.
          const adaptation = skill.adaptation ? `${utf8(inspected.contents.get(skill.adaptation))}\n\n` : '';
          return adaptation + utf8(inspected.contents.get(skill.main));
        } });
      const current = await this.catalog(routeSignal);
      checkJevCancellation(routeSignal);
      if (current.revision !== catalog.revision) throw failure('STALE_REVISION', 'catalog changed during Jev selection; repeat discovery');
      const candidates = selection.selected.map(judgment => {
        const { files, main, source, license, ...metadata } = cards.find(card => card.id === judgment.id);
        return { ...metadata, judgment: { fit: judgment.fit, score: judgment.score, confidence: judgment.confidence } };
      });
      const { selected, status, ...details } = selection;
      const result = { mode: 'jev', status, collections,
        candidates, total: candidates.length, hasMore: false, selection: details };
      if (Buffer.byteLength(JSON.stringify(result)) > RESPONSE_BYTES) throw failure('RESPONSE_TOO_LARGE', 'selected candidate metadata exceeds response budget; use a smaller limit');
      return result;
    }
    const candidates = search(catalog.skills.filter(card => !collection || card.collection === collection), query);
    const filter = digest(JSON.stringify({ query: query ?? null, collection: collection ?? null }));
    let offset = 0;
    if (cursor !== undefined) {
      const page = decode(cursor);
      if (page.kind !== 'find' || page.filter !== filter) throw failure('INVALID_CURSOR', 'cursor filters do not match');
      if (page.revision !== catalog.revision) throw failure('STALE_CURSOR', 'catalog changed; repeat discovery without a cursor');
      offset = page.offset;
      if (offset > candidates.length) throw failure('INVALID_CURSOR', 'cursor offset is outside the result set');
    }
    const result = { mode: query ? 'lexical' : 'browse',
      collections, candidates: [], total: candidates.length, hasMore: false };
    for (const { card } of candidates.slice(offset, offset + size)) {
      const { files, main, source, license, ...metadata } = card;
      result.candidates.push(metadata);
      if (Buffer.byteLength(JSON.stringify(result)) > RESPONSE_BYTES - 2048) {
        result.candidates.pop();
        break;
      }
    }
    if (result.candidates.length === 0 && offset < candidates.length) {
      throw failure('RESPONSE_TOO_LARGE', 'candidate metadata exceeds the find response budget; reduce its approved metadata before discovery');
    }
    const next = offset + result.candidates.length;
    result.hasMore = next < candidates.length;
    if (result.hasMore) result.nextCursor = encode({ kind: 'find', filter, revision: catalog.revision, offset: next });
    return result;
  }

  async read({ id, revision, file, cursor, max_bytes } = {}) {
    if (typeof id !== 'string' || id.length > 129 || !id.includes('/')) throw failure('INVALID_ARGUMENT', 'id must name one discovered skill');
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw failure('INVALID_ARGUMENT', 'revision must be the discovered SHA-256 revision');
    const budget = integer(max_bytes, 8192, 256, 16384, 'max_bytes');
    await this.checkPolicy();
    const [packId, skillId, extra] = id.split('/');
    const pack = this.policy.packs.find(item => item.id === packId);
    const skill = pack?.skills.find(item => item.id === skillId);
    if (!skill || extra !== undefined) throw failure('UNKNOWN_SKILL', 'skill is not approved');
    if (file !== undefined && (typeof file !== 'string' || file.length === 0 || file.length > 512)) {
      throw failure('INVALID_ARGUMENT', 'file must be a bounded string identifier');
    }
    const selected = file === undefined ? skill.main : file;
    if (!skill.readable.includes(selected)) throw failure('FILE_NOT_APPROVED', 'file is not in this skill readable dependency set');
    const inspected = await inspectSkill(pack, skill);
    await this.checkPolicy();
    if (inspected.card.revision !== revision) throw failure('STALE_REVISION', 'skill or a readable dependency changed; rediscover before reading');
    const bytes = inspected.contents.get(selected);
    let offset = 0;
    if (cursor !== undefined) {
      const page = decode(cursor);
      if (page.kind !== 'read' || page.id !== id || page.file !== selected || page.revision !== revision) {
        throw failure('INVALID_CURSOR', 'cursor does not match this skill, file and revision');
      }
      offset = page.offset;
    }
    if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) {
      throw failure('INVALID_CURSOR', 'cursor must point to a UTF-8 boundary inside the file');
    }
    let end = Math.min(bytes.length, offset + budget);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    const result = { id, revision, file: selected, content: utf8(bytes.subarray(offset, end)),
      bytes: end - offset, totalBytes: bytes.length, complete: end === bytes.length };
    // Continuations carry only new text; do not repeat the dependency inventory
    // and instruction metadata on every page in the client's context.
    if (cursor === undefined) {
      result.readableFiles = inspected.files.map(item => ({ file: item.file, bytes: item.bytes }));
      result.compatibility = skill.compatibility;
      result.invocationHints = inspected.card.invocationHints;
      if (skill.adaptation) result.adaptation = { file: skill.adaptation, content: utf8(inspected.contents.get(skill.adaptation)) };
    }
    // JSON escaping also counts toward the response budget, not only UTF-8 bytes.
    while (Buffer.byteLength(JSON.stringify(result)) > RESPONSE_BYTES - 2048 && end > offset) {
      end = offset + Math.floor((end - offset) / 2);
      while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
      result.content = utf8(bytes.subarray(offset, end));
      result.bytes = end - offset;
      result.complete = end === bytes.length;
    }
    if (end === offset && bytes.length > offset) throw failure('RESPONSE_TOO_LARGE', 'dependency metadata exceeds response budget');
    if (!result.complete) result.nextCursor = encode({ kind: 'read', id, file: selected, revision, offset: end });
    if (Buffer.byteLength(JSON.stringify(result)) > RESPONSE_BYTES) {
      throw failure('RESPONSE_TOO_LARGE', 'dependency metadata exceeds response budget; reduce the declared readable set');
    }
    return result;
  }
}
