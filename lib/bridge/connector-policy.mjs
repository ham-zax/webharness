import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEV_KNOWN_TOOLS, normalizeRouteTool } from '../local-route-policy.mjs';

export const DEFAULT_CONNECTOR_POLICY_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'mcp-dev-bridge',
  'connector-policy.yaml',
);

const RUN_SCRIPT_WORKED_EXAMPLE = 'Example (edit -> test -> review in 1 call): local_fallback_dispatch({server:"dev",tool:"run_script",arguments:{cwd:"repo/app",script:"await tools.edit({targets:[{path:\"a.mjs\",edits:[{oldText:\"x\",newText:\"y\"}]}]}); const t = await tools.exec({argv:[\"node\",\"--test\"]}); const d = await tools.review_changes({}); return t + \"\\n\" + d;"}}).';

const CONNECTOR_READ_ONLY_BANNER = [
  'CONNECTOR WRITE-ROUTING POLICY:',
  'Direct outer write tools are disabled in this connector session; route ALL writes, edits, file_ops, shell/exec, scripts, waits, terminal, browser, host, and owner-MCP actions via `local_fallback_dispatch`.',
  'Never claim you lack write access or ask for write tools — call `local_fallback_dispatch` directly.',
  'Routes: server="dev" -> edit/write/file_ops/exec/bash/run_script/wait; server="terminal" -> terminal_open/terminal_read/terminal_send/terminal_list/terminal_close; server="browser-fast" -> observe/execute; server="browser-daily" -> status/tabs/execute; server="host" -> pc_sleep; owner MCPs via local_tool_list.',
  'For 3+ Dev-only steps prefer `local_fallback_dispatch(server="dev", tool="run_script", ...)` (up to 32 Dev ops in one call); for multi-server or sequential Dev+Local pipelines use `calls:[{server,tool,arguments}]` with `sequential:true`; run independent calls in parallel.',
  RUN_SCRIPT_WORKED_EXAMPLE,
].join(' ');

const CONNECTOR_BATCH_WRITES_BANNER = [
  'CONNECTOR WRITE-ROUTING POLICY (BATCH-WRITES MODE):',
  'This session has a tight per-turn write budget and direct outer write tools are disabled. Put ALL multi-step Dev edits, tests, and review into ONE `local_fallback_dispatch(server="dev", tool="run_script", ...)` call (up to 32 ops) or ONE `calls:[{server,tool,arguments}]` with `sequential:true` for Dev+Local pipelines.',
  'Never claim you lack write access or ask for write tools — call `local_fallback_dispatch` directly.',
  'Routes: server="dev" -> edit/write/file_ops/exec/bash/run_script/wait; server="terminal" -> terminal_open/terminal_read/terminal_send/terminal_list/terminal_close; server="browser-fast" -> observe/execute; server="browser-daily" -> status/tabs/execute; server="host" -> pc_sleep; owner MCPs via local_tool_list.',
  RUN_SCRIPT_WORKED_EXAMPLE,
].join(' ');

const CONNECTOR_FALLBACK_SUFFIX = ' [ACTIVE CONNECTOR POLICY: Direct outer write tools are disabled; call this tool directly for all Dev/Local/owner-MCP writes and execution without asking for write tools.]';

const CONNECTOR_READ_TOOL_SUFFIX = ' [Read-only tool; for any write, edit, exec, bash, file_ops, run_script, wait, terminal, browser, or host action, call local_fallback_dispatch directly.]';

export const SEQUENTIAL_WRITE_NUDGE = '[tip: 3+ sequential Dev writes in 30s — batch multi-step edit/test/review work in one dev/run_script call]';

const COMPAT_READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
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

