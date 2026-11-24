import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pruneBashSpools, pruneJobSpools } from './spool-gc.mjs';
export { pruneBashSpools, pruneJobSpools } from './spool-gc.mjs';
import { resolveUserCwd, resolveWorkspaceCwd } from './boundary.mjs';
import { acquireRuntimeLease } from '../../lib/runtime-leases.mjs';
import { beginBackgroundWork } from './idle-worker.mjs';
import { MIN_RPC_BUDGET_MS } from './call-diagnostics.mjs';

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const EXIT_STDIO_GRACE_MS = 100;
const MAX_POLICY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SPOOL_BYTES = 64 * 1024 * 1024;
const MAX_SPOOL_BYTES = 256 * 1024 * 1024;
const DEFAULT_SPOOL_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SPOOL_TTL_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_SPOOL_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_SPOOL_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;

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

// Head plus tail capture keeps the start and the end of long output. Tiny limits keep the
// exact legacy tail-only behaviour.
const HEAD_TAIL_MIN_BYTES = 256;
const HEAD_BUDGET_SHARE = 0.4;

function headBudgetFor(maxOutputBytes) {
  if (maxOutputBytes < HEAD_TAIL_MIN_BYTES) return 0;
  return Math.floor(maxOutputBytes * HEAD_BUDGET_SHARE);
}

function trimSplitTrailingSequence(buffer) {
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return buffer.subarray(0, 0);
  const byte = buffer[lead];
  const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  if (expected > 1 && lead + expected > buffer.length) return buffer.subarray(0, lead);
  return buffer;
}

function decodeUtf8WithoutReplacement(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return buffer.toString('utf8').replace(/\uFFFD/g, '');
  }
}

function decodeBoundedUtf8Head(buffer, limit) {
  if (limit <= 0) return '';
  const slice = trimSplitTrailingSequence(buffer.subarray(0, Math.min(buffer.length, limit)));
  const text = decodeUtf8WithoutReplacement(slice);
  return Buffer.byteLength(text, 'utf8') <= limit ? text : '';
}

function decodeBoundedUtf8TailStrict(buffer, limit) {
  if (limit <= 0) return '';
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  const text = decodeUtf8WithoutReplacement(trimSplitTrailingSequence(buffer.subarray(start)));
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const encoded = Buffer.from(text, 'utf8');
  let encodedStart = encoded.length - limit;
  while (encodedStart < encoded.length && (encoded[encodedStart] & 0xc0) === 0x80) encodedStart += 1;
  const trimmed = decodeUtf8WithoutReplacement(encoded.subarray(encodedStart));
  return Buffer.byteLength(trimmed, 'utf8') <= limit ? trimmed : '';
}

function omittedMarker(omittedBytes) {
  return `\n[... ${omittedBytes} bytes omitted ...]\n`;
}

function composeHeadTail(headBuffer, tailBuffer, totalBytes, maxOutputBytes) {
  const headText = decodeBoundedUtf8Head(headBuffer, headBudgetFor(maxOutputBytes));
  const headBytes = Buffer.byteLength(headText, 'utf8');
  let omittedBytes = Math.max(0, totalBytes - headBytes);
  let marker = omittedMarker(omittedBytes);
  let tailText = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const budget = maxOutputBytes - headBytes - Buffer.byteLength(marker, 'utf8');
    tailText = decodeBoundedUtf8TailStrict(tailBuffer, Math.max(0, budget));
    const nextOmitted = Math.max(0, totalBytes - headBytes - Buffer.byteLength(tailText, 'utf8'));
    if (nextOmitted === omittedBytes) break;
    omittedBytes = nextOmitted;
    marker = omittedMarker(omittedBytes);
  }
  const combined = headText + marker + tailText;
  if (Buffer.byteLength(combined, 'utf8') <= maxOutputBytes) return combined;
  const budget = maxOutputBytes - headBytes - Buffer.byteLength(marker, 'utf8');
  return headText + marker + decodeBoundedUtf8TailStrict(tailBuffer, Math.max(0, budget));
}

async function resolveExecutionCwd({ pathMode, defaultCwd, workspaceRoot, cwd }) {
  if (pathMode === 'workspace') return resolveWorkspaceCwd(workspaceRoot, cwd);
  if (pathMode === 'user') return resolveUserCwd(defaultCwd, cwd);
  throw new Error('MCP_DEV_PATH_MODE must be workspace or user');
}

