const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function parseCapabilityToken(value) {
  return TOKEN_RE.test(value) ? value : undefined;
}

export function parseClientNonce(value) {
  if (!NONCE_RE.test(value)) throw new Error('invalid client nonce');
  return value;
}

export function decodeToolName(segment) {
  if (!segment || segment.length > 128 || !BASE64URL_RE.test(segment) || segment.includes('=')) {
    throw new Error('invalid encoded tool name');
  }
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) throw new Error('non-canonical encoded tool name');
  return decoded.toString('utf8');
}

export function parseRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request must be an object');
  const requestKeys = Object.keys(value).sort();
  if (requestKeys.join(',') !== 'arguments,tool,version') throw new Error('request fields must be exactly version, tool, arguments');
  if (value.version !== 1) throw new Error('only request version 1 is supported');
  if (typeof value.tool !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.tool)) throw new Error('invalid tool name');
  if (!value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) throw new Error('arguments must be an object');
  const normalized = { version: 1, tool: value.tool, arguments: value.arguments };
  return { normalized, requestJson: JSON.stringify(normalized) };
}

export function parseUniversalRequest(segment) {
  if (!segment || segment.length > 256 || !BASE64URL_RE.test(segment) || segment.includes('=')) {
    throw new Error('invalid encoded request');
  }
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) throw new Error('non-canonical encoded request');

  let value;
  try {
    value = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('request is not valid UTF-8 JSON');
  }
  return parseRequest(value);
}

export function renderOperation(operation, statusUrl, confirmation = undefined) {
  const lines = [
    'WEBSESSION-MCP-BRIDGE/1',
    `state: ${operation.state}`,
    `operation_id: ${operation.id}`,
    `status_url: ${statusUrl}`,
  ];
  if (operation.state === 'confirmation_required' && confirmation) {
    lines.push(
      'confirmation_base:',
      confirmation.base,
      'challenge:',
      confirmation.challenge,
      `confirmation_expires_at: ${new Date(confirmation.expiresMs).toISOString()}`,
      'summary:',
      confirmation.summary,
      'instruction:',
      'Construct confirmation_base + challenge and open that exact URL.',
    );
  } else if (operation.state === 'completed') {
    const chunkCount = Number(operation.chunk_count) || 1;
    lines.push(`chunk_count: ${chunkCount}`);
    if (chunkCount > 1) {
      lines.push(`chunk_base_url: ${statusUrl}/chunk/`);
    } else {
      lines.push('result:', operation.result_text || '');
    }
  } else if (operation.state === 'tool_failed' || operation.state === 'unknown_outcome' || operation.state === 'rejected' || operation.state === 'expired') {
    lines.push(`error: ${operation.error_text || operation.state}`);
  }
  return lines.join('\n');
}

export function renderChunk(operationId, chunk) {
  return [
    'WEBSESSION-MCP-BRIDGE/1',
    'state: chunk',
    `operation_id: ${operationId}`,
    `chunk_number: ${chunk.chunk_number}`,
    `chunk_count: ${chunk.chunk_count}`,
    `sha256: ${chunk.content_sha256}`,
    'content:',
    chunk.content,
  ].join('\n');
}

export function renderBridgeError(code, message) {
  return ['WEBSESSION-MCP-BRIDGE/1', 'state: rejected', `code: ${code}`, `message: ${message}`].join('\n');
}
