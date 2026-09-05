import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { OperationCore } from './core.mjs';
import { decodeToolName, parseCapabilityToken, parseClientNonce, parseRequest, parseUniversalRequest, renderBridgeError, renderChunk, renderOperation } from './protocol.mjs';

const host = process.env.WEBSESSION_ADAPTER_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.WEBSESSION_ADAPTER_PORT || '3051', 10);
const stateBase = process.env.XDG_STATE_HOME || join(process.env.HOME || homedir(), '.local', 'state');
const stateDir = process.env.WEBSESSION_ADAPTER_STATE_DIR || join(stateBase, 'mcp-dev-bridge', 'websession-adapter');
const evidencePath = join(stateDir, 'probe.jsonl');
const rotatedEvidencePath = `${evidencePath}.1`;
const maxEvidenceBytes = Number.parseInt(process.env.WEBSESSION_ADAPTER_MAX_EVIDENCE_BYTES || String(4 * 1024 * 1024), 10);
const configuredPublicBase = (process.env.WEBSESSION_ADAPTER_PUBLIC_URL || '').replace(/\/$/, '');
const mcpUrl = process.env.WEBSESSION_ADAPTER_MCP_URL || '';
const oauthCallbackUrl = process.env.WEBSESSION_ADAPTER_OAUTH_CALLBACK_URL || 'http://127.0.0.1:3052/callback';
const maxJsonBodyBytes = Number.parseInt(process.env.WEBSESSION_ADAPTER_MAX_JSON_BODY_BYTES || String(16 * 1024), 10);
const masterAccessTtlSeconds = 6 * 60 * 60;

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEBSESSION_ADAPTER_PORT must be 1..65535');
if (!Number.isInteger(maxEvidenceBytes) || maxEvidenceBytes < 4096) throw new Error('WEBSESSION_ADAPTER_MAX_EVIDENCE_BYTES must be at least 4096');
if (!Number.isInteger(maxJsonBodyBytes) || maxJsonBodyBytes < 1024 || maxJsonBodyBytes > 1024 * 1024) {
  throw new Error('WEBSESSION_ADAPTER_MAX_JSON_BODY_BYTES must be 1024..1048576');
}

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
chmodSync(stateDir, 0o700);
const operationCore = new OperationCore({ stateDir, mcpUrl, callbackUrl: oauthCallbackUrl });
operationCore.start();

