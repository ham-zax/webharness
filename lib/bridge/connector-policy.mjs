import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEV_KNOWN_TOOLS, DEV_ROUTE_ARG_HINTS, normalizeRouteTool } from '../local-route-policy.mjs';
import { explainSchemaViolation, looksLikeSchemaValidationError } from '../schema-hint.mjs';

export const DEFAULT_CONNECTOR_POLICY_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'mcp-dev-bridge',
  'connector-policy.yaml',
);

const DEV_ARGS_CHEAT_SHEET = 'Dev arg shapes: read{path|targets,offset,limit,mode:"lines"|"outline"}, list_directory{path,depth,limit}, search{pattern,path,globs,literal}, edit{targets:[{path,edits:[{oldText,newText}]}],diff}, write{path,content,overwrite,mkdir_parents}, file_ops{operations:[{kind:"move"|"delete",path,to?}]}, review_changes{cwd,paths,rev}, exec{argv[],cwd,timeout_seconds,detach} (no shell parsing; use bash for pipes/redirects), bash{command,cwd,timeout_seconds,detach}, run_script{script,cwd,timeout_ms,max_calls}, wait{name,condition,cancel}. Truncated outputs save to a remote log path: inspect it with dev_read(path=...).';

const CALLS_WORKED_EXAMPLE = 'Example (edit -> test -> review in 1 call): local_fallback_dispatch({sequential:true,calls:[{id:"e",server:"dev",tool:"edit",arguments:{targets:[{path:"a.mjs",edits:[{oldText:"x",newText:"y"}]}]}},{id:"t",server:"dev",tool:"exec",arguments:{argv:["node","--test"],cwd:"repo/app"}},{id:"d",server:"dev",tool:"review_changes",arguments:{cwd:"repo/app"}}]}).';

const CONNECTOR_ROUTING_RULES = [
  'Before editing a repository, check for and read its `AGENTS.md` (or `CLAUDE.md`/`GEMINI.md` if present) and read only relevant sections of host global guidance (`~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`, or `~/.claude/CLAUDE.md`) when applicable.',
  'Never use `run_script` for parallel reads, searches, or git history that native `dev_read(targets=[...])`, `dev_search`, and `dev_review_changes` already do natively.',
  'For multi-step edit + test/check workflows, prefer `local_fallback_dispatch(calls:[...], sequential:true)` with `dev/edit` and `dev/exec` (`argv[]`, using `justfile` recipes via `exec(argv=["just", ...])` when available), and run publish/update recipes (`just ship`, `just deploy`, `just update`) as standalone calls rather than mixed into multi-step batches.',
  'Reserve `dev/run_script` for dynamic JS-computed loops only; replace inline `tools.bash` pipelines inside `run_script` with `justfile` recipes called via `exec(argv=["just", ...])`, and never embed `git push`, `ssh`, or `curl` inside `run_script`.',
].join(' ');

const CONNECTOR_READ_ONLY_BANNER = [
  'CONNECTOR ROUTING GUIDE:',
  'Use `local_fallback_dispatch` as the unified router for Dev (`edit`, `write`, `file_ops`, `exec`, `bash`, `run_script`, `wait`), Terminal, Browser, Host, and configured local server operations.',
  'Routes: server="dev" -> edit/write/file_ops/exec/bash/run_script/wait; server="terminal" -> terminal_open/terminal_read/terminal_send/terminal_list/terminal_close; server="browser-fast" -> observe/execute; server="browser-daily" -> status/tabs/execute; server="host" -> pc_sleep; other local servers via local_tool_list.',
  DEV_ARGS_CHEAT_SHEET,
  CONNECTOR_ROUTING_RULES,
  CALLS_WORKED_EXAMPLE,
].join(' ');

const CONNECTOR_BATCH_WRITES_BANNER = [
  'CONNECTOR ROUTING GUIDE (BATCH MODE):',
  'Batch multi-step Dev edits, tests, and review into ONE `local_fallback_dispatch(calls:[{server,tool,arguments}], sequential:true)` call (or `dev/run_script` only for dynamic JS-computed loops).',
  'Routes: server="dev" -> edit/write/file_ops/exec/bash/run_script/wait; server="terminal" -> terminal_open/terminal_read/terminal_send/terminal_list/terminal_close; server="browser-fast" -> observe/execute; server="browser-daily" -> status/tabs/execute; server="host" -> pc_sleep; other local servers via local_tool_list.',
  DEV_ARGS_CHEAT_SHEET,
  CONNECTOR_ROUTING_RULES,
  CALLS_WORKED_EXAMPLE,
].join(' ');

const CONNECTOR_FALLBACK_SUFFIX = ' [Pack 2+ ops/turn into one calls[] batch (concurrency for reads, sequential:true for edit->verify); use dev/run_script for dynamic loops, exec(argv:["just",...]) for recipes, and pueue (just queue / pueue add --after) for >15s or multi-stage jobs.]';

const CONNECTOR_READ_TOOL_SUFFIX = ' [1 op only; pack 2+ or routed ops in one local_fallback_dispatch(calls:[...]).]';

export const SEQUENTIAL_WRITE_NUDGE = '[tip: 3+ unbatched Dev writes in 2m — pack multi-step ops in one local_fallback_dispatch(calls:[...], sequential:true), use dev/run_script for dynamic loops, or just queue / pueue for >15s jobs]';

export { DEV_ROUTE_ARG_HINTS };

const FALLBACK_DISPATCH_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    server: { type: 'string', minLength: 1 },
    tool: { type: 'string', minLength: 1 },
    arguments: { type: 'object', additionalProperties: true },
    calls: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          server: { type: 'string', minLength: 1 },
          tool: { type: 'string', minLength: 1 },
          arguments: { type: 'object', additionalProperties: true },
        },
        additionalProperties: false,
      },
    },
    concurrency: { type: 'integer', minimum: 1, maximum: 16 },
    sequential: { type: 'boolean' },
    stop_on_error: { type: 'boolean' },
  },
  additionalProperties: false,
});

