import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_MAX_OUTPUT_BYTES } from './output-limits.mjs';
import { renderScriptText } from './render.mjs';
import { pruneBashSpools } from './spool-gc.mjs';
import {
  DEFAULT_SCRIPT_MAX_CALLS,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  SCRIPT_EXCLUDED_TOOLS,
  SCRIPT_MAX_CONCURRENT,
  SCRIPT_MEMORY_LIMIT_BYTES,
  SCRIPT_READ_CONCURRENCY,
  SCRIPT_READ_ONLY_TOOLS,
  SCRIPT_SLOT_WAIT_MS,
} from './script-limits.mjs';

function textOf(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n');
}

// Bounded codes for _meta["webharness/error-code"], so a failed script is machine-readable
// without parsing the rendered text.
const SCRIPT_ERROR_CODES = {
  script: 'SCRIPT_FAILED',
  timeout: 'SCRIPT_TIMEOUT',
  aborted: 'SCRIPT_ABORTED',
  busy: 'SCRIPT_BUSY',
  sandbox: 'SCRIPT_SANDBOX_FAILED',
};

export function scriptErrorCode(kind) {
  return SCRIPT_ERROR_CODES[kind] ?? 'SCRIPT_FAILED';
}

/**
 * Read-only calls overlap up to a cap; a mutating call waits for every in-flight call
 * and then runs alone. A script's nested calls are real Dev calls, so they must not
 * interleave a mutation with a read of the same file.
 */
class ScriptCallGate {
  constructor({ readConcurrency = SCRIPT_READ_CONCURRENCY } = {}) {
    this.readConcurrency = readConcurrency;
    this.activeReads = 0;
    this.mutating = false;
    this.queue = [];
  }

  async run(readOnly, signal, fn) {
    await this.acquire(readOnly, signal);
    try {
      // A queued call can be admitted after the script already finished. Never dispatch
      // into an aborted signal: the handler would start real work for a dead script.
      signal?.throwIfAborted();
      return await fn();
    } finally {
      this.release(readOnly);
    }
  }

  acquire(readOnly, signal) {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise((resolve, reject) => {
      const entry = { readOnly, resolve, reject, cleanup: null };
      const onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.cleanup = () => signal?.removeEventListener('abort', onAbort);
      this.queue.push(entry);
      this.drain();
    });
  }

  drain() {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next.readOnly) {
        if (this.mutating || this.activeReads >= this.readConcurrency) return;
        this.queue.shift();
        this.activeReads += 1;
        next.cleanup?.();
        next.resolve();
        continue;
      }
      if (this.mutating || this.activeReads > 0) return;
      this.queue.shift();
      this.mutating = true;
      next.cleanup?.();
      next.resolve();
      return;
    }
  }

  release(readOnly) {
    if (readOnly) this.activeReads -= 1;
    else this.mutating = false;
    this.drain();
  }
}

// One Dev worker process can receive concurrent run_script calls. Each script starts its
// own worker thread with its own memory limit, so admission is bounded here rather than
// left to the caller.
const scriptSlots = { active: 0, queue: [] };

function releaseScriptSlot() {
  scriptSlots.active -= 1;
  const next = scriptSlots.queue.shift();
  if (!next) return;
  scriptSlots.active += 1;
  next.resolve();
}

function acquireScriptSlot(signal, waitMs) {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  if (scriptSlots.active < SCRIPT_MAX_CONCURRENT) {
    scriptSlots.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve: null };
    const remove = () => {
      const index = scriptSlots.queue.indexOf(entry);
      if (index >= 0) scriptSlots.queue.splice(index, 1);
    };
    const timer = setTimeout(() => {
      remove();
      cleanup();
      reject(new Error('busy'));
    }, waitMs);
    timer.unref?.();
    const onAbort = () => {
      remove();
      cleanup();
      reject(new Error('aborted'));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    entry.resolve = () => {
      cleanup();
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    scriptSlots.queue.push(entry);
  });
}

// A script's nested calls are dispatched inside Dev, so the WebSession adapter cannot
// rewrite their arguments the way it rewrites a top-level dev_* call. run_script takes
// the same base directory a top-level call would and applies it here, so tools.bash({})
// and tools.read({ path: 'a.txt' }) resolve exactly as dev_bash({}) and
// dev_read({ path: 'a.txt' }) do for the same capability.
const CWD_TOOLS = new Set(['bash', 'exec', 'review_changes', 'file_ops']);
const OPTIONAL_PATH_TOOLS = new Set(['list_directory', 'search']);
const RELATIVE_PATH_TOOLS = new Set(['read', 'write', 'list_directory', 'search']);
const TARGET_PATH_TOOLS = new Set(['read', 'edit']);

function resolveAgainstBase(base, value) {
  if (typeof value !== 'string' || value === '') return value;
  if (path.isAbsolute(value) || value === '~' || value.startsWith('~/')) return value;
  // User mode passes an absolute base; workspace mode passes a workspace-relative one,
  // which must stay relative or the nested handler rejects it.
  return path.isAbsolute(base) ? path.resolve(base, value) : path.join(base, value);
}

