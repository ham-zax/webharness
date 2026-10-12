// Minimal Node port of JevShelf's pinned jev-skill-router/jev.py.
// MIT attribution and source revisions: JEV_PROVENANCE.md.
import { failure } from './files.mjs';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MAX_REQUEST_BYTES = 24000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function payload(model, state, questions) {
  const body = JSON.stringify({ model, state, questions });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    throw failure('JEV_SCOPE_TOO_LARGE', 'Jev request exceeds 24000 bytes; narrow the collection or task/context');
  }
  return body;
}

function probability(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw failure('JEV_INVALID_RESPONSE', 'TypeSafe returned an invalid probability');
  }
  return value;
}

export function validateResponse(data, questions) {
  if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object'
      || typeof data.model !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(data.model)) {
    throw failure('JEV_INVALID_RESPONSE', 'TypeSafe returned a malformed answer');
  }
  for (const [key, question] of Object.entries(questions)) {
    const answer = data.answers[key];
    if (!answer || answer.type !== question.type) throw failure('JEV_INVALID_RESPONSE', 'TypeSafe answer is missing or has the wrong type');
    if (question.type === 'noul') { probability(answer.noul); continue; }
    probability(answer.confidence);
    const expected = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
    const distribution = answer.probabilities;
    if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)
        || Object.keys(distribution).length !== expected.length || expected.some(id => !Object.hasOwn(distribution, id))
        || Math.abs(Object.values(distribution).reduce((sum, value) => sum + probability(value), 0) - 1) > 0.025) {
      throw failure('JEV_INVALID_RESPONSE', 'TypeSafe returned an invalid probability distribution');
    }
    if (question.type === 'choice') {
      if (!expected.includes(answer.choice) || distribution[answer.choice] + 1e-6 < Math.max(...Object.values(distribution))) {
        throw failure('JEV_INVALID_RESPONSE', 'TypeSafe returned an invalid choice');
      }
    } else if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)
        || answer.score < 0 || answer.score > question.criteria.length - 1) {
      throw failure('JEV_INVALID_RESPONSE', 'TypeSafe returned an invalid score');
    }
  }
  return data;
}

export async function askJev({ config, state, questions, signal, fetchImpl = fetch }) {
  const body = payload(config.model, state, questions);
  try {
    const response = await fetchImpl(JEV_ENDPOINT, { method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body });
    if (!response.ok) {
      await response.body?.cancel();
      throw failure('JEV_HTTP_ERROR', `TypeSafe HTTP ${response.status}; check credentials, model and limits`);
    }
    if (!response.body) throw failure('JEV_INVALID_RESPONSE', 'TypeSafe returned an empty response');
    const chunks = [];
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw failure('JEV_INVALID_RESPONSE', 'TypeSafe response exceeds 64 KiB');
        }
        chunks.push(Buffer.from(next.value));
      }
    } finally { reader.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw failure('JEV_INVALID_RESPONSE', 'TypeSafe returned invalid JSON'); }
    if (typeof data?.model === 'string' && data.model.includes(config.apiKey)) {
      throw failure('JEV_INVALID_RESPONSE', 'TypeSafe returned an invalid public model identifier');
    }
    return validateResponse(data, questions);
  } catch (error) {
    if (signal?.aborted) throw failure('JEV_CANCELLED', 'Jev request cancelled or its 30-second deadline expired');
    if (typeof error.code === 'string' && error.code.startsWith('JEV_')) throw error;
    // Never expose response bodies, keys or transport error text; never retry an
    // ambiguous connection failure that may already have consumed API quota.
    throw failure('JEV_UNAVAILABLE', 'TypeSafe connection failed; lexical discovery remains available');
  }
}