const FALLBACK_DISPATCH_SHAPE_HINT = 'Hint: local_fallback_dispatch takes { server, tool, arguments } for a single call, or { calls: [{ id?, server?, tool?, arguments? }], concurrency?, sequential?, stop_on_error? } for a batch.';

export function devToolSchemaHint(outerOrBaseTool, { includeLocalSchemaHint = true, detail = null } = {}) {
  if (outerOrBaseTool === 'local_fallback_dispatch' || outerOrBaseTool === 'fallback_dispatch') {
    return detail
      ? `Schema mismatch for local_fallback_dispatch: ${detail}. ${FALLBACK_DISPATCH_SHAPE_HINT}`
      : FALLBACK_DISPATCH_SHAPE_HINT;
  }
  const base = typeof outerOrBaseTool === 'string' && outerOrBaseTool.startsWith('dev_')
    ? outerOrBaseTool.slice(4)
    : String(outerOrBaseTool ?? '');
  const schemaRef = includeLocalSchemaHint
    ? ` Inspect full schema with local_tool_schema(server="dev", tool="${base || 'unknown'}").`
    : '';
  if (Object.hasOwn(DEV_ROUTE_ARG_HINTS, base)) {
    return `${DEV_ROUTE_ARG_HINTS[base]}${schemaRef}`;
  }
  return includeLocalSchemaHint
    ? `Inspect required fields with local_tool_schema(server="dev", tool="${base || 'unknown'}").`
    : 'Check tool arguments against its input schema.';
}

const COMPAT_READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const DEV_WRITE_NUDGE_TOOLS = new Set(['edit', 'write', 'file_ops', 'exec', 'bash']);

const HIDDEN_WRITE_TOOLS = new Set([
  'dev_edit', 'dev_write', 'dev_import_file', 'dev_file_ops', 'dev_wait',
  'dev_exec', 'dev_bash', 'dev_run_script', 'local_tool_call', 'local_tool_batch',
]);

function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && inDouble) { i += 1; continue; }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

const ALLOWED_MATCH_KEYS = new Set(['query_client', 'user_agent', 'client_info']);
const ALLOWED_BANNERS = new Set(['default', 'batch-writes', 'none']);

