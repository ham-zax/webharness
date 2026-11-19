import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_LOG_LINE_BYTES = 2048;

function parseLogPolicyToml(text) {
  const fileRaw = text.match(/^file\s*=\s*("[^"]+"|'[^']+')\s*$/m)?.[1];
  if (!fileRaw) return null;
  let file;
  try {
    file = fileRaw.startsWith('"') ? JSON.parse(fileRaw) : fileRaw.slice(1, -1);
  } catch {
    return null;
  }
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const maxSize = Number(text.match(/^maxSize\s*=\s*(\d+)\s*$/m)?.[1]);
  const maxFiles = Number(text.match(/^maxFiles\s*=\s*(\d+)\s*$/m)?.[1]);
  if (!Number.isSafeInteger(maxSize) || maxSize < 256) return null;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 50) return null;
  return { file, maxSize, maxFiles };
}

function rotatedSiblingPath(baseFile, index) {
  const ext = path.extname(baseFile);
  const stem = ext ? baseFile.slice(0, -ext.length) : baseFile;
  return `${stem}${index}${ext}`;
}

// Bounded rotating diagnostic writer matching the rendered [logging] policy in
// local-1mcp/config.toml so `bin/status` and operators inspect one bounded log
// (`logs/local-inner*.log`) without needing a second 1MCP runtime.
export class LocalDiagnosticLogger {
  constructor({ appConfigPath, file, maxSize = 10 * 1024 * 1024, maxFiles = 5 } = {}) {
    this.policy = null;
    if (typeof file === 'string' && path.isAbsolute(file)) {
      this.policy = { file, maxSize, maxFiles };
    } else if (typeof appConfigPath === 'string' && appConfigPath.length > 0) {
      try {
        this.policy = parseLogPolicyToml(fsSync.readFileSync(appConfigPath, 'utf8'));
      } catch {
        this.policy = null;
      }
    }
    this._tail = Promise.resolve();
  }

  log(level, fields = {}) {
    if (!this.policy) return;
    const parts = [new Date().toISOString(), `[${level}]`];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      parts.push(`${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
    }
    let line = parts.join(' ');
    const maxChars = Math.min(MAX_LOG_LINE_BYTES, Math.max(64, this.policy.maxSize - 2));
    if (Buffer.byteLength(line, 'utf8') > maxChars) {
      line = `${Buffer.from(line, 'utf8').subarray(0, maxChars - 4).toString('utf8')}...`;
    }
    const payload = `${line}\n`;
    this._tail = this._tail.then(() => this._appendBounded(payload)).catch(() => {});
  }

  async _appendBounded(payload) {
    const { file, maxSize, maxFiles } = this.policy;
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > maxSize) return;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let currentSize = 0;
    try {
      currentSize = (await fs.stat(file)).size;
    } catch (error) {
      if (error?.code !== 'ENOENT') return;
    }
    if (currentSize + bytes > maxSize) {
      await this._rotate();
    }
    await fs.appendFile(file, payload, { encoding: 'utf8', mode: 0o600 });
  }

  async _rotate() {
    const { file, maxFiles } = this.policy;
    if (maxFiles <= 1) {
      await fs.rm(file, { force: true });
      return;
    }
    // Keep at most (maxFiles - 1) rotated siblings (`local-inner1.log` .. `local-inner{N-1}.log`)
    // plus the active `local-inner.log`, so total bytes never exceed maxSize * maxFiles.
    await fs.rm(rotatedSiblingPath(file, maxFiles - 1), { force: true });
    for (let idx = maxFiles - 2; idx >= 1; idx -= 1) {
      const src = rotatedSiblingPath(file, idx);
      const dst = rotatedSiblingPath(file, idx + 1);
      try {
        await fs.rename(src, dst);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    try {
      await fs.rename(file, rotatedSiblingPath(file, 1));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  flush() {
    return this._tail;
  }
}
