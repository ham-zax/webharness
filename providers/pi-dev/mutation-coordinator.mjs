import fs from 'node:fs/promises';
import path from 'node:path';

const locks = new Map();

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  throw error;
}

function abortReason(signal) {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return error;
  }
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function assertCanonicalAbsolutePath(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    throw new Error('mutation coordinator requires a canonical absolute path');
  }
}

async function canonicalMutationTarget(target) {
  assertCanonicalAbsolutePath(target);
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const parent = await fs.realpath(path.dirname(target));
    return path.join(parent, path.basename(target));
  }
}

function grantNext(target, state) {
  while (state.waiters.length > 0) {
    const waiter = state.waiters.shift();
    if (waiter.status !== 'queued') continue;
    waiter.status = 'granted';
    waiter.cleanup();
    waiter.resolve();
    return;
  }

  state.locked = false;
  if (locks.get(target) === state) locks.delete(target);
}

function releaseFactory(target, state) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    grantNext(target, state);
  };
}

async function acquire(target, signal) {
  throwIfAborted(signal);

  let state = locks.get(target);
  if (!state) {
    state = { locked: false, waiters: [] };
    locks.set(target, state);
  }

  if (!state.locked) {
    state.locked = true;
    return releaseFactory(target, state);
  }

  await new Promise((resolve, reject) => {
    const waiter = {
      status: 'queued',
      resolve,
      cleanup: () => {}
    };

    const onAbort = () => {
      if (waiter.status !== 'queued') return;
      waiter.status = 'canceled';
      const index = state.waiters.indexOf(waiter);
      if (index !== -1) state.waiters.splice(index, 1);
      waiter.cleanup();
      reject(abortReason(signal));
    };

    waiter.cleanup = () => signal?.removeEventListener('abort', onAbort);
    state.waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });

  return releaseFactory(target, state);
}

export async function withMutationPaths(targets, fn, { signal } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('mutation coordinator requires at least one target path');
  }
  if (typeof fn !== 'function') throw new Error('mutation coordinator requires a callback');

  throwIfAborted(signal);
  const canonicalTargets = await Promise.all(targets.map(canonicalMutationTarget));
  throwIfAborted(signal);
  const orderedTargets = [...new Set(canonicalTargets)].sort();
  const releases = [];

  try {
    for (const target of orderedTargets) {
      throwIfAborted(signal);
      const release = await acquire(target, signal);
      releases.push(release);
      throwIfAborted(signal);
    }
    throwIfAborted(signal);
    return await fn();
  } finally {
    for (let i = releases.length - 1; i >= 0; i -= 1) releases[i]();
  }
}

export function withMutationPath(target, fn, options) {
  return withMutationPaths([target], fn, options);
}
