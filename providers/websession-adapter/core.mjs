import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { requestHash, AdapterStore } from './store.mjs';
import { callMcpTool, closeMcpPools, listMcpTools } from './mcp-client.mjs';

const MAX_RESULT_BYTES = 1024 * 1024;
const DEFAULT_CWD_TOOLS = new Set(['dev_bash', 'dev_exec', 'dev_review_changes', 'dev_file_ops']);
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
  const hasStructuredContent = result?.structuredContent !== undefined;
  const textOnly = !hasStructuredContent
    && Array.isArray(result?.content)
    && result.content.length > 0
    && result.content.every(block => block?.type === 'text');
  const text = textOnly ? result.content.map(block => block.text).join('\n') : JSON.stringify(result);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new Error('result_too_large');
  return text;
}

export class OperationCore {
  constructor({ stateDir, mcpUrl, callbackUrl, toolTimeoutMs }) {
    this.store = new AdapterStore(stateDir);
    this.mcpUrl = mcpUrl;
    this.callbackUrl = callbackUrl;
    this.toolTimeoutMs = toolTimeoutMs;
    this._active = new Map();
    this._tail = Promise.resolve();
    this._readOnlyTools = new Set([
      'dev_read',
      'dev_list_directory',
      'dev_search',
      'dev_review_changes',
      'dev_wait',
    ]);
  }

  start() {
    this.store.recoverOperations();
    if (!this.mcpUrl) return;
    for (const id of this.store.queuedOperationIds()) this._schedule(id);
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

  submit(capabilityToken, clientNonce, parsedRequest, sourceProfile, turnId = null, { deferSchedule = false } = {}) {
    if (!this.mcpUrl) throw new Error('adapter MCP URL is unavailable');
    const principal = this.store.resolveCapability(capabilityToken);
    if (!principal) return { unauthorized: true };
    if (!this.store.advanceTurn(principal.id, turnId)) return { superseded: true };

    const classification = sourceProfile === 'universal-get-v1' ? 'confirmation_required' : 'automatic';
    const hash = requestHash(parsedRequest.requestJson);
    const state = classification === 'automatic' ? 'queued' : 'confirmation_required';
    const submitted = this.store.submitOperation(principal.id, clientNonce, parsedRequest.requestJson, hash, {
      tool: parsedRequest.normalized.tool,
      policyClass: classification,
      sourceProfile,
      state,
      turnId,
    });
    if (!submitted.operation || submitted.operation.request_hash !== hash || submitted.operation.turn_id !== turnId) return { nonceConflict: true };
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

  submitBatch(capabilityToken, clientNonce, parsedItems, turnId = null) {
    // Domain separation and the complete nonce keep batch item identities distinct.
    const nonceHash = createHash('sha256').update(clientNonce).digest('base64url');
    const submissions = [];
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < parsedItems.length; index += 1) {
        const submitted = this.submit(
          capabilityToken, `batch.${nonceHash}.${index}`, parsedItems[index],
          'json-post-v1', turnId, { deferSchedule: true },
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
    for (const submitted of submissions) {
      if (submitted.operation.state === 'queued') this._schedule(submitted.operation.id);
    }
    return { submissions };
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
    const concurrent = Boolean(operation && this._readOnlyTools.has(operation.tool));
    const execution = concurrent
      ? Promise.resolve().then(() => this._run(operationId))
      : this._tail.then(() => this._run(operationId));
    if (!concurrent) this._tail = execution.catch(() => {});
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
            if (!this.store.isCurrentTurn(operation.principal_id, operation.turn_id)) throw new Error('superseded_by_newer_turn');
            if (!this.store.markDispatchStarted(operationId)) throw new Error('failed to persist dispatch intent');
            dispatchStarted = true;
          },
        },
      );
    } catch (error) {
      if (dispatchStarted) this.store.markUnknownOutcome(operationId);
      else if (error?.message === 'superseded_by_newer_turn') this.store.rejectOperation(operationId, error.message);
      else this.store.failOperation(operationId, boundedError(error));
      return;
    }

    let resultText;
    try {
      resultText = renderToolResult(result);
    } catch (error) {
      this.store.failOperation(operationId, boundedError(error));
      return;
    }
    this.store.completeOperation(operationId, resultText);
  }
}
