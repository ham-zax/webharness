import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createSkillServer } from '../server.mjs';
import { SkillLibrary } from '../library.mjs';
import { LocalToolBroker, createLocalBrokerServer } from '../../local-tools/server.mjs';
import { createSampleLibrary } from './fixtures/sample-library.mjs';

const execFileAsync = promisify(execFile);
const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
const syncScriptPath = fileURLToPath(new URL('../../../scripts/sync-skillshare-library.mjs', import.meta.url));

test('real standalone stdio server exposes only two read-only tools and completes find/read', async t => {
  const { policyPath } = await createSampleLibrary(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath],
    env: { PATH: process.env.PATH, MCP_SKILL_POLICY_FILE: policyPath }, stderr: 'pipe' });
  const client = new Client({ name: 'skill-library-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['find_skills', 'read_skill']);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  const found = await client.callTool({ name: 'find_skills', arguments: { query: 'thinking-first-principles' } });
  const card = found.structuredContent.candidates[0];
  const read = await client.callTool({ name: 'read_skill', arguments: { id: card.id, revision: card.revision } });
  assert.equal(read.isError, undefined);
  assert.match(read.structuredContent.content, /First Principles/);
  assert.equal(read.structuredContent.complete, true);
  const invalid = await client.callTool({ name: 'read_skill', arguments: { id: card.id, revision: card.revision, file: '../../.env' } });
  assert.equal(invalid.isError, true);
  assert.equal(JSON.parse(invalid.content[0].text).code, 'FILE_NOT_APPROVED');
  const badRev = await client.callTool({ name: 'read_skill', arguments: { id: card.id, revision: 'not-a-sha' } });
  assert.equal(badRev.isError, true);
  assert.match(JSON.parse(badRev.content[0].text).message, /returned by find_skills/);
  for (const args of [{ limit: null }, { constructor: 'unexpected' }, { limit: 21 }]) {
    const rejected = await client.callTool({ name: 'find_skills', arguments: args });
    assert.equal(rejected.isError, true);
    const parsed = JSON.parse(rejected.content[0].text);
    assert.equal(parsed.code, 'INVALID_ARGUMENT');
    if (Object.hasOwn(args, 'constructor')) {
      assert.match(parsed.message, /unexpected argument\(s\): constructor; allowed:/);
    }
  }
});

test('standalone stdio server negotiates modern 2026-07-28 and serves concurrent calls', async t => {
  const { policyPath } = await createSampleLibrary(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { PATH: process.env.PATH, MCP_SKILL_POLICY_FILE: policyPath },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'skill-library-modern-test', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  t.after(() => client.close());
  await client.connect(transport);
  const [first, second] = await Promise.all([
    client.callTool({ name: 'find_skills', arguments: { query: 'using-aegis' } }),
    client.callTool({ name: 'find_skills', arguments: { query: 'thinking-first-principles' } }),
  ]);
  assert.equal(first.isError, undefined);
  assert.equal(second.isError, undefined);
  assert.ok(first.structuredContent.candidates.length >= 1);
  assert.ok(second.structuredContent.candidates.length >= 1);
});

test('Local maintains its five-tool ABI and routes skill discovery, schema and reads', async t => {
  const { policyPath } = await createSampleLibrary(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-local-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'mcp.json');
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { 'skill-library': { command: 'fixture' } } }));
  const skillServer = createSkillServer(await SkillLibrary.open(policyPath));
  const [innerClientTransport, innerServerTransport] = InMemoryTransport.createLinkedPair();
  const innerClient = new Client({ name: 'skill-inner-test', version: '1.0.0' });
  await skillServer.connect(innerServerTransport);
  await innerClient.connect(innerClientTransport);
  const inner = {
    serverState: () => 'running',
    isServerLive: () => true,
    async listServerTools(server) {
      assert.equal(server, 'skill-library');
      return innerClient.listTools();
    },
    async callServerTool(server, tool, args) {
      assert.equal(server, 'skill-library');
      return innerClient.callTool({ name: tool, arguments: args });
    },
    async close() { await innerClient.close(); await skillServer.close(); },
  };
  const broker = new LocalToolBroker({ configPath, inner });
  const server = createLocalBrokerServer({ broker });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'skills-local-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); await broker.shutdown(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.match(client.getInstructions(), /skill-library.*find_skills.*read_skill/);
  assert.equal((await client.listTools()).tools.length, 5);
  const listing = await client.callTool({ name: 'tool_list', arguments: { server: 'skill-library' } });
  assert.deepEqual(listing.structuredContent.tools.map(tool => tool.tool), ['find_skills', 'read_skill']);
  const schema = await client.callTool({ name: 'tool_schema', arguments: { server: 'skill-library', tool: 'read_skill' } });
  assert.deepEqual(schema.structuredContent.definition.inputSchema.required, ['id', 'revision']);
  const found = await client.callTool({ name: 'tool_call', arguments: { server: 'skill-library', tool: 'find_skills', arguments: { query: 'thinking-pre-mortem' } } });
  const card = found.structuredContent.candidates[0];
  const read = await client.callTool({ name: 'tool_call', arguments: { server: 'skill-library', tool: 'read_skill', arguments: { id: card.id, revision: card.revision } } });
  assert.match(read.structuredContent.content, /Pre-Mortem/);
});

