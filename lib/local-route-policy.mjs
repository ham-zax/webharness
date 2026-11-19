// Shared read-only route classification used by both providers/local-tools
// (mutation-state tracking) and providers/websession-adapter (concurrency lanes).

export const DEV_KNOWN_TOOLS = new Set([
  'read', 'list_directory', 'search', 'edit', 'write', 'import_file',
  'review_changes', 'wait', 'file_ops', 'exec', 'bash', 'run_script',
]);

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
