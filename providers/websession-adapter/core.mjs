import { requestHash, AdapterStore } from './store.mjs';
import { callMcpTool, listMcpTools } from './mcp-client.mjs';

const MAX_RESULT_BYTES = 1024 * 1024;

function boundedError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 2048);
}

function renderToolResult(result) {
  if (result?.isError) {
    const text = Array.isArray(result.content)
      ? result.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
      : 'MCP tool failed';
    throw new Error(text || 'MCP tool failed');
  }
  const textBlocks = Array.isArray(result?.content)
    ? result.content.filter(block => block?.type === 'text').map(block => block.text)
    : [];
  const text = textBlocks.length > 0 ? textBlocks.join('\n') : JSON.stringify(result);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new Error('result_too_large');
  return text;
}

export class OperationCore {
  constructor({ stateDir, mcpUrl, callbackUrl }) {
    this.store = new AdapterStore(stateDir);
    this.mcpUrl = mcpUrl;
    this.callbackUrl = callbackUrl;
    this._active = new Map();
    this._tail = Promise.resolve();
  }

  start() {
    this.store.recoverOperations();
    if (!this.mcpUrl) return;
    for (const id of this.store.queuedOperationIds()) this._schedule(id);
  }

  close() {
    this.store.close();
  }

  async permittedTools(capabilityToken) {
    const principal = this.store.resolveCapability(capabilityToken);
    if (!principal) return undefined;
    if (!this.mcpUrl) throw new Error('adapter MCP URL is unavailable');
    const listed = await listMcpTools({
      mcpUrl: this.mcpUrl,
      stateDir: this.store.stateDir,
      callbackUrl: this.callbackUrl,
    });
    return { principal, tools: listed.tools };
  }

  submit(capabilityToken, clientNonce, parsedRequest, sourceProfile) {
    if (!this.mcpUrl) throw new Error('adapter MCP URL is unavailable');
    const principal = this.store.resolveCapability(capabilityToken);
    if (!principal) return { unauthorized: true };

    const classification = sourceProfile === 'universal-get-v1' ? 'confirmation_required' : 'automatic';
    const hash = requestHash(parsedRequest.requestJson);
    const state = classification === 'automatic' ? 'queued' : 'confirmation_required';
    const submitted = this.store.submitOperation(principal.id, clientNonce, parsedRequest.requestJson, hash, {
      tool: parsedRequest.normalized.tool,
      policyClass: classification,
      sourceProfile,
      state,
    });
    if (!submitted.operation || submitted.operation.request_hash !== hash) return { nonceConflict: true };
    if (submitted.operation.state === 'queued') this._schedule(submitted.operation.id);

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

  async waitForOperation(operationId, timeoutMs) {
    const active = this._active.get(operationId);
    if (active) {
      let timer;
      await Promise.race([
        active.catch(() => {}),
        new Promise(resolve => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return this.store.getOperation(operationId);
  }

  _schedule(operationId) {
    if (this._active.has(operationId)) return this._active.get(operationId);
    const execution = this._tail.then(() => this._run(operationId));
    this._tail = execution.catch(() => {});
    this._active.set(operationId, execution);
    execution.finally(() => {
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
    let dispatchStarted = false;
    let result;
    try {
      result = await callMcpTool(
        { mcpUrl: this.mcpUrl, stateDir: this.store.stateDir, callbackUrl: this.callbackUrl },
        operation.tool,
        request.arguments,
        {
          onBeforeDispatch: async () => {
            if (!this.store.markDispatchStarted(operationId)) throw new Error('failed to persist dispatch intent');
            dispatchStarted = true;
          },
        },
      );
    } catch (error) {
      if (dispatchStarted) this.store.markUnknownOutcome(operationId);
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
