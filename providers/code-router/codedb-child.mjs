import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);

export const CODEDB_VERSION = '0.2.5840';
export const CODEDB_SHA256 = 'f784c931b053031ca9928173828130c504f769c9e94bf5c2666ab71091747966';

const verificationCache = new Map();

function childError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function defaultCodeDbBin() {
  if (process.env.CODEDB_BIN) return process.env.CODEDB_BIN;
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'mcp-dev-bridge', 'bin', `codedb-v${CODEDB_VERSION}`);
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyCodeDbBinary(bin = defaultCodeDbBin()) {
  let canonical;
  try {
    canonical = await fs.realpath(bin);
    await fs.access(canonical, constants.X_OK);
  } catch (error) {
    throw childError('CODEDB_BINARY_UNAVAILABLE', `CodeDB executable is unavailable: ${bin}`, error);
  }

  if (!verificationCache.has(canonical)) {
    verificationCache.set(canonical, (async () => {
      let stdout;
      try {
        ({ stdout } = await execFileAsync(canonical, ['--version'], { encoding: 'utf8' }));
      } catch (error) {
        throw childError('CODEDB_VERSION_FAILED', `cannot execute ${canonical} --version`, error);
      }
      const versionLine = stdout.trim();
      if (versionLine !== `codedb ${CODEDB_VERSION}`) {
        throw childError('CODEDB_VERSION_MISMATCH', `expected codedb ${CODEDB_VERSION}, got ${versionLine || '<empty>'}`);
      }
      const sha256 = await sha256File(canonical);
      if (sha256 !== CODEDB_SHA256) {
        throw childError('CODEDB_CHECKSUM_MISMATCH', `expected ${CODEDB_SHA256}, got ${sha256}`);
      }
      return { path: canonical, version: CODEDB_VERSION, sha256 };
    })());
  }

  try {
    return await verificationCache.get(canonical);
  } catch (error) {
    verificationCache.delete(canonical);
    throw error;
  }
}

export class CodeDbChild {
  constructor({ root, transport, client }) {
    this.root = root;
    this.transport = transport;
    this.client = client;
    this.closed = false;
    this.peerClosed = false;
  }

  static async start({ root, bin = defaultCodeDbBin(), env = {} } = {}) {
    if (typeof root !== 'string' || root.length === 0) {
      throw childError('INVALID_REPOSITORY', 'root must be a non-empty path');
    }

    let canonicalRoot;
    try {
      canonicalRoot = await fs.realpath(root);
      const stat = await fs.stat(canonicalRoot);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw childError('REPOSITORY_DISAPPEARED', `repository root is unavailable: ${root}`, error);
    }

    const verified = await verifyCodeDbBinary(bin);
    const transport = new StdioClientTransport({
      command: verified.path,
      args: [canonicalRoot, 'mcp'],
      cwd: canonicalRoot,
      env: {
        ...env,
        CODEDB_TOOLS_PROFILE: 'core',
        CODEDB_MCP_LEAN: '1',
        CODEDB_NO_TELEMETRY: '1'
      },
      stderr: 'pipe'
    });
    const client = new Client({ name: 'mcp-dev-bridge-code-router', version: '0.1.0' });
    const child = new CodeDbChild({ root: canonicalRoot, transport, client });
    client.onclose = () => { child.peerClosed = true; };

    try {
      await client.connect(transport);
      return child;
    } catch (error) {
      child.closed = true;
      try { await transport.close(); } catch { /* failed startup may already be closed */ }
      throw childError('CODEDB_START_FAILED', `failed to start rooted CodeDB child for ${canonicalRoot}`, error);
    }
  }

  get pid() {
    return this.transport.pid ?? null;
  }

  get alive() {
    return !this.closed && !this.peerClosed && this.transport.pid !== null;
  }

  async callTool(name, args = {}) {
    if (!this.alive) throw childError('CHILD_CLOSED', `CodeDB child for ${this.root} is not running`);
    if (typeof name !== 'string' || name.length === 0) throw new TypeError('tool name is required');
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('tool arguments must be an object');
    if (Object.prototype.hasOwnProperty.call(args, 'project')) {
      throw childError(
        'PROJECT_OVERRIDE_FORBIDDEN',
        'rooted child calls must not include project; route to the containing repository instead'
      );
    }

    try {
      return await this.client.callTool({ name, arguments: args });
    } catch (error) {
      if (!this.alive) throw childError('CHILD_CLOSED', `CodeDB child for ${this.root} closed during ${name}`, error);
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      try { await this.transport.close(); } catch { /* already closed */ }
    }
  }
}
