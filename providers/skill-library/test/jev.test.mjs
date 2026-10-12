import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JevSelector, skillExcerpt } from '../jev-selection.mjs';
import { askJev, JEV_ENDPOINT } from '../jev-transport.mjs';
import { loadJevConfig } from '../jev-config.mjs';
import { reply } from './fixtures/typesafe.mjs';

const config = { apiKey: 'test-secret-key', model: 'jev-latest' };
const cards = [
  { id: 'test/one', name: 'one', description: 'Diagnose performance bottlenecks.' },
  { id: 'test/two', name: 'two', description: 'Explore architectural tradeoffs.' },
];
const readBody = async card => `# ${card.name}\n## When to Use\nFor relevant tasks.\n## When NOT to Use\nAvoid unrelated tasks.\n`;

function mockSelector(options = {}) {
  const calls = [];
  const selector = new JevSelector({ loadConfig: async () => config, fetchImpl: async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ url, request, body });
    return new Response(JSON.stringify(reply(body.questions, options)), { status: 200 });
  } });
  return { selector, calls };
}

test('JevShelf rank/verification returns validated selections with real usage accounting', async () => {
  const { selector, calls } = mockSelector();
  const result = await selector.select({ cards, task: 'Diagnose a slow request', context: 'Current step: root cause', readBody, limit: 1 });
  assert.equal(result.status, 'selected');
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].id, 'test/one');
  assert.equal(result.apiCalls, 2);
  assert.deepEqual(result.usage, { input_tokens: 200, output_tokens: 40 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, JEV_ENDPOINT);
  assert.equal(calls[0].request.redirect, 'error');
  assert.equal(calls[0].request.headers.Authorization, 'Bearer test-secret-key');
  assert.equal(calls[0].body.state.recent_context, 'Current step: root cause');
  assert.ok(calls[0].body.questions.rank.criteria.__none__);
  assert.equal(calls[1].body.questions.fit_0.type, 'noul');
  assert.match(calls[1].body.questions.fit_0.instructions.skill.instructions_excerpt, /When NOT to Use/);
});

test('semantic no-match and uncertainty remain distinct and never become lexical candidates', async () => {
  const none = mockSelector({ fit: 0.1 });
  assert.equal((await none.selector.select({ cards, task: 'Irrelevant task', readBody })).status, 'no_match');
  const uncertain = mockSelector({ confidence: 0.3 });
  const result = await uncertain.selector.select({ cards, task: 'Diagnose performance', readBody });
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(result.selected, []);
});

test('all scope/request preflight limits reject before any model request', async () => {
  const { selector, calls } = mockSelector();
  await assert.rejects(selector.select({ cards: Array.from({ length: 65 }, (_, i) => ({ ...cards[0], id: `test/${i}` })), task: 'Test', readBody }), { code: 'JEV_SCOPE_TOO_LARGE' });
  await assert.rejects(selector.select({ cards, task: 'Test', context: '依'.repeat(3000), readBody }), { code: 'JEV_SCOPE_TOO_LARGE' });
  const huge = Array.from({ length: 20 }, (_, i) => ({ id: `test/${i}`, name: `skill-${i}`, description: '依'.repeat(1024) }));
  await assert.rejects(selector.select({ cards: huge, task: 'Test', readBody }), { code: 'JEV_SCOPE_TOO_LARGE' });
  const hugeVerification = cards.map(card => ({ ...card, description: '依'.repeat(1024) }));
  assert.equal(calls.length, 0);
  // The bounded adaptive evidence window can now fit this valid subset.
  const selected = await selector.select({ cards: hugeVerification, task: 'Test', readBody: async () => '依'.repeat(3000) });
  assert.equal(selected.apiCalls, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => Buffer.byteLength(JSON.stringify(call.body)) <= 24000));
});

test('large approved collections fit inside the same hard Jev wire limits', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    id: `marketing/specialist-${i}`, name: `specialist-${i}`,
    description: `Provide targeted guidance for marketing opportunity ${i}. ` + 'Detailed applicability criteria. '.repeat(25),
  }));
  const { selector, calls } = mockSelector();
  const result = await selector.select({ cards: many, task: 'Improve customer lifecycle marketing',
    readBody: async card => `# ${card.name}\n## When to Use\n` + 'Long instructions and exclusions. '.repeat(120) });
  assert.equal(result.apiCalls, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => Buffer.byteLength(JSON.stringify(call.body)) <= 24000));
  assert.ok(calls[0].body.questions.rank.criteria['marketing/specialist-0'].length < many[0].description.length);
});