function rotateEvidenceIfNeeded() {
  try {
    if (statSync(evidencePath).size < maxEvidenceBytes) return;
    rmSync(rotatedEvidencePath, { force: true });
    renameSync(evidencePath, rotatedEvidencePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function recordEvidence(req, url, route, extra = {}) {
  rotateEvidenceIfNeeded();
  const entry = {
    at: new Date().toISOString(),
    request_id: randomUUID(),
    route,
    method: req.method,
    path: url.pathname,
    query: url.search,
    host: req.headers.host || '',
    user_agent: req.headers['user-agent'] || '',
    forwarded_proto: req.headers['x-forwarded-proto'] || '',
    cf_ray: req.headers['cf-ray'] || '',
    ...extra,
  };
  appendFileSync(evidencePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
  chmodSync(evidencePath, 0o600);
  return entry;
}

function requestLogPath(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'v1' && parts[1] === 's') {
    return parts[3] ? `/v1/s/{secret}/${parts[3]}` : '/v1/s/{secret}';
  }
  if (parts[0] === 'v1' && parts[1] === 'operations') {
    return parts[4] === 'chunk'
      ? '/v1/operations/{secret}/{operation}/chunk/{chunk}'
      : '/v1/operations/{secret}/{operation}';
  }
  return url.pathname;
}

function sendText(res, status, body) {
  const req = res.req;
  if (req?.headers?.accept?.includes('text/html')) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    const escaped = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>WebSession Bridge</title></head><body><pre>${escaped}</pre></body></html>\n`);
    return;
  }
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(body.endsWith('\n') ? body : `${body}\n`);
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(`${JSON.stringify(value)}\n`);
}

function decodeSegment(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`invalid ${label} encoding`);
  }
}

function boundedToken(value, label) {
  const decoded = decodeSegment(value, label);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(decoded)) throw new Error(`invalid ${label}`);
  return decoded;
}

function publicBase(req) {
  if (configuredPublicBase) return configuredPublicBase;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host || `${host}:${port}`}`;
}

async function readBoundedBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleUniversalGet(req, res, parts) {
  const base = publicBase(req);

  if (parts[0] !== 'v1') {
    sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
    return true;
  }

  if (parts[1] === 'about' && parts.length === 2) {
    sendText(res, 200, [
      'WEBSESSION-MCP-BRIDGE/1',
      'state: ready',
      'universal_profile: universal-get-v1',
      'enhanced_profile: json-post-v1',
      'inline_request_max_chars: 256',
      `enhanced_json_max_bytes: ${maxJsonBodyBytes}`,
      'fast_wait_ms: 1900',
    ].join('\n'));
    return true;
  }

  if (parts[1] !== 's') {
    sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
    return true;
  }

  if (parts[3] === 'tools' && parts.length === 4) {
    const capability = parseCapabilityToken(parts[2]);
    const access = capability ? await operationCore.permittedTools(capability) : undefined;
    if (!access) {
      sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
      return true;
    }
    const lines = ['WEBSESSION-MCP-BRIDGE/1', 'state: ready', `tool_count: ${access.tools.length}`];
    access.tools.forEach((tool, index) => {
      const number = index + 1;
      lines.push(
        `tool_${number}: ${tool.name}`,
        `tool_${number}_name_b64: ${Buffer.from(tool.name, 'utf8').toString('base64url')}`,
      );
    });
    lines.push('call_path_template: /v1/s/{capability}/call/{client_nonce}/{request_b64}');
    sendText(res, 200, lines.join('\n'));
    return true;
  }

  if (parts[3] === 'tool' && parts.length === 5) {
    const capability = parseCapabilityToken(parts[2]);
    const access = capability ? await operationCore.permittedTools(capability) : undefined;
    if (!access) {
      sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
      return true;
    }
    try {
      const toolName = decodeToolName(parts[4]);
      const tool = access.tools.find(candidate => candidate.name === toolName);
      if (!tool) throw new Error('tool not found');
      const lines = [
        'WEBSESSION-MCP-BRIDGE/1',
        'state: ready',
        `tool: ${tool.name}`,
        'universal_get_confirmation: required',
        'enhanced_post_confirmation: not_required',
        'request_version: 1',
        `tool_json: ${JSON.stringify(tool)}`,
        'inline_request_max_chars: 256',
      ];
      sendText(res, 200, lines.join('\n'));
    } catch {
      sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
    }
    return true;
  }

  if (parts[3] === 'call' && parts.length === 6) {
    const capability = parseCapabilityToken(parts[2]);
    if (!capability) {
      sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
      return true;
    }
    try {
      const nonce = parseClientNonce(parts[4]);
      const parsed = parseUniversalRequest(parts[5]);
      const submitted = operationCore.submit(capability, nonce, parsed, 'universal-get-v1');
      if (submitted.unauthorized) {
        sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
        return true;
      }
      if (submitted.nonceConflict) {
        sendText(res, 200, renderBridgeError('nonce_conflict', 'client nonce was already used for a different request'));
        return true;
      }
      const statusUrl = `${base}/v1/s/${submitted.continuationToken}/op/${submitted.operation.id}`;
      const operation = submitted.operation.state === 'queued'
        ? await operationCore.waitForOperation(submitted.operation.id, 1900)
        : submitted.operation;
      const confirmation = submitted.confirmation
        ? {
            base: `${base}/v1/s/${submitted.confirmation.capability}/confirm/${submitted.operation.id}/`,
            challenge: submitted.confirmation.challenge,
            expiresMs: submitted.confirmation.expiresMs,
            summary: submitted.confirmation.summary,
          }
        : undefined;
      sendText(res, 200, renderOperation(operation, statusUrl, confirmation));
    } catch (error) {
      sendText(res, 200, renderBridgeError('invalid_request', error.message));
    }
    return true;
  }

  if (parts[3] === 'confirm' && parts.length === 6) {
    const confirmationCapability = parseCapabilityToken(parts[2]);
    const operationId = parts[4];
    const challenge = parts[5];
    if (!confirmationCapability || !/^[A-Za-z0-9_-]{16}$/.test(challenge)) {
      sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
      return true;
    }
    const confirmed = operationCore.confirm(operationId, confirmationCapability, challenge);
    if (confirmed.notFound || confirmed.authorizationInvalid || !confirmed.operation) {
      sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
      return true;
    }
    const operation = confirmed.operation.state === 'queued'
      ? await operationCore.waitForOperation(operationId, 1900)
      : confirmed.operation;
    const statusUrl = `${base}/v1/s/${confirmed.continuationToken}/op/${operationId}`;
    sendText(res, 200, renderOperation(operation, statusUrl));
    return true;
  }

  if (parts[3] === 'op' && parts[5] === 'chunk' && parts.length === 7) {
    const continuation = parseCapabilityToken(parts[2]);
    if (!continuation || !/^[1-9][0-9]{0,8}$/.test(parts[6])) {
      sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
      return true;
    }
    const operationId = parts[4];
    const chunk = operationCore.readOperationChunk(operationId, continuation, Number(parts[6]));
    if (!chunk) {
      sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
      return true;
    }
    sendText(res, 200, renderChunk(operationId, chunk));
    return true;
  }

  if (parts[3] === 'op' && parts.length === 5) {
    const continuation = parseCapabilityToken(parts[2]);
    if (!continuation) {
      sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
      return true;
    }
    const operationId = parts[4];
    const operation = operationCore.readOperation(operationId, continuation);
    if (!operation) {
      sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
      return true;
    }
    const statusUrl = `${base}/v1/s/${continuation}/op/${operation.id}`;
    sendText(res, 200, renderOperation(operation, statusUrl));
    return true;
  }

  sendText(res, 404, 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: not_found');
  return true;
}

function enhancedSnapshot(operation, statusUrl, confirmation = undefined) {
  const value = {
    protocol: 'WEBSESSION-MCP-BRIDGE/1',
    state: operation.state,
    operation_id: operation.id,
    status_url: statusUrl,
  };
  if (operation.state === 'confirmation_required' && confirmation) {
    value.confirmation_base = confirmation.base;
    value.challenge = confirmation.challenge;
    value.confirmation_expires_at = new Date(confirmation.expiresMs).toISOString();
    value.summary = confirmation.summary;
    value.instruction = 'Construct confirmation_base + challenge, or use explicit POST confirmation.';
  } else if (operation.state === 'completed') {
    const chunkCount = Number(operation.chunk_count) || 1;
    value.chunk_count = chunkCount;
    if (chunkCount > 1) value.chunk_base_url = `${statusUrl}/chunk/`;
    else value.result = operation.result_text || '';
  }
  if (['tool_failed', 'unknown_outcome', 'rejected', 'expired'].includes(operation.state)) {
    value.error = operation.error_text || operation.state;
  }
  return value;
}

function enhancedStatusUrl(base, continuationToken, operationId) {
  return `${base}/v1/operations/${continuationToken}/${operationId}`;
}

async function handleEnhancedCall(req, res) {
  const authorization = req.headers.authorization || '';
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    sendJson(res, 401, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'authorization_required' });
    return;
  }
  const capability = parseCapabilityToken(authorization.slice('Bearer '.length));
  if (!capability) {
    sendJson(res, 401, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'authorization_required' });
    return;
  }

  let nonce;
  try {
    nonce = parseClientNonce(req.headers['idempotency-key'] || '');
  } catch {
    sendJson(res, 400, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'invalid_idempotency_key' });
    return;
  }

  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    sendJson(res, 415, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'content_type_required' });
    return;
  }

  let body;
  try {
    body = await readBoundedBody(req, maxJsonBodyBytes);
  } catch (error) {
    const tooLarge = error.message.startsWith('body exceeds ');
    sendJson(res, tooLarge ? 413 : 400, {
      protocol: 'WEBSESSION-MCP-BRIDGE/1',
      state: 'rejected',
      code: tooLarge ? 'body_too_large' : 'invalid_request',
    });
    return;
  }

  let parsed;
  try {
    parsed = parseRequest(JSON.parse(body.toString('utf8')));
  } catch (error) {
    sendJson(res, 400, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'invalid_request', message: error.message });
    return;
  }

  const submitted = operationCore.submit(capability, nonce, parsed, 'json-post-v1');
  if (submitted.unauthorized) {
    sendJson(res, 401, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'authorization_required' });
    return;
  }
  if (submitted.nonceConflict) {
    sendJson(res, 409, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'nonce_conflict' });
    return;
  }

  const base = publicBase(req);
  const statusUrl = enhancedStatusUrl(base, submitted.continuationToken, submitted.operation.id);
  const operation = submitted.operation.state === 'queued'
    ? await operationCore.waitForOperation(submitted.operation.id, 1900)
    : submitted.operation;
  const confirmation = submitted.confirmation
    ? {
        base: `${base}/v1/s/${submitted.confirmation.capability}/confirm/${submitted.operation.id}/`,
        challenge: submitted.confirmation.challenge,
        expiresMs: submitted.confirmation.expiresMs,
        summary: submitted.confirmation.summary,
      }
    : undefined;
  sendJson(res, 200, enhancedSnapshot(operation, statusUrl, confirmation));
}

