// Shared read-only route classification used by both providers/local-tools
// (mutation-state tracking) and providers/websession-adapter (concurrency lanes).

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
