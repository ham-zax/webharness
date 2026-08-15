import {
  closeSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent';
import { resolveWorkspaceCwd } from './boundary.mjs';

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const MAX_POLICY_BYTES = 16 * 1024 * 1024;

function positiveNumber(name, value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be > 0 and <= ${max}`);
  }
}

function boundedTail(current, chunk, limit) {
  if (chunk.length >= limit) return Buffer.from(chunk.subarray(chunk.length - limit));
  if (current.length + chunk.length <= limit) return Buffer.concat([current, chunk]);
  const keep = limit - chunk.length;
  return Buffer.concat([current.subarray(current.length - keep), chunk]);
}

function decodeBoundedUtf8Tail(buffer, limit) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;

  const decoded = buffer.subarray(start).toString('utf8');
  const encoded = Buffer.from(decoded, 'utf8');
  if (encoded.length <= limit) return decoded;

  let encodedStart = encoded.length - limit;
  while (encodedStart < encoded.length && (encoded[encodedStart] & 0xc0) === 0x80) encodedStart += 1;
  return encoded.subarray(encodedStart).toString('utf8');
}

export async function runBash({
  workspaceRoot,
  command,
  cwd,
  timeout_seconds = DEFAULT_TIMEOUT_SECONDS,
  maxOutputBytes,
  stateDir
}, signal) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('command must be a non-empty string');
  }
  positiveNumber('timeout_seconds', timeout_seconds, MAX_TIMEOUT_SECONDS);
  positiveNumber('MCP_DEV_MAX_OUTPUT_BYTES', maxOutputBytes, MAX_POLICY_BYTES);
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    throw new Error('MCP_DEV_STATE_DIR must be an absolute path');
  }

  const resolvedCwd = await resolveWorkspaceCwd(workspaceRoot, cwd);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const spool = path.join(stateDir, `bash-${Date.now()}-${randomUUID()}.log`);
  const fd = openSync(spool, 'wx', 0o600);

  const ops = createLocalBashOperations();
  const started = process.hrtime.bigint();
  let tail = Buffer.alloc(0);
  let outputBytes = 0;
  let exitCode = null;
  let timedOut = false;
  let cancelled = false;
  let unexpected = null;

  const onData = data => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    writeSync(fd, chunk);
    outputBytes += chunk.length;
    tail = boundedTail(tail, chunk, maxOutputBytes);
  };

  try {
    ({ exitCode } = await ops.exec(command, resolvedCwd, {
      onData,
      signal,
      timeout: timeout_seconds
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'aborted') cancelled = true;
    else if (message.startsWith('timeout:')) timedOut = true;
    else unexpected = error;
  } finally {
    closeSync(fd);
  }

  if (unexpected) {
    try { unlinkSync(spool); } catch {}
    throw unexpected;
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const truncated = outputBytes > maxOutputBytes;
  if (!truncated) {
    try { unlinkSync(spool); } catch {}
  }

  return {
    cwd: resolvedCwd,
    exit_code: timedOut || cancelled ? null : exitCode,
    output: decodeBoundedUtf8Tail(tail, maxOutputBytes),
    output_bytes: outputBytes,
    duration_ms: Math.round(durationMs),
    timed_out: timedOut,
    cancelled,
    truncated,
    full_output_path: truncated ? spool : null,
    timeout_seconds
  };
}
