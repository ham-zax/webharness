// Shared read-only route classification used by providers/local-tools
// (mutation-state tracking), providers/websession-adapter (concurrency lanes),
// and lib/bridge/connector-policy.mjs (tool/arg hints).

export const DEV_KNOWN_TOOLS = new Set([
  'read', 'list_directory', 'search', 'edit', 'write', 'import_file',
  'review_changes', 'wait', 'file_ops', 'exec', 'bash', 'run_script',
]);

export const DEV_ROUTE_ARG_HINTS = Object.freeze({
  exec: 'Hint: dev/exec takes { argv: string[], cwd?, timeout_seconds?, detach? } with no shell parsing; use dev/bash { command, cwd?, timeout_seconds?, detach? } for pipes, redirects, or shell syntax.',
  bash: 'Hint: dev/bash takes { command: string, cwd?, timeout_seconds?, detach? }.',
  read: 'Hint: dev/read takes { path, offset?, limit?, mode?: "lines"|"outline" } or { targets: [{ path, offset?, limit?, mode? }] }.',
  list_directory: 'Hint: dev/list_directory takes { path?, depth?: 1-4, limit?, include_vendor? }.',
  search: 'Hint: dev/search takes { pattern: string, path?, globs?, literal?, case_sensitive?, max_results?, max_per_file? }.',
  edit: 'Hint: dev/edit takes { targets: [{ path, edits: [{ oldText, newText }] }], diff? }.',
  write: 'Hint: dev/write takes { path, content, overwrite?, mkdir_parents?, encoding?, mode? }.',
  file_ops: 'Hint: dev/file_ops takes { operations: [{ kind: "move"|"delete", path, to? }], cwd? }.',
  review_changes: 'Hint: dev/review_changes takes { cwd?, paths?, rev? }.',
  run_script: 'Hint: dev/run_script takes { script: string, cwd?, max_calls?, timeout_ms? }.',
  wait: 'Hint: dev/wait takes { name: string, condition?, cancel?, hold_seconds?, timeout_seconds? }.',
});

export const KNOWN_READ_ONLY_ROUTES = new Map([
  ['dev', new Set(['read', 'list_directory', 'search', 'review_changes'])],
  ['terminal', new Set(['terminal_list'])],
  ['browser-fast', new Set(['observe'])],
  ['browser-daily', new Set(['status'])],
  ['skill-library', new Set(['find_skills', 'read_skill'])],
  ['codebase-memory-mcp', new Set([
    'search_graph', 'query_graph', 'trace_path', 'get_code_snippet', 'get_file_outline',
    'get_graph_schema', 'compare_graphs', 'get_architecture', 'search_code',
    'list_projects', 'index_status', 'check_index_coverage', 'detect_changes',
  ])],
]);

export function normalizeRouteTool(server, tool) {
  if (server === 'dev' && typeof tool === 'string' && tool.startsWith('dev_')) {
    const stripped = tool.slice(4);
    if (DEV_KNOWN_TOOLS.has(stripped)) return stripped;
  }
  return tool;
}

export function isArgumentSensitiveReadOnlyRoute(server, tool) {
  if (typeof server !== 'string' || typeof tool !== 'string') return false;
  const normalized = normalizeRouteTool(server, tool);
  return (server === 'browser-daily' && normalized === 'tabs')
    || (server === 'terminal' && normalized === 'terminal_read');
}

export const DEV_COMMAND_FAILURE_FOOTER = /^\[(?:exit (?!0(?:\]| · ))-?\d+|timed out after [0-9.]+s|cancelled|terminated)(?: · [0-9.]+s)?\]$/;
export const DEV_COMMAND_PROMOTED_FOOTER = /^\[still running after [0-9.]+s · promoted to job [^\]]+\]$/;
export const COMMAND_OUTCOME_META = 'webharness/command-outcome';

function commandOutcomeFromMeta(textOrResult) {
  if (!textOrResult || typeof textOrResult !== 'object') return undefined;
  const outcome = textOrResult._meta?.[COMMAND_OUTCOME_META];
  return outcome === 'promoted' || outcome === 'succeeded' || outcome === 'failed'
    ? outcome
    : undefined;
}

export const ROUTED_LOCAL_TOOLS = new Set([
  'local_fallback_dispatch',
  'local_tool_call',
  'local_tool_batch',
]);