function unquoteYamlScalar(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function parseYamlBool(raw) {
  const s = unquoteYamlScalar(raw).toLowerCase();
  if (/^(true|yes|on|1)$/.test(s)) return true;
  if (/^(false|no|off|0)$/.test(s)) return false;
  return undefined;
}

function splitTopLevelInlineEntries(inner) {
  const parts = [];
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inDouble) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && inner[i + 1] === "'") { i += 1; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === ',' && braceDepth === 0 && bracketDepth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

function parseInlineMap(raw) {
  const inner = raw.trim().slice(1, -1);
  const out = {};
  for (const part of splitTopLevelInlineEntries(inner)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const k = unquoteYamlScalar(trimmed.slice(0, idx));
    const v = trimmed.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function parseInlineMatchMap(raw) {
  const rawEntries = parseInlineMap(raw);
  const out = {};
  for (const [k, v] of Object.entries(rawEntries)) {
    const unquoted = unquoteYamlScalar(v);
    if (k && unquoted) out[k] = unquoted;
  }
  return out;
}

const MAX_PATTERN_MATCH_INPUT_CHARS = 512;

function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) return null;
  try {
    return { regex: new RegExp(pattern, 'i'), lower: null };
  } catch {
    return { regex: null, lower: pattern.toLowerCase() };
  }
}

function defaultPolicyObject() {
  return {
    connectorWriteTools: true,
    default: { connectorWriteTools: true, compatAnnotations: false, banner: 'default', rpcBudgetSeconds: null },
    clients: [],
    logClientIdentifiers: false,
    warnings: [],
    _sig: null,
    _validDirectives: 0,
  };
}

export function parseConnectorPolicyYaml(text) {
  const policy = defaultPolicyObject();
  const warnings = policy.warnings;
  let validDirectives = 0;
  let topLevelWriteTools = null;
  let defaultCompatExplicit = undefined;
  let section = null; // 'default' | 'clients'
  let currentClient = null;
  let skippingListClient = false;
  let listClientIndent = -1;
  let inMatch = false;
  let clientIndent = -1;
  let matchIndent = -1;

  const applyRuleField = (target, key, rawVal, contextLabel, isDefault = false) => {
    if (key === 'connector_write_tools') {
      const b = parseYamlBool(rawVal);
      if (b !== undefined) { target.connectorWriteTools = b; validDirectives += 1; }
      else warnings.push(`${contextLabel}: ignored invalid boolean for connector_write_tools`);
    } else if (key === 'compat_annotations') {
      const b = parseYamlBool(rawVal);
      if (b !== undefined) {
        target.compatAnnotations = b;
        if (isDefault) defaultCompatExplicit = b;
        validDirectives += 1;
      } else {
        warnings.push(`${contextLabel}: ignored invalid boolean for compat_annotations`);
      }
    } else if (key === 'banner') {
      const s = unquoteYamlScalar(rawVal);
      if (s && ALLOWED_BANNERS.has(s)) { target.banner = s; validDirectives += 1; }
      else if (s) {
        target.banner = s;
        warnings.push(`${contextLabel}: unknown banner preset "${s}" (using default text)`);
      }
    } else if (key === 'rpc_budget_seconds') {
      const raw = unquoteYamlScalar(rawVal);
      const parsed = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (Number.isSafeInteger(parsed) && parsed >= 10 && parsed <= 300) {
        target.rpcBudgetSeconds = parsed;
        validDirectives += 1;
      } else {
        warnings.push(`${contextLabel}: ignored invalid integer for rpc_budget_seconds (expected 10..300)`);
      }
    } else {
      warnings.push(`${contextLabel}: ignored unknown key "${key}"`);
    }
  };

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const uncommented = stripInlineComment(rawLine);
    const trimmed = uncommented.trim();
    if (!trimmed) continue;
    const indent = uncommented.length - uncommented.trimStart().length;

    if (indent === 0) {
      inMatch = false;
      currentClient = null;
      skippingListClient = false;
      const idx = trimmed.indexOf(':');
      if (idx <= 0) {
        warnings.push('top-level: ignored malformed line');
        continue;
      }
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key === 'default') {
        if (!val) {
          section = 'default';
        } else if (val.startsWith('{') && val.endsWith('}')) {
          section = null;
          for (const [dk, dv] of Object.entries(parseInlineMap(val))) {
            applyRuleField(policy.default, dk, dv, 'default', true);
          }
        } else {
          section = null;
          warnings.push('default: expected block or inline map');
        }
      } else if (key === 'clients' && !val) {
        section = 'clients';
      } else if (key === 'connector_write_tools') {
        section = null;
        const b = parseYamlBool(val);
        if (b !== undefined) { topLevelWriteTools = b; validDirectives += 1; }
        else warnings.push('top-level: ignored invalid boolean for connector_write_tools');
      } else if (key === 'compat_annotations') {
        section = null;
        const b = parseYamlBool(val);
        if (b !== undefined) {
          policy.default.compatAnnotations = b;
          defaultCompatExplicit = b;
          validDirectives += 1;
        } else {
          warnings.push('top-level: ignored invalid boolean for compat_annotations');
        }
      } else if (key === 'banner') {
        section = null;
        applyRuleField(policy.default, 'banner', val, 'top-level', true);
      } else if (key === 'log_client_identifiers') {
        section = null;
        const b = parseYamlBool(val);
        if (b !== undefined) { policy.logClientIdentifiers = b; validDirectives += 1; }
        else warnings.push('top-level: ignored invalid boolean for log_client_identifiers');
      } else {
        section = null;
        warnings.push(`top-level: ignored unknown key "${key}"`);
      }
      continue;
    }

    if (section === 'default') {
      const idx = trimmed.indexOf(':');
      if (idx > 0) applyRuleField(policy.default, trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1), 'default', true);
      else warnings.push('default: ignored malformed line');
      continue;
    }

    if (section === 'clients') {
      if (skippingListClient) {
        if (indent > listClientIndent) continue;
        skippingListClient = false;
      }
      if (trimmed.startsWith('- ') || trimmed === '-') {
        warnings.push('clients: YAML list syntax ("- ...") is not supported; use named mapping keys under clients:');
        skippingListClient = true;
        listClientIndent = indent;
        currentClient = null;
        inMatch = false;
        continue;
      }
      if (inMatch && indent <= matchIndent) inMatch = false;
      const idx = trimmed.indexOf(':');
      if (idx <= 0) {
        warnings.push('clients: ignored malformed line');
        continue;
      }
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();

      if (!currentClient || indent <= clientIndent) {
        clientIndent = indent;
        currentClient = {
          name: key,
          match: {},
          _compiledMatch: {},
          connectorWriteTools: undefined,
          compatAnnotations: undefined,
          banner: undefined,
          rpcBudgetSeconds: undefined,
        };
        policy.clients.push(currentClient);
        inMatch = false;
        continue;
      }

      if (inMatch) {
        const s = unquoteYamlScalar(val);
        if (s) {
          currentClient.match[key] = s;
          if (!ALLOWED_MATCH_KEYS.has(key)) {
            warnings.push(`clients.${currentClient.name}.match: unknown match key "${key}" (rule disabled)`);
          } else {
            validDirectives += 1;
            if (key === 'user_agent' || key === 'client_info') {
              currentClient._compiledMatch[key] = compilePattern(s);
            }
          }
        }
        continue;
      }

      if (key === 'match') {
        if (!val) {
          inMatch = true;
          matchIndent = indent;
        } else if (val.startsWith('{') && val.endsWith('}')) {
          const parsed = parseInlineMatchMap(val);
          Object.assign(currentClient.match, parsed);
          for (const [mk, mv] of Object.entries(parsed)) {
            if (!ALLOWED_MATCH_KEYS.has(mk)) {
              warnings.push(`clients.${currentClient.name}.match: unknown match key "${mk}" (rule disabled)`);
            } else {
              validDirectives += 1;
              if (mk === 'user_agent' || mk === 'client_info') {
                currentClient._compiledMatch[mk] = compilePattern(mv);
              }
            }
          }
        } else {
          warnings.push(`clients.${currentClient.name}.match: expected inline "{ ... }" map or indented block`);
        }
        continue;
      }

      applyRuleField(currentClient, key, val, `clients.${currentClient.name}`, false);
    }
  }

  if (topLevelWriteTools !== null) {
    policy.default.connectorWriteTools = topLevelWriteTools;
  }
  if (defaultCompatExplicit !== undefined) {
    policy.default.compatAnnotations = defaultCompatExplicit;
  } else {
    policy.default.compatAnnotations = policy.default.connectorWriteTools === false;
  }
  policy.connectorWriteTools = policy.default.connectorWriteTools;
  policy._validDirectives = validDirectives;
  return policy;
}

export function createConnectorPolicyLoader(policyFile = process.env.BRIDGE_CONNECTOR_POLICY_FILE || DEFAULT_CONNECTOR_POLICY_FILE) {
  let cachedSig = null;
  let cachedPolicy = defaultPolicyObject();
  return () => {
    if (!policyFile) return defaultPolicyObject();
    try {
      const stat = fsSync.statSync(policyFile);
      const sig = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (sig === cachedSig) return cachedPolicy;
      const text = fsSync.readFileSync(policyFile, 'utf8');
      const parsed = parseConnectorPolicyYaml(text);
      // Do not overwrite a working active policy with permissive defaults if a
      // non-empty hot-reloaded file contains only unparseable/invalid lines.
      const hasActiveContent = text.split(/\r?\n/).some(l => stripInlineComment(l).trim().length > 0);
      if (cachedSig !== null && hasActiveContent && parsed._validDirectives === 0 && parsed.warnings.length > 0) {
        const warning = 'policy reload ignored malformed YAML: kept last-good policy';
        cachedPolicy = {
          ...cachedPolicy,
          warnings: [...parsed.warnings.slice(0, 6), warning],
          _sig: `${sig}:malformed`,
        };
        cachedSig = sig;
        return cachedPolicy;
      }
      parsed._sig = sig;
      cachedPolicy = parsed;
      cachedSig = sig;
      return cachedPolicy;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        cachedSig = null;
        cachedPolicy = defaultPolicyObject();
        return cachedPolicy;
      }
      const code = error?.code || 'IO';
      // Retain the last-good policy on transient I/O errors (e.g. EBUSY/EACCES during save)
      // instead of failing open to the permissive default.
      if (cachedSig !== null) {
        const warning = `policy reload error (${code}): kept last-good policy`;
        if (!cachedPolicy.warnings.includes(warning)) {
          cachedPolicy = { ...cachedPolicy, warnings: [...cachedPolicy.warnings, warning], _sig: `${cachedSig}:err:${code}` };
        }
        return cachedPolicy;
      }
      // On cold-start non-ENOENT error, emit a diagnostic warning rather than failing silently.
      const fallback = defaultPolicyObject();
      fallback.warnings.push(`policy load error (${code}): using default policy`);
      fallback._sig = `cold-err:${code}`;
      cachedPolicy = fallback;
      return cachedPolicy;
    }
  };
}

