import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { canonicalDefaultCwd, canonicalWorkspaceRoot } from './boundary.mjs';
import { fileURLToPath } from 'node:url';
import { IdleExecutionWorker, serveExecutionWorker } from './idle-worker.mjs';
import { pruneBashSpools } from './spool-gc.mjs';

const executionWorker = process.argv.includes('--dev-execution-worker');
const { runRead, runEdit, runWrite } = executionWorker ? await import('./files.mjs') : {};
const { runFileOps } = executionWorker ? await import('./file-ops.mjs') : {};
const { runImportFile } = executionWorker ? await import('./import-file.mjs') : {};
const { runReviewChanges } = executionWorker ? await import('./review-changes.mjs') : {};
const { runBash, runExec } = executionWorker ? await import('./shell.mjs') : {};
import {
  renderBashText,
  renderEditPartial,
  renderEditSummary,
  renderEditText,
  renderFileOpsPartial,
  renderFileOpsText,
  renderImportFileText,
  renderReviewChangesText,
  renderWriteText,
} from './render.mjs';
import { WaitEngine } from './wait-engine.mjs';
import { LocalWaitSources } from './wait-local.mjs';
import { waitInputSchema } from './wait-schema.mjs';
import { WaitStore } from './wait-state.mjs';
import { TerminalWaitSource } from './wait-terminal.mjs';

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

const maxOutputBytes = Number(process.env.MCP_DEV_MAX_OUTPUT_BYTES ?? '65536');
if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 16 * 1024 * 1024) {
  console.error('MCP_DEV_MAX_OUTPUT_BYTES must be an integer from 1 to 16777216');
  process.exit(2);
}

const importMaxBytes = Number(process.env.MCP_DEV_IMPORT_MAX_BYTES ?? String(100 * 1024 * 1024));
if (!Number.isInteger(importMaxBytes) || importMaxBytes <= 0 || importMaxBytes > 1024 * 1024 * 1024) {
  console.error('MCP_DEV_IMPORT_MAX_BYTES must be an integer from 1 to 1073741824');
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

// Lines returned by read when the caller gives no limit. Keeps one stray read of a big
// file from flooding the model's context; 0 restores the tool's own larger bound.
const readDefaultLinesValue = process.env.MCP_DEV_READ_DEFAULT_LINES ?? '500';
const readDefaultLinesNumber = Number(readDefaultLinesValue);
if (!/^\d+$/.test(readDefaultLinesValue) || readDefaultLinesNumber > 100000) {
  console.error('MCP_DEV_READ_DEFAULT_LINES must be an integer from 0 to 100000 (0 disables the default)');
  process.exit(2);
}
const readDefaultLines = readDefaultLinesNumber > 0 ? readDefaultLinesNumber : undefined;

try {
  const gc = await pruneBashSpools({
    stateDir,
    maxSpoolBytes,
    ttlSeconds: spoolTtlSeconds,
    maxTotalBytes: maxSpoolTotalBytes,
  });
  if (gc.deletedFiles > 0 || gc.deletedActiveFiles > 0 || gc.truncatedFiles > 0) {
    console.error(`Pi Dev command spool GC: deleted_files=${gc.deletedFiles} deleted_bytes=${gc.deletedBytes} deleted_active_files=${gc.deletedActiveFiles} deleted_active_bytes=${gc.deletedActiveBytes} truncated_files=${gc.truncatedFiles} truncated_bytes=${gc.truncatedBytes} retained_files=${gc.retainedFiles} retained_bytes=${gc.retainedBytes}`);
  }
} catch (error) {
  console.error(`Pi Dev command spool GC warning: ${error instanceof Error ? error.message : String(error)}`);
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
const idleValue = process.env.MCP_DEV_WORKER_IDLE_MS ?? '600000';
const idleMs = Number(idleValue);
if (!/^\d+$/.test(idleValue) || !Number.isSafeInteger(idleMs) || idleMs < 0 || idleMs > 2147483647) {
  console.error('MCP_DEV_WORKER_IDLE_MS must be an integer from 0 to 2147483647');
  process.exit(2);
}
const worker = executionWorker ? null : new IdleExecutionWorker({
  serverPath: fileURLToPath(import.meta.url), idleMs,
});
const executionHandlers = new Map();
const shutdownController = new AbortController();
function registerTool(name, config, handler) {
  if (executionWorker) executionHandlers.set(name, handler);
  else server.registerTool(name, config, name === 'wait'
    ? (args, extra) => handler(args, { ...extra, signal: AbortSignal.any([extra.signal, shutdownController.signal]) })
    : (args, extra) => worker.call(name, args, extra.signal));
}
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
    return `pending ${result.name} deadline=${new Date(result.deadlineAtMs).toISOString()} resume_required=true no_model_push=true poll_again_with=name-only wait`;
  }
  if (result.status === 'matched') {
    return `matched ${result.name}${result.evidence === undefined ? '' : ` ${String(result.evidence)}`}`;
  }
  if (result.status === 'timeout') return `timeout ${result.name}`;
  if (result.status === 'cancelled') return `cancelled ${result.name}`;
  return `${result.code ?? 'WAIT_FAILED'}: ${result.name}${result.evidence === undefined ? '' : ` ${String(result.evidence)}`}`;
}