function unquoteYamlScalar(raw) {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseYamlBool(raw) {
  const s = unquoteYamlScalar(raw).toLowerCase();
  if (/^(true|yes|on|1)$/.test(s)) return true;
  if (/^(false|no|off|0)$/.test(s)) return false;
  return undefined;
}

function parseInlineMatchMap(raw) {
  const inner = raw.trim().slice(1, -1);
  const out = {};
  for (const part of inner.split(',')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = unquoteYamlScalar(part.slice(idx + 1));
    if (k && v) out[k] = v;
  }
  return out;
}

function defaultPolicyObject() {
  return {
    connectorWriteTools: true,
    default: { connectorWriteTools: true, compatAnnotations: false, banner: 'default' },
    clients: [],
    logClientIdentifiers: false,
  };
}

export function parseConnectorPolicyYaml(text) {
  const policy = defaultPolicyObject();
  let topLevelWriteTools = null;
  let section = null; // 'default' | 'clients'
  let currentClient = null;
  let inMatch = false;
  let clientIndent = -1;
  let matchIndent = -1;

  const applyRuleField = (target, key, rawVal) => {
    if (key === 'connector_write_tools') {
      const b = parseYamlBool(rawVal);
      if (b !== undefined) target.connectorWriteTools = b;
    } else if (key === 'compat_annotations') {
      const b = parseYamlBool(rawVal);
      if (b !== undefined) target.compatAnnotations = b;
    } else if (key === 'banner') {
      const s = unquoteYamlScalar(rawVal);
      if (s) target.banner = s;
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
      const idx = trimmed.indexOf(':');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key === 'default' && !val) {
        section = 'default';
      } else if (key === 'clients' && !val) {
        section = 'clients';
      } else if (key === 'connector_write_tools') {
        section = null;
        const b = parseYamlBool(val);
        if (b !== undefined) topLevelWriteTools = b;
      } else if (key === 'compat_annotations') {
        section = null;
        const b = parseYamlBool(val);
        if (b !== undefined) policy.default.compatAnnotations = b;
      } else if (key === 'banner') {
        section = null;
        const s = unquoteYamlScalar(val);
        if (s) policy.default.banner = s;
      } else if (key === 'log_client_identifiers') {
        section = null;
        const b = parseYamlBool(val);
        if (b !== undefined) policy.logClientIdentifiers = b;
      }
      continue;
    }

    if (section === 'default') {
      const idx = trimmed.indexOf(':');
      if (idx > 0) applyRuleField(policy.default, trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1));
      continue;
    }

    if (section === 'clients') {
      if (inMatch && indent <= matchIndent) inMatch = false;
      const idx = trimmed.indexOf(':');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();

      if (!currentClient || indent <= clientIndent) {
        clientIndent = indent;
        currentClient = {
          name: key,
          match: {},
          connectorWriteTools: undefined,
          compatAnnotations: undefined,
          banner: undefined,
        };
        policy.clients.push(currentClient);
        inMatch = false;
        continue;
      }

      if (inMatch) {
        const s = unquoteYamlScalar(val);
        if (s) currentClient.match[key] = s;
        continue;
      }

      if (key === 'match') {
        if (val.startsWith('{') && val.endsWith('}')) {
          Object.assign(currentClient.match, parseInlineMatchMap(val));
        } else {
          inMatch = true;
          matchIndent = indent;
        }
        continue;
      }

      applyRuleField(currentClient, key, val);
    }
  }

  if (topLevelWriteTools !== null) {
    policy.default.connectorWriteTools = topLevelWriteTools;
    if (topLevelWriteTools === false) policy.default.compatAnnotations = true;
  }
  policy.connectorWriteTools = policy.default.connectorWriteTools;
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
      cachedPolicy = parseConnectorPolicyYaml(text);
      cachedSig = sig;
      return cachedPolicy;
    } catch {
      cachedSig = null;
      cachedPolicy = defaultPolicyObject();
      return cachedPolicy;
    }
  };
}

function matchesPattern(actual, pattern) {
  if (typeof actual !== 'string' || !actual || typeof pattern !== 'string' || !pattern) return false;
  try {
    return new RegExp(pattern, 'i').test(actual);
  } catch {
    return actual.toLowerCase().includes(pattern.toLowerCase());
  }
}