function matchesPattern(actual, pattern, compiled = null) {
  if (typeof actual !== 'string' || !actual || typeof pattern !== 'string' || !pattern) return false;
  const bounded = actual.length > MAX_PATTERN_MATCH_INPUT_CHARS
    ? actual.slice(0, MAX_PATTERN_MATCH_INPUT_CHARS)
    : actual;
  const matcher = compiled ?? compilePattern(pattern);
  if (!matcher) return false;
  if (matcher.regex) return matcher.regex.test(bounded);
  return bounded.toLowerCase().includes(matcher.lower);
}

export function extractQueryClient(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return null;
  const val = new URLSearchParams(rawUrl.slice(qIndex + 1)).get('client');
  return val ? val.trim() : null;
}

export function isInitializeRequest(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.some(item => item && typeof item === 'object' && item.method === 'initialize');
}

export function extractInitializeClientInfo(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    if (item && typeof item === 'object' && item.method === 'initialize') {
      const info = item.params?.clientInfo;
      if (info && typeof info === 'object' && typeof info.name === 'string' && info.name.trim()) {
        return {
          name: info.name.trim(),
          version: typeof info.version === 'string' ? info.version.trim() : undefined,
        };
      }
    }
  }
  return null;
}

export function resolveConnectorClientPolicy(policy, { url = '/mcp', headers = {}, clientInfoName = null } = {}) {
  const base = policy?.default ?? {
    connectorWriteTools: policy?.connectorWriteTools !== false,
    compatAnnotations: policy?.connectorWriteTools === false,
    banner: 'default',
  };
  const queryClient = extractQueryClient(url);
  const ua = String(headers['user-agent'] ?? headers['User-Agent'] ?? '').trim();
  const clients = Array.isArray(policy?.clients) ? policy.clients : [];

  for (const rule of clients) {
    const m = rule?.match;
    if (!m || typeof m !== 'object') continue;
    const keys = Object.keys(m);
    if (keys.length === 0) continue;
    // Fail closed: any unknown/misspelled match key disables the rule instead of acting as a wildcard.
    if (keys.some(k => !ALLOWED_MATCH_KEYS.has(k))) continue;
    let ok = true;
    if (m.query_client !== undefined) {
      ok = ok && Boolean(queryClient) && queryClient.toLowerCase() === String(m.query_client).toLowerCase();
    }
    if (m.user_agent !== undefined) {
      ok = ok && matchesPattern(ua, m.user_agent, rule._compiledMatch?.user_agent);
    }
    if (m.client_info !== undefined) {
      ok = ok && matchesPattern(clientInfoName, m.client_info, rule._compiledMatch?.client_info);
    }
    if (ok) {
      const connectorWriteTools = rule.connectorWriteTools ?? base.connectorWriteTools;
      const compatAnnotations = rule.compatAnnotations ?? (connectorWriteTools === false ? true : base.compatAnnotations);
      const banner = rule.banner ?? base.banner ?? 'default';
      const rpcBudgetSeconds = rule.rpcBudgetSeconds ?? base.rpcBudgetSeconds ?? null;
      return {
        matchedRule: rule.name,
        connectorWriteTools,
        compatAnnotations,
        banner,
        rpcBudgetSeconds,
        queryClient,
      };
    }
  }

  return {
    matchedRule: 'default',
    connectorWriteTools: base.connectorWriteTools,
    compatAnnotations: base.compatAnnotations,
    banner: base.banner ?? 'default',
    rpcBudgetSeconds: base.rpcBudgetSeconds ?? null,
    queryClient,
  };
}

export function bannerTextForPreset(preset, { rpcBudgetSeconds = null } = {}) {
  if (preset === 'none') return null;
  const base = preset === 'batch-writes' ? CONNECTOR_BATCH_WRITES_BANNER : CONNECTOR_READ_ONLY_BANNER;
  if (Number.isSafeInteger(rpcBudgetSeconds) && rpcBudgetSeconds > 0) {
    return `${base} Keep direct exec/bash under ${rpcBudgetSeconds}s (longer commands auto-promote to background jobs); for interactive or restart-surviving work use just queue <cmd> or terminal_open + dev/wait.`;
  }
  return base;
}

export function extractDirectOuterDevToolName(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.method !== 'tools/call') return null;
  const name = parsed.params?.name;
  if (typeof name !== 'string' || !name.startsWith('dev_')) return null;
  const base = name.slice(4);
  return DEV_KNOWN_TOOLS.has(base) ? name : null;
}

export function extractFallbackDispatchSchemaHint(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.method !== 'tools/call') return null;
  const name = parsed.params?.name;
  if (name !== 'local_fallback_dispatch' && name !== 'fallback_dispatch') return null;
  const rawArgs = Object.hasOwn(parsed.params ?? {}, 'arguments') ? parsed.params.arguments : {};
  return {
    toolName: name,
    detail: explainSchemaViolation(FALLBACK_DISPATCH_INPUT_SCHEMA, rawArgs),
  };
}

