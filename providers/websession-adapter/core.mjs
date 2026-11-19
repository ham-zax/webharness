import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { requestHash, AdapterStore } from './store.mjs';
import { callMcpTool, closeMcpPools, findMcpTool, listMcpTools } from './mcp-client.mjs';
import { explainSchemaViolation, looksLikeSchemaValidationError } from '../../lib/schema-hint.mjs';
import { isKnownReadOnlyRoute } from '../../lib/local-route-policy.mjs';

const MAX_RESULT_BYTES = 1024 * 1024;
const DEV_COMMAND_FAILURE_FOOTER = /^\[(?:exit (?!0(?:\]| · ))-?\d+|timed out after [0-9.]+s|cancelled|terminated)(?: · [0-9.]+s)?\]$/;
// dev_run_script takes the same base directory as the shell and file tools: Dev applies
// it to the script's nested calls, which never pass through this rewrite themselves.
const DEFAULT_CWD_TOOLS = new Set(['dev_bash', 'dev_exec', 'dev_review_changes', 'dev_file_ops', 'dev_run_script']);
// fallback_dispatch advertises readOnlyHint for client transport compatibility while the
// selected downstream operation can still mutate, so it must never join _readOnlyTools
// unconditionally; _isConcurrentOperation inspects its routed {server, tool} instead.
const SERIALIZED_TOOLS = new Set(['local_fallback_dispatch']);
const ROUTED_LOCAL_TOOLS = new Set(['local_fallback_dispatch', 'local_tool_call', 'local_tool_batch']);
const OPTIONAL_PATH_CWD_TOOLS = new Set(['dev_list_directory', 'dev_search']);
const RELATIVE_PATH_TOOLS = new Set(['dev_read', 'dev_write', 'dev_list_directory', 'dev_search']);
const TARGET_PATH_TOOLS = new Set(['dev_read', 'dev_edit']);

function normalizeDevInnerTool(tool) {
  if (typeof tool !== 'string' || !tool) return null;
  return tool.startsWith('dev_') ? tool.slice(4) : tool;
}

const FILE_SCOPED_DEV_TOOLS = new Set(['write', 'edit']);

function unwrapLocalRoute(tool, rawArguments) {
  if (!ROUTED_LOCAL_TOOLS.has(tool)) return null;
  if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) return null;
  const server = typeof rawArguments.server === 'string' && rawArguments.server ? rawArguments.server : undefined;
  const toolName = typeof rawArguments.tool === 'string' && rawArguments.tool ? rawArguments.tool : undefined;
  const args = rawArguments.arguments;
  const calls = Array.isArray(rawArguments.calls) ? rawArguments.calls : undefined;
  const allowHeterogeneous = tool === 'local_fallback_dispatch';
  if (!(allowHeterogeneous && calls !== undefined) && (!server || !toolName)) return null;
  return {
    server,
    tool: toolName,
    arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : undefined,
    hadArguments: args !== undefined,
    calls,
    allowHeterogeneous,
  };
}

function resolveBatchEntryRoute(route, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const server = (route.allowHeterogeneous && typeof entry.server === 'string' && entry.server)
    ? entry.server
    : route.server;
  const tool = (route.allowHeterogeneous && typeof entry.tool === 'string' && entry.tool)
    ? entry.tool
    : route.tool;
  if (!server || !tool) return null;
  const rawArgs = entry.arguments;
  return {
    server,
    tool,
    arguments: rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : undefined,
    hadArguments: rawArgs !== undefined,
  };
}

function isDevCommandRoute(server, tool) {
  if (server !== 'dev') return false;
  const baseTool = normalizeDevInnerTool(tool);
  return baseTool === 'exec' || baseTool === 'bash';
}

function parseOperationRoute(operation) {
  if (!operation || !ROUTED_LOCAL_TOOLS.has(operation.tool)) return null;
  try {
    const parsed = JSON.parse(operation.request_json);
    return unwrapLocalRoute(operation.tool, parsed?.arguments);
  } catch {
    return null;
  }
}

function resolveAgainstDefaultCwd(rawPath, defaultCwd) {
  if (typeof rawPath !== 'string' || !rawPath) return rawPath;
  if (rawPath.startsWith('/') || rawPath === '~' || rawPath.startsWith('~/')) return rawPath;
  return posix.resolve(defaultCwd, rawPath);
}

