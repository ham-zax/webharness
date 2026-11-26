import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import { normalizeRouteTool } from '../local-route-policy.mjs';

const MAX_ROUTES_PER_RECORD = 32;
const MAX_SNIPPET_DECODE_BYTES = 128 * 1024;
const TOKEN_DIVISOR = 4;

// Order matters: more specific token/header patterns run before generic KEY=VAL scrubbing.
const REDACT_RULES = [
  // Owner-link tickets are URL-safe bearer credentials, including in curl form data.
  [/ticket(?:=|%3d)(?:['"]|%22|%27)?[A-Za-z0-9_-]+/gi, 'ticket=[REDACTED]'],
  [/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1$2:[REDACTED]@'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b(?:sk-(?:proj-|ant-|live-|test-)?|gh[pousr]_|github_pat_|xox[baprs]-|AIza|AKIA|pa-)[A-Za-z0-9._-]{10,}\b/g, '[REDACTED_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|COOKIE|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(?:'[^']*'|"[^"]*"|\S+)/gi, '$1=[REDACTED]'],
  [/(--(?:token|api[-_]?key|password|passwd|secret|auth|bearer|cookie|client-secret)(?:=|\s+))(?:'[^']*'|"[^"]*"|\S+)/gi, '$1[REDACTED]'],
  [/(-H\s+['"]?(?:authorization|cookie|x-api-key|api-key)\s*:\s*)([^'"]+)/gi, '$1[REDACTED]'],
];

export function redactSensitiveText(input, maxLen = 140) {
  if (typeof input !== 'string') return '';
  let text = input.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!text) return '';
  for (const [pattern, replacement] of REDACT_RULES) {
    text = text.replace(pattern, replacement);
  }
  if (text.length > maxLen) {
    return `${text.slice(0, Math.max(1, maxLen - 3))}...`;
  }
  return text;
}

export function estimateTokens(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes / TOKEN_DIVISOR);
}

export function hashOpaqueSession(raw) {
  if (typeof raw !== 'string' || !raw) return 'anon';
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

export function inferRepoLabel(candidatePath) {
  if (typeof candidatePath !== 'string') return undefined;
  const clean = candidatePath.trim().replace(/\\/g, '/');
  if (!clean) return undefined;
  const repoMatch = clean.match(/(?:^|\/)repo\/([^/]+)(?:\/|$)/);
  if (repoMatch) return repoMatch[1];
  const claiveMatch = clean.match(/\/\.local\/state\/claive\/([^/]+)\/worktree(?:\/|$)/);
  if (claiveMatch) return `claive:${claiveMatch[1].slice(0, 8)}`;
  const cfgMatch = clean.match(/\/\.config\/([^/]+)(?:\/|$)/);
  if (cfgMatch) return `.config/${cfgMatch[1]}`;
  if (clean.startsWith('/tmp/')) return 'tmp';
  if (!path.isAbsolute(clean)) {
    const first = clean.split('/').find(Boolean);
    return first && first !== '.' && first !== '..' ? first : undefined;
  }
  const parts = clean.split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return parts[0];
}

function shortPathLabel(candidatePath) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) return undefined;
  const clean = candidatePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  return parts.length <= 2 ? clean : parts.slice(-2).join('/');
}

function safeByteLength(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value === undefined || value === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

export function summarizeRouteCall(server, rawTool, args) {
  const srv = typeof server === 'string' && server ? server : 'unknown';
  const tool = normalizeRouteTool(srv, typeof rawTool === 'string' && rawTool ? rawTool : 'unknown');
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const summary = { server: srv, tool };

  const repoCandidate = a.codebaseRoot ?? a.cwd ?? a.path ?? a.targets?.[0]?.path ?? a.operations?.[0]?.path;
  const repo = inferRepoLabel(repoCandidate);
  if (repo) summary.repo = repo;

  if (srv === 'dev') {
    if (tool === 'exec' && Array.isArray(a.argv) && a.argv.length > 0) {
      const bin = path.basename(String(a.argv[0]));
      summary.bin = bin.slice(0, 48);
      summary.cmd = redactSensitiveText(a.argv.map(String).join(' '), 140);
      if (a.detach === true) summary.detached = true;
      if (typeof a.timeout_seconds === 'number') summary.timeout_s = a.timeout_seconds;
      return summary;
    }
    if (tool === 'bash' && typeof a.command === 'string') {
      const firstToken = a.command.trim().split(/[\s;&|]+/, 1)[0] || '';
      if (firstToken && /^[A-Za-z0-9._/-]+$/.test(firstToken)) summary.bin = path.basename(firstToken).slice(0, 48);
      summary.cmd = redactSensitiveText(a.command, 140);
      if (a.detach === true) summary.detached = true;
      if (typeof a.timeout_seconds === 'number') summary.timeout_s = a.timeout_seconds;
      return summary;
    }
    if (tool === 'read') {
      if (Array.isArray(a.targets)) {
        summary.files = a.targets.length;
        const first = shortPathLabel(a.targets[0]?.path);
        if (first) summary.target = first;
      } else {
        const target = shortPathLabel(a.path);
        if (target) summary.target = target;
      }
      if (typeof a.mode === 'string') summary.mode = a.mode;
      if (typeof a.limit === 'number') summary.limit = a.limit;
      return summary;
    }
    if (tool === 'search') {
      if (typeof a.pattern === 'string') summary.pattern = redactSensitiveText(a.pattern, 80);
      const target = shortPathLabel(a.path);
      if (target) summary.target = target;
      if (a.literal === true) summary.literal = true;
      return summary;
    }
    if (tool === 'list_directory') {
      const target = shortPathLabel(a.path);
      if (target) summary.target = target;
      if (typeof a.depth === 'number') summary.depth = a.depth;
      return summary;
    }
    if (tool === 'edit') {
      const targets = Array.isArray(a.targets) ? a.targets : [];
      summary.files = targets.length;
      summary.edits = targets.reduce((sum, t) => sum + (Array.isArray(t?.edits) ? t.edits.length : 0), 0);
      const first = shortPathLabel(targets[0]?.path);
      if (first) summary.target = first;
      return summary;
    }
    if (tool === 'write') {
      const target = shortPathLabel(a.path);
      if (target) summary.target = target;
      summary.content_bytes = safeByteLength(a.content);
      return summary;
    }
    if (tool === 'file_ops') {
      const ops = Array.isArray(a.operations) ? a.operations : [];
      summary.ops = ops.length;
      const kinds = [...new Set(ops.map(op => op?.kind).filter(k => typeof k === 'string'))];
      if (kinds.length > 0) summary.kinds = kinds;
      return summary;
    }
    if (tool === 'review_changes') {
      if (typeof a.rev === 'string') summary.rev = a.rev.slice(0, 48);
      if (Array.isArray(a.paths)) summary.files = a.paths.length;
      return summary;
    }
    if (tool === 'wait') {
      if (typeof a.name === 'string') summary.target = a.name.slice(0, 64);
      if (typeof a.condition?.kind === 'string') summary.kind = a.condition.kind;
      if (typeof a.hold_seconds === 'number') summary.hold_s = a.hold_seconds;
      if (a.cancel === true) summary.cancel = true;
      return summary;
    }
    if (tool === 'run_script') {
      summary.script_bytes = safeByteLength(a.script);
      return summary;
    }
  }

  if (srv === 'satori') {
    if (tool === 'search_codebase') {
      if (typeof a.query === 'string') summary.query = redactSensitiveText(a.query, 100);
      if (Array.isArray(a.alt_terms)) summary.alt_terms = a.alt_terms.length;
      if (typeof a.limit === 'number') summary.limit = a.limit;
      if (typeof a.scope === 'string') summary.scope = a.scope;
      return summary;
    }
    if (tool === 'read_file') {
      const target = shortPathLabel(a.path);
      if (target) summary.target = target;
      if (a.open_symbol) summary.open_symbol = true;
      if (typeof a.mode === 'string') summary.mode = a.mode;
      return summary;
    }
    if (tool === 'call_graph') {
      const file = shortPathLabel(a.symbolRef?.file);
      if (file) summary.target = file;
      const sym = a.symbolRef?.symbolLabel ?? a.symbolRef?.symbolId;
      if (typeof sym === 'string') summary.symbol = sym.slice(0, 64);
      if (typeof a.direction === 'string') summary.direction = a.direction;
      if (typeof a.depth === 'number') summary.depth = a.depth;
      return summary;
    }
    if (tool === 'manage_index') {
      if (typeof a.action === 'string') summary.action = a.action;
      if (typeof a.detail === 'string') summary.detail = a.detail;
      return summary;
    }
    const target = shortPathLabel(a.path);
    if (target) summary.target = target;
    if (typeof a.symbol === 'string') summary.symbol = a.symbol.slice(0, 64);
    return summary;
  }

  if (srv === 'terminal') {
    if (typeof a.name === 'string') summary.target = a.name.slice(0, 64);
    if (a.snapshot === true) summary.snapshot = true;
    if (a.present === true) summary.present = true;
    if (typeof a.command === 'string') summary.cmd = redactSensitiveText(a.command, 100);
    return summary;
  }

  if (srv === 'browser-fast' || srv === 'browser-devtools' || srv === 'browser-daily') {
    if (typeof a.browser_backend === 'string') summary.backend = a.browser_backend;
    if (typeof a.browser_profile === 'string') summary.profile = a.browser_profile.slice(0, 48);
    if (Array.isArray(a.actions)) summary.actions = a.actions.length;
    if (typeof a.action === 'string') summary.action = a.action;
    return summary;
  }

  if (srv === 'skill-library') {
    if (typeof a.query === 'string') summary.query = redactSensitiveText(a.query, 80);
    if (typeof a.id === 'string') summary.target = a.id.slice(0, 64);
    return summary;
  }

  const keys = Object.keys(a).slice(0, 8);
  if (keys.length > 0) summary.arg_keys = keys;
  return summary;
}

export function extractRequestTelemetry(bodyText, { exceeded = false, totalBytes = null } = {}) {
  const reqBytes = typeof totalBytes === 'number'
    ? totalBytes
    : Buffer.byteLength(bodyText ?? '', 'utf8');
  if (exceeded) {
    const methodMatch = /"method"\s*:\s*"([^"]{1,64})"/.exec(bodyText ?? '');
    const nameMatch = /"name"\s*:\s*"([^"]{1,128})"/.exec(bodyText ?? '');
    return {
      rpc_method: methodMatch?.[1] ?? 'unknown',
      ...(nameMatch?.[1] ? { outer_tool: nameMatch[1] } : {}),
      req_bytes: reqBytes,
      est_req_tokens: estimateTokens(reqBytes),
      req_oversized: true,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rpcMethod = typeof parsed.method === 'string' ? parsed.method : 'unknown';
  const base = {
    rpc_method: rpcMethod,
    req_bytes: reqBytes,
    est_req_tokens: estimateTokens(reqBytes),
  };
  if (rpcMethod !== 'tools/call') return base;

  const outerTool = typeof parsed.params?.name === 'string' ? parsed.params.name : 'unknown';
  const args = parsed.params?.arguments;
  const routes = [];
  let batchSize = 1;
  let batchMode = 'single';

  if (outerTool === 'local_fallback_dispatch' || outerTool === 'fallback_dispatch') {
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      if (Array.isArray(args.calls) && args.calls.length > 0) {
        batchSize = args.calls.length;
        batchMode = args.sequential === true ? 'sequential' : 'parallel';
        for (const entry of args.calls.slice(0, MAX_ROUTES_PER_RECORD)) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
          routes.push(summarizeRouteCall(entry.server ?? args.server, entry.tool ?? args.tool, entry.arguments));
        }
      } else {
        routes.push(summarizeRouteCall(args.server, args.tool, args.arguments));
      }
    }
  } else if (outerTool === 'local_tool_call' || outerTool === 'tool_call') {
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      routes.push(summarizeRouteCall(args.server, args.tool, args.arguments));
    }
  } else if (outerTool === 'local_tool_batch' || outerTool === 'tool_batch') {
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      const calls = Array.isArray(args.calls) ? args.calls : [];
      batchSize = calls.length || 1;
      batchMode = 'parallel';
      for (const entry of calls.slice(0, MAX_ROUTES_PER_RECORD)) {
        routes.push(summarizeRouteCall(args.server, args.tool, entry?.arguments));
      }
    }
  } else if (outerTool.startsWith('dev_')) {
    routes.push(summarizeRouteCall('dev', outerTool.slice(4), args));
  } else if (outerTool.startsWith('local_')) {
    routes.push(summarizeRouteCall('local', outerTool.slice(6), args));
  } else {
    routes.push(summarizeRouteCall('outer', outerTool, args));
  }

  const repos = [...new Set(routes.map(r => r.repo).filter(Boolean))].slice(0, 8);
  return {
    ...base,
    outer_tool: outerTool,
    batch_size: batchSize,
    batch_mode: batchMode,
    routes,
    ...(repos.length > 0 ? { repos } : {}),
  };
}

function inspectResponseTextSignals(text, { rpcMethod = null } = {}) {
  if (typeof text !== 'string' || !text) return {};
  const out = {};
  if (/"isError"\s*:\s*true\b/.test(text) || /"error"\s*:\s*\{/.test(text)) {
    out.is_error = true;
  }
  if (rpcMethod && rpcMethod !== 'tools/call') {
    return out;
  }

  const exitMatches = [...text.matchAll(/\[exit (-?\d+)(?:\s*·\s*[0-9.]+s)?\]/g)];
  if (exitMatches.length > 0) {
    const codes = exitMatches.map(m => Number(m[1]));
    const nonZero = codes.find(c => c !== 0);
    out.exit_code = nonZero !== undefined ? nonZero : 0;
    if (nonZero !== undefined) out.is_error = true;
  }
  if (/\[timed out after [0-9.]+s\]|\[hard timeout after [0-9.]+s\]/.test(text)) {
    out.timed_out = true;
    out.is_error = true;
  }
  if (/\[still running after [0-9.]+s\s*·\s*promoted to job /.test(text)) {
    out.promoted_job = true;
  }
  if (/\[truncated\s*·\s*\d+ bytes total|\[showing \d+ matches \(capped at \d+\)/.test(text)) {
    out.truncated = true;
  }
  const matchCount = text.match(/\[(?:showing )?(\d+) matches?(?: \(capped at \d+\))?\]/i);
  if (matchCount) out.search_matches = Number(matchCount[1]);

  const batchErrCount = (text.match(/\): (?:rejected|fulfilled \(downstream isError\))/g) || []).length;
  if (batchErrCount > 0) {
    out.batch_failed = batchErrCount;
    out.is_error = true;
  }
  if (out.is_error) {
    const codeMatch = text.match(/\\?"(?:error_code|code)\\?"\s*:\s*\\?"([A-Z][A-Z0-9_]{2,48})\\?"/)
      ?? text.match(/\b(ENOENT|EACCES|EISDIR|ENOTDIR|EEXIST|TIMEOUT|ROOT_NOT_AUTHORIZED|BROAD_ROOT_NOT_ALLOWED|INVALID_WORKSPACE_ROOT|INVALID_ARGUMENTS|SCHEMA_MISMATCH|DOWNSTREAM_UNAVAILABLE|INNER_START_FAILED|BACKEND_UNAVAILABLE|BACKEND_CONNECTION_FAILED|UNKNOWN_SERVER|UNKNOWN_TOOL|EDIT_PARTIAL|POLICY_CHANGED|MCP_ERROR_-32602)\b/);
    if (codeMatch) out.error_code = codeMatch[1];
  }
  if (/\\?"mode\\?"\s*:\s*\\?"auto_indexing\\?"|\\?"status\\?"\s*:\s*\\?"indexing\\?"/.test(text)) {
    out.satori_auto_indexing = true;
  }
  return out;
}

export function createResponseTelemetryObserver({ maxSnippetBytes = 2048 } = {}) {
  let wireBytes = 0;
  let headBuf = Buffer.alloc(0);
  let tailBuf = Buffer.alloc(0);
  let fullBuf = Buffer.alloc(0);
  let fullOverflow = false;

  return {
    observe(chunk) {
      if (!chunk) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      wireBytes += buf.length;
      if (!fullOverflow) {
        if (fullBuf.length + buf.length <= MAX_SNIPPET_DECODE_BYTES) {
          fullBuf = fullBuf.length === 0 ? Buffer.from(buf) : Buffer.concat([fullBuf, buf]);
        } else {
          fullOverflow = true;
          fullBuf = Buffer.alloc(0);
        }
      }
      if (headBuf.length < maxSnippetBytes) {
        const take = buf.subarray(0, maxSnippetBytes - headBuf.length);
        headBuf = headBuf.length === 0 ? Buffer.from(take) : Buffer.concat([headBuf, take]);
      }
      if (buf.length >= maxSnippetBytes) {
        tailBuf = Buffer.from(buf.subarray(buf.length - maxSnippetBytes));
      } else if (tailBuf.length + buf.length <= maxSnippetBytes) {
        tailBuf = tailBuf.length === 0 ? Buffer.from(buf) : Buffer.concat([tailBuf, buf]);
      } else {
        const combined = Buffer.concat([tailBuf, buf]);
        tailBuf = Buffer.from(combined.subarray(combined.length - maxSnippetBytes));
      }
    },

    finalize({ rewrittenText = null, contentEncoding = '', rpcMethod = null } = {}) {
      if (typeof rewrittenText === 'string') {
        const resBytes = Buffer.byteLength(rewrittenText, 'utf8');
        return {
          res_bytes: resBytes,
          est_res_tokens: estimateTokens(resBytes),
          ...inspectResponseTextSignals(rewrittenText, { rpcMethod }),
        };
      }
      const enc = String(contentEncoding || '').trim().toLowerCase();
      if (enc && enc !== 'identity') {
        if (!fullOverflow && fullBuf.length > 0) {
          try {
            const decoded = (enc === 'gzip' || enc === 'x-gzip')
              ? zlib.gunzipSync(fullBuf, { maxOutputLength: MAX_SNIPPET_DECODE_BYTES * 4 })
              : enc === 'deflate'
                ? zlib.inflateSync(fullBuf, { maxOutputLength: MAX_SNIPPET_DECODE_BYTES * 4 })
                : enc === 'br'
                  ? zlib.brotliDecompressSync(fullBuf, { maxOutputLength: MAX_SNIPPET_DECODE_BYTES * 4 })
                  : null;
            if (decoded) {
              return {
                res_bytes: decoded.length,
                wire_bytes: wireBytes,
                est_res_tokens: estimateTokens(decoded.length),
                ...inspectResponseTextSignals(decoded.toString('utf8'), { rpcMethod }),
              };
            }
          } catch {
            // Fall through to compressed wire-bytes-only summary.
          }
        }
        return {
          res_bytes: wireBytes,
          est_res_tokens: estimateTokens(wireBytes),
          compressed: true,
        };
      }
      const sampleText = wireBytes <= maxSnippetBytes * 2 && !fullOverflow && fullBuf.length > 0
        ? fullBuf.toString('utf8')
        : `${headBuf.toString('utf8')}\n${tailBuf.toString('utf8')}`;
      return {
        res_bytes: wireBytes,
        est_res_tokens: estimateTokens(wireBytes),
        ...inspectResponseTextSignals(sampleText, { rpcMethod }),
      };
    },
  };
}

export function buildTelemetryRecord({
  requestId,
  sessionKey,
  clientRule,
  clientInfo,
  rpcBudgetSeconds,
  reqTelemetry,
  resTelemetry,
  status,
  outcome,
  durationMs,
  wakeMs,
  blockedWrite = false,
  rewrittenFallback = false,
  schemaHintSent = false,
  nudgeSent = null,
}) {
  const rec = {
    v: 1,
    ts: new Date().toISOString(),
    request_id: requestId,
    session: hashOpaqueSession(sessionKey),
    client: clientRule || 'default',
    ...(clientInfo ? { client_info: String(clientInfo).slice(0, 64) } : {}),
    ...reqTelemetry,
    status,
    outcome,
    duration_ms: durationMs,
    ...(typeof wakeMs === 'number' && wakeMs >= 50 ? { wake_ms: wakeMs } : {}),
    ...(typeof rpcBudgetSeconds === 'number' ? {
      rpc_budget_s: rpcBudgetSeconds,
      budget_pct: Math.round((durationMs / (rpcBudgetSeconds * 1000)) * 100),
    } : {}),
    ...resTelemetry,
  };
  if (status >= 400 || outcome === 'disconnected') rec.is_error = true;
  if (blockedWrite) rec.blocked_write = true;
  if (rewrittenFallback) rec.rewritten_fallback = true;
  if (schemaHintSent) rec.schema_hint_sent = true;
  if (nudgeSent) rec.nudge_sent = nudgeSent;
  return rec;
}