export function extractQueryClient(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return null;
  const val = new URLSearchParams(rawUrl.slice(qIndex + 1)).get('client');
  return val ? val.trim() : null;
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
    let ok = true;
    if (m.query_client !== undefined) {
      ok = ok && Boolean(queryClient) && queryClient.toLowerCase() === String(m.query_client).toLowerCase();
    }
    if (m.user_agent !== undefined) {
      ok = ok && matchesPattern(ua, m.user_agent);
    }
    if (m.client_info !== undefined) {
      ok = ok && matchesPattern(clientInfoName, m.client_info);
    }
    if (ok) {
      const connectorWriteTools = rule.connectorWriteTools ?? base.connectorWriteTools;
      const compatAnnotations = rule.compatAnnotations ?? (connectorWriteTools === false ? true : base.compatAnnotations);
      const banner = rule.banner ?? base.banner ?? 'default';
      return {
        matchedRule: rule.name,
        connectorWriteTools,
        compatAnnotations,
        banner,
        queryClient,
      };
    }
  }

  return {
    matchedRule: 'default',
    connectorWriteTools: base.connectorWriteTools,
    compatAnnotations: base.compatAnnotations,
    banner: base.banner ?? 'default',
    queryClient,
  };
}

export function bannerTextForPreset(preset) {
  if (preset === 'batch-writes') return CONNECTOR_BATCH_WRITES_BANNER;
  return CONNECTOR_READ_ONLY_BANNER;
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
  if (name === 'local_fallback_dispatch') {
    const args = parsed.params?.arguments;
    if (args && typeof args === 'object' && !Array.isArray(args) && args.server === 'dev' && args.calls === undefined) {
      const base = normalizeRouteTool('dev', args.tool);
      return DEV_WRITE_NUDGE_TOOLS.has(base);
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

export function rewriteToolForConnectorReadOnly(tool, { compatAnnotations = true, hideWriteTools = true } = {}) {
  if (!tool || typeof tool !== 'object') return tool;
  const desc = typeof tool.description === 'string' ? tool.description : '';
  if (tool.name === 'local_fallback_dispatch' || tool.name === 'fallback_dispatch') {
    const nextSchema = tool.inputSchema ? simplifyFallbackInputSchema(tool.inputSchema) : tool.inputSchema;
    const nextDesc = hideWriteTools && !desc.includes('[ACTIVE CONNECTOR POLICY:')
      ? `${desc}${CONNECTOR_FALLBACK_SUFFIX}`
      : desc;
    return {
      ...tool,
      description: nextDesc,
      ...(compatAnnotations ? { annotations: { ...tool.annotations, ...COMPAT_READ_ONLY_ANNOTATIONS } } : {}),
      ...(nextSchema !== undefined ? { inputSchema: nextSchema } : {}),
    };
  }
  if (!hideWriteTools) return tool;
  if (desc.includes('[Read-only tool; for any write,')) return tool;
  return { ...tool, description: `${desc}${CONNECTOR_READ_TOOL_SUFFIX}` };
}

export function filterRpcResponseMessage(msg, learnedHiddenTools = null, observedOuterTools = null, options = {}) {
  if (!msg || typeof msg !== 'object' || !msg.result || typeof msg.result !== 'object') return msg;
  const result = msg.result;
  let changed = false;
  let nextResult = result;
  const hideWriteTools = options?.hideWriteTools !== false;
  const compatAnnotations = options?.compatAnnotations ?? hideWriteTools;
  const bannerText = bannerTextForPreset(options?.banner);
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
          if (tool?.annotations?.readOnlyHint === true || (compatAnnotations && isFallback)) {
            learnedHiddenTools.delete(tool.name);
          } else {
            learnedHiddenTools.add(tool.name);
          }
        }
      }
      const filtered = result.tools
        .filter(tool => {
          if (tool?.annotations?.readOnlyHint === true) return true;
          const isFallback = tool?.name === 'local_fallback_dispatch' || tool?.name === 'fallback_dispatch';
          return compatAnnotations && isFallback;
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

  const allowBanner = hideWriteTools && (sawTools ? hasFallback : (options?.allowBannerWithoutTools !== false));
  if (allowBanner) {
    if (typeof result.instructions === 'string') {
      if (!result.instructions.includes('CONNECTOR WRITE-ROUTING POLICY')) {
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

export function urlAllowsDevFastPath(rawUrl) {
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
    if (tags.length > 0 && !tags.includes('dev')) return false;
  }
  return true;
}

export function urlAllowsLocalFallback(rawUrl) {
  if (typeof rawUrl !== 'string') return true;
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return true;
  const params = new URLSearchParams(rawUrl.slice(qIndex + 1));
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