function extractCommandResultBody(textOrResult) {
  let body = '';
  if (typeof textOrResult === 'string') {
    body = textOrResult;
    if (body.startsWith('{')) {
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed?.content)) {
          const joined = parsed.content
            .filter(block => block?.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join('\n');
          if (joined) body = joined;
        }
      } catch {
        // Plain command output that happens to start with '{'.
      }
    }
  } else if (textOrResult && typeof textOrResult === 'object' && Array.isArray(textOrResult.content)) {
    body = textOrResult.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n');
  }
  return body;
}

export function isPromotedDevCommandResult(textOrResult) {
  const metaOutcome = commandOutcomeFromMeta(textOrResult);
  if (metaOutcome !== undefined) return metaOutcome === 'promoted';
  const body = extractCommandResultBody(textOrResult);
  if (!body) return false;
  const clean = body.replace(/\r?\n$/, '');
  const lines = clean.split(/\r?\n/);
  if (lines.length < 4) return false;
  return DEV_COMMAND_PROMOTED_FOOTER.test(lines[lines.length - 4])
    && lines[lines.length - 3].startsWith('log: ')
    && lines[lines.length - 2].startsWith('exit: ')
    && lines[lines.length - 1].startsWith('Next: wait ');
}

// Accepts either raw command text (including JSON-wrapped MCP CallToolResult text)
// or a structured CallToolResult { content: [...] } object.
export function hasUnsuccessfulDevCommandFooter(textOrResult) {
  const metaOutcome = commandOutcomeFromMeta(textOrResult);
  if (metaOutcome !== undefined) return metaOutcome === 'failed';
  if (isPromotedDevCommandResult(textOrResult)) return false;
  const body = extractCommandResultBody(textOrResult);
  if (!body) return false;
  const withoutLf = body.endsWith('\n') ? body.slice(0, -1) : body;
  const clean = withoutLf.endsWith('\r') ? withoutLf.slice(0, -1) : withoutLf;
  const lastLine = clean.slice(clean.lastIndexOf('\n') + 1);
  return DEV_COMMAND_FAILURE_FOOTER.test(lastLine);
}

export function unwrapLocalRoute(tool, rawArguments) {
  if (!ROUTED_LOCAL_TOOLS.has(tool)) return null;
  if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) return null;
  const server = typeof rawArguments.server === 'string' && rawArguments.server ? rawArguments.server : undefined;
  const toolName = typeof rawArguments.tool === 'string' && rawArguments.tool ? rawArguments.tool : undefined;
  const args = rawArguments.arguments;
  const calls = Array.isArray(rawArguments.calls) ? rawArguments.calls : undefined;
  const allowHeterogeneous = tool === 'local_fallback_dispatch';
  if (!(allowHeterogeneous && calls !== undefined) && (!server || !toolName)) return null;
  return {
    server,
    tool: toolName,
    arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : undefined,
    hadArguments: args !== undefined,
    calls,
    allowHeterogeneous,
  };
}

export function resolveBatchEntryRoute(route, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const server = (route.allowHeterogeneous && typeof entry.server === 'string' && entry.server)
    ? entry.server
    : route.server;
  const tool = (route.allowHeterogeneous && typeof entry.tool === 'string' && entry.tool)
    ? entry.tool
    : route.tool;
  if (!server || !tool) return null;
  const rawArgs = entry.arguments;
  return {
    server,
    tool,
    arguments: rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : undefined,
    hadArguments: rawArgs !== undefined,
  };
}

export function isKnownReadOnlyRoute(server, tool, args, { hadArguments = args !== undefined } = {}) {
  if (typeof server !== 'string' || typeof tool !== 'string') return false;
  const normalized = normalizeRouteTool(server, tool);
  if (server === 'browser-daily' && normalized === 'tabs') {
    if (!hadArguments) return true;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
    return args.action === undefined || args.action === 'list';
  }
  if (server === 'terminal' && normalized === 'terminal_read') {
    return Boolean(args && typeof args === 'object' && !Array.isArray(args) && args.snapshot === true);
  }
  const tools = KNOWN_READ_ONLY_ROUTES.get(server);
  return tools ? tools.has(normalized) : false;
}
