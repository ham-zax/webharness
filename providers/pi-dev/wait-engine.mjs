import { WaitError } from './wait-state.mjs';

export const DEFAULT_WAIT_TIMEOUT_SECONDS = 300;
export const MAX_WAIT_TIMEOUT_SECONDS = 86400;
export const DEFAULT_HOLD_SECONDS = 10;
export const MAX_HOLD_SECONDS = 15;
export const MIN_POLL_MS = 250;
export const WAIT_LOCK_ACQUIRE_MS = 250;
export const COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set(['matched', 'timeout', 'cancelled', 'failed']);

function throwIfAborted(signal) {
  if (signal?.aborted) throw new WaitError('WAIT_ABORTED', 'wait request was aborted');
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeJson(value[key])]));
  }
  return value;
}

function definitionKey(definition) {
  return JSON.stringify(normalizeJson(definition));
}

function integerInRange(value, field, min, max, fallback) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new WaitError('INVALID_WAIT_REQUEST', `${field} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function sourceResultStatus(value) {
  return ['pending', 'matched', 'failed'].includes(value) ? value : null;
}

function publicResult(record) {
  const result = {
    status: record.status,
    name: record.name,
  };
  if (record.deadlineAtMs !== undefined) result.deadlineAtMs = record.deadlineAtMs;
  if (record.evidence !== undefined) result.evidence = record.evidence;
  if (record.code !== undefined) result.code = record.code;
  if (record.details !== undefined) result.details = record.details;
  return result;
}

function defaultSleep(ms, signal) {
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
    const onAbort = () => finish(reject, new WaitError('WAIT_ABORTED', 'wait request was aborted'));
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export class WaitEngine {
  constructor({ store, sources, now = () => Date.now(), sleep = defaultSleep } = {}) {
    if (!store || typeof store.withLock !== 'function') throw new TypeError('store is required');
    if (!sources || typeof sources !== 'object') throw new TypeError('sources are required');
    this.store = store;
    this.sources = sources;
    this.now = now;
    this.sleep = sleep;
  }

  sourceFor(condition) {
    const kind = condition?.kind;
    const source = typeof kind === 'string' ? this.sources[kind] : null;
    if (!source || typeof source.arm !== 'function' || typeof source.check !== 'function') {
      throw new WaitError('INVALID_WAIT_CONDITION', `unsupported wait condition: ${String(kind)}`);
    }
    return source;
  }

  sourceResultRecord(record, result, nowMs) {
    if (!result || !sourceResultStatus(result.status)) {
      throw new WaitError('WAIT_SOURCE_ERROR', 'wait source returned an invalid result');
    }
    const next = {
      ...record,
      baseline: result.baseline === undefined ? record.baseline : result.baseline,
      sourceArmed: true,
      lastCheckedAtMs: nowMs,
    };
    delete next.completedAtMs;
    if (result.status === 'pending') {
      next.status = 'pending';
      delete next.evidence;
      delete next.code;
      delete next.details;
    } else {
      next.status = result.status;
      next.completedAtMs = nowMs;
      if (result.evidence !== undefined) next.evidence = result.evidence;
      else delete next.evidence;
      if (result.code !== undefined) next.code = result.code;
      else delete next.code;
      if (result.details !== undefined) next.details = result.details;
      else delete next.details;
    }
    return next;
  }

  timeoutRecord(record, nowMs = this.now()) {
    return {
      ...record,
      status: 'timeout',
      completedAtMs: Math.max(nowMs, record.deadlineAtMs),
      ...(record.evidence === undefined ? {} : { evidence: record.evidence }),
    };
  }

  async persistTimeout(record) {
    return this.store.write(this.timeoutRecord(record, this.now()));
  }

  async runSourceOperation(operation, {
    signal,
    waitDeadlineAtMs,
    callDeadlineAtMs = null,
    resultWinsOnResolve = false,
  }) {
    throwIfAborted(signal);
    const beforeMs = this.now();
    if (beforeMs >= waitDeadlineAtMs) return { boundary: 'wait' };
    if (callDeadlineAtMs !== null && beforeMs >= callDeadlineAtMs) return { boundary: 'hold' };

    const controller = new AbortController();
    let boundary = null;
    let timer = null;
    const onCallerAbort = () => {
      boundary = 'caller';
      controller.abort();
    };
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();

    const waitRemaining = waitDeadlineAtMs - beforeMs;
    const holdRemaining = callDeadlineAtMs === null ? Infinity : callDeadlineAtMs - beforeMs;
    const boundaryDelay = Math.max(0, Math.min(waitRemaining, holdRemaining));
    const timedBoundary = waitRemaining <= holdRemaining ? 'wait' : 'hold';
    if (Number.isFinite(boundaryDelay)) {
      timer = setTimeout(() => {
        if (boundary !== null) return;
        boundary = timedBoundary;
        controller.abort();
      }, boundaryDelay);
    }

    try {
      const result = await operation(controller.signal);
      if (resultWinsOnResolve) {
        return { boundary: null, result, postResultBoundary: boundary };
      }
      if (signal?.aborted || boundary === 'caller') {
        throw new WaitError('WAIT_ABORTED', 'wait request was aborted');
      }
      const afterMs = this.now();
      if (afterMs >= waitDeadlineAtMs) return { boundary: 'wait' };
      if (callDeadlineAtMs !== null && afterMs >= callDeadlineAtMs) return { boundary: 'hold' };
      return { boundary: null, result };
    } catch (error) {
      if (signal?.aborted || boundary === 'caller') {
        throw new WaitError('WAIT_ABORTED', 'wait request was aborted');
      }
      const nowMs = this.now();
      if (boundary === 'wait' || nowMs >= waitDeadlineAtMs) return { boundary: 'wait' };
      if (boundary === 'hold' || (callDeadlineAtMs !== null && nowMs >= callDeadlineAtMs)) {
        return { boundary: 'hold' };
      }
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  async commitSourceResult(record, result, { signal, callDeadlineAtMs = null } = {}) {
    throwIfAborted(signal);
    let nowMs = this.now();
    if (nowMs >= record.deadlineAtMs) return this.persistTimeout(record);
    if (callDeadlineAtMs !== null && nowMs >= callDeadlineAtMs) return record;

    let next = this.sourceResultRecord(record, result, nowMs);
    throwIfAborted(signal);
    nowMs = this.now();
    if (nowMs >= record.deadlineAtMs) return this.persistTimeout(record);
    if (callDeadlineAtMs !== null && nowMs >= callDeadlineAtMs) return record;
    return this.store.write(next);
  }

  pollInterval(source, condition) {
    const candidate = typeof source.pollIntervalMs === 'function'
      ? source.pollIntervalMs(condition)
      : source.pollIntervalMs;
    return Math.max(MIN_POLL_MS, Number.isFinite(candidate) ? Math.floor(candidate) : MIN_POLL_MS);
  }

  async run(args, signal) {
    const name = args?.name;
    if (typeof name !== 'string') throw new WaitError('INVALID_WAIT_NAME', 'wait name is required');
    const holdSeconds = integerInRange(
      args.hold_seconds,
      'hold_seconds',
      0,
      MAX_HOLD_SECONDS,
      DEFAULT_HOLD_SECONDS,
    );
    const callStartedAtMs = this.now();
    const callDeadlineAtMs = holdSeconds > 0 ? callStartedAtMs + holdSeconds * 1000 : null;
    throwIfAborted(signal);

    return this.store.withLock(name, async () => {
      throwIfAborted(signal);
      await this.store.gc(this.now(), COMPLETED_RETENTION_MS);
      let record = await this.store.read(name);

      if (args.cancel === true) {
        if (args.condition !== undefined || args.timeout_seconds !== undefined) {
          throw new WaitError('INVALID_WAIT_REQUEST', 'cancel cannot include condition or timeout_seconds');
        }
        if (!record) throw new WaitError('WAIT_NOT_FOUND', `wait not found: ${name}`);
        if (TERMINAL_STATUSES.has(record.status)) return publicResult(record);
        record = await this.store.write({
          ...record,
          status: 'cancelled',
          completedAtMs: this.now(),
        });
        return publicResult(record);
      }

      if (args.condition !== undefined) {
        const timeoutSeconds = integerInRange(
          args.timeout_seconds,
          'timeout_seconds',
          1,
          MAX_WAIT_TIMEOUT_SECONDS,
          DEFAULT_WAIT_TIMEOUT_SECONDS,
        );
        const definition = {
          condition: normalizeJson(args.condition),
          timeoutSeconds,
        };
        if (record) {
          if (definitionKey(record.definition) !== definitionKey(definition)) {
            throw new WaitError('WAIT_CONFLICT', `wait ${name} already exists with a different definition`);
          }
        } else {
          const armedAtMs = this.now();
          const unpersisted = {
            name,
            definition,
            condition: definition.condition,
            timeoutSeconds,
            armedAtMs,
            deadlineAtMs: armedAtMs + timeoutSeconds * 1000,
            status: 'pending',
          };
          const source = this.sourceFor(unpersisted.condition);
          throwIfAborted(signal);
          let armResult;
          if (callDeadlineAtMs === null) {
            armResult = await source.arm(unpersisted.condition, signal);
            throwIfAborted(signal);
          } else {
            const operation = await this.runSourceOperation(
              (operationSignal) => source.arm(unpersisted.condition, operationSignal),
              {
                signal,
                waitDeadlineAtMs: unpersisted.deadlineAtMs,
                callDeadlineAtMs,
              },
            );
            if (operation.boundary === 'wait') {
              return publicResult({
                name,
                status: 'timeout',
                deadlineAtMs: unpersisted.deadlineAtMs,
              });
            }
            if (operation.boundary === 'hold') {
              throw new WaitError(
                'WAIT_HOLD_EXPIRED',
                `${name} was not armed before the call hold expired; no durable wait was created`,
              );
            }
            armResult = operation.result;
          }

          let nowMs = this.now();
          let armedRecord = this.sourceResultRecord(unpersisted, armResult, nowMs);
          if (nowMs >= unpersisted.deadlineAtMs) {
            armedRecord = this.timeoutRecord(armedRecord, nowMs);
          } else if (callDeadlineAtMs !== null && nowMs >= callDeadlineAtMs) {
            throw new WaitError(
              'WAIT_HOLD_EXPIRED',
              `${name} was not armed before the call hold expired; no durable wait was created`,
            );
          }
          throwIfAborted(signal);
          nowMs = this.now();
          if (nowMs >= unpersisted.deadlineAtMs) {
            armedRecord = this.timeoutRecord(armedRecord, nowMs);
          } else if (callDeadlineAtMs !== null && nowMs >= callDeadlineAtMs) {
            throw new WaitError(
              'WAIT_HOLD_EXPIRED',
              `${name} was not armed before the call hold expired; no durable wait was created`,
            );
          }
          throwIfAborted(signal);
          if (armedRecord.status === 'timeout') {
            record = await this.store.create(armedRecord, { signal });
          } else {
            const persistence = await this.runSourceOperation(
              (operationSignal) => this.store.create(armedRecord, { signal: operationSignal }),
              {
                signal,
                waitDeadlineAtMs: unpersisted.deadlineAtMs,
                callDeadlineAtMs,
                resultWinsOnResolve: true,
              },
            );
            if (persistence.boundary === 'wait') {
              return publicResult({
                name,
                status: 'timeout',
                deadlineAtMs: unpersisted.deadlineAtMs,
              });
            }
            if (persistence.boundary === 'hold') {
              throw new WaitError(
                'WAIT_HOLD_EXPIRED',
                `${name} was not armed before the call hold expired; no durable wait was created`,
              );
            }
            record = persistence.result;

            // The atomic create commit already won. Later request/hold boundaries cannot deny that durable fact.
            if (TERMINAL_STATUSES.has(record.status)) return publicResult(record);
            if (this.now() >= record.deadlineAtMs) {
              record = await this.persistTimeout(record);
              return publicResult(record);
            }
            if (persistence.postResultBoundary === 'caller' || signal?.aborted) {
              return publicResult(record);
            }
            if (persistence.postResultBoundary === 'hold'
                || (callDeadlineAtMs !== null && this.now() >= callDeadlineAtMs)) {
              return publicResult(record);
            }
          }
        }
      } else if (!record) {
        throw new WaitError('WAIT_NOT_FOUND', `wait not found: ${name}`);
      }

      if (TERMINAL_STATUSES.has(record.status)) return publicResult(record);
      const source = this.sourceFor(record.condition);
      if (this.now() >= record.deadlineAtMs) {
        record = await this.persistTimeout(record);
        return publicResult(record);
      }
      if (callDeadlineAtMs !== null && this.now() >= callDeadlineAtMs) return publicResult(record);

      const pollMs = this.pollInterval(source, record.condition);
      while (true) {
        throwIfAborted(signal);
        const nowMs = this.now();
        if (nowMs >= record.deadlineAtMs) {
          record = await this.persistTimeout(record);
          return publicResult(record);
        }
        if (callDeadlineAtMs !== null && nowMs >= callDeadlineAtMs) return publicResult(record);

        const operation = await this.runSourceOperation(
          (operationSignal) => source.check(record, operationSignal),
          {
            signal,
            waitDeadlineAtMs: record.deadlineAtMs,
            callDeadlineAtMs,
          },
        );
        if (operation.boundary === 'wait') {
          record = await this.persistTimeout(record);
          return publicResult(record);
        }
        if (operation.boundary === 'hold') return publicResult(record);

        record = await this.commitSourceResult(record, operation.result, { signal, callDeadlineAtMs });
        if (TERMINAL_STATUSES.has(record.status)) return publicResult(record);
        if (holdSeconds === 0 || (callDeadlineAtMs !== null && this.now() >= callDeadlineAtMs)) {
          return publicResult(record);
        }

        const remainingCall = callDeadlineAtMs - this.now();
        const remainingWait = record.deadlineAtMs - this.now();
        if (remainingCall <= 0) return publicResult(record);
        if (remainingWait <= 0) continue;
        try {
          await this.sleep(Math.min(pollMs, remainingCall, remainingWait), signal);
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'WAIT_ABORTED') {
            throw new WaitError('WAIT_ABORTED', 'wait request was aborted');
          }
          throw error;
        }
      }
    }, { signal, maxWaitMs: WAIT_LOCK_ACQUIRE_MS });
  }
}
