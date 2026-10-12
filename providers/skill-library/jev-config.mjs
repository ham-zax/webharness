import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { failure } from './files.mjs';

// Reuse an existing operator Browser Jev credential file without copying keys.
// These optional text-model settings are accepted but never used or forwarded.
const KEYS = new Set(['TYPESAFE_API_KEY', 'TYPESAFE_MODEL', 'TEXT_MODEL_API_KEY',
  'TEXT_MODEL_BASE_URL', 'TEXT_MODEL', 'TEXT_MODEL_REASONING']);

async function credentialFile(filename) {
  if (!path.isAbsolute(filename)) throw failure('JEV_CONFIG_INVALID', 'Jev credential file must be absolute');
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 65536) {
      throw failure('JEV_CONFIG_INVALID', 'Jev credentials require a current-user-owned private regular file under 64 KiB');
    }
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > 65536) throw failure('JEV_CONFIG_INVALID', 'Jev credential file exceeds 64 KiB');
    const values = {};
    for (const line of buffer.subarray(0, size).toString('utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      if (!match || !KEYS.has(match[1]) || Object.hasOwn(values, match[1])) {
        throw failure('JEV_CONFIG_INVALID', 'Jev credential file permits unique TypeSafe and optional Browser Jev text-model assignments only');
      }
      let value = match[2];
      if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
      values[match[1]] = value;
    }
    return values;
  } catch (error) {
    if (error.code === 'JEV_CONFIG_INVALID') throw error;
    throw failure('JEV_CONFIG_INVALID', 'Jev credential file could not be safely read');
  } finally { await handle?.close(); }
}

// Lazy: bad or absent optional configuration never disables offline discovery.
export async function loadJevConfig(env = process.env) {
  if (env.MCP_SKILL_JEV_ENABLED !== '1') throw failure('JEV_DISABLED', 'Jev is disabled; operator must set MCP_SKILL_JEV_ENABLED=1');
  const values = env.MCP_SKILL_JEV_ENV_FILE ? await credentialFile(env.MCP_SKILL_JEV_ENV_FILE) : env;
  const apiKey = values.TYPESAFE_API_KEY;
  const model = values.TYPESAFE_MODEL ?? 'jev-latest';
  if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(apiKey)
      || typeof model !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(model)) {
    throw failure('JEV_CONFIG_INVALID', 'Jev requires a valid operator API key and model');
  }
  return { apiKey, model };
}