export function applyDefaultCwd(tool, rawArguments, defaultCwd) {
  if (!defaultCwd || !rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
    return rawArguments;
  }
  const routed = unwrapLocalRoute(tool, rawArguments);
  if (routed) {
    if (routed.calls) {
      let changed = false;
      const nextCalls = routed.calls.map(entry => {
        const resolved = resolveBatchEntryRoute(routed, entry);
        if (!resolved || resolved.server !== 'dev') return entry;
        const baseTool = normalizeDevInnerTool(resolved.tool);
        if (!baseTool) return entry;
        if (resolved.hadArguments && resolved.arguments === undefined) return entry;
        const innerArgs = resolved.arguments ?? {};
        const nextInner = applyDefaultCwd(`dev_${baseTool}`, innerArgs, defaultCwd);
        if (nextInner === innerArgs) return entry;
        changed = true;
        return { ...entry, arguments: nextInner };
      });
      return changed ? { ...rawArguments, calls: nextCalls } : rawArguments;
    }
    if (routed.server !== 'dev') return rawArguments;
    const baseTool = normalizeDevInnerTool(routed.tool);
    if (!baseTool) return rawArguments;
    if (routed.hadArguments && routed.arguments === undefined) return rawArguments;
    const innerArgs = routed.arguments ?? {};
    const nextInner = applyDefaultCwd(`dev_${baseTool}`, innerArgs, defaultCwd);
    if (nextInner === innerArgs) return rawArguments;
    return { ...rawArguments, arguments: nextInner };
  }
  let updated = rawArguments;
  const clone = () => {
    if (updated === rawArguments) updated = { ...rawArguments };
    return updated;
  };
  if (DEFAULT_CWD_TOOLS.has(tool)) {
    if (rawArguments.cwd === undefined) {
      clone().cwd = defaultCwd;
    } else if (typeof rawArguments.cwd === 'string') {
      const resolved = resolveAgainstDefaultCwd(rawArguments.cwd, defaultCwd);
      if (resolved !== rawArguments.cwd) clone().cwd = resolved;
    }
  }
  if (OPTIONAL_PATH_CWD_TOOLS.has(tool) && rawArguments.path === undefined) {
    clone().path = defaultCwd;
  } else if (RELATIVE_PATH_TOOLS.has(tool) && typeof rawArguments.path === 'string') {
    const resolved = resolveAgainstDefaultCwd(rawArguments.path, defaultCwd);
    if (resolved !== rawArguments.path) clone().path = resolved;
  }
  if (TARGET_PATH_TOOLS.has(tool) && Array.isArray(rawArguments.targets)) {
    let changed = false;
    const nextTargets = rawArguments.targets.map(target => {
      if (!target || typeof target !== 'object' || typeof target.path !== 'string') return target;
      const resolved = resolveAgainstDefaultCwd(target.path, defaultCwd);
      if (resolved === target.path) return target;
      changed = true;
      return { ...target, path: resolved };
    });
    if (changed) clone().targets = nextTargets;
  }
  return updated;
}

function boundedError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 2048);
}

export function renderToolResult(result) {
  if (result?.isError) {
    const text = Array.isArray(result.content)
      ? result.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
      : 'MCP tool failed';
    throw new Error(text || 'MCP tool failed');
  }
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const textOnly = blocks.length > 0 && blocks.every(block => block?.type === 'text');
  // A tool that returns structuredContent also renders the same payload as text, so
  // sending the whole envelope billed the model twice for one result. Send one form:
  // the rendered text, which carries the tool's own guidance (a detached exec's wait
  // hint, for example), and fall back to the structured value when the content is not
  // plain text.
  const text = textOnly
    ? blocks.map(block => block.text).join('\n')
    : result?.structuredContent !== undefined
      ? JSON.stringify(result.structuredContent)
      : JSON.stringify(result);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new Error('result_too_large');
  return text;
}

function isDevCommandOperation(operation) {
  if (operation.tool === 'dev_exec' || operation.tool === 'dev_bash') return true;
  const route = parseOperationRoute(operation);
  if (!route || route.server !== 'dev') return false;
  const baseTool = normalizeDevInnerTool(route.tool);
  return baseTool === 'exec' || baseTool === 'bash';
}

function normalizeTargetPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) return null;
  if (rawPath === '~') return posix.normalize(homedir());
  if (rawPath.startsWith('~/')) {
    return posix.resolve(homedir(), rawPath.slice(2));
  }
  return posix.normalize(rawPath);
}

function extractSingleFileScopedPaths(baseTool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (baseTool === 'write') {
    const normalized = normalizeTargetPath(args.path);
    return normalized ? [normalized] : null;
  }
  if (baseTool === 'edit') {
    if (!Array.isArray(args.targets) || args.targets.length === 0) return null;
    const paths = [];
    for (const target of args.targets) {
      if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
      const normalized = normalizeTargetPath(target.path);
      if (!normalized) return null;
      paths.push(normalized);
    }
    return paths;
  }
  return null;
}

const BATCH_CALL_HEADER = /^call (\d+)(?: \([^\n]+\))?(?: \[([^\]\n]+)\])?: (?:fulfilled(?: \(downstream isError\))?|rejected [A-Z0-9_]+:.*)$/;

function isHeaderSectionDevCommand(callIndex, routeTag, route) {
  if (routeTag) {
    const slash = routeTag.indexOf('/');
    if (slash > 0) {
      return isDevCommandRoute(routeTag.slice(0, slash), routeTag.slice(slash + 1));
    }
  }
  if (route?.calls && Number.isInteger(callIndex) && callIndex >= 0 && callIndex < route.calls.length) {
    const resolved = resolveBatchEntryRoute(route, route.calls[callIndex]);
    if (resolved) return isDevCommandRoute(resolved.server, resolved.tool);
  }
  return Boolean(route && isDevCommandRoute(route.server, route.tool));
}

