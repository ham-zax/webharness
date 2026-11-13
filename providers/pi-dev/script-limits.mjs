// Bounds for run_script. The sandbox enforces its own hard caps (16 MiB of output,
// 100k output items); these are the model-facing budgets the adapter enforces on top.
// Every result stays in conversation context and is re-billed on each later turn, so
// the default output cap matches DEFAULT_MAX_OUTPUT_BYTES for exec and bash.
export const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
export const MAX_SCRIPT_TIMEOUT_MS = 120_000;
export const DEFAULT_SCRIPT_MAX_CALLS = 32;
export const MAX_SCRIPT_MAX_CALLS = 32;
export const SCRIPT_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
export const SCRIPT_READ_CONCURRENCY = 4;
export const SCRIPT_MAX_CONCURRENT = 2;
export const SCRIPT_SLOT_WAIT_MS = 60_000;

// A script's authority is exactly the Dev surface this process registered, minus the
// tools that cannot work inside a script: run_script would recurse, wait would hold the
// connector window on a durable condition, and import_file needs a ChatGPT-native file
// value a script cannot construct.
export const SCRIPT_EXCLUDED_TOOLS = new Set(['run_script', 'wait', 'import_file']);

// Read-only calls may overlap; everything else serializes. Mirrors the WebSession
// adapter's rule so a script cannot mutate while another mutation runs.
export const SCRIPT_READ_ONLY_TOOLS = new Set(['read', 'list_directory', 'search', 'review_changes']);