function handleMasterAccess(req, res) {
  const authorization = req.headers.authorization || '';
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    sendJson(res, 401, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'authorization_required' });
    return;
  }
  const masterBearer = authorization.slice('Bearer '.length);
  if (!operationCore.store.masterBearerMatches(masterBearer)) {
    sendJson(res, 401, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'authorization_required' });
    return;
  }
  const issued = operationCore.store.issueMainCapability(masterAccessTtlSeconds);
  sendJson(res, 200, {
    protocol: 'WEBSESSION-MCP-BRIDGE/1',
    state: 'ready',
    capability: issued.token,
    scope: issued.scope,
    ttl_seconds: masterAccessTtlSeconds,
    expires_at: new Date(issued.expiresMs).toISOString(),
  });
}

async function handleEnhancedConfirm(req, res, operationId) {
  const authorization = req.headers.authorization || '';
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    sendJson(res, 401, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'authorization_required' });
    return;
  }
  const confirmationCapability = parseCapabilityToken(authorization.slice('Bearer '.length));
  if (!confirmationCapability) {
    sendJson(res, 401, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'authorization_required' });
    return;
  }
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    sendJson(res, 415, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'content_type_required' });
    return;
  }

  let value;
  try {
    const body = await readBoundedBody(req, 1024);
    value = JSON.parse(body.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'challenge') {
      throw new Error('confirmation body must contain only challenge');
    }
    if (typeof value.challenge !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(value.challenge)) {
      throw new Error('invalid confirmation challenge');
    }
  } catch (error) {
    sendJson(res, 400, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'invalid_request', message: error.message });
    return;
  }

  const confirmed = operationCore.confirm(operationId, confirmationCapability, value.challenge);
  if (confirmed.notFound || confirmed.authorizationInvalid || !confirmed.operation) {
    sendJson(res, 404, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'not_found' });
    return;
  }
  const operation = confirmed.operation.state === 'queued'
    ? await operationCore.waitForOperation(operationId, 1900)
    : confirmed.operation;
  const base = publicBase(req);
  const statusUrl = enhancedStatusUrl(base, confirmed.continuationToken, operationId);
  sendJson(res, 200, enhancedSnapshot(operation, statusUrl));
}

