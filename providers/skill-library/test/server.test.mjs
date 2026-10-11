import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSkillServer, DEFAULT_POLICY } from '../server.mjs';
import { SkillLibrary } from '../library.mjs';
import { INNER_TOOL_SEPARATOR, LocalToolBroker, createLocalBrokerServer } from '../../local-tools/server.mjs';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));

test('real standalone stdio server exposes only two read-only tools and completes find/read', async t => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath],
    env: { PATH: process.env.PATH }, stderr: 'pipe' });
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
  for (const args of [{ limit: null }, { constructor: 'unexpected' }, { limit: 21 }]) {
    const rejected = await client.callTool({ name: 'find_skills', arguments: args });
    assert.equal(rejected.isError, true);
    assert.equal(JSON.parse(rejected.content[0].text).code, 'INVALID_ARGUMENT');
  }
});

test('Local maintains its five-tool ABI and routes skill discovery, schema and reads', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-local-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'mcp.json');
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { 'skill-library': { command: 'fixture' } } }));
  const skillServer = createSkillServer(await SkillLibrary.open(DEFAULT_POLICY));
  const [innerClientTransport, innerServerTransport] = InMemoryTransport.createLinkedPair();
  const innerClient = new Client({ name: 'skill-inner-test', version: '1.0.0' });
  await skillServer.connect(innerServerTransport);
  await innerClient.connect(innerClientTransport);
  const inner = {
    state: 'running',
    async listTools() {
      const { tools } = await innerClient.listTools();
      return { tools: tools.map(tool => ({ ...tool, name: `skill-library${INNER_TOOL_SEPARATOR}${tool.name}` })) };
    },
    async callTool(name, args) { return innerClient.callTool({ name: name.slice(`skill-library${INNER_TOOL_SEPARATOR}`.length), arguments: args }); },
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
