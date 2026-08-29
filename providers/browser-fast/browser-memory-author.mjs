#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_MEMORY_MAX_FILE_BYTES,
  canonicalBrowserHost,
  defaultBrowserMemoryRoot
} from './browser-memory.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function readJsonStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk.toString('utf8');
  if (!text.trim()) fail('INVALID_INPUT', 'expected one JSON object on stdin');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('INVALID_INPUT', 'stdin must contain valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 'stdin JSON must be an object');
  return value;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) fail('INVALID_INPUT', `${name} must be a non-empty string`);
  return value.trim();
}

function memoryName(value) {
  const name = requiredString(value, 'name');
  if (!NAME_RE.test(name)) fail('INVALID_INPUT', 'name must match ^[a-z0-9][a-z0-9-]{0,63}$');
  return name;
}

function normalizedSource(value) {
  const raw = requiredString(value, 'url');
  const host = canonicalBrowserHost(raw);
  if (!host) fail('INVALID_INPUT', 'url must be an http(s) URL with a valid hostname');

  const parsed = new URL(raw);
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return {
    host,
    source: `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}`
  };
}

function candidatePath(root, host, name) {
  return path.join(root, 'candidates', host, `${name}.json`);
}

function sitePath(root, host, name) {
  return path.join(root, 'sites', host, `${name}.md`);
}

async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

function promotedMarkdown(candidate, promotedAt) {
  const header = [
    '<!-- browser-memory',
    `source: ${candidate.source}`,
    `proposed_at: ${candidate.proposed_at}`,
    `promoted_at: ${promotedAt}`,
    '-->',
    ''
  ].join('\n');
  const content = `${header}${candidate.content.trimEnd()}\n`;
  if (Buffer.byteLength(content, 'utf8') > DEFAULT_MEMORY_MAX_FILE_BYTES) {
    fail('MEMORY_TOO_LARGE', `promoted memory exceeds ${DEFAULT_MEMORY_MAX_FILE_BYTES} bytes`);
  }
  return content;
}

async function propose(input, root) {
  const { host, source } = normalizedSource(input.url);
  const name = memoryName(input.name);
  const content = requiredString(input.content, 'content');
  if (Buffer.byteLength(content, 'utf8') > DEFAULT_MEMORY_MAX_FILE_BYTES) {
    fail('MEMORY_TOO_LARGE', `candidate content exceeds ${DEFAULT_MEMORY_MAX_FILE_BYTES} bytes`);
  }

  const dir = path.join(root, 'candidates', host);
  await ensurePrivateDir(dir);
  const file = candidatePath(root, host, name);
  const candidate = {
    version: 1,
    host,
    source,
    proposed_at: new Date().toISOString(),
    content
  };
  try {
    await fs.writeFile(file, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('CANDIDATE_EXISTS', `candidate already exists: ${host}/${name}`);
    throw error;
  }
  return { status: 'candidate', host, name, path: file };
}

async function promote(input, root) {
  const { host } = normalizedSource(input.url);
  const name = memoryName(input.name);
  const candidateFile = candidatePath(root, host, name);
  let candidate;
  try {
    candidate = JSON.parse(await fs.readFile(candidateFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') fail('CANDIDATE_NOT_FOUND', `candidate not found: ${host}/${name}`);
    if (error instanceof SyntaxError) fail('CANDIDATE_INVALID', `candidate is not valid JSON: ${host}/${name}`);
    throw error;
  }

  if (candidate?.version !== 1 || candidate?.host !== host || typeof candidate?.source !== 'string' ||
      typeof candidate?.proposed_at !== 'string' || typeof candidate?.content !== 'string') {
    fail('CANDIDATE_INVALID', `candidate has an invalid shape: ${host}/${name}`);
  }

  const dir = path.join(root, 'sites', host);
  await ensurePrivateDir(dir);
  const destination = sitePath(root, host, name);
  const promotedAt = new Date().toISOString();
  const content = promotedMarkdown(candidate, promotedAt);
  try {
    await fs.writeFile(destination, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('SITE_MEMORY_EXISTS', `site memory already exists: ${host}/${name}`);
    throw error;
  }

  let warning;
  try {
    await fs.unlink(candidateFile);
  } catch (error) {
    warning = `promoted memory is active but candidate cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { status: 'promoted', host, name, path: destination, ...(warning ? { warning } : {}) };
}

export async function runBrowserMemoryAuthor(command, input, { root = defaultBrowserMemoryRoot() } = {}) {
  if (command === 'propose') return propose(input, root);
  if (command === 'promote') return promote(input, root);
  fail('INVALID_COMMAND', 'expected command: propose or promote');
}

async function main() {
  const command = process.argv[2];
  const input = await readJsonStdin();
  const result = await runBrowserMemoryAuthor(command, input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const code = typeof error?.code === 'string' ? error.code : 'BROWSER_MEMORY_AUTHOR_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  });
}