function hasUnsuccessfulDevCommandInBatchText(text, route) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const lines = text.split('\n');
  let section = [];
  let checkCurrent = false;
  for (const line of lines) {
    const match = BATCH_CALL_HEADER.exec(line);
    if (match) {
      if (checkCurrent && section.length > 0 && hasUnsuccessfulCommandFooter(section.join('\n'))) return true;
      section = [];
      checkCurrent = isHeaderSectionDevCommand(Number.parseInt(match[1], 10), match[2], route);
    } else if (checkCurrent) {
      section.push(line);
    }
  }
  return checkCurrent && section.length > 0 && hasUnsuccessfulCommandFooter(section.join('\n'));
}

export function hasUnsuccessfulCommandFooter(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  let body = text;
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed?.content)) {
        const joined = parsed.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
        if (joined) body = joined;
      }
    } catch {
      // Plain command output that happens to start with '{'.
    }
  }
  const withoutLf = body.endsWith('\n') ? body.slice(0, -1) : body;
  const clean = withoutLf.endsWith('\r') ? withoutLf.slice(0, -1) : withoutLf;
  const lastLine = clean.slice(clean.lastIndexOf('\n') + 1);
  return DEV_COMMAND_FAILURE_FOOTER.test(lastLine);
}

export class OperationCore {
  constructor({ stateDir, mcpUrl, callbackUrl, toolTimeoutMs }) {
    this.store = new AdapterStore(stateDir);
    this.mcpUrl = mcpUrl;
    this.callbackUrl = callbackUrl;
    this.toolTimeoutMs = toolTimeoutMs;
    this._active = new Map();
    this._tails = new Map();
    this._fileActive = new Map();
    this._filePathTails = new Map();
    this._scheduledDefaultCwd = new Map();
    this._readOnlyTools = new Set([
      'dev_read',
      'dev_list_directory',
      'dev_search',
      'dev_review_changes',
      // dev_wait is non-readOnly in pi-dev (arming/cancel writes durable wait state),
      // but stays concurrent here so waits never deadlock behind a running dev_bash/dev_exec.
      'dev_wait',
      'local_tool_list',
      'local_tool_schema',
    ]);
  }

  start() {
    this.store.recoverOperations();
    if (!this.mcpUrl) return;
    for (const item of this.store.recoverableScheduleItems()) {
      if (item.kind === 'sequential_batch') {
        this._scheduleSequentialBatch(item.principalId, item.batchId);
      } else {
        this._schedule(item.id);
      }
    }
  }

  close() {
    this.store.close();
    return closeMcpPools();
  }

  async permittedTools(capabilityToken, { signal } = {}) {
    const principal = this.store.resolveCapability(capabilityToken);
    if (!principal) return undefined;
    if (!this.mcpUrl) throw new Error('adapter MCP URL is unavailable');
    const listed = await listMcpTools({
      mcpUrl: this.mcpUrl,
      stateDir: this.store.stateDir,
      callbackUrl: this.callbackUrl,
      signal,
    });
    for (const tool of listed.tools) {
      if (tool?.annotations?.readOnlyHint === true && typeof tool.name === 'string' && !SERIALIZED_TOOLS.has(tool.name)) this._readOnlyTools.add(tool.name);
    }
    return { principal, tools: listed.tools, instructions: listed.instructions };
  }

  getDefaultCwd(capabilityToken) {
    const principal = this.store.resolveCapability(capabilityToken);
    if (!principal) return { unauthorized: true };
    return { defaultCwd: principal.defaultCwd };
  }

  async setDefaultCwd(capabilityToken, requestedCwd) {
    const principal = this.store.resolveCapability(capabilityToken);
    if (!principal) return { unauthorized: true };
    if (requestedCwd === null || requestedCwd === '') {
      const updated = this.store.updateCapabilityDefaultCwd(principal.id, null);
      if (updated === undefined) return { unauthorized: true };
      return { defaultCwd: null };
    }
    if (typeof requestedCwd !== 'string' || requestedCwd.includes('\0')) {
      return { invalidCwd: true, message: 'cwd must be a non-empty string without NUL bytes, or null to clear' };
    }
    const candidate = (requestedCwd.startsWith('/') || requestedCwd === '~' || requestedCwd.startsWith('~/'))
      ? requestedCwd
      : (principal.defaultCwd ? posix.resolve(principal.defaultCwd, requestedCwd) : requestedCwd);
    if (!this.mcpUrl) throw new Error('adapter MCP URL is unavailable');
    const listed = await listMcpTools({
      mcpUrl: this.mcpUrl,
      stateDir: this.store.stateDir,
      callbackUrl: this.callbackUrl,
    });
    if (listed.tools.some(tool => tool?.name === 'dev_list_directory')) {
      let result;
      try {
        result = await callMcpTool(
          { mcpUrl: this.mcpUrl, stateDir: this.store.stateDir, callbackUrl: this.callbackUrl, timeoutMs: this.toolTimeoutMs },
          'dev_list_directory',
          { path: candidate, limit: 30 },
        );
      } catch (error) {
        return { invalidCwd: true, message: boundedError(error) };
      }
      let listing;
      try {
        listing = renderToolResult(result);
      } catch (error) {
        return { invalidCwd: true, message: boundedError(error) };
      }
      const firstLine = listing.split('\n', 1)[0] || '';
      const canonical = firstLine.startsWith('dir: ') ? firstLine.slice('dir: '.length).trim() : candidate;
      if (!canonical || canonical.includes('\0')) {
        return { invalidCwd: true, message: 'unable to resolve canonical directory path' };
      }
      const updated = this.store.updateCapabilityDefaultCwd(principal.id, canonical);
      if (updated === undefined) return { unauthorized: true };
      return { defaultCwd: canonical, listing };
    }
    if (!candidate.startsWith('/')) {
      return { invalidCwd: true, message: 'cwd must be an absolute path when dev_list_directory is unavailable' };
    }
    const normalized = posix.normalize(candidate);
    const updated = this.store.updateCapabilityDefaultCwd(principal.id, normalized);
    if (updated === undefined) return { unauthorized: true };
    return { defaultCwd: normalized };
  }