function handleEnhancedStatus(req, res, parts) {
  const continuation = parseCapabilityToken(parts[2]);
  const operationId = parts[3];
  if (!continuation || !operationId) {
    sendJson(res, 404, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'not_found' });
    return;
  }

  const operation = operationCore.readOperation(operationId, continuation);
  if (!operation) {
    sendJson(res, 404, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'not_found' });
    return;
  }

  const base = publicBase(req);
  sendJson(res, 200, enhancedSnapshot(operation, enhancedStatusUrl(base, continuation, operationId)));
}

function handleEnhancedChunk(req, res, parts) {
  const continuation = parseCapabilityToken(parts[2]);
  const operationId = parts[3];
  const chunkNumber = Number(parts[5]);
  if (!continuation || !operationId || !Number.isInteger(chunkNumber) || chunkNumber < 1) {
    sendJson(res, 404, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'not_found' });
    return;
  }

  const chunk = operationCore.readOperationChunk(operationId, continuation, chunkNumber);
  if (!chunk) {
    sendJson(res, 404, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'not_found' });
    return;
  }

  sendJson(res, 200, {
    protocol: 'WEBSESSION-MCP-BRIDGE/1',
    state: 'chunk',
    operation_id: operationId,
    chunk_number: chunk.chunk_number,
    chunk_count: chunk.chunk_count,
    sha256: chunk.content_sha256,
    content: chunk.content,
  });
}