export function withDefaultCwd(tool, args, base) {
  if (!base || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  let updated = args;
  const clone = () => {
    if (updated === args) updated = { ...args };
    return updated;
  };
  if (CWD_TOOLS.has(tool) && args.cwd === undefined) {
    clone().cwd = base;
  }
  if (OPTIONAL_PATH_TOOLS.has(tool) && args.path === undefined) {
    clone().path = base;
  } else if (RELATIVE_PATH_TOOLS.has(tool) && typeof args.path === 'string') {
    const resolved = resolveAgainstBase(base, args.path);
    if (resolved !== args.path) clone().path = resolved;
  }
  if (TARGET_PATH_TOOLS.has(tool) && Array.isArray(args.targets)) {
    let changed = false;
    const nextTargets = args.targets.map(target => {
      if (!target || typeof target !== 'object' || typeof target.path !== 'string') return target;
      const resolved = resolveAgainstBase(base, target.path);
      if (resolved === target.path) return target;
      changed = true;
      return { ...target, path: resolved };
    });
    if (changed) clone().targets = nextTargets;
  }
  return updated;
}

function formatIssues(error) {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  if (issues.length === 0) return 'arguments do not match the tool schema';
  return issues.slice(0, 4).map(issue => {
    const where = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  }).join('; ');
}

/**
 * The script's tool table. Each entry forwards to the same handler the MCP tools/call
 * path uses, so nested calls keep the same path policy, error rendering, diagnostics and
 * mutation accounting. A failed nested call rejects the script's promise with the same
 * message, which makes Promise.allSettled work for partial-failure handling.
 */
export function scriptToolTable({ handlers, configs, gate, limits, defaultCwd }) {
  const tools = [];
  for (const [name, handler] of handlers) {
    if (SCRIPT_EXCLUDED_TOOLS.has(name)) continue;
    const readOnly = SCRIPT_READ_ONLY_TOOLS.has(name);
    const schema = configs?.get(name)?.inputSchema;
    tools.push({
      name,
      description: configs?.get(name)?.description,
      execute: async (args, { signal }) => {
        // Seed the base directory before validation so the parsed value carries it, and
        // so a relative path is resolved by the same rule a top-level call would use.
        const seeded = defaultCwd ? withDefaultCwd(name, args, defaultCwd) : args;
        // tools/call validates against this schema before the handler runs. A script must
        // not be a way around those bounds, so validate here too and dispatch the parsed
        // value, which applies defaults and drops unknown keys exactly as MCP does.
        let input = seeded;
        if (typeof schema?.safeParse === 'function') {
          const parsed = schema.safeParse(seeded);
          if (!parsed.success) {
            throw new Error(`INVALID_ARGUMENTS: ${name}: ${formatIssues(parsed.error)}`);
          }
          input = parsed.data;
        }
        if (limits.calls >= limits.maxCalls) {
          throw new Error(`SCRIPT_CALL_LIMIT: the script already made ${limits.maxCalls} tool calls; split the work into smaller scripts`);
        }
        limits.calls += 1;
        const result = await gate.run(readOnly, signal, () => handler(input, { signal, callId: limits.callId }));
        if (result?.isError) throw new Error(textOf(result) || `Tool "${name}" failed`);
        if (result?.structuredContent !== undefined) return result.structuredContent;
        return textOf(result);
      },
    });
  }
  return tools;
}

function sliceUtf8Head(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function sliceUtf8Tail(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

export function truncateScriptText(text, maxBytes) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  const headBytes = Math.floor(maxBytes / 2);
  const tailBytes = maxBytes - headBytes;
  const head = sliceUtf8Head(text, headBytes);
  const tail = sliceUtf8Tail(text, tailBytes);
  const omitted = bytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
  return { text: `${head}\n[... ${omitted} bytes omitted ...]\n${tail}`, bytes, truncated: true };
}

function renderOutputItems(items) {
  const parts = [];
  for (const item of items ?? []) {
    if (item?.type === 'text') parts.push(item.text);
    else if (item?.type === 'image') {
      const bytes = Math.floor((String(item.data ?? '').length * 3) / 4);
      parts.push(`[image ${item.mimeType ?? 'unknown'} ${bytes}B not returned]`);
    }
  }
  return parts.join('\n');
}

function renderValue(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function spillScriptOutput({ text, stateDir, spoolTtlSeconds, maxSpoolBytes, maxSpoolTotalBytes }) {
  const file = path.join(stateDir, `script-${Date.now()}-${process.pid}-${randomUUID()}.log`);
  // A fresh state path must not turn a truncated result into a failed call.
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(file, text, { mode: 0o600, flag: 'wx' });
  try {
    await pruneBashSpools({
      stateDir,
      maxSpoolBytes,
      ttlSeconds: spoolTtlSeconds,
      maxTotalBytes: maxSpoolTotalBytes,
      protectedPaths: [file],
    });
  } catch (error) {
    console.error(`Pi Dev script spool GC warning: ${error instanceof Error ? error.message : String(error)}`);
  }
  return file;
}

function failedResult({ kind, message, durationMs, calls = [], callCount = 0, callLimit = 0 }) {
  return {
    status: 'failed',
    error_kind: kind,
    error_message: message,
    duration_ms: durationMs,
    calls,
    call_count: callCount,
    call_limit: callLimit,
    output: '',
    output_bytes: 0,
    truncated: false,
    full_output_path: null,
  };
}

/**
 * Run one script against this process's registered Dev handlers.
 *
 * The sandbox owns the VM, the promise bridge, the deadline and cancellation. This
 * adapter owns everything the script must not influence: which tools exist, how many
 * calls it may make, how nested calls interleave, and what reaches the model.
 */
export async function runScript({
  script,
  cwd,
  timeout_ms,
  max_calls,
  maxOutputBytes,
  handlers,
  configs,
  signal,
  callId,
  stateDir,
  spoolTtlSeconds,
  maxSpoolBytes,
  maxSpoolTotalBytes,
}) {
  const started = performance.now();
  const timeoutMs = timeout_ms ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const outputLimit = maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxCalls = max_calls ?? DEFAULT_SCRIPT_MAX_CALLS;
  // The wait for a free slot counts against the caller's deadline, so timeout_ms stays an
  // overall bound instead of a bound that only starts after admission.
  const slotWaitMs = Math.min(SCRIPT_SLOT_WAIT_MS, timeoutMs);

  try {
    await acquireScriptSlot(signal, slotWaitMs);
  } catch (error) {
    const aborted = error?.message !== 'busy';
    const kind = aborted ? 'aborted' : slotWaitMs < SCRIPT_SLOT_WAIT_MS ? 'timeout' : 'busy';
    const message = aborted
      ? 'The script was cancelled before it started'
      : kind === 'timeout'
        ? `The script timed out after ${timeoutMs} ms while waiting for a free script slot`
        : `All ${SCRIPT_MAX_CONCURRENT} script slots are held by other scripts; retry after they finish`;
    return failedResult({ kind, message, durationMs: Math.round(performance.now() - started), callLimit: maxCalls });
  }

  const remainingMs = Math.max(1, Math.round(timeoutMs - (performance.now() - started)));

  const gate = new ScriptCallGate();
  const limits = { calls: 0, maxCalls, callId };
  const tools = scriptToolTable({ handlers, configs, gate, limits, defaultCwd: cwd });
  let sandbox;
  let result;
  try {
    // The import and the constructor are inside the try so a missing or broken
    // sandbox dependency cannot strand the admission slot.
    const { CodemodeSandbox } = await import('@earendil-works/pi-codemode');
    sandbox = new CodemodeSandbox({
      tools,
      timeoutMs: remainingMs,
      memoryLimitBytes: SCRIPT_MEMORY_LIMIT_BYTES,
    });
    result = await sandbox.execute(script, { signal });
  } finally {
    await sandbox?.close().catch(() => {});
    releaseScriptSlot();
  }

  const durationMs = Math.round(performance.now() - started);
  const calls = (result.calls ?? []).map(call => ({
    name: call.name,
    status: call.status,
    duration_ms: Math.round(call.durationMs),
  }));

  const structured = result.ok
    ? {
        status: 'completed',
        error_kind: null,
        error_message: null,
        duration_ms: durationMs,
        calls,
        call_count: limits.calls,
        call_limit: maxCalls,
        output: [renderOutputItems(result.output), renderValue(result.value)]
          .filter(part => part !== '')
          .join('\n'),
      }
    : {
        status: 'failed',
        error_kind: result.error.kind,
        error_message: result.error.message,
        duration_ms: durationMs,
        calls,
        call_count: limits.calls,
        call_limit: maxCalls,
        output: renderOutputItems(result.output),
      };

  // The model-facing artifact is the rendered text, so the budget applies to the whole
  // response: output, error message and call records together. Bounding only the output
  // let a generated error or a long call list exceed the cap while reporting truncated:false.
  const rendered = renderScriptText(structured);
  const bounded = truncateScriptText(rendered, outputLimit);
  const fullOutputPath = bounded.truncated
    ? await spillScriptOutput({ text: rendered, stateDir, spoolTtlSeconds, maxSpoolBytes, maxSpoolTotalBytes })
    : null;
  return {
    ...structured,
    text: bounded.truncated
      ? `${bounded.text}\n[truncated · ${bounded.bytes} bytes total · saved on remote host: ${fullOutputPath}]`
      : bounded.text,
    output_bytes: bounded.bytes,
    truncated: bounded.truncated,
    full_output_path: fullOutputPath,
  };
}
