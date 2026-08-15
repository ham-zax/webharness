import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { canonicalWorkspaceRoot } from './boundary.mjs';
import { runRead, runEdit, runWrite } from './files.mjs';
import { runBash } from './shell.mjs';
import { renderBashText, renderEditText, renderWriteText } from './render.mjs';

const mode = process.env.MCP_DEV_SHELL_MODE;
if (!['disabled', 'unrestricted'].includes(mode)) {
  console.error('MCP_DEV_SHELL_MODE must be disabled or unrestricted');
  process.exit(2);
}

const workspaceRoot = await canonicalWorkspaceRoot(process.env.MCP_DEV_WORKSPACE_ROOT);
const stateDir = process.env.MCP_DEV_STATE_DIR;
if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
  console.error('MCP_DEV_STATE_DIR must be an absolute path');
  process.exit(2);
}

const maxOutputBytes = Number(process.env.MCP_DEV_MAX_OUTPUT_BYTES ?? '1048576');
if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 16 * 1024 * 1024) {
  console.error('MCP_DEV_MAX_OUTPUT_BYTES must be an integer from 1 to 16777216');
  process.exit(2);
}

const server = new McpServer({ name: 'pi-dev', version: '0.1.0' });
const relativePath = z.string().min(1).describe('Path relative to the configured workspace root');

async function invoke(fn) {
  try {
    return await fn();
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }]
    };
  }
}

server.registerTool('read', {
  description: 'Read source/text below the configured workspace root',
  inputSchema: {
    path: relativePath,
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional()
  }
}, async (args, extra) => invoke(async () => {
  const result = await runRead({ workspaceRoot, ...args }, extra.signal);
  if (result.content.some(block => block.type !== 'text')) {
    throw new Error('dev.read supports text files only');
  }
  return { content: result.content };
}));

server.registerTool('edit', {
  description: 'Apply one or more exact, disjoint replacements below the workspace root',
  inputSchema: {
    path: relativePath,
    edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1)
  }
}, async (args, extra) => invoke(async () => {
  const result = await runEdit({ workspaceRoot, ...args }, extra.signal);
  return { content: [{ type: 'text', text: renderEditText(args.path, result.details?.diff) }] };
}));

server.registerTool('write', {
  description: 'Create a new text file below the workspace root; fails if it already exists',
  inputSchema: { path: relativePath, content: z.string() }
}, async (args, extra) => invoke(async () => {
  await runWrite({ workspaceRoot, ...args }, extra.signal);
  return { content: [{ type: 'text', text: renderWriteText(args.path) }] };
}));

if (mode === 'unrestricted') {
  server.registerTool('bash', {
    description: 'Run one native Bash command string; cwd is optional and workspace-relative',
    inputSchema: {
      command: z.string().min(1),
      cwd: z.string().min(1).optional(),
      timeout_seconds: z.number().positive().max(300).optional()
    }
  }, async (args, extra) => invoke(async () => {
    const result = await runBash({
      workspaceRoot,
      ...args,
      maxOutputBytes,
      stateDir
    }, extra.signal);
    return { content: [{ type: 'text', text: renderBashText(result) }] };
  }));
}

await server.connect(new StdioServerTransport());
