import net from 'node:net';

import { TerminalError } from './protocol.mjs';

const DEFAULT_RETRY_WINDOW_MS = 1000;
const DEFAULT_RETRY_INTERVAL_MS = 25;
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;

function abortError() {
  const error = new Error('broker request aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function delay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError());
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function retryableConnectionError(error) {
  return error?.retryable === true || ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error?.code);
}

function closedEarlyError() {
  const error = new Error('broker connection closed before a complete response');
  error.code = 'BROKER_CONNECTION_CLOSED';
  error.retryable = true;
  return error;
}

export class BrokerClient {
  constructor({
    socketPath,
    retryWindowMs = DEFAULT_RETRY_WINDOW_MS,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    if (typeof socketPath !== 'string' || socketPath.length === 0) {
      throw new TypeError('socketPath is required');
    }
    this.socketPath = socketPath;
    this.retryWindowMs = retryWindowMs;
    this.retryIntervalMs = retryIntervalMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
  }

  async request(op, params = {}, { signal } = {}) {
    throwIfAborted(signal);
    const id = this.nextId++;
    const deadline = Date.now() + this.retryWindowMs;
    while (true) {
      throwIfAborted(signal);
      try {
        return await this.requestOnce({ id, op, params }, { signal });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
          throw abortError();
        }
        if (!retryableConnectionError(error) || Date.now() >= deadline) throw error;
        await delay(Math.min(this.retryIntervalMs, Math.max(0, deadline - Date.now())), signal);
      }
    }
  }

  requestOnce(request, { signal } = {}) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffered = '';
      let settled = false;
      const timer = setTimeout(() => {
        finishReject(Object.assign(new Error(`broker request timed out: ${request.op}`), {
          code: 'BROKER_REQUEST_TIMEOUT',
          retryable: true,
        }));
      }, this.requestTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.removeAllListeners();
        socket.destroy();
      };
      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => finishReject(abortError());

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on('data', (chunk) => {
        buffered += chunk;
        const newline = buffered.indexOf('\n');
        if (newline === -1) return;
        let response;
        try {
          response = JSON.parse(buffered.slice(0, newline));
        } catch (error) {
          finishReject(new TerminalError('INVALID_RESPONSE', `broker returned invalid JSON: ${error.message}`));
          return;
        }
        if (response?.id !== request.id) {
          finishReject(new TerminalError('INVALID_RESPONSE', 'broker response id does not match request id'));
          return;
        }
        if (response?.ok === true) {
          finishResolve(response.result);
          return;
        }
        const payload = response?.error ?? {};
        finishReject(new TerminalError(
          typeof payload.code === 'string' ? payload.code : 'BROKER_ERROR',
          typeof payload.message === 'string' ? payload.message : 'broker request failed',
          payload.details,
        ));
      });
      socket.once('error', finishReject);
      socket.once('close', () => {
        if (!settled && !buffered.includes('\n')) finishReject(closedEarlyError());
      });
    });
  }
}
