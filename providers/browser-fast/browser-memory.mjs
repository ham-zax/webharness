import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MEMORY_MAX_FILES = 6;
export const DEFAULT_MEMORY_MAX_FILE_BYTES = 16 * 1024;
export const DEFAULT_MEMORY_MAX_TOTAL_BYTES = 48 * 1024;

const PLATFORM_RULE_MAX_BYTES = 32 * 1024;
const MAX_WARNINGS = 8;

export function defaultBrowserMemoryRoot(env = process.env) {
  const configured = typeof env.MCP_BROWSER_MEMORY_DIR === 'string'
    ? env.MCP_BROWSER_MEMORY_DIR.trim()
    : '';
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), '.config', 'mcp-dev-bridge', 'browser-memory');
}

export function canonicalBrowserHost(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    let host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host.startsWith('www.')) host = host.slice(4);
    if (!host || !/^[a-z0-9.-]+$/.test(host) || host.includes('..')) return null;
    return host;
  } catch {
    return null;
  }
}

function normalizedRuleHost(value) {
  if (typeof value !== 'string') return null;
  let host = value.trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  return host && /^[a-z0-9.-]+$/.test(host) && !host.includes('..') ? host : null;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.length > 0) : [];
}

function platformRuleMatches(rule, host, href) {
  for (const candidate of stringList(rule.hosts)) {
    if (normalizedRuleHost(candidate) === host) return true;
  }
  for (const candidate of stringList(rule.host_suffixes)) {
    const suffix = normalizedRuleHost(candidate);
    if (suffix && (host === suffix || host.endsWith(`.${suffix}`))) return true;
  }
  for (const prefix of stringList(rule.url_prefixes)) {
    if (href.startsWith(prefix)) return true;
  }
  return false;
}

async function readdirOrEmpty(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function boundedUtf8(buffer, limit) {
  if (buffer.length <= limit) return buffer.toString('utf8');
  return buffer.subarray(0, limit).toString('utf8');
}

function addWarning(warnings, message) {
  if (warnings.length < MAX_WARNINGS) warnings.push(message);
}

async function appendMarkdownTree({ root, dir, kind, key, state, maxFiles, maxFileBytes, maxTotalBytes }) {
  if (state.matches.length >= maxFiles || state.bytes >= maxTotalBytes) return;
  let entries;
  try {
    entries = await readdirOrEmpty(dir);
  } catch (error) {
    addWarning(state.warnings, `${kind}:${key}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (state.matches.length >= maxFiles || state.bytes >= maxTotalBytes) break;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await appendMarkdownTree({ root, dir: file, kind, key, state, maxFiles, maxFileBytes, maxTotalBytes });
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;

    try {
      const raw = await fs.readFile(file);
      const allowed = Math.min(maxFileBytes, maxTotalBytes - state.bytes);
      if (allowed <= 0) break;
      const used = Math.min(raw.length, allowed);
      state.matches.push({
        kind,
        key,
        source: path.relative(root, file).split(path.sep).join('/'),
        content: boundedUtf8(raw, allowed),
        truncated: raw.length > allowed
      });
      state.bytes += used;
    } catch (error) {
      addWarning(state.warnings, `${kind}:${key}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function readPlatformRule(dir, key, warnings) {
  const file = path.join(dir, 'match.json');
  try {
    const raw = await fs.readFile(file);
    if (raw.length > PLATFORM_RULE_MAX_BYTES) {
      addWarning(warnings, `platform:${key}/match.json exceeds ${PLATFORM_RULE_MAX_BYTES} bytes`);
      return null;
    }
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      addWarning(warnings, `platform:${key}/match.json must contain a JSON object`);
      return null;
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    addWarning(warnings, `platform:${key}/match.json: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function resolveBrowserMemory(value, {
  root = defaultBrowserMemoryRoot(),
  maxFiles = DEFAULT_MEMORY_MAX_FILES,
  maxFileBytes = DEFAULT_MEMORY_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MEMORY_MAX_TOTAL_BYTES
} = {}) {
  const host = canonicalBrowserHost(value);
  const result = { host, matches: [], warnings: [] };
  if (!host) return result;

  let href;
  try {
    href = new URL(value).href;
  } catch {
    return result;
  }

  const state = { matches: result.matches, warnings: result.warnings, bytes: 0 };
  const append = async (kind, key, dir) => appendMarkdownTree({
    root,
    dir,
    kind,
    key,
    state,
    maxFiles,
    maxFileBytes,
    maxTotalBytes
  });

  await append('policy', host, path.join(root, 'policies', host));
  await append('site', host, path.join(root, 'sites', host));

  let platformEntries = [];
  try {
    platformEntries = await readdirOrEmpty(path.join(root, 'platforms'));
  } catch (error) {
    addWarning(result.warnings, `platforms: ${error instanceof Error ? error.message : String(error)}`);
  }
  platformEntries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of platformEntries) {
    if (!entry.isDirectory() || state.matches.length >= maxFiles || state.bytes >= maxTotalBytes) continue;
    const dir = path.join(root, 'platforms', entry.name);
    const rule = await readPlatformRule(dir, entry.name, result.warnings);
    if (rule && platformRuleMatches(rule, host, href)) await append('platform', entry.name, dir);
  }

  return result;
}
