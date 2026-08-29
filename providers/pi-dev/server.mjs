import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { canonicalDefaultCwd, canonicalWorkspaceRoot } from './boundary.mjs';
import { runRead, runEdit, runWrite } from './files.mjs';
import { runFileOps } from './file-ops.mjs';
import { pruneBashSpools, runBash } from './shell.mjs';
import {
  renderBashText,
  renderEditPartial,
  renderEditText,
  renderFileOpsPartial,
  renderFileOpsText,
  renderWriteText,
} from './render.mjs';
import { WaitEngine } from './wait-engine.mjs';
import { LocalWaitSources } from './wait-local.mjs';
import { waitInputSchema } from './wait-schema.mjs';
import { WaitStore } from './wait-state.mjs';
import { TerminalWaitSource } from './wait-terminal.mjs';
import { runWindowsSleep } from './windows-power.mjs';

const OWNER_CONTEXT_MAX_BYTES = 32 * 1024;

async function loadOwnerContext(file) {
  if (!file) return undefined;
  if (!path.isAbsolute(file)) throw new Error('MCP_OWNER_CONTEXT_FILE must be an absolute path');
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error('MCP_OWNER_CONTEXT_FILE must reference a regular file');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('MCP_OWNER_CONTEXT_FILE must be owned by the current user');
  }
  if (stat.size > OWNER_CONTEXT_MAX_BYTES) {
    throw new Error(`MCP_OWNER_CONTEXT_FILE exceeds the ${OWNER_CONTEXT_MAX_BYTES}-byte limit`);
  }
  await fs.access(file, fsConstants.R_OK);
  const text = await fs.readFile(file, 'utf8');
  return text.trim() || undefined;
}

const mode = process.env.MCP_DEV_SHELL_MODE;
if (!['allowlist', 'unrestricted'].includes(mode)) {
  console.error('MCP_DEV_SHELL_MODE must be allowlist or unrestricted');
  process.exit(2);
}

const pathMode = process.env.MCP_DEV_PATH_MODE ?? 'workspace';
if (!['workspace', 'user'].includes(pathMode)) {
  console.error('MCP_DEV_PATH_MODE must be workspace or user');
  process.exit(2);
}

