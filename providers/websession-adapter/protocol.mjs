const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// Principal credentials are either a 43-character capability or the configured
// master bearer (32-128 characters). This only bounds the input shape; the store
// still decides whether the presented value resolves to an active principal.
const BEARER_RE = /^[A-Za-z0-9._-]{32,128}$/;
const NONCE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function parseCapabilityToken(value) {
  return TOKEN_RE.test(value) ? value : undefined;
}

export function parseBearerToken(value) {
  return BEARER_RE.test(value) ? value : undefined;
}

export function parseClientNonce(value) {
  if (!NONCE_RE.test(value)) throw new Error('invalid client nonce');
  return value;
}

export function parseToolName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('invalid tool name');
  return value;
}

const ONEMCP_PREAMBLE = '# 1MCP - Model Context Protocol Proxy';
const ONEMCP_TIPS_FOOTER = /\n+## Tips for Using 1MCP[\s\S]*$/;

export function compactInstructions(instructions) {
  if (typeof instructions !== 'string' || !instructions) return instructions;
  if (!instructions.startsWith(ONEMCP_PREAMBLE)) return instructions.replace(ONEMCP_TIPS_FOOTER, '').trim();
  const devBlock = instructions.match(/<dev>[\s\S]*/);
  if (devBlock) return devBlock[0].replace(ONEMCP_TIPS_FOOTER, '').trim();
  const blockStart = instructions.search(/<[a-zA-Z0-9_-]+>\s*\n/);
  if (blockStart !== -1) return instructions.slice(blockStart).replace(ONEMCP_TIPS_FOOTER, '').trim();
  return '';
}

// The contract sentences below are the single source for both the server-served
// instructions and the client-facing pairing prompt that bin/adapter prints.
// Keep them here so the two can never disagree about how results are shaped.
export const CALL_CONTRACT = 'GET /v1/tools/<name> retrieves a schema. Invoke every tool via POST /v1/calls?wait=2 (wait=10+ for commands) with Authorization: Bearer <capability>, Content-Type: application/json, and Idempotency-Key: <fresh UUID hex>. Body: {"version":1,"tool":"<discovered-name>","arguments":{...}}.';

export const RESULT_CONTRACT = 'Poll the returned status_url verbatim while queued/running (optional wait=90) to completion inside the same local script run rather than spending separate model turns polling; reuse HTTP keep-alive connections across submit/poll/chunk requests and retry transient 502/503/504 only on GET. Check state, not status. For completed with chunk_count == 1, read result. With chunk_count > 1, result is intentionally absent: GET chunk_base_url + each number 1..chunk_count and concatenate the response content fields in order. Never interpret a missing result as empty output. The assembled result is the tool output itself, either its rendered text or its structured JSON when the tool returns no plain text; it is not an MCP envelope, so do not look for content blocks inside it. Never automatically repeat a mutation after a lost submission response or unknown_outcome.';

export const BATCH_CONTRACT = 'POST /v1/batch?wait=2 uses the same headers and {"version":1,"calls":[{"tool":"<name>","arguments":{...}}],"sequential"?:true,"stop_on_error"?:true} (1..20 calls). Default batch overlaps reads with serialized writes; set "sequential":true for ordered pipelines (e.g. edit -> test -> review) that stop on failure. stop_on_error requires sequential:true.';

export const CWD_CONTRACT = 'GET /v1/cwd reads project context; POST /v1/cwd with the bearer and JSON {"cwd":"/project"} selects it once ({"cwd":null} clears it). Supported Dev calls inherit it; use relative paths. Local Terminal has its own cwd.';

export const HTTP_INSTRUCTIONS = [
  'WebSession HTTP contract:',
  'Use only documented routes; do not probe endpoint names. Send User-Agent: websession-client/1.0.',
  CALL_CONTRACT,
  RESULT_CONTRACT,
  BATCH_CONTRACT,
  CWD_CONTRACT,
  'Execution efficiency: cache pairing signatures locally instead of re-fetching schemas; group related independent reads/searches into one /v1/batch (or dev_read targets); use a sequential batch/pipe (wait=10+) for ordered edit -> targeted tests -> final review, and run long suites detached (dev_exec detach:true + dev_wait) inside one local call. Avoid a separate model round-trip for every inspection, poll, or Git check.',
  'Quiet output: keep builds and test logs in /tmp files, and print a short status plus failures (normally <=25 lines), not raw schemas, full diffs, or all passing-test output. Use the client output cap and --save when full output is necessary.',
  'Localized bugs: when the report includes a concrete file, line, and reproduction, inspect that scope and verify the fix with targeted tests before expanding investigation. Do not skip validation.',
  'Deployment: when changing a running adapter or daemon, determine whether its process must restart or reload, then perform a harmless live readiness check before claiming deployment success.',
  'Long sessions: around 80k-100k accumulated context, summarize state, decisions, remaining work and last commits in a short non-secret handoff, then continue in a fresh session when practical.',
].join('\n');

export function webSessionInstructions(instructions) {
  const compacted = compactInstructions(instructions);
  return typeof compacted === 'string' && compacted
    ? `${compacted}\n\n${HTTP_INSTRUCTIONS}`
    : HTTP_INSTRUCTIONS;
}

export function toolListSnapshot(tools, instructions = undefined, defaultCwd = undefined) {
  const value = { protocol: 'WEBSESSION-MCP-BRIDGE/1', state: 'ready', tool_count: tools.length, tools: tools.map(tool => tool.name) };
  value.instructions = webSessionInstructions(instructions);
  if (defaultCwd) value.default_cwd = defaultCwd;
  return value;
}

function schemaType(schema, depth = 0) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 6) {
    return schema.enum.map(value => JSON.stringify(value)).join('|');
  }
  const variants = schema.anyOf || schema.oneOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const rendered = [...new Set(variants.map(variant => schemaType(variant, depth)))].join('|');
    return variants.length > 1 ? `(${rendered})` : rendered;
  }
  if (Array.isArray(schema.type)) return schema.type.join('|');
  if (schema.type === 'array') return `${schemaType(schema.items, depth)}[]`;
  if (schema.type === 'integer') return 'number';
  if (schema.type === 'object' && depth < 2 && schema.properties && typeof schema.properties === 'object') {
    const keys = Object.keys(schema.properties);
    if (keys.length > 0 && keys.length <= 4) {
      const req = new Set(Array.isArray(schema.required) ? schema.required : []);
      const ordered = keys.sort((a, b) => Number(req.has(b)) - Number(req.has(a)));
      const fields = ordered.map(k => `${k}${req.has(k) ? '' : '?'}: ${schemaType(schema.properties[k], depth + 1)}`);
      return `{ ${fields.join(', ')} }`;
    }
  }
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
