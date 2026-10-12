import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SkillLibrary } from '../library.mjs';
import { JevSelector } from '../jev-selection.mjs';
import { createSkillServer, DEFAULT_POLICY } from '../server.mjs';
import { runCli } from '../cli.mjs';
import { renderConfig } from '../../../scripts/render-config.mjs';
import { reply } from './fixtures/typesafe.mjs';

function selector(fetchImpl) {
  return new JevSelector({ loadConfig: async () => ({ apiKey: 'fixture-key', model: 'jev-latest' }), fetchImpl });
}

test('ordinary discovery stays offline even when optional configuration is available or invalid', async () => {
  let calls = 0;
  const jevSelector = new JevSelector({ loadConfig: async () => { calls += 1; throw new Error('invalid optional configuration'); },
    fetchImpl: async () => { calls += 1; throw new Error('must not contact network'); } });
  const library = await SkillLibrary.open(DEFAULT_POLICY, { jevSelector });
  const found = await library.find({ query: 'thinking-first-principles' });
  assert.equal(found.mode, 'lexical');
  assert.equal(found.candidates.length, 1);
  assert.equal(calls, 0);
  assert.equal(found.candidates[0].source, undefined);
  assert.equal(found.candidates[0].license, undefined);
  await assert.rejects(library.find({ mode: 'jev', query: 'Test', cursor: 'cursor' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.find({ mode: 'other', query: 'Test' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.find({ context: 'ignored' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.find({ mode: 'jev', query: 'Test' }), /invalid optional configuration/);
});

test('MCP find/read uses optional Jev without a lexical prefilter or additional tools', async t => {
  let calls = 0;
  const jevSelector = selector(async (_, request) => {
    calls += 1;
    return new Response(JSON.stringify(reply(JSON.parse(request.body).questions)));
  });
  const library = await SkillLibrary.open(DEFAULT_POLICY, { jevSelector });
  assert.equal((await library.find({ query: 'zzzzunmatched' })).total, 0);
  const server = createSkillServer(library);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'jev-integration', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(item => item.name), ['find_skills', 'read_skill']);
  assert.equal(tools[0].annotations.openWorldHint, true);
  const found = await client.callTool({ name: 'find_skills', arguments: {
    mode: 'jev', collection: 'thinking', query: 'zzzzunmatched', context: 'Current step: choose a method', limit: 1,
  } });
  assert.equal(found.isError, undefined);
  assert.equal(found.structuredContent.status, 'selected');
  assert.equal(found.structuredContent.selection.considered, 28);
  assert.equal(found.structuredContent.candidates.length, 1);
  assert.equal(calls, 2);
  const card = found.structuredContent.candidates[0];
  assert.equal(card.invocationHints['disable-model-invocation'], true);
  const read = await client.callTool({ name: 'read_skill', arguments: { id: card.id, revision: card.revision } });
  assert.equal(read.isError, undefined);
  assert.equal(read.structuredContent.complete, true);
  assert.ok(read.structuredContent.readableFiles.every(item => item.digest === undefined));
});

test('policy-approved router adaptation is surfaced alongside original instructions', async () => {
  const library = await SkillLibrary.open(DEFAULT_POLICY);
  const card = (await library.find({ query: 'thinking-model-router' })).candidates[0];
  const read = await library.read({ id: card.id, revision: card.revision });
  assert.match(read.content, /thinking-skills:thinking-/);
  assert.equal(read.adaptation.file, card.adaptation);
  assert.match(read.adaptation.content, /thinking\/thinking-/);
  assert.match(read.adaptation.content, /provides no execution authority/);
});

test('source changes during model evaluation invalidate the result before returning candidates', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-stale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const exported = path.join(root, 'library');
  await runCli(['export', '--destination', exported]);
  let calls = 0;
  const jevSelector = selector(async (_, request) => {
    calls += 1;
    if (calls === 1) await fs.appendFile(path.join(exported, 'packs/thinking/thinking-first-principles/SKILL.md'), '\nChanged during evaluation.\n');
    return new Response(JSON.stringify(reply(JSON.parse(request.body).questions)));
  });
  const library = await SkillLibrary.open(path.join(exported, 'policy.json'), { jevSelector });
  await assert.rejects(library.find({ mode: 'jev', collection: 'thinking', query: 'Compare options' }), { code: 'STALE_REVISION' });
  assert.equal(calls, 2);
});

test('Local rendering forwards credential paths and enablement, never secret values', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-render-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const credentials = path.join(root, 'credentials.env');
  await fs.writeFile(credentials, 'TYPESAFE_API_KEY=unique-fixture-secret\n', { mode: 0o600 });
  const deployment = path.join(root, 'deployment.env');
  await fs.writeFile(deployment, `MCP_PUBLIC_URL=https://example.test\nMCP_SKILL_JEV_ENABLED=1\nMCP_SKILL_JEV_ENV_FILE=${credentials}\n`);
  const stateDir = path.join(root, 'state');
  await renderConfig({ profile: 'server', envFile: deployment, stateDir });
  const text = await fs.readFile(path.join(stateDir, 'local-1mcp/mcp.json'), 'utf8');
  const config = JSON.parse(text);
  assert.deepEqual(config.mcpServers['skill-library'].env, { MCP_SKILL_JEV_ENABLED: '1', MCP_SKILL_JEV_ENV_FILE: credentials });
  assert.equal(text.includes('unique-fixture-secret'), false);
  await fs.chmod(credentials, 0o644);
  await assert.rejects(renderConfig({ profile: 'server', envFile: deployment, stateDir, check: true }), { code: 'JEV_CONFIG_INVALID' });
});

test('cancellation covers catalog inspection before and after model selection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const exported = path.join(root, 'library');
  await runCli(['export', '--destination', exported]);
  const controller = new AbortController();
  let calls = 0;
  const jevSelector = selector(async (_, request) => {
    calls += 1;
    const result = new Response(JSON.stringify(reply(JSON.parse(request.body).questions)));
    if (calls === 2) controller.abort(new Error('private cancellation reason'));
    return result;
  });
  const library = await SkillLibrary.open(path.join(exported, 'policy.json'), { jevSelector });
  await assert.rejects(library.find({ mode: 'jev', query: 'Compare alternatives', signal: controller.signal }),
    error => error.code === 'JEV_CANCELLED' && !error.message.includes('private'));
  assert.equal(calls, 2);
  await fs.unlink(path.join(exported, 'packs/thinking/thinking-first-principles/SKILL.md'));
  await assert.rejects(library.find({ mode: 'jev', query: 'Compare alternatives', signal: controller.signal }), { code: 'JEV_CANCELLED' });
  assert.equal(calls, 2);
  await assert.rejects(library.find({ query: 'first-principles' }), { code: 'MISSING_DEPENDENCY' });
});
