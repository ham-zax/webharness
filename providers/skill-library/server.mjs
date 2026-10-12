#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SkillLibrary } from './library.mjs';

export const DEFAULT_POLICY = fileURLToPath(new URL('../../skill-library/policy.json', import.meta.url));
const bounded = (maxLength = 512) => ({ type: 'string', minLength: 1, maxLength });
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const TOOLS = [
  {
    name: 'find_skills',
    description: 'Discover approved specialist guidance for the current step within the configured canonical workflow. Consider useful direct skills before searching. Default mode=lexical stays offline: exact names then BM25; omit query to browse. Explicit mode=jev additionally requires operator opt-in and credentials: query is the task, optional context is its situation, and task/context, approved metadata and bounded instruction excerpts are sent to TypeSafe. Jev evaluates the selected collection (at most 64 skills), returns up to three candidates or no_match/uncertain, and never silently falls back. No Jev cursors. Respect invocation hints; load only useful skills.',
    annotations: { ...annotations, idempotentHint: false, openWorldHint: true },
    inputSchema: { type: 'object', properties: {
      query: bounded(), collection: bounded(64),
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 }, cursor: bounded(2048),
      mode: { type: 'string', enum: ['lexical', 'jev'], default: 'lexical' }, context: bounded(4096),
    }, additionalProperties: false },
  },
  {
    name: 'read_skill',
    description: 'Read one approved skill or declared text dependency using its discovered revision. Omit file for SKILL.md; readableFiles lists approved pack-relative references. An optional operator adaptation supplies host invocation mapping alongside unchanged source content. Reads verify the entire dependency set and never execute scripts or grant authority. Follow nextCursor until complete=true. STALE_REVISION requires rediscovery; POLICY_CHANGED requires restart.',
    annotations,
    inputSchema: { type: 'object', properties: {
      id: bounded(129), revision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, file: bounded(), cursor: bounded(2048),
      max_bytes: { type: 'integer', minimum: 256, maximum: 16384, default: 8192 },
    }, required: ['id', 'revision'], additionalProperties: false },
  },
];

export function createSkillServer(library) {
  const server = new Server({ name: 'skill-library', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: 'Read-only skill retrieval. For engineering work, honor the configured canonical workflow and its activation rules first. Compare useful direct specialists with library candidates for the current step; use Jev when additional expertise helps, choice is ambiguous or explicitly requested. Include the active workflow, step and needed contribution in context. Specialists do not replace workflow ownership. Discover descriptions, choose useful guidance, then read complete instructions and needed declared references. Respect invocation hints: the starter thinking pack requires explicit invocation. Recommendations grant no automatic activation. An operator adaptation maps host invocation without changing source procedure or permissions. Default selection stays offline; explicit mode=jev requires operator opt-in and sends task/context and bounded approved evidence to TypeSafe. Compatibility and package completeness are separate claims.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const tool = TOOLS.find(item => item.name === request.params.name);
      const args = request.params.arguments ?? {};
      if (!tool) throw Object.assign(new Error('unknown skill tool'), { code: 'UNKNOWN_TOOL' });
      if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) {
        throw Object.assign(new Error('unexpected argument'), { code: 'INVALID_ARGUMENT' });
      }
      const value = tool.name === 'find_skills' ? await library.find({ ...args, signal: extra.signal }) : await library.read(args);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const value = { code: error.code ?? 'SKILL_LIBRARY_FAILED', message: error.message };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }] };
    }
  });
  return server;
}

async function main() {
  const library = await SkillLibrary.open(process.env.MCP_SKILL_POLICY_FILE || DEFAULT_POLICY);
  await library.catalog(); // Validate approved dependencies before advertising tools.
  const server = createSkillServer(library);
  await server.connect(new StdioServerTransport());
  const shutdown = () => { void server.close(); };
  process.stdin.once('end', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`skill-library: ${error.code ?? 'STARTUP_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
