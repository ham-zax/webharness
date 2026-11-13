import { constants as fsConstants } from 'node:fs';
import { CALL_ID_META, traceCall, markMutation, diagnosticErrorCode } from './call-diagnostics.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { createStdioErrorReporter } from './stdio-diagnostics.mjs';
import { z } from 'zod';
import { canonicalDefaultCwd, canonicalWorkspaceRoot } from './boundary.mjs';
import { fileURLToPath } from 'node:url';
import { IdleExecutionWorker, serveExecutionWorker } from './idle-worker.mjs';
import { pruneBashSpools } from './spool-gc.mjs';
import { DEFAULT_LIST_LIMIT, MAX_LIST_DEPTH, MAX_LIST_LIMIT, runListDirectory } from './list-directory.mjs';
import { DEFAULT_MAX_OUTPUT_BYTES } from './output-limits.mjs';
import {
  DEFAULT_SEARCH_MAX_PER_FILE,
  DEFAULT_SEARCH_MAX_RESULTS,
  MAX_SEARCH_MAX_PER_FILE,
  MAX_SEARCH_MAX_RESULTS,
  runSearch,
} from './search.mjs';

const executionWorker = process.argv.includes('--dev-execution-worker');
const { runRead, runEdit, runWrite } = executionWorker ? await import('./files.mjs') : {};
const { runFileOps } = executionWorker ? await import('./file-ops.mjs') : {};
const { runImportFile } = executionWorker ? await import('./import-file.mjs') : {};
const { runReviewChanges } = executionWorker ? await import('./review-changes.mjs') : {};
const { runBash, runExec } = executionWorker ? await import('./shell.mjs') : {};
const { runScript, scriptErrorCode } = executionWorker ? await import('./run-script.mjs') : {};
import {
  renderBashText,
  renderDetachedText,
  renderEditPartial,
  renderEditSummary,
  renderEditText,
  renderFileOpsPartial,
  renderFileOpsText,
  renderImportFileText,
  renderListDirectoryText,
  renderReviewChangesText,
  renderSearchText,
  renderWriteText,
} from './render.mjs';
import {
  DEFAULT_SCRIPT_MAX_CALLS,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  MAX_SCRIPT_MAX_CALLS,
  MAX_SCRIPT_TIMEOUT_MS,
  SCRIPT_EXCLUDED_TOOLS,
} from './script-limits.mjs';
import { WaitEngine } from './wait-engine.mjs';
import { LocalWaitSources } from './wait-local.mjs';
import { waitInputSchema } from './wait-schema.mjs';
import { WaitStore } from './wait-state.mjs';
import { TerminalWaitSource } from './wait-terminal.mjs';

const OWNER_CONTEXT_MAX_BYTES = 32 * 1024;

// Routing rules that must reach every client, independent of any owner context file.
const FILE_ACCESS_INSTRUCTIONS = [
  'Dev file access policy:',
  '- Search text with search, discover names with list_directory, and read known files with read (mode="outline" first for unfamiliar large files) instead of exec or bash.',
  '- If exec or bash fails, do not conclude that filesystem access is unavailable. Retry with read or list_directory.',
  '- Messages start with a code. ENOENT: correct or discover the path. ENOTDIR or EISDIR: call list_directory. EACCES: report the restriction.',
  '- A folder the user names may differ from the directory name. List the parent, then use the exact name.',
  '- Read only, unless the user asks for a change.',
].join('\n');

// Token-cost rules for every client: each tool result stays in context and is re-billed on every later turn.
const EXECUTION_EFFICIENCY_INSTRUCTIONS = [
  'Execution efficiency (each result stays in context and is re-billed on every later turn):',
  '- Batch inspection: read several known files in one read call with targets (up to 20) and locate code with search first; avoid one call per file or per Git check.',
  '- Code mode: when a task needs several dependent Dev steps (search, then read the hits, then edit, then verify), send one run_script instead of one call per step; intermediate results stay out of context.',
  '- Quiet output: send builds and test runs to a /tmp log and print only the exit status plus the tail or failing lines (normally 25 lines or fewer); never dump schemas, full diffs, or passing-test output. Call review_changes once after the final related edit instead of repeating Git status or diff.',
  '- Localized bugs: when the report names a file, line, and reproduction, read that scope and verify with a targeted test before widening the investigation. Do not skip validation.',
  '- Deployment: after changing a running service, decide whether it needs a restart or reload, then confirm with a harmless readiness check before claiming it is live.',
  '- Long sessions: around 80k-100k tokens of context, write a short non-secret handoff (state, decisions, remaining work, last commits) and continue in a fresh session when practical.',
].join('\n');

