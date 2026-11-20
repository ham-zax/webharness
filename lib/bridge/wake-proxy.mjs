import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHttpDiagnosticLog } from './http-diagnostics.mjs';
import { callId } from '../../providers/pi-dev/call-diagnostics.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasActiveRuntimeLeases } from '../runtime-leases.mjs';
import {
  appendHintToMcpJsonPayload,
  appendHintToMcpSsePayload,
  appendSchemaHintToMcpJsonPayload,
  appendSchemaHintToMcpSsePayload,
  createConnectorPolicyLoader,
  detectDevWriteToolCall,
  extractDirectOuterDevToolName,
  extractInitializeClientInfo,
  filterMcpJsonPayload,
  filterMcpSsePayload,
  injectRpcBudgetMeta,
  inspectBlockedConnectorToolCall,
  inspectBlockedConnectorToolCallPrefix,
  isInitializeRequest,
  isPaginatedToolsListRequest,
  isWebSessionAdapterRequest,
  resolveConnectorClientPolicy,
  rewriteConnectorFallbackDevCall,
  shouldFilterResponseForRequest,
  urlAllowsLocalFallback,
} from './connector-policy.mjs';

const MAX_INSPECT_POST_BYTES = 256 * 1024;
const MAX_FILTER_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_NUDGE_RESPONSE_BYTES = 128 * 1024;
const MAX_SCHEMA_HINT_RESPONSE_BYTES = 4 * 1024;
const MAX_NUDGE_SSE_HOLD_MS = 1_500;
const MAX_SCHEMA_HINT_SSE_HOLD_MS = 150;
const MAX_DRAIN_BLOCKED_BYTES = 1024 * 1024;
const DRAIN_BLOCKED_TIMEOUT_MS = 2_000;
const DEFAULT_PREFIX_READ_TIMEOUT_MS = 15_000;

function drainBoundedRemainder(req, maxBytes = MAX_DRAIN_BLOCKED_BYTES, timeoutMs = DRAIN_BLOCKED_TIMEOUT_MS) {
  if (req.readableEnded) return Promise.resolve(true);
  if (req.destroyed || req.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let drained = 0;
    let settled = false;
    let timer;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onFail);
      req.off('aborted', onFail);
      if (!ok) req.pause();
      resolve(ok);
    };
    const onData = chunk => {
      drained += chunk.length;
      if (drained > maxBytes) finish(false);
    };
    const onEnd = () => finish(true);
    const onFail = () => finish(false);
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onFail);
    req.once('aborted', onFail);
    req.resume();
  });
}

function sessionCatalogKey(req, respHeaders = null) {
  const sid = respHeaders?.['mcp-session-id'] || req.headers['mcp-session-id'];
  const authDigest = req.headers.authorization
    ? crypto.createHash('sha256').update(String(req.headers.authorization)).digest('hex').slice(0, 24)
    : null;
  let principal;
  if (sid && authDigest) {
    principal = `sid:${sid}|auth:${authDigest}`;
  } else if (sid) {
    principal = `sid:${sid}`;
  } else if (authDigest) {
    principal = `auth:${authDigest}`;
  } else {
    const ua = String(req.headers['user-agent'] ?? '').trim().slice(0, 160);
    const uaDigest = ua ? crypto.createHash('sha256').update(ua).digest('hex').slice(0, 16) : '';
    principal = uaDigest ? `anon:${uaDigest}` : '__anon__';
  }
  return `${principal}\0${req.url || '/mcp'}`;
}

function readBoundedPrefix(req, maxBytes, timeoutMs = DEFAULT_PREFIX_READ_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const onData = chunk => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.pause();
        cleanup();
        resolve({ buffer: Buffer.concat(chunks), exceeded: true });
      }
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ buffer: Buffer.concat(chunks), exceeded: false });
    };
    const onError = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('request aborted'));
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const err = new Error('Request body prefix read timed out');
        err.code = 'PREFIX_TIMEOUT';
        reject(err);
      }, timeoutMs);
      timer.unref?.();
    }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