function validateCapturePolicy({
  timeoutSeconds,
  maxOutputBytes,
  maxSpoolBytes,
  spoolTtlSeconds,
  maxSpoolTotalBytes,
  stateDir,
}) {
  positiveNumber('timeout_seconds', timeoutSeconds, MAX_TIMEOUT_SECONDS);
  positiveNumber('MCP_DEV_MAX_OUTPUT_BYTES', maxOutputBytes, MAX_POLICY_BYTES);
  positiveNumber('MCP_DEV_MAX_SPOOL_BYTES', maxSpoolBytes, MAX_SPOOL_BYTES);
  positiveNumber('MCP_DEV_SPOOL_TTL_SECONDS', spoolTtlSeconds, MAX_SPOOL_TTL_SECONDS);
  positiveNumber('MCP_DEV_SPOOL_MAX_TOTAL_BYTES', maxSpoolTotalBytes, MAX_SPOOL_TOTAL_BYTES);
  if (maxSpoolTotalBytes < maxSpoolBytes) {
    throw new Error('MCP_DEV_SPOOL_MAX_TOTAL_BYTES must be >= MCP_DEV_MAX_SPOOL_BYTES');
  }
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    throw new Error('MCP_DEV_STATE_DIR must be an absolute path');
  }
}

function killProcessTree(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
    return;
  } catch {
    // The process may have exited before its group was signalled, or may not own a group.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function executeArgv(file, args, cwd, { onData, signal, timeout, softTimeout, onSoftPromote, onBackgroundComplete }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }

    let settled = false;
    let exited = false;
    let promoted = false;
    let exitCode = null;
    let termination = null;
    let hardTimedOut = false;
    let softTimer = null;
    let deadlineTimer = null;
    let postExitTimer = null;
    let stdoutEnded = false;
    let stderrEnded = false;
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    stdoutEnded = child.stdout === null;
    stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (softTimer !== null) clearTimeout(softTimer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (postExitTimer !== null) clearTimeout(postExitTimer);
      signal?.removeEventListener('abort', abort);
      child.removeListener('error', handleError);
      child.removeListener('exit', handleExit);
      child.removeListener('close', handleClose);
      child.stdout?.removeListener('data', handleData);
      child.stdout?.removeListener('end', handleStdoutEnd);
      child.stderr?.removeListener('data', handleData);
      child.stderr?.removeListener('end', handleStderrEnd);
    };
    const finish = (error, code = exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (promoted) {
        onBackgroundComplete?.({ exitCode: code, hardTimedOut });
        return;
      }
      if (error) reject(error);
      else resolve({ exitCode: code });
    };
    const finishAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) {
        finish(termination === null ? null : (termination instanceof Error ? termination : new Error(termination)));
      }
    };
    const armPostExitTimer = () => {
      if (postExitTimer !== null) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(
        () => finish(termination === null ? null : (termination instanceof Error ? termination : new Error(termination))),
        EXIT_STDIO_GRACE_MS
      );
    };
    const terminate = reason => {
      if (settled || termination !== null) return;
      termination = reason;
      if (typeof reason === 'string' && reason.startsWith('timeout:')) hardTimedOut = true;
      killProcessTree(child);
    };
    const abort = () => terminate('aborted');
    const handleData = data => {
      onData(data);
      if (exited && !settled) armPostExitTimer();
    };
    const handleStdoutEnd = () => {
      stdoutEnded = true;
      finishAfterExit();
    };
    const handleStderrEnd = () => {
      stderrEnded = true;
      finishAfterExit();
    };
    const handleError = error => finish(error);
    const handleExit = code => {
      exited = true;
      exitCode = code;
      if (softTimer !== null) {
        clearTimeout(softTimer);
        softTimer = null;
      }
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      finishAfterExit();
      if (!settled) armPostExitTimer();
    };
    const handleClose = code => finish(termination === null ? null : (termination instanceof Error ? termination : new Error(termination)), code);

    child.stdout?.on('data', handleData);
    child.stdout?.once('end', handleStdoutEnd);
    child.stderr?.on('data', handleData);
    child.stderr?.once('end', handleStderrEnd);
    child.once('error', handleError);
    child.once('exit', handleExit);
    child.once('close', handleClose);
    deadlineTimer = setTimeout(() => terminate(`timeout: ${timeout}`), timeout * 1000);
    if (softTimeout !== undefined) {
      softTimer = setTimeout(() => {
        if (settled || exited || promoted) return;
        try {
          onSoftPromote?.(child, () => terminate('aborted'));
        } catch (promoteErr) {
          terminate(promoteErr instanceof Error ? promoteErr : new Error(String(promoteErr)));
          return;
        }
        promoted = true;
        signal?.removeEventListener('abort', abort);
        deadlineTimer?.unref?.();
        child.unref?.();
      }, softTimeout * 1000);
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function resolveCommandDeadlines({ timeout_seconds, softTimeoutSeconds, rpcBudgetMs }) {
  if (softTimeoutSeconds !== undefined) {
    positiveNumber('softTimeoutSeconds', softTimeoutSeconds, MAX_TIMEOUT_SECONDS);
  }
  const budgetSoft = softTimeoutSeconds !== undefined
    ? softTimeoutSeconds
    : (Number.isSafeInteger(rpcBudgetMs) && rpcBudgetMs >= MIN_RPC_BUDGET_MS
      ? Math.max(1, Math.floor(rpcBudgetMs / 1000) - 3)
      : undefined);
  let hardTimeoutSeconds = timeout_seconds;
  if (hardTimeoutSeconds === undefined) {
    hardTimeoutSeconds = budgetSoft === undefined
      ? DEFAULT_TIMEOUT_SECONDS
      : Math.min(MAX_TIMEOUT_SECONDS, Math.max(120, budgetSoft + 30));
  }
  return {
    hardTimeoutSeconds,
    softTimeoutSeconds: budgetSoft !== undefined && budgetSoft < hardTimeoutSeconds ? budgetSoft : undefined,
  };
}

async function runCaptured({
  spoolPrefix,
  pathMode = 'workspace',
  defaultCwd,
  workspaceRoot,
  cwd,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  softTimeoutSeconds,
  maxOutputBytes,
  maxSpoolBytes = DEFAULT_MAX_SPOOL_BYTES,
  spoolTtlSeconds = DEFAULT_SPOOL_TTL_SECONDS,
  maxSpoolTotalBytes = DEFAULT_SPOOL_MAX_TOTAL_BYTES,
  stateDir,
}, signal, execute) {
  validateCapturePolicy({
    timeoutSeconds,
    maxOutputBytes,
    maxSpoolBytes,
    spoolTtlSeconds,
    maxSpoolTotalBytes,
    stateDir,
  });
  if (softTimeoutSeconds !== undefined) {
    positiveNumber('softTimeoutSeconds', softTimeoutSeconds, MAX_TIMEOUT_SECONDS);
  }

  const resolvedCwd = await resolveExecutionCwd({ pathMode, defaultCwd, workspaceRoot, cwd });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const spool = path.join(stateDir, `${spoolPrefix}-${Date.now()}-${process.pid}-${randomUUID()}.log`);
  const activeSpool = `${spool}.active`;
  const fd = openSync(activeSpool, 'wx', 0o600);
  let fdClosed = false;
  const closeFdOnce = () => {
    if (!fdClosed) {
      fdClosed = true;
      try { closeSync(fd); } catch {}
    }
  };
  const started = process.hrtime.bigint();
  const headBudget = headBudgetFor(maxOutputBytes);
  const headBuffer = headBudget > 0 ? Buffer.allocUnsafe(headBudget) : null;
  let headBytes = 0;
  let tail = Buffer.alloc(0);
  let outputBytes = 0;
  let spoolBytes = 0;
  let exitCode = null;
  let timedOut = false;
  let cancelled = false;
  let unexpected = null;
  let promotedInfo = null;
  let leasePromise = null;
  let endBackground = null;
  let resolveBgDone;
  const bgDonePromise = new Promise(resolve => { resolveBgDone = resolve; });

  const onData = data => {
    if (fdClosed) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const remainingSpoolBytes = Math.max(0, maxSpoolBytes - spoolBytes);
    if (remainingSpoolBytes > 0) {
      const retained = chunk.length <= remainingSpoolBytes
        ? chunk
        : chunk.subarray(0, remainingSpoolBytes);
      try {
        writeSync(fd, retained);
        spoolBytes += retained.length;
      } catch {}
    }
    outputBytes += chunk.length;
    if (promotedInfo === null) {
      if (headBuffer !== null && headBytes < headBudget) {
        const room = headBudget - headBytes;
        const copied = Math.min(room, chunk.length);
        chunk.copy(headBuffer, headBytes, 0, copied);
        headBytes += copied;
      }
      tail = boundedTail(tail, chunk, maxOutputBytes);
    }
  };

  try {
    const outcome = await new Promise((resolveOutcome, rejectOutcome) => {
      const onSoftPromote = (child, terminatePromoted) => {
        const jobsDir = path.join(stateDir, 'jobs');
        mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
        void pruneJobSpools({ jobsDir, ttlSeconds: spoolTtlSeconds }).catch(() => {});
        const jobId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
        const logPath = path.join(jobsDir, `${jobId}.log`);
        const exitPath = path.join(jobsDir, `${jobId}.exit`);
        renameSync(activeSpool, logPath);
        promotedInfo = { jobId, pid: child.pid, logPath, exitPath };
        endBackground = beginBackgroundWork(terminatePromoted);
        leasePromise = acquireRuntimeLease({ kind: 'pi-dev-job' });
        void leasePromise.then(
          () => {
            resolveOutcome({ promoted: true });
          },
          async leaseErr => {
            const staleLog = promotedInfo?.logPath;
            promotedInfo = null;
            terminatePromoted?.();
            await bgDonePromise;
            if (staleLog) {
              try { unlinkSync(staleLog); } catch {}
            }
            rejectOutcome(leaseErr);
          },
        );
      };
      const onBackgroundComplete = ({ exitCode: bgExitCode, hardTimedOut }) => {
        if (promotedInfo) {
          if (hardTimedOut && !fdClosed && spoolBytes < maxSpoolBytes) {
            try {
              writeSync(fd, Buffer.from(`\n[hard timeout after ${timeoutSeconds}s]\n`, 'utf8'));
            } catch {}
          }
          closeFdOnce();
          const finalCode = hardTimedOut ? 124 : (typeof bgExitCode === 'number' ? bgExitCode : 128);
          const tmpExit = `${promotedInfo.exitPath}.tmp`;
          try {
            writeFileSync(tmpExit, `${finalCode}\n`, { mode: 0o600 });
            renameSync(tmpExit, promotedInfo.exitPath);
          } catch {}
        } else {
          closeFdOnce();
        }
        resolveBgDone();
        if (endBackground) {
          const finishBg = endBackground;
          endBackground = null;
          finishBg();
        }
        if (leasePromise) {
          const p = leasePromise;
          leasePromise = null;
          void p.then(lease => lease?.close()).catch(() => {});
        }
      };
      execute({
        cwd: resolvedCwd,
        onData,
        signal,
        timeout: timeoutSeconds,
        softTimeout: softTimeoutSeconds,
        onSoftPromote,
        onBackgroundComplete,
      }).then(
        res => resolveOutcome({ promoted: false, exitCode: res.exitCode }),
        err => rejectOutcome(err),
      );
    });
    if (!outcome.promoted) {
      exitCode = outcome.exitCode;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'aborted') cancelled = true;
    else if (message.startsWith('timeout:')) timedOut = true;
    else unexpected = error;
  } finally {
    if (!promotedInfo) {
      closeFdOnce();
    }
  }

  if (unexpected) {
    if (!promotedInfo) {
      try { unlinkSync(activeSpool); } catch {}
    }
    throw unexpected;
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const truncated = outputBytes > maxOutputBytes;
  const spoolTruncated = outputBytes > maxSpoolBytes;
  const renderedOutput = truncated && headBuffer !== null
    ? composeHeadTail(headBuffer.subarray(0, headBytes), tail, outputBytes, maxOutputBytes)
    : decodeBoundedUtf8Tail(tail, maxOutputBytes);

  if (promotedInfo !== null) {
    return {
      cwd: resolvedCwd,
      promoted: true,
      exit_code: null,
      job_id: promotedInfo.jobId,
      pid: promotedInfo.pid,
      log_path: promotedInfo.logPath,
      exit_path: promotedInfo.exitPath,
      hard_timeout_seconds: timeoutSeconds,
      soft_timeout_seconds: softTimeoutSeconds,
      output: renderedOutput,
      output_bytes: outputBytes,
      duration_ms: Math.round(durationMs),
      timed_out: false,
      cancelled: false,
      truncated,
      spool_truncated: spoolTruncated,
      full_output_path: promotedInfo.logPath,
      timeout_seconds: timeoutSeconds,
    };
  }

  if (truncated) {
    renameSync(activeSpool, spool);
  } else {
    try { unlinkSync(activeSpool); } catch {}
  }
  try {
    await pruneBashSpools({
      stateDir,
      maxSpoolBytes,
      ttlSeconds: spoolTtlSeconds,
      maxTotalBytes: maxSpoolTotalBytes,
      protectedPaths: truncated ? [spool] : [],
    });
  } catch (error) {
    console.error(`Pi Dev command spool GC warning: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    cwd: resolvedCwd,
    promoted: false,
    exit_code: timedOut || cancelled ? null : exitCode,
    output: renderedOutput,
    output_bytes: outputBytes,
    duration_ms: Math.round(durationMs),
    timed_out: timedOut,
    cancelled,
    truncated,
    spool_truncated: spoolTruncated,
    full_output_path: truncated ? spool : null,
    timeout_seconds: timeoutSeconds,
  };
}

export async function runBash({
  command,
  timeout_seconds,
  softTimeoutSeconds,
  rpcBudgetMs,
  detach = false,
  ...options
}, signal) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('command must be a non-empty string');
  }
  if (detach) {
    if (timeout_seconds !== undefined) throw new Error('timeout_seconds does not apply to detach: true');
    return runDetached({ argv: ['bash', '-lc', command], ...options });
  }
  const deadlines = resolveCommandDeadlines({ timeout_seconds, softTimeoutSeconds, rpcBudgetMs });
  return runCaptured({
    ...options,
    spoolPrefix: 'bash',
    timeoutSeconds: deadlines.hardTimeoutSeconds,
    softTimeoutSeconds: deadlines.softTimeoutSeconds,
  }, signal, ({ cwd, onData, signal: executionSignal, timeout, softTimeout, onSoftPromote, onBackgroundComplete }) => executeArgv('bash', ['-c', command], cwd, {
    onData,
    signal: executionSignal,
    timeout,
    softTimeout,
    onSoftPromote,
    onBackgroundComplete,
  }));
}

// Runs argv with stdout+stderr in the log; the exit code is written to <exit>.tmp and
// renamed into place, so the exit file existing means the job finished and is readable.
const DETACHED_WRAPPER = 'log=$1; exitf=$2; shift 2; "$@" >"$log" 2>&1 </dev/null; '
  + 'code=$?; printf "%s\\n" "$code" >"$exitf.tmp" && mv -f "$exitf.tmp" "$exitf"';

async function runDetached({
  argv,
  pathMode = 'workspace',
  defaultCwd,
  workspaceRoot,
  cwd,
  spoolTtlSeconds = DEFAULT_SPOOL_TTL_SECONDS,
  stateDir,
}) {
  positiveNumber('MCP_DEV_SPOOL_TTL_SECONDS', spoolTtlSeconds, MAX_SPOOL_TTL_SECONDS);
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    throw new Error('MCP_DEV_STATE_DIR must be an absolute path');
  }
  const resolvedCwd = await resolveExecutionCwd({ pathMode, defaultCwd, workspaceRoot, cwd });
  const jobsDir = path.join(stateDir, 'jobs');
  mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  await pruneJobSpools({ jobsDir, ttlSeconds: spoolTtlSeconds }).catch(() => {});

  const jobId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const logPath = path.join(jobsDir, `${jobId}.log`);
  const exitPath = path.join(jobsDir, `${jobId}.exit`);
  closeSync(openSync(logPath, 'wx', 0o600));
  const child = spawn('/bin/sh', ['-c', DETACHED_WRAPPER, 'sh', logPath, exitPath, ...argv], {
    cwd: resolvedCwd,
    shell: false,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return { cwd: resolvedCwd, job_id: jobId, pid: child.pid, log_path: logPath, exit_path: exitPath };
}

export async function runExec({
  argv,
  timeout_seconds,
  softTimeoutSeconds,
  rpcBudgetMs,
  detach = false,
  ...options
}, signal) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 256) {
    throw new Error('argv must contain from 1 to 256 strings');
  }
  if (argv.some(value => typeof value !== 'string' || value.includes('\0')) || argv[0].length === 0) {
    throw new Error('argv must contain strings without null bytes and argv[0] must be non-empty');
  }
  if (detach) {
    if (timeout_seconds !== undefined) throw new Error('timeout_seconds does not apply to detach: true');
    return runDetached({ argv, ...options });
  }
  const deadlines = resolveCommandDeadlines({ timeout_seconds, softTimeoutSeconds, rpcBudgetMs });
  const [file, ...args] = argv;
  return runCaptured({
    ...options,
    spoolPrefix: 'exec',
    timeoutSeconds: deadlines.hardTimeoutSeconds,
    softTimeoutSeconds: deadlines.softTimeoutSeconds,
  }, signal, ({ cwd, onData, signal: executionSignal, timeout, softTimeout, onSoftPromote, onBackgroundComplete }) => executeArgv(file, args, cwd, {
    onData,
    signal: executionSignal,
    timeout,
    softTimeout,
    onSoftPromote,
    onBackgroundComplete,
  }));
}