function serverInstructions(ownerContext) {
  const builtIn = `${FILE_ACCESS_INSTRUCTIONS}\n\n${EXECUTION_EFFICIENCY_INSTRUCTIONS}`;
  return ownerContext ? `${builtIn}\n\n${ownerContext}` : builtIn;
}

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

const maxOutputBytes = Number(process.env.MCP_DEV_MAX_OUTPUT_BYTES ?? String(DEFAULT_MAX_OUTPUT_BYTES));
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
const readDefaultLinesValue = process.env.MCP_DEV_READ_DEFAULT_LINES ?? '160';
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
const executionToolConfigs = new Map();
const toolRegistrations = [];
const shutdownController = new AbortController();
const READ_ONLY_TOOLS = new Set(['read', 'list_directory', 'search', 'review_changes', 'wait']);
function registerTool(name, config, handler) {
  const mutating = !READ_ONLY_TOOLS.has(name);
  if (executionWorker) {
    executionToolConfigs.set(name, config);
    executionHandlers.set(name, (args, extra) => traceCall({
      id: extra.callId, layer: 'dev-worker', tool: name, mutating,
    }, () => {
      if (mutating && name !== 'write') markMutation('unknown');
      return handler(args, extra);
    }));
  } else {
    toolRegistrations.push([name, config, (args, ctx) => traceCall({
      id: ctx.mcpReq._meta?.[CALL_ID_META], layer: 'dev', tool: name, mutating,
    }, context => {
      if (name === 'wait') return handler(args, { signal: AbortSignal.any([ctx.mcpReq.signal, shutdownController.signal]) });
      if (mutating) markMutation('unknown');
      return worker.call(name, args, ctx.mcpReq.signal, context.id);
    })]);
  }
}
function createPiDevServer() {
  const server = new McpServer(
    { name: 'pi-dev', version: '0.1.0' },
    { instructions: serverInstructions(ownerContext) },
  );
  for (const [name, config, handler] of toolRegistrations) {
    server.registerTool(name, config, handler);
  }
  return server;
}
const modelPath = pathMode === 'user'
  ? z.string().min(1).describe('Path; relative paths resolve from the configured default cwd and absolute paths are accepted')
  : z.string().min(1).describe('Path relative to the configured workspace root');
const cwdPath = pathMode === 'user'
  ? z.string().min(1).describe('Optional cwd; relative paths resolve from the configured default cwd and absolute paths are accepted')
  : z.string().min(1).describe('Optional cwd relative to the configured workspace root');
const pathPolicy = { pathMode, workspaceRoot, defaultCwd };
const listPath = pathMode === 'user'
  ? z.string().min(1).describe('Directory to list; relative paths resolve from the configured default cwd and absolute paths are accepted')
  : z.string().min(1).describe('Directory to list, relative to the configured workspace root');

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
      content: [{ type: 'text', text }],
      _meta: { 'webharness/error-code': diagnosticErrorCode(error?.code) }
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
  description: 'Read UTF-8 text in pages of at most 16 KiB. offset is a 1-based line; limit is a line count. Truncated results give the next offset. mode "outline" returns compact structural landmarks (L<line>: <symbol>) instead of full lines; targets reads up to 20 files in one call. A directory path is refused with EISDIR; use list_directory instead.' + (readDefaultLines ? ` Without limit, at most ${readDefaultLines} lines.` : ''),
  inputSchema: z.object({
    path: modelPath.optional(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
    mode: z.enum(['lines', 'outline']).optional().describe('lines (default) returns file text; outline returns structural landmarks only'),
    targets: z.array(z.object({
      path: modelPath,
      offset: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
      mode: z.enum(['lines', 'outline']).optional(),
    })).min(1).max(20).optional().describe('Read several files in one call; give either path or targets, not both')
  }),
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
    limit: args.limit,
    defaultLines: readDefaultLines,
    mode: args.mode,
    targets: args.targets
  }, extra.signal);
  if (result.content.some(block => block.type !== 'text')) {
    throw new Error('dev.read supports text files only');
  }
  return { content: result.content };
}));

