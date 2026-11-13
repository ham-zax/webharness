import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { requestHash, AdapterStore } from './store.mjs';
import { callMcpTool, closeMcpPools, findMcpTool, listMcpTools } from './mcp-client.mjs';
import { explainSchemaViolation } from './schema-hint.mjs';

const MAX_RESULT_BYTES = 1024 * 1024;
const DEV_COMMAND_FAILURE_FOOTER = /^\[(?:exit (?!0(?:\]| · ))-?\d+|timed out after [0-9.]+s|cancelled|terminated)(?: · [0-9.]+s)?\]$/;
// dev_run_script takes the same base directory as the shell and file tools: Dev applies
// it to the script's nested calls, which never pass through this rewrite themselves.
const DEFAULT_CWD_TOOLS = new Set(['dev_bash', 'dev_exec', 'dev_review_changes', 'dev_file_ops', 'dev_run_script']);
const OPTIONAL_PATH_CWD_TOOLS = new Set(['dev_list_directory', 'dev_search']);
const RELATIVE_PATH_TOOLS = new Set(['dev_read', 'dev_write', 'dev_list_directory', 'dev_search']);
const TARGET_PATH_TOOLS = new Set(['dev_read', 'dev_edit']);

function resolveAgainstDefaultCwd(rawPath, defaultCwd) {
  if (typeof rawPath !== 'string' || !rawPath) return rawPath;
  if (rawPath.startsWith('/') || rawPath === '~' || rawPath.startsWith('~/')) return rawPath;
  return posix.resolve(defaultCwd, rawPath);
}

export function applyDefaultCwd(tool, rawArguments, defaultCwd) {
  if (!defaultCwd || !rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
    return rawArguments;
  }
  let updated = rawArguments;
  const clone = () => {
    if (updated === rawArguments) updated = { ...rawArguments };
    return updated;
  };
  if (DEFAULT_CWD_TOOLS.has(tool) && rawArguments.cwd === undefined) {
    clone().cwd = defaultCwd;
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
  if (operation.tool !== 'local_fallback_dispatch') return false;
  try {
    const parsed = JSON.parse(operation.request_json);
    return parsed?.arguments?.server === 'dev'
      && (parsed?.arguments?.tool === 'exec' || parsed?.arguments?.tool === 'bash');
  } catch {
    return false;
  }
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
    this._readOnlyTools = new Set([
      'dev_read',
      'dev_list_directory',
      'dev_search',
      'dev_review_changes',
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
      if (tool?.annotations?.readOnlyHint === true && typeof tool.name === 'string') this._readOnlyTools.add(tool.name);
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
    if (isDevCommandOperation(operation)) {
      const tail = operation.result_text ?? this.store.getOperationTailText(operation.id) ?? '';
      if (hasUnsuccessfulCommandFooter(tail)) return true;
    }
    if (operation.tool === 'local_tool_batch') {
      const full = operation.result_text ?? this.store.getOperationResult(operation.id) ?? '';
      try {
        const parsed = JSON.parse(full);
        const results = parsed?.structuredContent?.results;
        if (Array.isArray(results) && results.some(entry => entry?.status === 'rejected' || entry?.result?.isError === true)) {
          return true;
        }
      } catch {
        // Non-JSON result text uses normal state checking.
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

    this._enqueuePrincipal(principalId, async () => {
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

  _enqueuePrincipal(principalId, taskFn) {
    const previous = this._tails.get(principalId) ?? Promise.resolve();
    let current;
    const cleanup = () => {
      if (this._tails.get(principalId) === current) this._tails.delete(principalId);
    };
    current = previous.then(taskFn).then(
      value => {
        cleanup();
        return value;
      },
      () => {
        cleanup();
      },
    );
    this._tails.set(principalId, current);
    return current;
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

  _schedule(operationId) {
    if (this._active.has(operationId)) return this._active.get(operationId);
    const operation = this.store.getOperation(operationId);
    const concurrent = !operation || this._readOnlyTools.has(operation.tool);
    const execution = concurrent
      ? Promise.resolve().then(() => this._run(operationId))
      : this._enqueuePrincipal(operation.principal_id, () => this._run(operationId));
    this._active.set(operationId, execution);
    execution.catch(() => {}).finally(() => {
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
    const requestArguments = applyDefaultCwd(operation.tool, request.arguments, principal.defaultCwd);
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
    if (message !== 'schema_input_invalid') return message;
    try {
      const schema = (await findMcpTool({
        mcpUrl: this.mcpUrl,
        stateDir: this.store.stateDir,
        callbackUrl: this.callbackUrl,
        timeoutMs: this.toolTimeoutMs,
        signal: AbortSignal.timeout(5000),
      }, tool))?.inputSchema;
      const detail = explainSchemaViolation(schema, args);
      if (detail) return `${message}: ${tool}: ${detail}`;
    } catch {
      // The schema could not be read; the upstream message still stands.
    }
    return message;
  }
}