export function detectDevWriteToolCall(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.method !== 'tools/call') return false;
  const name = parsed.params?.name;
  if (typeof name !== 'string') return false;
  if (name.startsWith('dev_') && DEV_WRITE_NUDGE_TOOLS.has(name.slice(4))) return true;
  if (name === 'local_fallback_dispatch' || name === 'fallback_dispatch') {
    const args = parsed.params?.arguments;
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      if (args.calls === undefined && args.server === 'dev') {
        const base = normalizeRouteTool('dev', args.tool);
        return DEV_WRITE_NUDGE_TOOLS.has(base);
      }
      if (Array.isArray(args.calls) && args.calls.length === 1) {
        const entry = args.calls[0];
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const entryServer = entry.server ?? args.server;
          const entryTool = entry.tool ?? args.tool;
          if (entryServer === 'dev') {
            return DEV_WRITE_NUDGE_TOOLS.has(normalizeRouteTool('dev', entryTool));
          }
        }
      }
    }
  }
  return false;
}

export function appendHintToMcpJsonPayload(bodyText, hintText = SEQUENTIAL_WRITE_NUDGE) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const result = parsed.result;
  if (!result || typeof result !== 'object' || result.isError === true || !Array.isArray(result.content)) return null;
  let lastTextIndex = -1;
  for (let i = result.content.length - 1; i >= 0; i -= 1) {
    if (result.content[i]?.type === 'text' && typeof result.content[i].text === 'string') {
      lastTextIndex = i;
      break;
    }
  }
  if (lastTextIndex === -1) return null;
  if (result.content[lastTextIndex].text.includes(hintText)) return null;
  const nextContent = result.content.slice();
  nextContent[lastTextIndex] = {
    ...nextContent[lastTextIndex],
    text: `${nextContent[lastTextIndex].text}\n${hintText}`,
  };
  return JSON.stringify({ ...parsed, result: { ...result, content: nextContent } });
}

export function appendHintToMcpSsePayload(bodyText, hintText = SEQUENTIAL_WRITE_NUDGE) {
  let changed = false;
  const lines = bodyText.split('\n');
  const out = lines.map(line => {
    const cr = line.endsWith('\r') ? '\r' : '';
    const clean = cr ? line.slice(0, -1) : line;
    if (!clean.startsWith('data:')) return line;
    const rawData = clean.slice(5).trimStart();
    if (!rawData.startsWith('{')) return line;
    const next = appendHintToMcpJsonPayload(rawData, hintText);
    if (next === null) return line;
    changed = true;
    return `data: ${next}${cr}`;
  });
  return changed ? out.join('\n') : null;
}



function alreadyHasSchemaHint(text, outerOrBaseTool, fullHint) {
  if (typeof text !== 'string') return false;
  if (text.includes(fullHint) || text.includes('Schema mismatch for ')) return true;
  const base = typeof outerOrBaseTool === 'string' && outerOrBaseTool.startsWith('dev_')
    ? outerOrBaseTool.slice(4)
    : String(outerOrBaseTool ?? '');
  const coreHint = Object.hasOwn(DEV_ROUTE_ARG_HINTS, base) ? DEV_ROUTE_ARG_HINTS[base] : null;
  return Boolean(coreHint && text.includes(coreHint));
}

export function appendSchemaHintToMcpJsonPayload(bodyText, outerOrBaseTool, options = {}) {
  if (!outerOrBaseTool) return null;
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const hint = devToolSchemaHint(outerOrBaseTool, options);
  if (parsed.error && typeof parsed.error === 'object' && looksLikeSchemaValidationError(parsed.error.message)) {
    if (alreadyHasSchemaHint(parsed.error.message, outerOrBaseTool, hint)) return null;
    return JSON.stringify({
      ...parsed,
      error: { ...parsed.error, message: `${parsed.error.message}\n${hint}` },
    });
  }
  const result = parsed.result;
  if (!result || typeof result !== 'object' || result.isError !== true || !Array.isArray(result.content)) return null;
  const idx = result.content.findIndex(item => item?.type === 'text' && looksLikeSchemaValidationError(item.text));
  if (idx === -1 || alreadyHasSchemaHint(result.content[idx].text, outerOrBaseTool, hint)) return null;
  const nextContent = result.content.slice();
  nextContent[idx] = { ...nextContent[idx], text: `${nextContent[idx].text}\n${hint}` };
  return JSON.stringify({ ...parsed, result: { ...result, content: nextContent } });
}

export function appendSchemaHintToMcpSsePayload(bodyText, outerOrBaseTool, options = {}) {
  if (!outerOrBaseTool) return null;
  let changed = false;
  const lines = bodyText.split('\n');
  const out = lines.map(line => {
    const cr = line.endsWith('\r') ? '\r' : '';
    const clean = cr ? line.slice(0, -1) : line;
    if (!clean.startsWith('data:')) return line;
    const rawData = clean.slice(5).trimStart();
    if (!rawData.startsWith('{')) return line;
    const next = appendSchemaHintToMcpJsonPayload(rawData, outerOrBaseTool, options);
    if (next === null) return line;
    changed = true;
    return `data: ${next}${cr}`;
  });
  return changed ? out.join('\n') : null;
}

export function isWebSessionAdapterRequest(headers = {}) {
  const ua = String(headers['user-agent'] ?? headers['User-Agent'] ?? '');
  return /^websession-adapter\//i.test(ua.trim());
}

function simplifyFallbackInputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  if (!props) return schema;
  const nextProps = {};
  for (const [key, def] of Object.entries(props)) {
    if (!def || typeof def !== 'object') {
      nextProps[key] = def;
      continue;
    }
    if (key === 'calls') {
      const itemProps = def.items?.properties && typeof def.items.properties === 'object' ? def.items.properties : null;
      const nextItemProps = {};
      if (itemProps) {
        for (const [ik, idef] of Object.entries(itemProps)) {
          if (!idef || typeof idef !== 'object') continue;
          const cleaned = {};
          if (idef.type !== undefined) cleaned.type = idef.type;
          if (typeof idef.description === 'string') cleaned.description = idef.description;
          nextItemProps[ik] = cleaned;
        }
      }
      nextProps[key] = {
        type: 'array',
        ...(typeof def.description === 'string' ? { description: def.description } : {}),
        items: itemProps ? { type: 'object', properties: nextItemProps } : { type: 'object' },
      };
      continue;
    }
    const cleaned = {};
    if (def.type !== undefined) cleaned.type = def.type;
    if (typeof def.description === 'string') cleaned.description = def.description;
    nextProps[key] = cleaned;
  }
  return { type: 'object', properties: nextProps };
}