test('invalid probability IDs and nonfinite/missing answers fail closed without exposing response text', async () => {
  for (const change of [
    data => { data.answers.rank.probabilities.secret = 0; },
    data => { data.answers.rank.probabilities['test/one'] = 2; },
    data => { delete data.answers.rank; },
    data => { data.answers.rank.choice = 'unapproved'; },
    data => { data.model = `jev-${config.apiKey}`; },
  ]) {
    let calls = 0;
    const selector = new JevSelector({ loadConfig: async () => config, fetchImpl: async (_, request) => {
      calls += 1;
      const result = reply(JSON.parse(request.body).questions);
      change(result);
      result.secret = config.apiKey;
      return new Response(JSON.stringify(result));
    } });
    await assert.rejects(selector.select({ cards, task: 'Test', readBody }), error => error.code === 'JEV_INVALID_RESPONSE' && !error.message.includes(config.apiKey));
    assert.equal(calls, 1);
  }
});

test('HTTP and transport failures are explicit, sanitized, and not retried', async () => {
  for (const fetchImpl of [async () => new Response(config.apiKey, { status: 503 }), async () => { throw new Error(config.apiKey); }]) {
    let count = 0;
    const selector = new JevSelector({ loadConfig: async () => config, fetchImpl: async (...args) => { count += 1; return fetchImpl(...args); } });
    await assert.rejects(selector.select({ cards, task: 'Test', readBody }), error => ['JEV_HTTP_ERROR', 'JEV_UNAVAILABLE'].includes(error.code) && !error.message.includes(config.apiKey));
    assert.equal(count, 1);
  }
});

test('response bodies are bounded and cancellation aborts the in-flight request', async () => {
  await assert.rejects(askJev({ config, state: {}, questions: {}, fetchImpl: async () => new Response('x'.repeat(65537)) }), { code: 'JEV_INVALID_RESPONSE' });
  const controller = new AbortController();
  const selector = new JevSelector({ loadConfig: async () => config, fetchImpl: async (_, request) => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new Error(config.apiKey)), { once: true });
    controller.abort();
  }) });
  await assert.rejects(selector.select({ cards, task: 'Test', readBody, signal: controller.signal }), { code: 'JEV_CANCELLED' });
  const cancelled = new AbortController();
  cancelled.abort(new Error(config.apiKey));
  const pending = mockSelector();
  await assert.rejects(pending.selector.select({ cards, task: 'Test', readBody, signal: cancelled.signal }), error => error.code === 'JEV_CANCELLED' && !error.message.includes(config.apiKey));
  assert.equal(pending.calls.length, 0);
});

test('bounded evidence preserves applicability, exclusions and Unicode boundaries', () => {
  const body = `# Long guidance\n${'😀 background\n'.repeat(100)}\n## When NOT to Use\nAvoid this for irreversible data deletion.\n${'filler\n'.repeat(100)}\n## When to Use\nDiagnose performance bottlenecks.\n${'tail\n'.repeat(100)}`;
  const excerpt = skillExcerpt(body, 'Diagnose performance');
  assert.ok(excerpt.length <= 900);
  assert.match(excerpt, /When NOT to Use/);
  assert.match(excerpt, /When to Use/);
  assert.equal(Buffer.from(excerpt).toString(), excerpt);
});

test('configuration is disabled by default and private credentials are declarative operator input', async t => {
  await assert.rejects(loadJevConfig({ TYPESAFE_API_KEY: config.apiKey }), { code: 'JEV_DISABLED' });
  await assert.rejects(loadJevConfig({ MCP_SKILL_JEV_ENABLED: '1' }), { code: 'JEV_CONFIG_INVALID' });
  assert.deepEqual(await loadJevConfig({ MCP_SKILL_JEV_ENABLED: '1', TYPESAFE_API_KEY: config.apiKey }), config);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-jev-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'model.env');
  await fs.writeFile(file, `TYPESAFE_API_KEY='${config.apiKey}'\nTYPESAFE_MODEL=jev-latest\n`, { mode: 0o600 });
  const env = { MCP_SKILL_JEV_ENABLED: '1', MCP_SKILL_JEV_ENV_FILE: file };
  assert.deepEqual(await loadJevConfig(env), config);
  await fs.appendFile(file, 'TEXT_MODEL_API_KEY=other-private-key\nTEXT_MODEL_BASE_URL=https://example.test\nTEXT_MODEL=other-model\nTEXT_MODEL_REASONING=max\n');
  assert.deepEqual(await loadJevConfig(env), config);
  await fs.chmod(file, 0o644);
  await assert.rejects(loadJevConfig(env), { code: 'JEV_CONFIG_INVALID' });
  await fs.chmod(file, 0o600);
  await fs.writeFile(file, 'TYPESAFE_API_KEY=x\nPATH=/unsafe\n');
  await assert.rejects(loadJevConfig(env), { code: 'JEV_CONFIG_INVALID' });
  await fs.writeFile(file, 'TYPESAFE_API_KEY=x\nTYPESAFE_API_KEY=y\n');
  await assert.rejects(loadJevConfig(env), { code: 'JEV_CONFIG_INVALID' });
  const link = path.join(root, 'linked.env');
  await fs.symlink(file, link);
  await assert.rejects(loadJevConfig({ ...env, MCP_SKILL_JEV_ENV_FILE: link }), { code: 'JEV_CONFIG_INVALID' });
});