async function handleHttpProbe(req, res, url, noncePart) {
  const nonce = boundedToken(noncePart, 'nonce');
  const body = await readBoundedBody(req);
  const contentType = req.headers['content-type'] || '';
  const authorizationPresent = Boolean(req.headers.authorization);
  const idempotencyKey = req.headers['idempotency-key'] || '';
  const xWebSessionProbe = req.headers['x-websession-probe'] || '';
  let jsonValid = false;
  let probeIdMatchesNonce = false;

  try {
    const parsed = JSON.parse(body.toString('utf8'));
    jsonValid = true;
    probeIdMatchesNonce = parsed?.probe_id === nonce;
  } catch {
    // This endpoint measures transport, not JSON schema semantics.
  }

  const bodySha256 = createHash('sha256').update(body).digest('hex');
  const entry = recordEvidence(req, url, 'http', {
    nonce,
    content_type: contentType,
    authorization_present: authorizationPresent,
    idempotency_key_present: Boolean(idempotencyKey),
    idempotency_key_matches_nonce: idempotencyKey === nonce,
    x_websession_probe: xWebSessionProbe,
    body_bytes: body.length,
    body_sha256: bodySha256,
    json_valid: jsonValid,
    probe_id_matches_nonce: probeIdMatchesNonce,
  });

  sendText(res, 200, [
    'WEBSESSION-PROBE/1',
    'state: observed',
    `request_id: ${entry.request_id}`,
    `method: ${entry.method}`,
    `nonce: ${nonce}`,
    `content_type: ${contentType}`,
    `authorization_present: ${authorizationPresent ? 'yes' : 'no'}`,
    `idempotency_key_present: ${idempotencyKey ? 'yes' : 'no'}`,
    `idempotency_key_matches_nonce: ${idempotencyKey === nonce ? 'yes' : 'no'}`,
    `x_websession_probe: ${xWebSessionProbe}`,
    `body_bytes: ${body.length}`,
    `body_sha256: ${bodySha256}`,
    `json_valid: ${jsonValid ? 'yes' : 'no'}`,
    `probe_id_matches_nonce: ${probeIdMatchesNonce ? 'yes' : 'no'}`,
  ].join('\n'));
}