registerTool('list_directory', {
  description: `List one directory (or bounded tree when depth=2..${MAX_LIST_DEPTH}) as entries: kind (dir, file, link, other) and name, plus bytes for regular files. Sorted by name. Symlinks are listed and never followed; depth>1 skips .git, node_modules, third_party, and skill-library/packs unless include_vendor=true. Use this to map a folder or resolve names before reading, instead of exec or bash. Omit path to list the authority root. limit defaults to ${DEFAULT_LIST_LIMIT} entries, maximum ${MAX_LIST_LIMIT}.`,
  inputSchema: z.object({
    path: listPath.optional(),
    limit: z.number().int().positive().max(MAX_LIST_LIMIT).optional().describe(`Maximum entries to return; default ${DEFAULT_LIST_LIMIT}`),
    depth: z.number().int().min(1).max(MAX_LIST_DEPTH).optional().describe(`Directory tree depth from 1 to ${MAX_LIST_DEPTH}; default 1`),
    include_vendor: z.boolean().optional().describe('Expand .git/vendor subdirectories when depth > 1')
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
}, async (args, extra) => invoke(async () => {
  const result = await runListDirectory({
    ...pathPolicy,
    path: args.path,
    limit: args.limit,
    depth: args.depth,
    include_vendor: args.include_vendor,
  }, extra.signal);
  return { content: [{ type: 'text', text: renderListDirectoryText(result) }] };
}));

registerTool('search', {
  description: `Search text across files with ripgrep and return compact path:line:match results without shell quoting. Excludes vendored trees (skill-library/packs, third_party, node_modules, .git) unless include_vendor=true. Defaults to smart-case, ${DEFAULT_SEARCH_MAX_RESULTS} total matches (max ${MAX_SEARCH_MAX_RESULTS}), and ${DEFAULT_SEARCH_MAX_PER_FILE} matches per file (max ${MAX_SEARCH_MAX_PER_FILE}).`,
  inputSchema: z.object({
    pattern: z.string().min(1).max(4096).describe('Regex pattern (or exact string when literal=true)'),
    path: listPath.optional().describe('Optional directory or file to search; omit to search the authority root'),
    globs: z.array(z.string().min(1).max(256)).max(32).optional().describe('Optional ripgrep file globs, e.g. ["*.mjs", "!test/**"]'),
    literal: z.boolean().optional().describe('Match pattern literally (-F) instead of as a regex'),
    case_sensitive: z.boolean().optional().describe('Force case-sensitive (true) or case-insensitive (false); omit for smart-case'),
    max_results: z.number().int().positive().max(MAX_SEARCH_MAX_RESULTS).optional().describe(`Maximum matches to return; default ${DEFAULT_SEARCH_MAX_RESULTS}`),
    max_per_file: z.number().int().positive().max(MAX_SEARCH_MAX_PER_FILE).optional().describe(`Maximum matches per file; default ${DEFAULT_SEARCH_MAX_PER_FILE}`),
    include_vendor: z.boolean().optional().describe('Include vendored directories (skill-library/packs, third_party, node_modules)'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
}, async (args, extra) => invoke(async () => {
  const result = await runSearch({
    ...pathPolicy,
    ...args,
  }, extra.signal);
  return { content: [{ type: 'text', text: renderSearchText(result) }] };
}));

registerTool('edit', {
  description: 'Apply unique, disjoint oldText replacements in existing files. Exact oldText always wins; fallback tolerates line endings, trailing whitespace and common Unicode punctuation/spaces. Merge edits sharing a line. Multi-file batches may partially apply; failures report affected paths. Returns +/- counts; diff=true returns diffs.',
  inputSchema: z.object({
    targets: z.array(z.object({
      path: modelPath,
      edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1)
    })).min(1),
    diff: z.boolean().optional().describe('Return unified diffs instead of per-file +/- counts')
  })
}, async (args, extra) => invoke(async () => {
  const result = await runEdit({ ...pathPolicy, targets: args.targets }, extra.signal);
  const text = args.diff
    ? result.targets.map(target => renderEditText(target.path, target.diff)).join('\n\n')
    : result.targets.map(target => renderEditSummary(target.path, target.diff)).join('\n');
  return { content: [{ type: 'text', text }] };
}));

registerTool('write', {
  description: 'Create-only write; parent must exist unless mkdir_parents=true. overwrite=true atomically replaces an existing regular file. Symlinks and directories are refused. encoding=base64 writes binary content; for many files, write one base64 tar archive and extract it with exec. Content passes through model context, so keep it to small files.',
  inputSchema: z.object({
    path: modelPath,
    content: z.string(),
    overwrite: z.boolean().optional().describe('Atomically replace an existing regular file'),
    encoding: z.enum(['utf8', 'base64']).optional().describe('Content encoding: utf8 (default) or base64 for binary'),
    mode: z.string().regex(/^0?[0-7]{3}$/).optional().describe('Octal permissions such as "755"; default keeps the replaced file mode or uses the umask'),
    mkdir_parents: z.boolean().optional().describe('Create missing parent directories'),
    expected_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('Expected decoded content size in bytes; checked before mutation'),
    expected_sha256: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/i).optional().describe('Expected decoded content SHA-256; optional sha256: prefix')
  })
}, async (args, extra) => invoke(async () => {
  const result = await runWrite({ ...pathPolicy, ...args }, extra.signal);
  return { content: [{ type: 'text', text: renderWriteText(args.path, result) }], structuredContent: result };
}));

if (pathMode === 'user') {
  registerTool('import_file', {
    description: 'Import one ChatGPT-native attached or generated file into the WSL filesystem. This is create-only: the destination parent must already exist and an existing destination is never overwritten. Use this for binary or external file ingress instead of base64, shell downloads, or invented host paths. The source must be a native ChatGPT file value from a trusted OpenAI file host. Relative destinations resolve from the configured default cwd; absolute paths are accepted.',
    inputSchema: z.object({
      file: z.object({
        download_url: z.string(),
        file_id: z.string().min(1),
        mime_type: z.string().nullable().optional(),
        file_name: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        size: z.number().int().nonnegative().nullable().optional(),
      }).describe('Native file value supplied by ChatGPT'),
      path: modelPath.describe('Create-only destination path; parent directory must already exist'),
    }),
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
    inputSchema: z.object({
      cwd: cwdPath.optional(),
      paths: z.array(z.string().min(1)).min(1).max(256).optional().describe('Optional literal paths relative to cwd, or absolute paths inside the selected repository'),
    }),
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
    inputSchema: z.object({
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
    }),
  }, async (args, extra) => invoke(async () => {
    const result = await runFileOps({ ...pathPolicy, ...args }, extra.signal);
    return { content: [{ type: 'text', text: renderFileOpsText(result) }] };
  }));
}

if (mode === 'unrestricted') {
  registerTool('exec', {
    description: 'Run structured argv with no shell parsing; arguments are passed literally. Prefer for ordinary commands. Use only when runtime is known and comfortably below 45s. For longer noninteractive work (installs, builds) pass detach=true: it returns at once with a log path and an exit file to wait on with Dev wait file_exists, then read the log. For interactive or human-watched work use Local terminal_open, Dev wait, then terminal_read. Output is bounded; truncated output has a retained-file path.',
  inputSchema: z.object({
      argv: z.array(z.string()).min(1).max(256).describe('Executable name/path followed by literal arguments. Do not add shell quoting around individual elements.'),
      cwd: cwdPath.optional(),
      timeout_seconds: z.number().positive().max(300, {
        message: 'timeout_seconds must be from 1 to 300. A larger deadline is rejected because it cannot extend the connector window: start long work with Local terminal_open, observe it with Dev wait, then read output with terminal_read.'
      }).optional().describe('Execution deadline: default 30s, max 300s; does not extend the connector window. Not allowed with detach.'),
      detach: z.boolean().optional().describe('Start in the background with stdin closed and output to a log; returns job_id, pid, log_path and exit_path. Survives the call but not a WebHarness service restart.')
    })
  }, async (args, extra) => invoke(async () => {
    if (args.detach) {
      const result = await runExec({ ...pathPolicy, ...args, spoolTtlSeconds, stateDir }, extra.signal);
      return { content: [{ type: 'text', text: renderDetachedText(result) }], structuredContent: result };
    }
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
  inputSchema: z.object({
      command: z.string().min(1),
      cwd: cwdPath.optional(),
      timeout_seconds: z.number().positive().max(300, {
        message: 'timeout_seconds must be from 1 to 300. A larger deadline is rejected because it cannot extend the connector window: start long work with Local terminal_open, observe it with Dev wait, then read output with terminal_read.'
      }).optional().describe('Execution deadline: default 30s, max 300s; does not extend the connector window.')
    })
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

const scriptToolNames = toolRegistrations
  .map(([name]) => name)
  .filter(name => !SCRIPT_EXCLUDED_TOOLS.has(name));

registerTool('run_script', {
  description: `Run one JavaScript program that calls Dev tools directly, so loops, filters and conditional edit/test cycles stay inside one call instead of one model round trip per step. The script runs as an async function body: top-level await and return work. Call tools.<name>({...}) with exactly the arguments of the same-named Dev tool (${scriptToolNames.join(', ')}). text(value) adds output; the returned value is reported too. Nested calls are real and are not rolled back if the script later fails. The script has no filesystem, network, timers, imports or process access; its only capability is the listed tools. store() and load() do not persist across calls. timeout_ms does not extend the connector window.`,
  inputSchema: z.object({
    script: z.string().min(1).max(65536).describe('Raw JavaScript as a JSON string, no code fence. Runs as an async function body.'),
    timeout_ms: z.number().int().min(1000).max(MAX_SCRIPT_TIMEOUT_MS).optional().describe(`Overall deadline including nested calls; default ${DEFAULT_SCRIPT_TIMEOUT_MS / 1000}s, max ${MAX_SCRIPT_TIMEOUT_MS / 1000}s`),
    max_calls: z.number().int().min(1).max(MAX_SCRIPT_MAX_CALLS).optional().describe(`Maximum nested tool calls; default ${DEFAULT_SCRIPT_MAX_CALLS}`),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async (args, extra) => invoke(async () => {
  const result = await runScript({
    ...args,
    maxOutputBytes,
    handlers: executionHandlers,
    configs: executionToolConfigs,
    signal: extra.signal,
    callId: extra.callId,
    stateDir,
    spoolTtlSeconds,
    maxSpoolBytes,
    maxSpoolTotalBytes,
  });
  return {
    isError: result.status === 'failed',
    content: [{ type: 'text', text: result.text }],
    ...(result.status === 'failed'
      ? { _meta: { 'webharness/error-code': scriptErrorCode(result.error_kind) } }
      : {}),
  };
}));

if (executionWorker) {
  serveExecutionWorker(executionHandlers);
} else {
  const transport = new StdioServerTransport();
  const handle = serveStdio(createPiDevServer, {
    transport,
    onerror: createStdioErrorReporter('pi-dev'),
  });
  let closing = null;
  const shutdown = () => {
    if (closing) return closing;
    closing = (async () => {
      shutdownController.abort();
      await worker.close();
      await handle.close();
    })();
    return closing;
  };
  let exitStarted = false;
  const shutdownAndExit = () => {
    if (exitStarted) return;
    exitStarted = true;
    void shutdown().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdownAndExit);
  process.once('SIGINT', shutdownAndExit);
  const wireClose = transport.onclose;
  transport.onclose = () => {
    wireClose?.();
    void shutdown();
  };
  // SDK owns transport.onclose; EOF must independently close the execution child.
  process.stdin.once('end', () => void shutdown());
}