function sanitizeCompatFallbackDescription(desc) {
  return desc
    .replace(/\s*The selected downstream operation retains its full real authority[^.]*\./gi, '')
    .replace(/\s*—\s*use directly whenever write-annotated outer tools are disabled[^.]*\./gi, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function rewriteToolForConnectorReadOnly(tool, { compatAnnotations = true, hideWriteTools = true } = {}) {
  if (!tool || typeof tool !== 'object') return tool;
  const desc = typeof tool.description === 'string' ? tool.description : '';
  if (tool.name === 'local_fallback_dispatch' || tool.name === 'fallback_dispatch') {
    const nextSchema = tool.inputSchema ? simplifyFallbackInputSchema(tool.inputSchema) : tool.inputSchema;
    const cleanedDesc = compatAnnotations ? sanitizeCompatFallbackDescription(desc) : desc;
    const baseDesc = hideWriteTools
      ? cleanedDesc.replace(/\s*Safe to call in parallel for independent ops;[^.]*\./gi, '').replace(/\s{2,}/g, ' ').trim()
      : cleanedDesc;
    const nextDesc = hideWriteTools && !baseDesc.includes('Pack 2+ ops/turn into one calls[] batch')
      ? `${baseDesc}${CONNECTOR_FALLBACK_SUFFIX}`
      : baseDesc;
    return {
      ...tool,
      description: nextDesc,
      ...(compatAnnotations ? { annotations: { ...tool.annotations, ...COMPAT_READ_ONLY_ANNOTATIONS } } : {}),
      ...(nextSchema !== undefined ? { inputSchema: nextSchema } : {}),
    };
  }
  if (!hideWriteTools) return tool;
  if (desc.includes('[1 op only; pack 2+ or routed ops')) return tool;
  return { ...tool, description: `${desc}${CONNECTOR_READ_TOOL_SUFFIX}` };
}

export function filterRpcResponseMessage(msg, learnedHiddenTools = null, observedOuterTools = null, options = {}) {
  if (!msg || typeof msg !== 'object' || !msg.result || typeof msg.result !== 'object') return msg;
  const result = msg.result;
  let changed = false;
  let nextResult = result;
  const hideWriteTools = options?.hideWriteTools !== false;
  const compatAnnotations = options?.compatAnnotations ?? hideWriteTools;
  const bannerText = bannerTextForPreset(options?.banner, { rpcBudgetSeconds: options?.rpcBudgetSeconds ?? null });
  const sawTools = Array.isArray(result.tools);
  let hasFallback = Boolean(options?.knownHasFallback);

  if (sawTools) {
    for (const tool of result.tools) {
      if (typeof tool?.name !== 'string' || !tool.name) continue;
      if (observedOuterTools instanceof Set) observedOuterTools.add(tool.name);
      if (tool.name === 'local_fallback_dispatch' || tool.name === 'fallback_dispatch') {
        hasFallback = true;
      }
    }
    // Only strip write tools when local_fallback_dispatch is present in this catalog
    // (or inherited from page 1 of a paginated tools/list); otherwise tag:dev-only /
    // restricted / trusted-dev sessions would lose all writes.
    if (hideWriteTools && hasFallback) {
      if (learnedHiddenTools instanceof Set) {
        for (const tool of result.tools) {
          if (typeof tool?.name !== 'string' || !tool.name) continue;
          const isFallback = tool.name === 'local_fallback_dispatch' || tool.name === 'fallback_dispatch';
          if (tool?.annotations?.readOnlyHint === true || isFallback) {
            learnedHiddenTools.delete(tool.name);
          } else {
            learnedHiddenTools.add(tool.name);
          }
        }
      }
      const filtered = result.tools
        .filter(tool => {
          if (tool?.annotations?.readOnlyHint === true) return true;
          return tool?.name === 'local_fallback_dispatch' || tool?.name === 'fallback_dispatch';
        })
        .map(tool => rewriteToolForConnectorReadOnly(tool, { compatAnnotations, hideWriteTools: true }));
      nextResult = { ...nextResult, tools: filtered };
      changed = true;
    } else if (!hideWriteTools && compatAnnotations && hasFallback) {
      const mapped = result.tools.map(tool => rewriteToolForConnectorReadOnly(tool, { compatAnnotations: true, hideWriteTools: false }));
      nextResult = { ...nextResult, tools: mapped };
      changed = true;
    }
  }

  const allowBanner = hideWriteTools && bannerText !== null && (sawTools ? hasFallback : (options?.allowBannerWithoutTools !== false));
  if (allowBanner) {
    if (typeof result.instructions === 'string') {
      if (!result.instructions.includes('CONNECTOR ROUTING GUIDE')) {
        nextResult = { ...nextResult, instructions: `${bannerText}\n\n${result.instructions}` };
        changed = true;
      }
    } else if (result.serverInfo && result.capabilities) {
      nextResult = { ...nextResult, instructions: bannerText };
      changed = true;
    }
  }

  return changed ? { ...msg, result: nextResult } : msg;
}

export function filterMcpJsonPayload(bodyText, learnedHiddenTools = null, observedOuterTools = null, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    let anyChanged = false;
    const mapped = parsed.map(item => {
      const next = filterRpcResponseMessage(item, learnedHiddenTools, observedOuterTools, options);
      if (next !== item) anyChanged = true;
      return next;
    });
    return anyChanged ? JSON.stringify(mapped) : null;
  }
  const next = filterRpcResponseMessage(parsed, learnedHiddenTools, observedOuterTools, options);
  return next !== parsed ? JSON.stringify(next) : null;
}

export function filterMcpSsePayload(bodyText, learnedHiddenTools = null, observedOuterTools = null, options = {}) {
  let changed = false;
  const lines = bodyText.split('\n');
  const out = lines.map(line => {
    const cr = line.endsWith('\r') ? '\r' : '';
    const clean = cr ? line.slice(0, -1) : line;
    if (!clean.startsWith('data:')) return line;
    const rawData = clean.slice(5).trimStart();
    if (!rawData.startsWith('{') && !rawData.startsWith('[')) return line;
    const filtered = filterMcpJsonPayload(rawData, learnedHiddenTools, observedOuterTools, options);
    if (filtered === null) return line;
    changed = true;
    return `data: ${filtered}${cr}`;
  });
  return changed ? out.join('\n') : null;
}

const FILTERABLE_RESPONSE_METHODS = new Set(['tools/list', 'initialize', 'server/discover']);

export function shouldFilterResponseForRequest(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.some(item => item && typeof item === 'object' && FILTERABLE_RESPONSE_METHODS.has(item.method));
}

export function isPaginatedToolsListRequest(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.some(item => item && typeof item === 'object' && item.method === 'tools/list' && item.params?.cursor !== undefined);
}

function isBlockedToolName(name, extraBlockedTools = null) {
  if (typeof name !== 'string' || !name) return false;
  return HIDDEN_WRITE_TOOLS.has(name) || (extraBlockedTools instanceof Set && extraBlockedTools.has(name));
}

function buildBlockedToolResponse(id, name) {
  const suggestion = name.startsWith('dev_')
    ? `local_fallback_dispatch(server="dev", tool="${name.slice(4)}", arguments=...)`
    : 'local_fallback_dispatch(server="<server>", tool="<tool>", arguments=...)';
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      isError: true,
      content: [{
        type: 'text',
        text: `CONNECTOR_WRITE_TOOLS_DISABLED: ${name} is disabled by connector-policy.yaml (connector_write_tools: false). Call ${suggestion} instead.`,
      }],
    },
  };
}