const server = createServer((req, res) => {
  const requestAt = new Date().toISOString();
  let url;
  try {
    url = new URL(req.url || '/', `http://${host}:${port}`);
  } catch {
    console.log(`${requestAt} ${req.method} <invalid-url> - UA: ${req.headers['user-agent']}`);
    sendText(res, 400, 'WEBSESSION-PROBE/1\nstate: rejected\ncode: invalid_url');
    return;
  }
  console.log(`${requestAt} ${req.method} ${requestLogPath(url)} - UA: ${req.headers['user-agent']}`);

  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'POST' && parts[0] === 'probe' && parts[1] === 'http' && parts.length === 3) {
    handleHttpProbe(req, res, url, parts[2]).catch((error) => {
      sendText(res, 400, `WEBSESSION-PROBE/1\nstate: rejected\ncode: invalid_probe_request\nmessage: ${error.message}`);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/calls') {
    handleEnhancedCall(req, res).catch(() => {
      sendJson(res, 500, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'internal_error' });
    });
    return;
  }

  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'operations' && parts.length === 4) {
    handleEnhancedStatus(req, res, parts);
    return;
  }

  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'operations' && parts[4] === 'chunk' && parts.length === 6) {
    handleEnhancedChunk(req, res, parts);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/access') {
    try {
      handleMasterAccess(req, res);
    } catch {
      sendJson(res, 500, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'internal_error' });
    }
    return;
  }

  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'confirm' && parts.length === 3) {
    handleEnhancedConfirm(req, res, parts[2]).catch(() => {
      sendJson(res, 500, { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'rejected', code: 'internal_error' });
    });
    return;
  }

  if (req.method !== 'GET') {
    sendText(res, 405, parts[0] === 'v1'
      ? 'WEBSESSION-MCP-BRIDGE/1\nstate: rejected\ncode: method_not_allowed'
      : 'WEBSESSION-PROBE/1\nstate: rejected\ncode: method_not_allowed');
    return;
  }

  if (parts[0] === 'v1') {
    handleUniversalGet(req, res, parts).catch(error => {
      sendText(res, 500, renderBridgeError('internal_error', error.message));
    });
    return;
  }

  if (url.pathname === '/health/ready') {
    sendText(res, 200, 'WEBSESSION-ADAPTER/1\nstate: ready');
    return;
  }

  if (parts[0] !== 'probe') {
    sendText(res, 404, 'WEBSESSION-PROBE/1\nstate: rejected\ncode: not_found');
    return;
  }

  try {
    if (parts[1] === 'request' && parts.length === 3) {
      const nonce = boundedToken(parts[2], 'nonce');
      const entry = recordEvidence(req, url, 'request', { nonce });
      sendText(res, 200, [
        'WEBSESSION-PROBE/1',
        'state: observed',
        `request_id: ${entry.request_id}`,
        `method: ${entry.method}`,
        `path: ${entry.path}`,
        `query: ${entry.query}`,
        `nonce: ${nonce}`,
        `user_agent: ${entry.user_agent}`,
        `cf_ray: ${entry.cf_ray}`,
      ].join('\n'));
      return;
    }

    if (parts[1] === 'echo-path' && parts.length === 3) {
      const payload = decodeSegment(parts[2], 'payload');
      const bytes = Buffer.byteLength(payload, 'utf8');
      const sha256 = createHash('sha256').update(payload, 'utf8').digest('hex');
      recordEvidence(req, url, 'echo-path', { payload_bytes: bytes, payload_sha256: sha256 });
      sendText(res, 200, `WEBSESSION-PROBE/1\nstate: observed\npayload_bytes: ${bytes}\nsha256: ${sha256}`);
      return;
    }

    if (parts[1] === 'delay' && parts.length === 3) {
      const seconds = Number(parts[2]);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30) throw new Error('delay must be an integer from 0 to 30');
      const started = process.hrtime.bigint();
      setTimeout(() => {
        const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
        recordEvidence(req, url, 'delay', { requested_seconds: seconds, server_elapsed_ms: elapsedMs });
        sendText(res, 200, `WEBSESSION-PROBE/1\nstate: observed\nrequested_seconds: ${seconds}\nserver_elapsed_ms: ${elapsedMs}`);
      }, seconds * 1000);
      return;
    }

    if (parts[1] === 'page' && parts.length === 3) {
      const nonce = boundedToken(parts[2], 'nonce');
      const base = publicBase(req);
      recordEvidence(req, url, 'page', { nonce });
      sendText(res, 200, [
        'WEBSESSION-PROBE/1',
        'state: prefetch_probe',
        'instruction:',
        'Open only instructed_url. Do not open either canary URL.',
        'instructed_url:',
        `${base}/probe/hit/instructed/${nonce}`,
        'canary_url_1:',
        `${base}/probe/hit/canary-a/${nonce}`,
        'canary_url_2:',
        `${base}/probe/hit/canary-b/${nonce}`,
      ].join('\n'));
      return;
    }

    if (parts[1] === 'hit' && parts.length === 4) {
      const kind = boundedToken(parts[2], 'kind');
      const nonce = boundedToken(parts[3], 'nonce');
      const entry = recordEvidence(req, url, 'hit', { kind, nonce });
      sendText(res, 200, `WEBSESSION-PROBE/1\nstate: hit_recorded\nrequest_id: ${entry.request_id}\nkind: ${kind}\nnonce: ${nonce}`);
      return;
    }

    sendText(res, 404, 'WEBSESSION-PROBE/1\nstate: rejected\ncode: not_found');
  } catch (error) {
    sendText(res, 400, `WEBSESSION-PROBE/1\nstate: rejected\ncode: invalid_probe_request\nmessage: ${error.message}`);
  }
});

server.listen(port, host, () => {
  process.stdout.write(`WebSession adapter probe listening on http://${host}:${port}\n`);
});

function shutdown() {
  server.close(() => {
    operationCore.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