function decodeResponseBody(rawBuf, contentEncoding, maxOutputLength = MAX_DECOMPRESSED_BYTES) {
  const enc = String(contentEncoding || '').trim().toLowerCase();
  if (!enc || enc === 'identity') return { ok: true, buffer: rawBuf, decoded: false };
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return { ok: true, buffer: zlib.gunzipSync(rawBuf, { maxOutputLength }), decoded: true };
    if (enc === 'deflate') return { ok: true, buffer: zlib.inflateSync(rawBuf, { maxOutputLength }), decoded: true };
    if (enc === 'br') return { ok: true, buffer: zlib.brotliDecompressSync(rawBuf, { maxOutputLength }), decoded: true };
  } catch {
    return { ok: false };
  }
  return { ok: false };
}

export function createWakeProxy({ port, backendPort, idleMs = 1800000, startupMs = 30000,
  maxQueued = 64, prefixReadTimeoutMs = DEFAULT_PREFIX_READ_TIMEOUT_MS,
  hasActiveLeases = async () => false, startBackend, stopBackend,
  connectorPolicy = createConnectorPolicyLoader(),
  onDiagnostic = record => process.stderr.write(`${JSON.stringify(record)}\n`) }) {
  let state = 'asleep', active = 0, pending = 0, startPromise, stopPromise, timer, closing = false, lastFailure = false;
  const sessions = new Map();
  let lastWarnedPolicySig = null;
  const MAX_SESSION_CATALOGS = 256;
  const WRITE_NUDGE_WINDOW_MS = 30_000;
  const WRITE_NUDGE_THRESHOLD = 3;
  const updateSession = (sessionKey, updater) => {
    const existing = sessions.get(sessionKey) ?? {
      outerTools: null,
      hiddenTools: null,
      clientInfoName: null,
      writeHistory: null,
    };
    const next = typeof updater === 'function' ? updater(existing) : { ...existing, ...updater };
    sessions.delete(sessionKey);
    sessions.set(sessionKey, next);
    if (sessions.size > MAX_SESSION_CATALOGS) {
      sessions.delete(sessions.keys().next().value);
    }
    return next;
  };
  const recordSessionCatalog = (sessionKey, outerTools, hiddenTools, { merge = false } = {}) => {
    if (!outerTools || outerTools.size === 0) return;
    updateSession(sessionKey, existing => ({
      ...existing,
      outerTools: merge && existing.outerTools ? new Set([...existing.outerTools, ...outerTools]) : new Set(outerTools),
      hiddenTools: hiddenTools instanceof Set
        ? (merge && existing.hiddenTools ? new Set([...existing.hiddenTools, ...hiddenTools]) : new Set(hiddenTools))
        : existing.hiddenTools,
    }));
  };
  // Count writes 1–2 at ingress without buffering responses; claim a single in-flight
  // nudge slot on write 3+ so only that response buffers to append the tip.
  const recordIngressDevWriteAndTryClaimNudge = sessionKey => {
    const now = Date.now();
    const entry = sessions.get(sessionKey)?.writeHistory ?? { times: [], lastNudgedAt: 0, inFlightNudge: false };
    const recent = entry.times.filter(t => now - t <= WRITE_NUDGE_WINDOW_MS);
    const shouldNudge = !entry.inFlightNudge
      && recent.length >= (WRITE_NUDGE_THRESHOLD - 1)
      && (now - entry.lastNudgedAt) > WRITE_NUDGE_WINDOW_MS;
    if (!shouldNudge && !entry.inFlightNudge) {
      recent.push(now);
    }
    updateSession(sessionKey, existing => ({
      ...existing,
      writeHistory: {
        times: recent,
        lastNudgedAt: entry.lastNudgedAt,
        inFlightNudge: shouldNudge ? true : entry.inFlightNudge,
      },
    }));
    return shouldNudge;
  };
  const releaseDevWriteNudgeClaim = sessionKey => {
    const existing = sessions.get(sessionKey);
    if (!existing?.writeHistory?.inFlightNudge) return;
    updateSession(sessionKey, s => ({
      ...s,
      writeHistory: { ...s.writeHistory, inFlightNudge: false },
    }));
  };
  const commitDevWriteNudge = sessionKey => {
    updateSession(sessionKey, existing => ({
      ...existing,
      writeHistory: {
        times: [],
        lastNudgedAt: Date.now(),
        inFlightNudge: false,
      },
    }));
  };
  for (const [name, value] of Object.entries({ idleMs, startupMs, maxQueued })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  let idleGeneration = 0, startupController, managedClosing = false;
  const sockets = new Set();
  const cancelIdle = () => { idleGeneration++; clearTimeout(timer); timer = undefined; };
  const stop = async () => {
    cancelIdle();
    if (stopPromise) return stopPromise;
    state = 'stopping';
    stopPromise = Promise.resolve().then(stopBackend).then(() => { state = 'asleep'; }, () => { state = 'failed'; })
      .finally(() => { stopPromise = undefined; });
    return stopPromise;
  };
  const armIdle = () => {
    cancelIdle();
    const generation = idleGeneration;
    if (!closing && state === 'ready' && active === 0) timer = setTimeout(async () => {
      try {
        const pinned = await hasActiveLeases();
        if (!closing && generation === idleGeneration && state === 'ready' && active === 0) {
          if (pinned) armIdle(); else await stop();
        }
      } catch { if (generation === idleGeneration) armIdle(); } // An unreadable lease must not evict live work.
    }, idleMs);
  };
  const probeBackend = () => new Promise(resolve => {
    const probe = http.get({ hostname: '127.0.0.1', port: backendPort, path: '/health/ready', timeout: 1000 }, response => {
      response.resume(); resolve(response.statusCode === 200);
    });
    probe.once('error', () => resolve(false));
    probe.once('timeout', () => { probe.destroy(); resolve(false); });
  });
  const recoverBackend = async () => {
    if (closing || state !== 'failed' || startPromise || stopPromise) return;
    if (!await probeBackend()) return;
    // Reconcile stale failure state without stopping a healthy backend or its streams.
    // A concurrent lifecycle transition owns its own result.
    if (!closing && state === 'failed' && !startPromise && !stopPromise) {
      state = 'ready'; lastFailure = false; armIdle();
    }
  };
  const ensureReady = async () => {
    cancelIdle();
    await recoverBackend();
    if (stopPromise) await stopPromise;
    if (closing) throw new Error('shutting down');
    if (state === 'ready') return;
    if (!startPromise) {
      if (state === 'failed') {
        if (active > 1) throw new Error('Backend recovery waits for in-flight requests');
        await stop();
      }
      state = 'starting';
      const controller = new AbortController();
      startupController = controller;
      const launch = Promise.resolve().then(() => startBackend(controller.signal));
      const cancelled = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      const startupTimer = setTimeout(() => controller.abort(new Error('Backend startup timed out')), startupMs);
      startPromise = Promise.race([launch, cancelled]).then(() => {
        if (closing || controller.signal.aborted) throw new Error('shutting down');
        state = 'ready'; lastFailure = false;
      }).catch(async (error) => {
        lastFailure = true; state = 'failed';
        controller.abort(error);
        // The startup callback must settle only after its controller is reaped.
        // Cleanup then runs after startup can no longer create another backend.
        await launch.catch(() => {});
        if (!managedClosing) await stop();
        state = 'failed'; throw error;
      }).finally(() => {
        clearTimeout(startupTimer); startPromise = undefined; startupController = undefined;
      });
    }
    await startPromise;
  };
  const server = http.createServer(async (req, res) => {
    const pathname = req.url?.split('?')[0];
    if (pathname === '/health/ready' || pathname === '/health/live') {
      await recoverBackend();
      let healthy = !closing && !lastFailure && state !== 'failed';
      if (healthy && state === 'ready') {
        healthy = await probeBackend();
      }
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ status: healthy ? 'available' : 'failed', backend: state }));
      return;
    }
    const requestId = callId(req.headers['x-webharness-request-id']);
    const startedAt = performance.now();
    let forwarded = false;
    let resolvedClientPolicy = null;
    const diagnose = (event, fields = {}) => {
      try { onDiagnostic({ timestamp: new Date().toISOString(), event, layer: 'wake-proxy', request_id: requestId, ...fields }); } catch {}
    };
    res.setHeader('x-webharness-request-id', requestId);
    diagnose('http_started');
    res.once('close', () => diagnose('http_completed', {
      status: res.statusCode, outcome: res.writableFinished ? 'finished' : 'disconnected',
      forwarded, duration_ms: Math.round(performance.now() - startedAt),
      ...(resolvedClientPolicy ? {
        matched_rule: resolvedClientPolicy.matchedRule,
        rpc_budget_seconds: resolvedClientPolicy.rpcBudgetSeconds,
      } : {}),
    }));
    if (closing || pending >= maxQueued) { res.writeHead(503); res.end('Gateway unavailable'); return; }
    const loadedPolicy = (pathname === '/mcp' && req.method === 'POST' && !isWebSessionAdapterRequest(req.headers))
      ? connectorPolicy()
      : null;
    if (loadedPolicy?.warnings?.length > 0 && loadedPolicy._sig !== lastWarnedPolicySig) {
      lastWarnedPolicySig = loadedPolicy._sig;
      diagnose('connector_policy_parse_warning', { warnings: loadedPolicy.warnings.slice(0, 8) });
    }
    const applyConnectorPolicy = Boolean(loadedPolicy && (
      loadedPolicy.default?.connectorWriteTools === false
      || loadedPolicy.default?.compatAnnotations === true
      || loadedPolicy.default?.rpcBudgetSeconds != null
      || (Array.isArray(loadedPolicy.clients) && loadedPolicy.clients.some(c =>
        c?.connectorWriteTools === false || c?.compatAnnotations === true || c?.rpcBudgetSeconds != null
      ))
      || (Array.isArray(loadedPolicy.clients) && loadedPolicy.clients.length > 0)
      || loadedPolicy.logClientIdentifiers === true
      || loadedPolicy.connectorWriteTools === false
    ));

    pending++; active++; cancelIdle();
    let upstream;
    let released = false;
    const release = () => { if (!released) { released = true; active--; armIdle(); } };
    res.once('close', () => { upstream?.destroy(); release(); });
    req.once('aborted', () => { upstream?.destroy(); release(); });
    // Pause incoming bodies while the backend starts unless we inspect a bounded prefix first.
    if (!applyConnectorPolicy) req.pause();
    let timeout;
    let nudgeClaimed = false;
    let activeSessionKey = null;
    const releaseNudge = () => {
      if (nudgeClaimed && activeSessionKey) {
        nudgeClaimed = false;
        releaseDevWriteNudgeClaim(activeSessionKey);
      }
    };
    res.once('close', releaseNudge);
    try {
      let bufferedReqBody = null;
      let rewrittenToolName = null;
      let schemaHintToolName = null;
      let filterResponse = false;
      let paginatedToolsList = false;
      let appendRunScriptHint = false;
      let activeClientPolicy = null;
      let initClientInfo = null;
      let sessionCanUseFallback = false;
      if (applyConnectorPolicy) {
        let prefix;
        try {
          prefix = await readBoundedPrefix(req, MAX_INSPECT_POST_BYTES, prefixReadTimeoutMs);
        } catch (error) {
          if (error?.code === 'PREFIX_TIMEOUT' && !res.destroyed && !res.headersSent) {
            res.writeHead(408, { 'content-type': 'text/plain', 'connection': 'close', 'cache-control': 'no-store' });
            res.end('Request body timeout');
            req.destroy();
            return;
          }
          if (!res.destroyed) res.destroy();
          return;
        }
        if (res.destroyed || req.aborted || closing) {
          if (closing && !res.destroyed && !res.headersSent) { res.writeHead(503); res.end('Gateway unavailable'); }
          return;
        }
        const bodyText = prefix.buffer.toString('utf8');
        const sessionKey = sessionCatalogKey(req);
        activeSessionKey = sessionKey;
        const reqIsInit = !prefix.exceeded && isInitializeRequest(bodyText);
        if (reqIsInit) {
          initClientInfo = extractInitializeClientInfo(bodyText);
          // Cache clientInfo on identified sessions or bearer principals; anonymous
          // pre-session initialize requests wait for 1MCP to assign mcp-session-id.
          if (initClientInfo && (req.headers['mcp-session-id'] || req.headers.authorization)) {
            updateSession(sessionKey, { clientInfoName: initClientInfo.name });
          }
        }
        const sessionState = sessions.get(sessionKey) ?? null;
        const knownClientInfoName = reqIsInit
          ? (initClientInfo?.name ?? null)
          : (sessionState?.clientInfoName ?? null);
        activeClientPolicy = resolveConnectorClientPolicy(loadedPolicy, {
          url: req.url,
          headers: req.headers,
          clientInfoName: knownClientInfoName,
        });
        resolvedClientPolicy = activeClientPolicy;
        const hideWriteTools = activeClientPolicy.connectorWriteTools === false;
        const compatAnnotations = activeClientPolicy.compatAnnotations === true;
        const observedForSession = sessionState?.outerTools ?? null;
        const hiddenForSession = sessionState?.hiddenTools ?? null;

        if (!prefix.exceeded && shouldFilterResponseForRequest(bodyText)) {
          diagnose('connector_client_identified', {
            user_agent: String(req.headers['user-agent'] || '').slice(0, 160),
            client_info: typeof knownClientInfoName === 'string' ? knownClientInfoName.slice(0, 160) : null,
            query_client: typeof activeClientPolicy.queryClient === 'string' ? activeClientPolicy.queryClient.slice(0, 160) : null,
            matched_rule: activeClientPolicy.matchedRule,
            connector_write_tools: activeClientPolicy.connectorWriteTools,
            compat_annotations: compatAnnotations,
            banner: activeClientPolicy.banner,
            rpc_budget_seconds: activeClientPolicy.rpcBudgetSeconds,
          });
        }

        // Fail closed on blocking too: only block direct writes once local_fallback_dispatch
        // has been positively observed for this session/token/URL catalog so cold-restarted
        // restricted / trusted-dev / tag:dev-only clients are never bricked.
        sessionCanUseFallback = hideWriteTools
          && observedForSession instanceof Set
          && (observedForSession.has('local_fallback_dispatch') || observedForSession.has('fallback_dispatch'));
        const blocked = sessionCanUseFallback
          ? (prefix.exceeded
            ? inspectBlockedConnectorToolCallPrefix(bodyText, hiddenForSession)
            : inspectBlockedConnectorToolCall(bodyText, hiddenForSession))
          : null;
        if (blocked !== null) {
          let drained = true;
          if (prefix.exceeded) {
            drained = await drainBoundedRemainder(req);
          }
          if (res.destroyed || req.aborted) return;
          const payload = Buffer.from(blocked, 'utf8');
          const respHeaders = {
            'content-type': 'application/json',
            'content-length': String(payload.length),
            'cache-control': 'no-store',
          };
          if (!drained) respHeaders.connection = 'close';
          res.writeHead(200, respHeaders);
          res.end(payload);
          return;
        }
        if (!prefix.exceeded) {
          if (hideWriteTools && detectDevWriteToolCall(bodyText)) {
            appendRunScriptHint = recordIngressDevWriteAndTryClaimNudge(sessionKey);
            nudgeClaimed = appendRunScriptHint;
          }
          const rewrittenReq = hideWriteTools
            ? rewriteConnectorFallbackDevCall(bodyText, observedForSession)
            : null;
          let workingReqBody = rewrittenReq !== null ? rewrittenReq.body : bodyText;
          if (rewrittenReq !== null) {
            rewrittenToolName = rewrittenReq.rewrittenName;
          }
          if (activeClientPolicy.rpcBudgetSeconds != null) {
            workingReqBody = injectRpcBudgetMeta(workingReqBody, activeClientPolicy.rpcBudgetSeconds * 1000);
          }
          bufferedReqBody = workingReqBody !== bodyText
            ? Buffer.from(workingReqBody, 'utf8')
            : prefix.buffer;
          // Only watch for 1MCP's bare schema_input_invalid on fast-pathed dev_* calls
          // or direct outer dev_* calls when connector policy is active for this client
          // (never on un-rewritten local_fallback_dispatch, which LocalToolBroker enriches,
          // and never on permissive clients).
          schemaHintToolName = rewrittenToolName
            ?? ((hideWriteTools || compatAnnotations) ? extractDirectOuterDevToolName(bodyText) : null);
          filterResponse = (hideWriteTools || compatAnnotations) && shouldFilterResponseForRequest(bodyText);
          paginatedToolsList = filterResponse && isPaginatedToolsListRequest(bodyText);
        } else {
          // Oversized POST body (>256 KiB) cannot be initialize/tools/list; forward prefix + remainder.
          bufferedReqBody = { prefix: prefix.buffer, streamRemainder: true };
        }
      }

      await Promise.race([ensureReady(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Backend startup timed out')), startupMs);
      })]);
      if (res.destroyed || req.aborted || closing) { releaseNudge(); return; }
      forwarded = true;
      diagnose('http_forwarding');
      const forwardHeaders = { ...req.headers, 'x-webharness-request-id': requestId };
      if (Buffer.isBuffer(bufferedReqBody)) {
        delete forwardHeaders['transfer-encoding'];
        forwardHeaders['content-length'] = String(bufferedReqBody.length);
      }
      if (rewrittenToolName && forwardHeaders['mcp-name'] === 'local_fallback_dispatch') {
        forwardHeaders['mcp-name'] = rewrittenToolName;
      }
      const watchSchemaHint = Boolean(schemaHintToolName);
      if (filterResponse || appendRunScriptHint || watchSchemaHint) {
        forwardHeaders['accept-encoding'] = 'identity';
      }
      upstream = http.request({ hostname: '127.0.0.1', port: backendPort,
        method: req.method, path: req.url, headers: forwardHeaders }, (response) => {
        const headers = [];
        if (initClientInfo && response.headers['mcp-session-id']) {
          updateSession(sessionCatalogKey(req, response.headers), { clientInfoName: initClientInfo.name });
        }
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        const isSse = contentType.includes('text/event-stream');
        const shouldRewrite = (filterResponse || appendRunScriptHint || watchSchemaHint)
          && response.statusCode >= 200 && response.statusCode < 300
          && (contentType.includes('application/json') || isSse);
        if (shouldRewrite) {
          const maxBufferBytes = filterResponse
            ? MAX_FILTER_RESPONSE_BYTES
            : (appendRunScriptHint ? MAX_NUDGE_RESPONSE_BYTES : MAX_SCHEMA_HINT_RESPONSE_BYTES);
          const maxSseHoldMs = appendRunScriptHint ? MAX_NUDGE_SSE_HOLD_MS : MAX_SCHEMA_HINT_SSE_HOLD_MS;
          const respChunks = [];
          let respBytes = 0;
          let passthrough = false;
          let sseHoldTimer;
          const onResponseError = () => { clearTimeout(sseHoldTimer); releaseNudge(); res.destroy(); };
          const flushPassthrough = () => {
            clearTimeout(sseHoldTimer);
            if (passthrough || res.destroyed) return;
            passthrough = true;
            releaseNudge();
            response.off('data', onData);
            response.off('end', onEnd);
            for (let i = 0; i < response.rawHeaders.length; i += 2) {
              if (response.rawHeaders[i].toLowerCase() !== 'x-webharness-request-id') headers.push(response.rawHeaders[i], response.rawHeaders[i + 1]);
            }
            res.writeHead(response.statusCode, headers);
            for (const c of respChunks) res.write(c);
            respChunks.length = 0;
            response.once('end', () => res.addTrailers(response.trailers));
            response.pipe(res);
          };
          const onData = chunk => {
            respChunks.push(chunk);
            respBytes += chunk.length;
            if (respBytes > maxBufferBytes) {
              if (filterResponse) {
                clearTimeout(sseHoldTimer);
                respChunks.length = 0;
                response.off('data', onData);
                response.off('end', onEnd);
                response.off('error', onResponseError);
                response.on('error', () => {});
                if (!res.destroyed && !res.headersSent) {
                  res.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
                  res.end('Backend response exceeded connector policy filter limit');
                }
                response.destroy();
                return;
              }
              flushPassthrough();
            }
          };
          const onEnd = () => {
            clearTimeout(sseHoldTimer);
            if (res.destroyed || passthrough) return;
            const rawBuf = Buffer.concat(respChunks);
            const decoded = decodeResponseBody(rawBuf, response.headers['content-encoding']);
            if (!decoded.ok) {
              releaseNudge();
              if (filterResponse) {
                res.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
                res.end('Unsupported backend content encoding for connector policy filtering');
                return;
              }
              for (let i = 0; i < response.rawHeaders.length; i += 2) {
                if (response.rawHeaders[i].toLowerCase() !== 'x-webharness-request-id') headers.push(response.rawHeaders[i], response.rawHeaders[i + 1]);
              }
              res.writeHead(response.statusCode, headers);
              res.end(rawBuf);
              return;
            }
            const rawText = decoded.buffer.toString('utf8');
            let rewritten = null;
            if (filterResponse) {
              const respSessionKey = sessionCatalogKey(req, response.headers);
              const priorCatalog = sessions.get(respSessionKey)?.outerTools ?? sessions.get(sessionCatalogKey(req))?.outerTools ?? null;
              const priorHasFallback = priorCatalog instanceof Set
                && (priorCatalog.has('local_fallback_dispatch') || priorCatalog.has('fallback_dispatch'));
              const knownHasFallback = Boolean(paginatedToolsList && priorHasFallback);
              const allowBannerWithoutTools = urlAllowsLocalFallback(req.url)
                && (!(priorCatalog instanceof Set) || priorHasFallback);
              const observedOuterTools = new Set();
              const observedHiddenTools = new Set();
              const filterOpts = {
                knownHasFallback,
                allowBannerWithoutTools,
                hideWriteTools: activeClientPolicy?.connectorWriteTools === false,
                compatAnnotations: activeClientPolicy?.compatAnnotations === true,
                banner: activeClientPolicy?.banner ?? 'default',
                rpcBudgetSeconds: activeClientPolicy?.rpcBudgetSeconds ?? null,
              };
              rewritten = isSse
                ? filterMcpSsePayload(rawText, observedHiddenTools, observedOuterTools, filterOpts)
                : filterMcpJsonPayload(rawText, observedHiddenTools, observedOuterTools, filterOpts);
              if (observedOuterTools.size > 0) {
                recordSessionCatalog(respSessionKey, observedOuterTools, observedHiddenTools, { merge: paginatedToolsList });
              }
            } else {
              let working = rawText;
              if (watchSchemaHint) {
                const hintOpts = { includeLocalSchemaHint: sessionCanUseFallback };
                const schemaEnriched = isSse
                  ? appendSchemaHintToMcpSsePayload(working, schemaHintToolName, hintOpts)
                  : appendSchemaHintToMcpJsonPayload(working, schemaHintToolName, hintOpts);
                if (schemaEnriched !== null) {
                  working = schemaEnriched;
                  rewritten = working;
                }
              }
              if (appendRunScriptHint) {
                const nudged = isSse ? appendHintToMcpSsePayload(working) : appendHintToMcpJsonPayload(working);
                if (nudged !== null) {
                  rewritten = nudged;
                  nudgeClaimed = false;
                  commitDevWriteNudge(activeSessionKey ?? sessionCatalogKey(req));
                } else {
                  releaseNudge();
                }
              }
            }
            const finalBuf = rewritten !== null ? Buffer.from(rewritten, 'utf8') : decoded.buffer;
            for (let i = 0; i < response.rawHeaders.length; i += 2) {
              const name = response.rawHeaders[i].toLowerCase();
              if (name === 'x-webharness-request-id' || name === 'content-length' || name === 'transfer-encoding') continue;
              if (decoded.decoded && name === 'content-encoding') continue;
              headers.push(response.rawHeaders[i], response.rawHeaders[i + 1]);
            }
            headers.push('content-length', String(finalBuf.length));
            res.writeHead(response.statusCode, headers);
            res.end(finalBuf);
          };
          // Do not delay keepalives on long-running SSE tool calls for best-effort hints.
          if (!filterResponse && isSse) {
            sseHoldTimer = setTimeout(flushPassthrough, maxSseHoldMs);
            sseHoldTimer.unref?.();
          }
          response.on('data', onData);
          response.on('error', onResponseError);
          response.once('end', onEnd);
          return;
        }
        releaseNudge();
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          if (response.rawHeaders[i].toLowerCase() !== 'x-webharness-request-id') headers.push(response.rawHeaders[i], response.rawHeaders[i + 1]);
        }
        res.writeHead(response.statusCode, headers);
        response.on('error', () => res.destroy());
        response.once('end', () => res.addTrailers(response.trailers));
        response.pipe(res);
      });
      upstream.on('error', () => {
        releaseNudge();
        diagnose('http_failed', { error_code: 'BACKEND_CONNECTION_FAILED', mutation_state: 'unknown' });
        // Never replay a request: it may already have performed a mutation.
        state = 'failed'; lastFailure = true; cancelIdle();
        if (!res.headersSent) { res.writeHead(502); res.end('Backend connection failed'); }
        else res.destroy();
      });
      if (Buffer.isBuffer(bufferedReqBody)) {
        upstream.end(bufferedReqBody);
      } else if (bufferedReqBody && bufferedReqBody.streamRemainder) {
        if (req.readableEnded) {
          upstream.addTrailers(req.trailers);
          upstream.end(bufferedReqBody.prefix);
        } else {
          upstream.write(bufferedReqBody.prefix);
          req.once('end', () => upstream.addTrailers(req.trailers));
          req.pipe(upstream);
          req.resume();
        }
      } else {
        req.once('end', () => upstream.addTrailers(req.trailers));
        req.pipe(upstream);
        req.resume();
      }
    } catch {
      releaseNudge();
      diagnose('http_failed', { error_code: 'BACKEND_UNAVAILABLE', mutation_state: forwarded ? 'unknown' : 'not_forwarded' });
      if (!res.destroyed) { res.writeHead(503); res.end('Backend unavailable'); }
    } finally { clearTimeout(timeout); pending--; armIdle(); }
  });
  const rejectUpgrade = (_req, socket) => { socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
  server.on('connect', rejectUpgrade); server.on('upgrade', rejectUpgrade);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }),
    close: async ({ managed = false } = {}) => {
      closing = true; managedClosing = managed; startupController?.abort(new Error('shutting down'));
      cancelIdle(); server.close();
      for (const socket of sockets) socket.destroy();
      if (startPromise) await startPromise.catch(() => {});
      if (!managed) await stop();
    },
  };
}