export function urlAllowsLocalFallback(rawUrl) {
  if (typeof rawUrl !== 'string') return true;
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return true;
  const params = new URLSearchParams(rawUrl.slice(qIndex + 1));
  if (params.has('preset') || params.has('tag-filter')) return false;
  if (params.has('tags')) {
    const tags = params.getAll('tags')
      .flatMap(v => v.split(','))
      .map(v => v.trim().toLowerCase())
      .filter(Boolean);
    if (tags.length > 0 && !tags.includes('local')) return false;
  }
  return true;
}

function rewriteSingleFallbackDevCall(msg, allowedOuterTools = null) {
  if (!msg || typeof msg !== 'object' || msg.method !== 'tools/call') return msg;
  const params = msg.params;
  if (!params || typeof params !== 'object' || params.name !== 'local_fallback_dispatch') return msg;
  const outerArgs = params.arguments;
  if (!outerArgs || typeof outerArgs !== 'object' || Array.isArray(outerArgs)) return msg;
  if (outerArgs.server !== 'dev' || outerArgs.calls !== undefined) return msg;
  for (const key of Object.keys(outerArgs)) {
    if (key !== 'server' && key !== 'tool' && key !== 'arguments') return msg;
  }
  if (typeof outerArgs.tool !== 'string' || !outerArgs.tool) return msg;
  const baseTool = normalizeRouteTool('dev', outerArgs.tool);
  if (!DEV_KNOWN_TOOLS.has(baseTool)) return msg;
  const outerName = `dev_${baseTool}`;
  // Fail closed: only rewrite when this session/token/URL catalog positively exposed dev_<tool>.
  if (!(allowedOuterTools instanceof Set) || !allowedOuterTools.has(outerName)) return msg;
  const innerArgs = outerArgs.arguments;
  if (innerArgs !== undefined && (innerArgs === null || typeof innerArgs !== 'object' || Array.isArray(innerArgs))) {
    return msg;
  }
  return {
    ...msg,
    params: {
      ...params,
      name: outerName,
      arguments: innerArgs ?? {},
    },
  };
}

// Fast path: when connector_write_tools: false routes single-call dev ops through
// local_fallback_dispatch, rewrite them directly to outer dev_<tool> so they hit the
// primary pi-dev worker instead of waking a duplicate inner pi-dev process.
// Callers pass allowedOuterTools (when tools/list was observed for the session) so
// tag:local-only sessions fall back cleanly to local_fallback_dispatch instead.
export function rewriteConnectorFallbackDevCall(bodyText, allowedOuterTools = null) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    let changed = false;
    const mapped = parsed.map(item => {
      const next = rewriteSingleFallbackDevCall(item, allowedOuterTools);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? { body: JSON.stringify(mapped), rewrittenName: null } : null;
  }
  const next = rewriteSingleFallbackDevCall(parsed, allowedOuterTools);
  return next !== parsed ? { body: JSON.stringify(next), rewrittenName: next.params.name } : null;
}

export function inspectBlockedConnectorToolCall(bodyText, extraBlockedTools = null) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed)) {
    const blockedNames = [];
    for (const item of parsed) {
      if (item && typeof item === 'object' && item.method === 'tools/call' && isBlockedToolName(item.params?.name, extraBlockedTools)) {
        blockedNames.push(item.params.name);
      }
    }
    if (blockedNames.length === 0) return null;
    const uniqueBlocked = [...new Set(blockedNames)].join(', ');
    const responses = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      if (item.method === 'tools/call' && isBlockedToolName(item.params?.name, extraBlockedTools)) {
        if (item.id !== undefined) responses.push(buildBlockedToolResponse(item.id, item.params.name));
      } else if (item.id !== undefined) {
        responses.push({
          jsonrpc: '2.0',
          id: item.id,
          result: {
            isError: true,
            content: [{
              type: 'text',
              text: `CONNECTOR_WRITE_TOOLS_DISABLED: batch rejected because it contained disabled write tool(s) (${uniqueBlocked}). Resend allowed calls separately and route writes through local_fallback_dispatch.`,
            }],
          },
        });
      }
    }
    if (responses.length === 0) {
      return JSON.stringify([buildBlockedToolResponse(null, blockedNames[0])]);
    }
    return JSON.stringify(responses);
  }
  if (parsed.method !== 'tools/call') return null;
  const name = parsed.params?.name;
  if (!isBlockedToolName(name, extraBlockedTools)) return null;
  return JSON.stringify(buildBlockedToolResponse(parsed.id, name));
}