let workspaceRoot = null;
let defaultCwd = null;
try {
  if (pathMode === 'workspace') workspaceRoot = await canonicalWorkspaceRoot(process.env.MCP_DEV_WORKSPACE_ROOT);
  else defaultCwd = await canonicalDefaultCwd(process.env.MCP_DEV_DEFAULT_CWD);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

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

const maxSpoolBytes = Number(process.env.MCP_DEV_MAX_SPOOL_BYTES ?? String(64 * 1024 * 1024));
if (!Number.isInteger(maxSpoolBytes) || maxSpoolBytes <= 0 || maxSpoolBytes > 256 * 1024 * 1024) {
  console.error('MCP_DEV_MAX_SPOOL_BYTES must be a positive integer up to 268435456');
  process.exit(2);
}

const spoolTtlSeconds = Number(process.env.MCP_DEV_SPOOL_TTL_SECONDS ?? String(7 * 24 * 60 * 60));
if (!Number.isInteger(spoolTtlSeconds) || spoolTtlSeconds <= 0 || spoolTtlSeconds > 365 * 24 * 60 * 60) {
  console.error('MCP_DEV_SPOOL_TTL_SECONDS must be a positive integer up to 31536000');
  process.exit(2);
}

const maxSpoolTotalBytes = Number(process.env.MCP_DEV_SPOOL_MAX_TOTAL_BYTES ?? String(512 * 1024 * 1024));
if (!Number.isInteger(maxSpoolTotalBytes) || maxSpoolTotalBytes <= 0 || maxSpoolTotalBytes > 8 * 1024 * 1024 * 1024) {
  console.error('MCP_DEV_SPOOL_MAX_TOTAL_BYTES must be a positive integer up to 8589934592');
  process.exit(2);
}
if (maxSpoolTotalBytes < maxSpoolBytes) {
  console.error('MCP_DEV_SPOOL_MAX_TOTAL_BYTES must be >= MCP_DEV_MAX_SPOOL_BYTES');
  process.exit(2);
}

try {
  const gc = await pruneBashSpools({
    stateDir,
    maxSpoolBytes,
    ttlSeconds: spoolTtlSeconds,
    maxTotalBytes: maxSpoolTotalBytes,
  });
  if (gc.deletedFiles > 0 || gc.deletedActiveFiles > 0 || gc.truncatedFiles > 0) {
    console.error(`Pi Dev Bash spool GC: deleted_files=${gc.deletedFiles} deleted_bytes=${gc.deletedBytes} deleted_active_files=${gc.deletedActiveFiles} deleted_active_bytes=${gc.deletedActiveBytes} truncated_files=${gc.truncatedFiles} truncated_bytes=${gc.truncatedBytes} retained_files=${gc.retainedFiles} retained_bytes=${gc.retainedBytes}`);
  }
} catch (error) {
  console.error(`Pi Dev Bash spool GC warning: ${error instanceof Error ? error.message : String(error)}`);
}

let waitEngine = null;
if (pathMode === 'user') {
  const terminalSocketPath = process.env.MCP_DEV_TERMINAL_SOCKET;
  if (typeof terminalSocketPath !== 'string' || !path.isAbsolute(terminalSocketPath)) {
    console.error('MCP_DEV_TERMINAL_SOCKET must be an absolute path in user mode');
    process.exit(2);
  }
  const { BrokerClient } = await import('../terminal/broker-client.mjs');
  const terminalSource = new TerminalWaitSource({ client: new BrokerClient({ socketPath: terminalSocketPath }) });
  const localSource = new LocalWaitSources({ defaultCwd });
  waitEngine = new WaitEngine({
    store: new WaitStore({ stateDir }),
    sources: {
      terminal_output: terminalSource,
      terminal_exit: terminalSource,
      process_exit: localSource,
      tcp_listen: localSource,
      file_exists: localSource,
      file_changed: localSource,
      http_ready: localSource,
      systemd_user: localSource,
      timer: localSource,
    },
  });
}

let ownerContext;
try {
  ownerContext = await loadOwnerContext(process.env.MCP_OWNER_CONTEXT_FILE);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const server = new McpServer(
  { name: 'pi-dev', version: '0.1.0' },
  ownerContext ? { instructions: ownerContext } : undefined,
);
const modelPath = pathMode === 'user'
  ? z.string().min(1).describe('Path; relative paths resolve from the configured default cwd and absolute paths are accepted')
  : z.string().min(1).describe('Path relative to the configured workspace root');
const cwdPath = pathMode === 'user'
  ? z.string().min(1).describe('Optional cwd; relative paths resolve from the configured default cwd and absolute paths are accepted')
  : z.string().min(1).describe('Optional cwd relative to the configured workspace root');
const pathPolicy = { pathMode, workspaceRoot, defaultCwd };

async function invoke(fn) {
  try {
    return await fn();
  } catch (error) {
    const text = error?.code === 'EDIT_PARTIAL' && error?.editPartial
      ? renderEditPartial(error.editPartial)
      : error?.code === 'FILE_OPS_PARTIAL' && error?.fileOpsPartial
        ? renderFileOpsPartial(error.fileOpsPartial)
        : (error instanceof Error ? error.message : String(error));
    return {
      isError: true,
      content: [{ type: 'text', text }]
    };
  }
}

async function invokeWait(fn) {
  try {
    return await fn();
  } catch (error) {
    const code = typeof error?.code === 'string' ? `${error.code}: ` : '';
    return {
      isError: true,
      content: [{ type: 'text', text: `${code}${error instanceof Error ? error.message : String(error)}` }],
    };
  }
}

function renderWaitResult(result) {
  if (result.status === 'pending') {
    return `pending ${result.name} deadline=${new Date(result.deadlineAtMs).toISOString()} resume_required=true no_model_push=true`;
  }
  if (result.status === 'matched') {
    return `matched ${result.name}${result.evidence === undefined ? '' : ` ${String(result.evidence)}`}`;
  }
  if (result.status === 'timeout') return `timeout ${result.name}`;
  if (result.status === 'cancelled') return `cancelled ${result.name}`;
  return `${result.code ?? 'WAIT_FAILED'}: ${result.name}${result.evidence === undefined ? '' : ` ${String(result.evidence)}`}`;
}

server.registerTool('read', {
  description: pathMode === 'user'
    ? 'Read focused UTF-8/text available to the WSL user; prefer this over Bash cat/sed for ordinary bounded file reads. offset is a 1-based line number, limit is a line count, and large text is bounded/truncated with continuation guidance; this Dev wrapper is text-only. Relative paths use the configured default cwd and absolute paths are accepted'
    : 'Read focused UTF-8/text below the configured workspace root; prefer this over Bash cat/sed for ordinary bounded file reads. offset is a 1-based line number, limit is a line count, and large text is bounded/truncated with continuation guidance; this Dev wrapper is text-only',
  inputSchema: {
    path: modelPath,
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional()
  }
}, async (args, extra) => invoke(async () => {
  const result = await runRead({ ...pathPolicy, ...args }, extra.signal);
  if (result.content.some(block => block.type !== 'text')) {
    throw new Error('dev.read supports text files only');
  }
  return { content: result.content };
}));

server.registerTool('edit', {
  description: pathMode === 'user'
    ? 'Apply guarded, unique, disjoint replacements to one or more existing text files. One exact oldText always wins; only zero exact matches trigger fallback matching for line endings, trailing whitespace, and common Unicode punctuation/space differences. Merge exact and tolerant edits that share a line. Multi-file batches are preflighted together but are not transactional; a later failure may leave earlier targets applied and is reported as partial or uncertain. If oldText is not yet known, locate it with read/rg, Code, or ast-grep and include enough context to remain unique. Use write for creation and file_ops for regular-file move/delete. Relative paths use the configured default cwd and absolute paths are accepted'
    : 'Apply guarded, unique, disjoint replacements to one or more existing text files below the workspace root. One exact oldText always wins; only zero exact matches trigger fallback matching for line endings, trailing whitespace, and common Unicode punctuation/space differences. Merge exact and tolerant edits that share a line. Multi-file batches are preflighted together but are not transactional; a later failure may leave earlier targets applied and is reported as partial or uncertain. If oldText is not yet known, locate it with read/rg and include enough context to remain unique',
  inputSchema: {
    targets: z.array(z.object({
      path: modelPath,
      edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1)
    })).min(1)
  }
}, async (args, extra) => invoke(async () => {
  const result = await runEdit({ ...pathPolicy, ...args }, extra.signal);
  const text = result.targets.length === 1
    ? renderEditText(result.targets[0].path, result.targets[0].diff)
    : result.targets.map(target => `M ${target.path}`).join('\n');
  return { content: [{ type: 'text', text }] };
}));

server.registerTool('write', {
  description: pathMode === 'user'
    ? 'Create-only: create a new WSL-user-accessible text file whose parent directory already exists; fails if the target exists. Use edit for existing text files and file_ops for regular-file move/delete. Relative paths use the configured default cwd and absolute paths are accepted'
    : 'Create-only: create a new text file below the workspace root whose parent directory already exists; fails if the target exists. Use edit for existing text files',
  inputSchema: { path: modelPath, content: z.string() }
}, async (args, extra) => invoke(async () => {
  await runWrite({ ...pathPolicy, ...args }, extra.signal);
  return { content: [{ type: 'text', text: renderWriteText(args.path) }] };
}));

if (pathMode === 'user') {
  server.registerTool('pc_sleep', {
    title: 'Sleep Windows PC',
    description: 'Put the Windows host into sleep after a 10-second grace period. Optionally schedule one Windows Task Scheduler wake time first. This personal-only destructive action requires confirm=true from a direct user request. wake_at must be an ISO 8601 timestamp with Z or an explicit UTC offset and must be at least two minutes in the future. Omitting wake_at clears the previous MCP wake task before sleeping.',
    inputSchema: {
      confirm: z.literal(true).describe('Must be true only after the user directly requests that the PC sleep'),
      wake_at: z.string().min(1).optional().describe('Optional ISO 8601 wake timestamp ending in Z or an explicit UTC offset'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (args, extra) => invoke(async () => {
    const text = await runWindowsSleep({ wakeAt: args.wake_at, signal: extra.signal });
    return { content: [{ type: 'text', text }] };
  }));

  server.registerTool('wait', {
    description: 'Create, resume, or cancel one durable named condition/timer wait; prefer this over Bash polling/sleep loops. A wait persists local condition state only; it does not start, wake, push, or schedule a ChatGPT/model turn. Arm with name+condition and resume later with name only. A pending result leaves the same wait durable and must be explicitly resumed by an active current or successor model turn. timeout_seconds is the durable safety deadline (default 300s, max 24h); hold_seconds only bounds this invocation (default 10s, max 15s). Use timer.after_seconds or timezone-qualified timer.at for elapsed/absolute timer conditions and keep the safety deadline later than the timer target. Event conditions cover Terminal output/exit, process exit, TCP listen, file exists/change, HTTP readiness, and user-systemd state. Terminal-output waits match only output produced after arming and do not consume the Terminal model cursor.',
    inputSchema: waitInputSchema,
  }, async (args, extra) => invokeWait(async () => {
    const result = await waitEngine.run(args, extra.signal);
    if (result.status === 'failed') {
      return {
        isError: true,
        content: [{ type: 'text', text: renderWaitResult(result) }],
      };
    }
    return { content: [{ type: 'text', text: renderWaitResult(result) }] };
  }));

  server.registerTool('file_ops', {
    description: 'Move or delete existing regular files without following final-component symlinks. Batches are preflighted together but are not transactional; a later failure may leave earlier operations applied and is reported as partial or uncertain. Moves are same-filesystem hard-link plus guarded source unlink, never overwrite an existing destination, and do not fall back to copying across filesystems.',
    inputSchema: {
      operations: z.array(z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('move'),
          path: modelPath,
          to: modelPath.describe('Destination path; parent directory must already exist'),
        }),
        z.object({
          kind: z.literal('delete'),
          path: modelPath,
        }),
      ])).min(1),
      cwd: cwdPath.optional(),
    },
  }, async (args, extra) => invoke(async () => {
    const result = await runFileOps({ ...pathPolicy, ...args }, extra.signal);
    return { content: [{ type: 'text', text: renderFileOpsText(result) }] };
  }));
}

