export const OPERATIONS = new Set([
  'session.open',
  'session.open_human',
  'session.list',
  'session.read',
  'session.observe',
  'session.send',
  'session.resize',
  'session.close',
  'model.read',
  'lease.acquire_human',
  'lease.bind_human',
  'lease.release_human',
  'control.give_model',
  'control.take_human',
]);

export class TerminalError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'TerminalError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function decodeRequest(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new TerminalError('INVALID_REQUEST', 'request must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TerminalError('INVALID_REQUEST', 'request must be a JSON object');
  }
  const { id, op } = value;
  if ((typeof id !== 'string' && typeof id !== 'number') || String(id).length === 0) {
    throw new TerminalError('INVALID_REQUEST', 'request id must be a non-empty string or number');
  }
  if (typeof op !== 'string' || !OPERATIONS.has(op)) {
    throw new TerminalError('UNSUPPORTED_OPERATION', `unsupported operation: ${String(op)}`);
  }
  const params = value.params === undefined ? {} : value.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new TerminalError('INVALID_REQUEST', 'request params must be a JSON object');
  }
  return { id, op, params };
}

export function encodeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

export function errorResponse(id, error) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  const payload = { id, ok: false, error: { code, message } };
  if (error?.details !== undefined) payload.error.details = error.details;
  return payload;
}