registerTool('read', {
  description: 'Read UTF-8 text in pages of at most 16 KiB. offset is a 1-based line; limit is a line count. Truncated results give the next offset.' + (readDefaultLines ? ` Without limit, at most ${readDefaultLines} lines.` : ''),
  inputSchema: {
    path: modelPath,
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional()
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
}, async (args, extra) => invoke(async () => {
  const result = await runRead({
    ...pathPolicy,
    path: args.path,
    offset: args.offset,
    limit: args.limit ?? readDefaultLines
  }, extra.signal);
  if (result.content.some(block => block.type !== 'text')) {
    throw new Error('dev.read supports text files only');
  }
  return { content: result.content };
}));

registerTool('edit', {
  description: 'Apply unique, disjoint oldText replacements in existing files. Exact oldText always wins; fallback tolerates line endings, trailing whitespace and common Unicode punctuation/spaces. Merge edits sharing a line. Multi-file batches may partially apply; failures report affected paths. Returns +/- counts; diff=true returns diffs.',
  inputSchema: {
    targets: z.array(z.object({
      path: modelPath,
      edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1)
    })).min(1),
    diff: z.boolean().optional().describe('Return unified diffs instead of per-file +/- counts')
  }
}, async (args, extra) => invoke(async () => {
  const result = await runEdit({ ...pathPolicy, targets: args.targets }, extra.signal);
  const text = args.diff
    ? result.targets.map(target => renderEditText(target.path, target.diff)).join('\n\n')
    : result.targets.map(target => renderEditSummary(target.path, target.diff)).join('\n');
  return { content: [{ type: 'text', text }] };
}));

registerTool('write', {
  description: 'Create-only UTF-8 write; parent must exist. overwrite=true atomically replaces an existing regular file. Symlinks and directories are refused.',
  inputSchema: {
    path: modelPath,
    content: z.string(),
    overwrite: z.boolean().optional().describe('Atomically replace an existing regular file')
  }
}, async (args, extra) => invoke(async () => {
  const result = await runWrite({ ...pathPolicy, ...args }, extra.signal);
  return { content: [{ type: 'text', text: renderWriteText(args.path, { replaced: result?.replaced === true }) }] };
}));