if (mode === 'unrestricted') {
  server.registerTool('bash', {
    description: pathMode === 'user'
      ? 'Run one bounded, noninteractive native Bash command as the WSL user; prefer for short commands, Git, builds, tests, rg, repository inspection, and ordinary execution. Default timeout is 30 seconds, maximum 300 seconds, and large output may be truncated with a bounded retained-output path. Use Terminal for processes that must persist or need a PTY/interactive workflow. For a large or unfamiliar repository, Bash with rg plus focused read is the lower-cost discovery path before potentially heavyweight CodeDB-backed Code tools. Do not use raw tmux or wsl-term through Bash to bypass human Terminal ownership. cwd defaults to the configured default cwd and may be relative to it or absolute'
      : 'Run one bounded, noninteractive native Bash command; prefer for short commands, Git, builds, tests, and ordinary execution. Default timeout is 30 seconds, maximum 300 seconds, and large output may be truncated with a bounded retained-output path; cwd is optional and workspace-relative',
    inputSchema: {
      command: z.string().min(1),
      cwd: cwdPath.optional(),
      timeout_seconds: z.number().positive().max(300).optional()
    }
  }, async (args, extra) => invoke(async () => {
    const result = await runBash({
      ...pathPolicy,
      ...args,
      maxOutputBytes,
      maxSpoolBytes,
      spoolTtlSeconds,
      maxSpoolTotalBytes,
      stateDir
    }, extra.signal);
    return { content: [{ type: 'text', text: renderBashText(result) }] };
  }));
}

await server.connect(new StdioServerTransport());