test('sync-skillshare-library publishes atomically by generation and preserves live catalog on failed sync', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-sync-atomic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const outDir = path.join(root, 'out');
  const emptyExtra = path.join(root, 'extra-none');
  await fs.mkdir(path.join(sourceDir, 'alpha-skill'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\ndescription: Alpha test skill\n---\n# Alpha v1\n', 'utf8');

  // 1. First sync publishes generation 1 cleanly.
  await execFileAsync(process.execPath, [syncScriptPath, '--source', sourceDir, '--extra-packs', emptyExtra, '--out', outDir]);
  const policyPath = path.join(outDir, 'policy.json');
  const policy1 = JSON.parse(await fs.readFile(policyPath, 'utf8'));
  const active1 = policy1.packs.find(p => p.id === 'active');
  assert.ok(active1, 'active pack published');
  assert.match(active1.root, /^packs\/sync-[^/]+\/active$/);
  const lib1 = await SkillLibrary.open(policyPath);
  const cat1 = await lib1.catalog();
  assert.ok(cat1.skills.some(s => s.id === 'active/alpha-skill'));

  // 2. Second sync publishes generation 2 and removes superseded generation 1.
  await fs.writeFile(path.join(sourceDir, 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\ndescription: Alpha v2 skill\n---\n# Alpha v2\n', 'utf8');
  await execFileAsync(process.execPath, [syncScriptPath, '--source', sourceDir, '--extra-packs', emptyExtra, '--out', outDir]);
  const policy2 = JSON.parse(await fs.readFile(policyPath, 'utf8'));
  const active2 = policy2.packs.find(p => p.id === 'active');
  assert.notEqual(active2.root, active1.root);
  const packDirsAfter2 = await fs.readdir(path.join(outDir, 'packs'));
  assert.deepEqual(packDirsAfter2, [active2.root.split('/')[1]]);

  // 3. A failed sync (corrupt policy.example.json or invalid skill) must leave generation 2 intact and loadable.
  await fs.writeFile(path.join(outDir, 'policy.example.json'), '{not-valid-json', 'utf8');
  await assert.rejects(() => execFileAsync(process.execPath, [syncScriptPath, '--source', sourceDir, '--extra-packs', emptyExtra, '--out', outDir]));
  const libAfterFail = await SkillLibrary.open(policyPath);
  const catAfterFail = await libAfterFail.catalog();
  const alphaCard = catAfterFail.skills.find(s => s.id === 'active/alpha-skill');
  assert.ok(alphaCard);
  const readAfterFail = await libAfterFail.read({ id: alphaCard.id, revision: alphaCard.revision });
  assert.match(readAfterFail.content, /Alpha v2/);
});
