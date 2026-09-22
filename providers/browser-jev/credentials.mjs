import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ENV_BYTES = 64 * 1024;

export const JEV_ENV_KEYS = Object.freeze([
  'TYPESAFE_API_KEY', 'TYPESAFE_MODEL', 'TEXT_MODEL_API_KEY',
  'TEXT_MODEL_BASE_URL', 'TEXT_MODEL', 'TEXT_MODEL_REASONING'
]);

const ALLOWED_KEYS = new Set(JEV_ENV_KEYS);

function credentialError(message) {
  const error = new Error(`BROWSER_JEV_CREDENTIALS_INVALID: ${message}`);
  error.code = 'BROWSER_JEV_CREDENTIALS_INVALID';
  return error;
}

function allowedEnvironment(baseEnv) {
  const result = {};
  for (const key of JEV_ENV_KEYS) {
    if (typeof baseEnv?.[key] === 'string' && baseEnv[key].length > 0) result[key] = baseEnv[key];
  }
  return result;
}

function parseEnvironmentFile(contents) {
  const result = {};
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!match) throw credentialError(`credential file has a malformed assignment on line ${index + 1}`);
    const [, key, encoded] = match;
    if (!ALLOWED_KEYS.has(key)) throw credentialError('credential file permits only the browser-jev model environment allowlist');
    if (Object.hasOwn(result, key)) throw credentialError(`credential file repeats ${key}`);
    let value = encoded;
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value.includes('\n') || value.includes('\r')) throw credentialError(`credential file has a malformed assignment on line ${index + 1}`);
    if (value.length > 0) result[key] = value;
  }
  return result;
}

export async function loadWorkerEnvironment({
  file,
  baseEnv = process.env,
  readFile = fs.readFile,
  lstat = fs.lstat
} = {}) {
  const result = allowedEnvironment(baseEnv);
  if (file !== undefined && file !== '') {
    if (typeof file !== 'string' || !path.isAbsolute(file)) {
      throw credentialError('MCP_BROWSER_JEV_ENV_FILE must be an absolute path');
    }
    let metadata;
    try {
      metadata = await lstat(file);
    } catch {
      throw credentialError('credential file is not readable');
    }
    if (!metadata.isFile()) throw credentialError('credential path must name a regular file');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw credentialError('credential file must be owned by the current user');
    }
    if (!Number.isInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_ENV_BYTES) {
      throw credentialError('credential file must be no larger than 64 KiB');
    }
    let contents;
    try {
      contents = await readFile(file, 'utf8');
    } catch {
      throw credentialError('credential file is not readable');
    }
    if (Buffer.byteLength(contents, 'utf8') > MAX_ENV_BYTES) {
      throw credentialError('credential file must be no larger than 64 KiB');
    }
    Object.assign(result, parseEnvironmentFile(contents));
  }
  if (typeof result.TYPESAFE_API_KEY !== 'string' || result.TYPESAFE_API_KEY.length === 0) {
    throw credentialError('TYPESAFE_API_KEY is required in the server environment or credential file');
  }
  return result;
}

