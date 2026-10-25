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

export function parseToolName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('invalid tool name');
  return value;
}

export function toolListSnapshot(tools, instructions = undefined) {
  const value = { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'ready', tool_count: tools.length, tools: tools.map(tool => tool.name) };
  if (instructions) value.instructions = instructions;
  return value;
}

function schemaType(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 6) {
    return schema.enum.map(value => JSON.stringify(value)).join('|');
  }
  const variants = schema.anyOf || schema.oneOf;
  if (Array.isArray(variants) && variants.length > 0) return [...new Set(variants.map(schemaType))].join('|');
  if (Array.isArray(schema.type)) return schema.type.join('|');
  if (schema.type === 'array') return `${schemaType(schema.items)}[]`;
  if (schema.type === 'integer') return 'number';
  return typeof schema.type === 'string' ? schema.type : 'any';
}

// One line per tool: name(required: type, optional?: type)  first sentence of the description.
export function toolSignature(tool) {
  const schema = tool?.inputSchema || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const names = Object.keys(properties).sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  const parameters = names.map(name => `${name}${required.has(name) ? '' : '?'}: ${schemaType(properties[name])}`);
  const description = typeof tool?.description === 'string' ? tool.description.replace(/\s+/g, ' ').trim() : '';
  const sentence = description.match(/^.*?[.;](?= |$)/)?.[0] || description;
  const summary = sentence.length > 120 ? `${sentence.slice(0, 117)}...` : sentence;
  return `${tool.name}(${parameters.join(', ')})${summary ? `  ${summary}` : ''}`;
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
  parseToolName(value.tool);
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

export function parseWait(searchParams) {
  const values = searchParams.getAll('wait');
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^[0-9]+$/.test(values[0]) || Number(values[0]) > 90) {
    throw new Error('invalid_wait');
  }
  return Number(values[0]) * 1000;
}

export function prefersPlainText(accept = '') {
  const value = String(accept).toLowerCase();
  return value.includes('text/plain') && !value.includes('application/json');
}

// A 5xx from the MCP transport means the backend is down, not that the request
// or the capability is wrong. Report it as retryable so clients wait instead of
// rotating credentials.
export function upstreamUnavailable(error) {
  const status = Number(error?.code);
  return Number.isInteger(status) && status >= 500 && status <= 599;
}

function withFullResult(operation, fullResult) {
  return operation.state === 'completed' && fullResult !== undefined
    ? { ...operation, chunk_count: 1, result_text: fullResult }
    : operation;
}

export function renderOperation(operation, statusUrl, confirmation = undefined, fullResult = undefined) {
  operation = withFullResult(operation, fullResult);
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

export function enhancedSnapshot(operation, statusUrl, confirmation = undefined, fullResult = undefined) {
  operation = withFullResult(operation, fullResult);
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