  submit(
    capabilityToken,
    clientNonce,
    parsedRequest,
    sourceProfile,
    turnId = null,
    { deferSchedule = false, requestHashOverride, batchId = null, batchIndex = null, stopOnError = null } = {},
  ) {
    if (!this.mcpUrl) throw new Error('adapter MCP URL is unavailable');
    const principal = this.store.resolveCapability(capabilityToken);
    if (!principal) return { unauthorized: true };
    if (!this.store.advanceTurn(principal.id, turnId)) return { superseded: true };

    const classification = sourceProfile === 'universal-get-v1' ? 'confirmation_required' : 'automatic';
    const hash = requestHashOverride || requestHash(parsedRequest.requestJson);
    const state = classification === 'automatic' ? 'queued' : 'confirmation_required';
    const submitted = this.store.submitOperation(principal.id, clientNonce, parsedRequest.requestJson, hash, {
      tool: parsedRequest.normalized.tool,
      policyClass: classification,
      sourceProfile,
      state,
      turnId,
      batchId,
      batchIndex,
      stopOnError,
    });
    if (
      !submitted.operation
      || submitted.operation.request_hash !== hash
      || submitted.operation.turn_id !== turnId
      || submitted.operation.batch_id !== batchId
      || submitted.operation.batch_index !== batchIndex
      || submitted.operation.stop_on_error !== stopOnError
    ) {
      return { nonceConflict: true };
    }
    if (!deferSchedule && submitted.operation.state === 'queued') this._schedule(submitted.operation.id);

    const response = {
      operation: submitted.operation,
      continuationToken: this.store.continuationToken(submitted.operation.id),
      created: submitted.created,
    };
    if (submitted.operation.state === 'confirmation_required') {
      response.confirmation = {
        capability: submitted.confirmationCapability || this.store.confirmationCapability(submitted.operation.id),
        challenge: submitted.challenge || this.store.confirmationChallenge(submitted.operation.id),
        expiresMs: submitted.operation.confirmation_expires_ms,
        summary: `invoke ${parsedRequest.normalized.tool}`,
      };
    }
    return response;
  }