// Each controller has its own process group. Abort terminates and reaps it
// before the caller runs the existing scoped backend cleanup. 1MCP's own
// setsid group remains owned by common.sh and is stopped by that cleanup.
export function runBackendControl(control, action, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [control, action], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    let aborted = false, termination;
    const killGroup = kind => {
      if (!child.pid) return;
      try { process.kill(-child.pid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const abort = () => {
      if (aborted) return;
      aborted = true;
      killGroup('SIGTERM');
      termination = new Promise(done => setTimeout(() => { killGroup('SIGKILL'); done(); }, 500));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', async code => {
      signal?.removeEventListener('abort', abort);
      if (termination) await termination;
      if (aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error(`${action} exited ${code}`));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const control = fileURLToPath(new URL('./backend-control.sh', import.meta.url));
  const stateRoot = process.env.BRIDGE_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'mcp-dev-bridge');
  const diagnostics = createHttpDiagnosticLog(path.join(stateRoot, 'logs', 'wake-proxy-calls.log'));
  const proxy = createWakeProxy({ port: Number(process.env.MCP_ONE_MCP_PORT || 3050),
    backendPort: Number(process.env.BRIDGE_BACKEND_PORT || (Number(process.env.MCP_ONE_MCP_PORT || 3050) + 10)),
    idleMs: Number(process.env.BRIDGE_WAKE_IDLE_MS || 1800000),
    startupMs: Number(process.env.BRIDGE_WAKE_STARTUP_MS || 30000),
    hasActiveLeases: () => hasActiveRuntimeLeases(process.env.MCP_LIFECYCLE_LEASE_DIR),
    startBackend: signal => runBackendControl(control, 'start', { signal }),
    stopBackend: () => runBackendControl(control, 'stop'), onDiagnostic: diagnostics.log });
  let shutdown;
  const close = managed => { shutdown ??= proxy.close({ managed }).finally(async () => { await diagnostics.flush(); process.exit(0); }); };
  process.once('SIGUSR2', () => close(true)); // Lifecycle owner stops the backend under its held lock.
  process.once('SIGTERM', () => close(false)); process.once('SIGINT', () => close(false));
  await proxy.listen();
}