function skipWs(s, i) {
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) i += 1;
    else break;
  }
  return i;
}

function readJsonString(s, start) {
  if (s[start] !== '"') return null;
  let i = start + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') {
      try {
        return { value: JSON.parse(s.slice(start, i + 1)), next: i + 1 };
      } catch {
        return null;
      }
    }
    i += 1;
  }
  return null;
}

function readJsonPrimitive(s, start) {
  let i = start;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ',' || ch === '}' || ch === ']' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
    i += 1;
  }
  if (i === start || i >= s.length) return null;
  try {
    return { value: JSON.parse(s.slice(start, i)), next: i };
  } catch {
    return null;
  }
}

function skipJsonValue(s, start) {
  let i = skipWs(s, start);
  if (i >= s.length) return -1;
  const ch = s[i];
  if (ch === '"') {
    const str = readJsonString(s, i);
    return str ? str.next : -1;
  }
  if (ch === '{' || ch === '[') {
    let depth = 0;
    let inString = false;
    while (i < s.length) {
      const c = s[i];
      if (inString) {
        if (c === '\\') { i += 2; continue; }
        if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '{' || c === '[') {
        depth += 1;
      } else if (c === '}' || c === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    return -1;
  }
  const prim = readJsonPrimitive(s, i);
  return prim ? prim.next : -1;
}

function scanObjectPrefixForToolCall(s, start) {
  let i = skipWs(s, start);
  if (s[i] !== '{') return null;
  i += 1;
  let method;
  let id;
  let toolName;
  while (i < s.length) {
    i = skipWs(s, i);
    if (i >= s.length || s[i] === '}') break;
    const key = readJsonString(s, i);
    if (!key) break;
    i = skipWs(s, key.next);
    if (s[i] !== ':') break;
    i = skipWs(s, i + 1);
    if (i >= s.length) break;

    if (key.value === 'method' && s[i] === '"') {
      const val = readJsonString(s, i);
      if (!val) break;
      method = val.value;
      i = val.next;
    } else if (key.value === 'id') {
      const val = s[i] === '"' ? readJsonString(s, i) : readJsonPrimitive(s, i);
      if (!val) break;
      id = val.value;
      i = val.next;
    } else if (key.value === 'params' && s[i] === '{') {
      let j = i + 1;
      let truncated = false;
      while (j < s.length) {
        j = skipWs(s, j);
        if (j >= s.length) { truncated = true; break; }
        if (s[j] === '}') { j += 1; break; }
        const pKey = readJsonString(s, j);
        if (!pKey) { truncated = true; break; }
        j = skipWs(s, pKey.next);
        if (s[j] !== ':') { truncated = true; break; }
        j = skipWs(s, j + 1);
        if (j >= s.length) { truncated = true; break; }
        if (pKey.value === 'name' && s[j] === '"') {
          const pVal = readJsonString(s, j);
          if (!pVal) { truncated = true; break; }
          toolName = pVal.value;
          j = pVal.next;
        } else {
          const nextJ = skipJsonValue(s, j);
          if (nextJ === -1) { truncated = true; break; }
          j = nextJ;
        }
        j = skipWs(s, j);
        if (s[j] === ',') j += 1;
        else if (s[j] === '}') { j += 1; break; }
        else { truncated = true; break; }
      }
      if (truncated) break;
      i = j;
    } else {
      const nextI = skipJsonValue(s, i);
      if (nextI === -1) break;
      i = nextI;
    }

    i = skipWs(s, i);
    if (s[i] === ',') i += 1;
    else if (s[i] === '}') break;
    else break;
  }
  return { method, id, name: toolName, next: i < s.length && s[i] === '}' ? i + 1 : -1 };
}

// Inspects a truncated prefix of an oversized (>256 KiB) JSON-RPC POST body so
// large dev_write/dev_edit calls cannot bypass connector_write_tools: false.
// Tradeoff: this stays bounded to the 256 KiB prefix and intentionally fails open
// if a client sorts JSON keys alphabetically ("arguments" before "name" inside
// "params"), because failing closed on unresolved prefixes would also reject
// legitimate >256 KiB local_fallback_dispatch writes (connector-policy.yaml is a
// UX routing policy rather than a hard security boundary).
export function inspectBlockedConnectorToolCallPrefix(prefixText, extraBlockedTools = null) {
  let i = skipWs(prefixText, 0);
  if (i >= prefixText.length) return null;
  if (prefixText[i] === '{') {
    const scanned = scanObjectPrefixForToolCall(prefixText, i);
    if (scanned && scanned.method === 'tools/call' && isBlockedToolName(scanned.name, extraBlockedTools)) {
      return JSON.stringify(buildBlockedToolResponse(scanned.id, scanned.name));
    }
    return null;
  }
  if (prefixText[i] === '[') {
    i += 1;
    while (i < prefixText.length) {
      i = skipWs(prefixText, i);
      if (i >= prefixText.length || prefixText[i] === ']') break;
      if (prefixText[i] === '{') {
        const scanned = scanObjectPrefixForToolCall(prefixText, i);
        if (scanned && scanned.method === 'tools/call' && isBlockedToolName(scanned.name, extraBlockedTools)) {
          return JSON.stringify([buildBlockedToolResponse(scanned.id, scanned.name)]);
        }
        if (!scanned || scanned.next === -1) break;
        i = scanned.next;
      } else {
        const nextI = skipJsonValue(prefixText, i);
        if (nextI === -1) break;
        i = nextI;
      }
      i = skipWs(prefixText, i);
      if (prefixText[i] === ',') i += 1;
      else break;
    }
  }
  return null;
}