  submitBatch(capabilityToken, clientNonce, parsedItems, turnId = null, { sequential = false, stopOnError = true } = {}) {
    // Domain separation and the complete nonce keep batch item identities distinct.
    const nonceHash = createHash('sha256').update(clientNonce).digest('base64url');
    const batchId = sequential ? `seq.${nonceHash}` : null;
    const persistedStopOnError = sequential ? (stopOnError ? 1 : 0) : null;
    const submissions = [];
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < parsedItems.length; index += 1) {
        const itemHash = sequential
          ? requestHash(`${parsedItems[index].requestJson}|seq:${stopOnError ? 1 : 0}:${index}:${parsedItems.length}`)
          : undefined;
        const submitted = this.submit(
          capabilityToken,
          `batch.${nonceHash}.${index}`,
          parsedItems[index],
          'json-post-v1',
          turnId,
          {
            deferSchedule: true,
            requestHashOverride: itemHash,
            batchId,
            batchIndex: sequential ? index : null,
            stopOnError: persistedStopOnError,
          },
        );
        if (submitted.unauthorized || submitted.superseded || submitted.nonceConflict) {
          this.store.db.exec('ROLLBACK');
          return submitted;
        }
        submissions.push(submitted);
      }
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    if (sequential) {
      this._scheduleSequentialBatch(submissions[0].operation.principal_id, batchId);
    } else {
      for (const submitted of submissions) {
        if (submitted.operation.state === 'queued') this._schedule(submitted.operation.id);
      }
    }
    return { submissions };
  }

  _isUnsuccessfulStep(operation) {
    if (!operation || operation.state !== 'completed') return true;
    const route = parseOperationRoute(operation);
    const isLocalBatch = operation.tool === 'local_tool_batch'
      || (operation.tool === 'local_fallback_dispatch' && Array.isArray(route?.calls));
    if (!isLocalBatch && isDevCommandOperation(operation)) {
      const tail = operation.result_text ?? this.store.getOperationTailText(operation.id) ?? '';
      if (hasUnsuccessfulCommandFooter(tail)) return true;
    }
    if (isLocalBatch) {
      const full = operation.result_text ?? this.store.getOperationResult(operation.id) ?? '';
      try {
        const parsed = JSON.parse(full);
        const results = parsed?.structuredContent?.results ?? parsed?.results;
        const parsedServer = parsed?.structuredContent?.server ?? parsed?.server;
        const parsedTool = parsed?.structuredContent?.tool ?? parsed?.tool;
        if (Array.isArray(results)) {
          for (let i = 0; i < results.length; i += 1) {
            const entry = results[i];
            if (entry?.status === 'rejected' || entry?.result?.isError === true) return true;
            if (entry?.status === 'fulfilled') {
              const idx = Number.isInteger(entry.index) ? entry.index : i;
              const reqEntry = route?.calls?.[idx] ? resolveBatchEntryRoute(route, route.calls[idx]) : null;
              const entryServer = entry.server ?? parsedServer ?? reqEntry?.server ?? route?.server;
              const entryTool = entry.tool ?? parsedTool ?? reqEntry?.tool ?? route?.tool;
              if (isDevCommandRoute(entryServer, entryTool)) {
                const content = Array.isArray(entry?.result?.content) ? entry.result.content : [];
                const entryText = content
                  .filter(block => block?.type === 'text' && typeof block.text === 'string')
                  .map(block => block.text)
                  .join('\n');
                if (hasUnsuccessfulCommandFooter(entryText)) return true;
              }
            }
          }
        }
      } catch {
        // Text-only batch results render as "call <index>[ (<id>)][ [<server>/<tool>]]: rejected <CODE>: ..."
        // or "call <index>[ (<id>)][ [<server>/<tool>]]: fulfilled (downstream isError)".
        if (/^call \d+(?: \([^\n]+\))?(?: \[[^\]\n]+\])?: (?:rejected [A-Z0-9_]+:|fulfilled \(downstream isError\)$)/m.test(full)) {
          return true;
        }
        if (hasUnsuccessfulDevCommandInBatchText(full, route)) {
          return true;
        }
      }
    }
    return false;
  }

  _scheduleSequentialBatch(principalId, batchId) {
    const operations = this.store.getBatchOperations(principalId, batchId);
    if (operations.length === 0) return;
    const stopOnError = operations[0].stop_on_error !== 0;

    const queuedIds = [];
    for (const op of operations) {
      if (op.state === 'queued' && !this._active.has(op.id)) {
        queuedIds.push(op.id);
      }
    }
    if (queuedIds.length === 0) return;

    const resolvers = new Map();
    const promises = new Map();
    for (const id of queuedIds) {
      let resolveDone;
      const promise = new Promise(resolve => { resolveDone = resolve; });
      resolvers.set(id, resolveDone);
      promises.set(id, promise);
      this._active.set(id, promise);
    }

    const laneKeys = new Set([principalId]);
    for (const op of operations) {
      for (const key of this._mutationLaneKeys(op)) laneKeys.add(key);
    }

    this._enqueueLanes([...laneKeys], async () => {
      try {
        let failedPrior = false;
        for (const op of this.store.getBatchOperations(principalId, batchId)) {
          const id = op.id;
          const done = resolvers.get(id);
          if (!done) {
            if (stopOnError && this._isUnsuccessfulStep(op)) failedPrior = true;
            continue;
          }
          try {
            if (failedPrior) {
              this.store.rejectOperation(id, 'skipped_after_prior_failure');
            } else {
              await this._run(id);
              if (stopOnError) {
                const after = this.store.getOperation(id);
                if (this._isUnsuccessfulStep(after)) failedPrior = true;
              }
            }
          } finally {
            resolvers.delete(id);
            if (this._active.get(id) === promises.get(id)) this._active.delete(id);
            done();
          }
        }
      } finally {
        for (const [id, done] of resolvers) {
          if (this._active.get(id) === promises.get(id)) this._active.delete(id);
          done();
        }
      }
    });
  }

  _enqueueLanes(laneKeys, taskFn) {
    const keys = [...new Set(laneKeys)];
    const deps = [];
    for (const key of keys) {
      const prev = this._tails.get(key);
      if (prev) deps.push(prev);
      const priorFiles = this._fileActive.get(key);
      if (priorFiles) deps.push(...priorFiles);
    }
    let current;
    const cleanup = () => {
      for (const key of keys) {
        if (this._tails.get(key) === current) this._tails.delete(key);
      }
    };
    const barrier = deps.length === 0
      ? Promise.resolve()
      : deps.length === 1
        ? deps[0].catch(() => {})
        : Promise.allSettled(deps);
    current = barrier.then(taskFn).then(
      value => {
        cleanup();
        return value;
      },
      () => {
        cleanup();
      },
    );
    for (const key of keys) {
      this._tails.set(key, current);
    }
    return current;
  }

  _enqueuePrincipal(principalId, taskFn) {
    return this._enqueueLanes([principalId], taskFn);
  }

  // File-scoped Dev mutations (dev_write / dev_edit) wait behind any prior exclusive Dev
  // op (bash/exec/file_ops/run_script/batch) and drain before any later exclusive op.
  // Disjoint target paths overlap while same-path writes/edits chain FIFO in submission order.
  _enqueueFileScoped(principalId, targetPaths, taskFn) {
    const uniquePaths = [...new Set(targetPaths)];
    const deps = [];
    const previousExclusive = this._tails.get(principalId);
    if (previousExclusive) deps.push(previousExclusive);
    let pathMap = this._filePathTails.get(principalId);
    if (!pathMap) {
      pathMap = new Map();
      this._filePathTails.set(principalId, pathMap);
    }
    for (const targetPath of uniquePaths) {
      const prevForPath = pathMap.get(targetPath);
      if (prevForPath) deps.push(prevForPath);
    }
    let set = this._fileActive.get(principalId);
    if (!set) {
      set = new Set();
      this._fileActive.set(principalId, set);
    }
    const barrier = deps.length === 0
      ? Promise.resolve()
      : deps.length === 1
        ? deps[0].catch(() => {})
        : Promise.allSettled(deps);
    let promise;
    const cleanup = () => {
      set.delete(promise);
      if (set.size === 0 && this._fileActive.get(principalId) === set) {
        this._fileActive.delete(principalId);
      }
      for (const targetPath of uniquePaths) {
        if (pathMap.get(targetPath) === promise) pathMap.delete(targetPath);
      }
      if (pathMap.size === 0 && this._filePathTails.get(principalId) === pathMap) {
        this._filePathTails.delete(principalId);
      }
    };
    promise = barrier.then(taskFn).then(
      value => {
        cleanup();
        return value;
      },
      () => {
        cleanup();
      },
    );
    set.add(promise);
    for (const targetPath of uniquePaths) {
      pathMap.set(targetPath, promise);
    }
    return promise;
  }

  confirm(operationId, confirmationCapability, challenge) {
    if (!this.store.confirmationCapabilityMatches(operationId, confirmationCapability)) return { notFound: true };
    const operation = this.store.getOperation(operationId);
    if (!operation) return { notFound: true };
    if (operation.state === 'confirmation_required') {
      const principal = this.store.activeCapabilityById(operation.principal_id);
      if (!principal) return { authorizationInvalid: true, operation };
    }

    const confirmed = this.store.confirmOperation(operationId, challenge);
    if (confirmed.invalid) return { notFound: true };
    if (confirmed.authorizationInvalid) return { authorizationInvalid: true, operation: confirmed.operation };
    if (confirmed.operation?.state === 'queued') this._schedule(operationId);
    return {
      operation: confirmed.operation,
      continuationToken: this.store.continuationToken(operationId),
    };
  }

  readOperation(operationId, continuationToken) {
    if (!this.store.continuationMatches(operationId, continuationToken)) return undefined;
    return this.store.getOperation(operationId);
  }

  readOperationChunk(operationId, continuationToken, chunkNumber) {
    if (!this.store.continuationMatches(operationId, continuationToken)) return undefined;
    const operation = this.store.getOperation(operationId);
    if (!operation || operation.state !== 'completed') return undefined;
    return this.store.getOperationChunk(operationId, chunkNumber);
  }

  readOperationResult(operationId, continuationToken) {
    if (!this.store.continuationMatches(operationId, continuationToken)) return undefined;
    return this.store.getOperationResult(operationId);
  }

  async waitForOperation(operationId, timeoutMs, signal = undefined) {
    const active = this._active.get(operationId);
    if (active && !signal?.aborted) {
      let timer;
      let onAbort;
      try {
        await Promise.race([
          active.catch(() => {}),
          new Promise(resolve => {
            timer = setTimeout(resolve, timeoutMs);
            onAbort = resolve;
            signal?.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      }
    }
    return this.store.getOperation(operationId);
  }

  _isReadOnlyLocalRoute(server, tool, args, hadArguments) {
    if (server === 'dev') {
      const baseTool = normalizeDevInnerTool(tool);
      return Boolean(baseTool && this._readOnlyTools.has(`dev_${baseTool}`));
    }
    return isKnownReadOnlyRoute(server, tool, args, { hadArguments });
  }

  _isConcurrentOperation(operation) {
    if (!operation) return true;
    if (this._readOnlyTools.has(operation.tool)) return true;
    const route = parseOperationRoute(operation);
    if (!route) return false;
    if (route.calls) {
      return route.calls.length > 0 && route.calls.every(entry => {
        const resolved = resolveBatchEntryRoute(route, entry);
        if (!resolved) return false;
        return this._isReadOnlyLocalRoute(resolved.server, resolved.tool, resolved.arguments, resolved.hadArguments);
      });
    }
    return this._isReadOnlyLocalRoute(route.server, route.tool, route.arguments, route.hadArguments);
  }

  _isFileScopedDevMutation(operation) {
    if (!operation) return false;
    if (operation.tool === 'dev_write' || operation.tool === 'dev_edit') return true;
    const route = parseOperationRoute(operation);
    if (!route) return false;
    if (route.calls) {
      return route.calls.length > 0 && route.calls.every(entry => {
        const resolved = resolveBatchEntryRoute(route, entry);
        if (!resolved || resolved.server !== 'dev') return false;
        const baseTool = normalizeDevInnerTool(resolved.tool);
        return Boolean(baseTool && FILE_SCOPED_DEV_TOOLS.has(baseTool));
      });
    }
    if (route.server !== 'dev') return false;
    const baseTool = normalizeDevInnerTool(route.tool);
    return Boolean(baseTool && FILE_SCOPED_DEV_TOOLS.has(baseTool));
  }

  _extractFileScopedPaths(operation, defaultCwdOverride = undefined) {
    if (!operation) return null;
    let parsedArgs;
    try {
      parsedArgs = JSON.parse(operation.request_json)?.arguments;
    } catch {
      return null;
    }
    const effectiveCwd = defaultCwdOverride !== undefined
      ? defaultCwdOverride
      : this.store.activeCapabilityById(operation.principal_id)?.defaultCwd;
    const effectiveArgs = applyDefaultCwd(operation.tool, parsedArgs, effectiveCwd);
    let paths = null;
    if (operation.tool === 'dev_write') {
      paths = extractSingleFileScopedPaths('write', effectiveArgs);
    } else if (operation.tool === 'dev_edit') {
      paths = extractSingleFileScopedPaths('edit', effectiveArgs);
    } else {
      const route = unwrapLocalRoute(operation.tool, effectiveArgs);
      if (!route) return null;
      if (route.calls) {
        if (route.calls.length === 0) return null;
        paths = [];
        for (const entry of route.calls) {
          const resolved = resolveBatchEntryRoute(route, entry);
          if (!resolved || resolved.server !== 'dev') return null;
          const baseTool = normalizeDevInnerTool(resolved.tool);
          if (!baseTool || !FILE_SCOPED_DEV_TOOLS.has(baseTool)) return null;
          const entryPaths = extractSingleFileScopedPaths(baseTool, resolved.arguments);
          if (!entryPaths) return null;
          paths.push(...entryPaths);
        }
      } else {
        if (route.server !== 'dev') return null;
        const baseTool = normalizeDevInnerTool(route.tool);
        if (!baseTool || !FILE_SCOPED_DEV_TOOLS.has(baseTool)) return null;
        paths = extractSingleFileScopedPaths(baseTool, route.arguments);
      }
    }
    // Only overlap file-scoped mutations when every target path is absolute after
    // applying defaultCwd/tilde expansion; unresolved relative paths could alias an
    // absolute path to the same file when no capability defaultCwd is configured.
    if (!paths || paths.length === 0 || paths.some(targetPath => !targetPath.startsWith('/'))) {
      return null;
    }
    return paths;
  }

  _mutationLaneKeys(operation) {
    if (!operation) return [];
    const route = parseOperationRoute(operation);
    if (!route) return [operation.principal_id];
    if (route.calls) {
      if (route.calls.length === 0) {
        return [route.server && route.server !== 'dev'
          ? `${operation.principal_id}:server:${route.server}`
          : operation.principal_id];
      }
      const keys = new Set();
      for (const entry of route.calls) {
        const resolved = resolveBatchEntryRoute(route, entry);
        if (!resolved || resolved.server === 'dev') {
          keys.add(operation.principal_id);
        } else {
          keys.add(`${operation.principal_id}:server:${resolved.server}`);
        }
      }
      return [...keys];
    }
    if (route.server && route.server !== 'dev') {
      return [`${operation.principal_id}:server:${route.server}`];
    }
    return [operation.principal_id];
  }

  _mutationLaneKey(operation) {
    return this._mutationLaneKeys(operation)[0] ?? operation?.principal_id;
  }

  _schedule(operationId) {
    if (this._active.has(operationId)) return this._active.get(operationId);
    const operation = this.store.getOperation(operationId);
    const scheduledDefaultCwd = operation
      ? (this.store.activeCapabilityById(operation.principal_id)?.defaultCwd ?? null)
      : null;
    if (operation) this._scheduledDefaultCwd.set(operationId, scheduledDefaultCwd);
    const concurrent = this._isConcurrentOperation(operation);
    const fileScopedPaths = !concurrent && this._isFileScopedDevMutation(operation)
      ? this._extractFileScopedPaths(operation, scheduledDefaultCwd)
      : null;
    const execution = concurrent
      ? Promise.resolve().then(() => this._run(operationId))
      : fileScopedPaths
        ? this._enqueueFileScoped(operation.principal_id, fileScopedPaths, () => this._run(operationId))
        : this._enqueueLanes(this._mutationLaneKeys(operation), () => this._run(operationId));
    this._active.set(operationId, execution);
    execution.catch(() => {}).finally(() => {
      this._scheduledDefaultCwd.delete(operationId);
      if (this._active.get(operationId) === execution) this._active.delete(operationId);
    });
    return execution;
  }

  async _run(operationId) {
    if (!this.store.claimQueued(operationId)) return;
    const operation = this.store.getOperation(operationId);
    const principal = this.store.activeCapabilityById(operation.principal_id);
    if (!principal) {
      this.store.rejectOperation(operationId, 'submission capability expired or was revoked before execution');
      return;
    }
    if (!this.store.isCurrentTurn(operation.principal_id, operation.turn_id)) {
      this.store.rejectOperation(operationId, 'superseded_by_newer_turn');
      return;
    }
    const classification = operation.source_profile === 'universal-get-v1' ? 'confirmation_required' : 'automatic';
    if (classification !== operation.policy_class) {
      this.store.rejectOperation(operationId, 'operation execution class changed before dispatch');
      return;
    }
    if (classification === 'confirmation_required' && !operation.confirmation_used_ms) {
      this.store.rejectOperation(operationId, 'universal GET confirmation is missing');
      return;
    }

    const request = JSON.parse(operation.request_json);
    const effectiveDefaultCwd = this._scheduledDefaultCwd.has(operationId)
      ? this._scheduledDefaultCwd.get(operationId)
      : principal.defaultCwd;
    const requestArguments = applyDefaultCwd(operation.tool, request.arguments, effectiveDefaultCwd);
    let dispatchStarted = false;
    let result;
    try {
      result = await callMcpTool(
        { mcpUrl: this.mcpUrl, stateDir: this.store.stateDir, callbackUrl: this.callbackUrl, timeoutMs: this.toolTimeoutMs },
        operation.tool,
        requestArguments,
        {
          onBeforeDispatch: async () => {
            this.store.db.exec('BEGIN IMMEDIATE');
            try {
              if (!this.store.activeCapabilityById(operation.principal_id)) throw new Error('submission capability expired or was revoked before execution');
              if (!this.store.isCurrentTurn(operation.principal_id, operation.turn_id)) throw new Error('superseded_by_newer_turn');
              if (!this.store.markDispatchStarted(operationId)) throw new Error('failed to persist dispatch intent');
              this.store.db.exec('COMMIT');
            } catch (error) {
              this.store.db.exec('ROLLBACK');
              throw error;
            }
            dispatchStarted = true;
          },
        },
      );
    } catch (error) {
      if (dispatchStarted) this.store.markUnknownOutcome(operationId);
      else if (error?.message === 'superseded_by_newer_turn' || error?.message === 'submission capability expired or was revoked before execution') this.store.rejectOperation(operationId, error.message);
      else this.store.failOperation(operationId, boundedError(error));
      return;
    }

    let resultText;
    try {
      resultText = renderToolResult(result);
    } catch (error) {
      this.store.failOperation(operationId, await this._describeToolFailure(error, operation.tool, requestArguments));
      return;
    }
    this.store.completeOperation(operationId, resultText);
  }

  // 1MCP rejects an argument object that fails the tool's input schema with the bare
  // text "schema_input_invalid", which names neither the field nor the rule. Explain it
  // from the same schema so the client can fix the call instead of guessing or spending
  // a round trip on GET /v1/tools/<name>. Any other failure keeps its own message.
  async _describeToolFailure(error, tool, args) {
    const message = boundedError(error);
    if (!looksLikeSchemaValidationError(message) || /invalid arguments for tool/i.test(message)) return message;
    try {
      const lookup = targetTool => findMcpTool({
        mcpUrl: this.mcpUrl,
        stateDir: this.store.stateDir,
        callbackUrl: this.callbackUrl,
        timeoutMs: this.toolTimeoutMs,
        signal: AbortSignal.timeout(5000),
      }, targetTool);
      const schema = (await lookup(tool))?.inputSchema;
      const detail = explainSchemaViolation(schema, args);
      if (detail) return `${message}: ${tool}: ${detail}`;
      const routed = unwrapLocalRoute(tool, args);
      if (routed) {
        if (routed.calls) {
          const schemaCache = new Map();
          for (let i = 0; i < routed.calls.length; i += 1) {
            const resolved = resolveBatchEntryRoute(routed, routed.calls[i]);
            if (!resolved || resolved.server !== 'dev') continue;
            const baseTool = normalizeDevInnerTool(resolved.tool);
            if (!baseTool) continue;
            if (resolved.hadArguments && resolved.arguments === undefined) continue;
            let innerSchema = schemaCache.get(baseTool);
            if (innerSchema === undefined) {
              innerSchema = (await lookup(`dev_${baseTool}`))?.inputSchema ?? null;
              schemaCache.set(baseTool, innerSchema);
            }
            const innerDetail = explainSchemaViolation(innerSchema, resolved.arguments ?? {});
            if (innerDetail) return `${message}: dev/${baseTool} calls[${i}]: ${innerDetail}`;
          }
        } else if (routed.server === 'dev') {
          const baseTool = normalizeDevInnerTool(routed.tool);
          if (baseTool) {
            const innerSchema = (await lookup(`dev_${baseTool}`))?.inputSchema;
            const innerDetail = explainSchemaViolation(innerSchema, routed.arguments ?? {});
            if (innerDetail) return `${message}: dev/${baseTool}: ${innerDetail}`;
          }
        }
      }
    } catch {
      // The schema could not be read; the upstream message still stands.
    }
    return message;
  }
}