if (pathMode === 'user') {
  registerTool('import_file', {
    description: 'Import one ChatGPT-native attached or generated file into the WSL filesystem. This is create-only: the destination parent must already exist and an existing destination is never overwritten. Use this for binary or external file ingress instead of base64, shell downloads, or invented host paths. The source must be a native ChatGPT file value from a trusted OpenAI file host. Relative destinations resolve from the configured default cwd; absolute paths are accepted.',
    inputSchema: {
      file: z.object({
        download_url: z.string(),
        file_id: z.string().min(1),
        mime_type: z.string().nullable().optional(),
        file_name: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        size: z.number().int().nonnegative().nullable().optional(),
      }).describe('Native file value supplied by ChatGPT'),
      path: modelPath.describe('Create-only destination path; parent directory must already exist'),
    },
    _meta: { 'openai/fileParams': ['file'] },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async (args, extra) => invoke(async () => {
    const result = await runImportFile({ defaultCwd, ...args, maxBytes: importMaxBytes }, extra.signal);
    return {
      content: [{ type: 'text', text: renderImportFileText(result) }],
      structuredContent: result,
    };
  }));

  registerTool('review_changes', {
    description: 'Return one bounded aggregate review of the current Git working-tree changes: status, tracked line counts, and a unified patch including untracked file contents when they fit the shared patch budget. Use this once after the final related file mutation instead of repeatedly calling Git status/diff. cwd selects the repository; optional paths narrow review to literal files or directories and are useful when unrelated dirty work is present. This tool is read-only and creates no Git refs, commits, or temporary index state.',
    inputSchema: {
      cwd: cwdPath.optional(),
      paths: z.array(z.string().min(1)).min(1).max(256).optional().describe('Optional literal paths relative to cwd, or absolute paths inside the selected repository'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (args, extra) => invoke(async () => {
    const result = await runReviewChanges({ defaultCwd, ...args }, extra.signal);
    return {
      content: [{ type: 'text', text: renderReviewChangesText(result) }],
      structuredContent: result,
    };
  }));

  registerTool('wait', {
    description: 'Create, resume, or cancel one durable named condition/timer wait. Prefer this over polling or sleep loops. Arm with name+condition and resume later with name only. A pending wait stays durable and must be resumed by a later active model turn; it does not start one. A matched wait reports its evidence in the same call, including an already-satisfied condition at arm time. For long-running commands, start the process through Local server="terminal" with terminal_open, then use terminal_exit or terminal_output waits across short RPCs and inspect final output with terminal_read. timeout_seconds is the durable deadline (default 300s, max 24h); hold_seconds bounds only this invocation (default 10s, max 45s). Supports timer, Terminal output/exit, process exit, TCP listen, file exists/change, HTTP readiness, and user-systemd conditions. Terminal-output waits observe only output produced after arming and do not consume the Terminal model cursor.',
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

  registerTool('file_ops', {
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
  registerTool('exec', {
    description: 'Run structured argv with no shell parsing; arguments are passed literally. Prefer for ordinary commands. Use only when runtime is known and comfortably below 45s. For uncertain, longer or persistent work use Local terminal_open, Dev wait, then terminal_read. Output is bounded; truncated output has a retained-file path.',
  inputSchema: {
      argv: z.array(z.string()).min(1).max(256).describe('Executable name/path followed by literal arguments. Do not add shell quoting around individual elements.'),
      cwd: cwdPath.optional(),
      timeout_seconds: z.number().positive().max(300).optional().describe('Execution deadline: default 30s, max 300s; does not extend the connector window.')
    }
  }, async (args, extra) => invoke(async () => {
    const result = await runExec({
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

  registerTool('bash', {
    description: 'Run a noninteractive Bash program for pipes, redirects or other shell syntax; otherwise prefer exec. Use only when runtime is known and comfortably below 45s. For uncertain, longer or persistent work use Local terminal_open, Dev wait, then terminal_read. Output is bounded; never bypass Terminal human ownership.',
  inputSchema: {
      command: z.string().min(1),
      cwd: cwdPath.optional(),
      timeout_seconds: z.number().positive().max(300).optional().describe('Execution deadline: default 30s, max 300s; does not extend the connector window.')
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

if (executionWorker) {
  serveExecutionWorker(executionHandlers);
} else {
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    shutdownController.abort();
    await worker.close();
    await server.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown();
  await server.connect(transport);
  // SDK owns transport.onclose; EOF must independently close the execution child.
  process.stdin.once('end', () => void shutdown());
}
