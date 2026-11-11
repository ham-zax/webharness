import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const locks = new Map();
const DEFAULT_KERNEL_LOCK_WAIT_MS = 15_000;

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

function kernelLockAddress(canonicalTarget) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
  const digest = crypto.createHash('sha256')
    .update(`${uid}\0${canonicalTarget}`)
    .digest('hex');
  return `\0mcp-dev-mut-${digest}`;
}

function closeKernelLockServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function tryBindKernelLock(address, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy());
    let settled = false;
    let aborted = false;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      aborted = true;
      if (server.listening) {
        void closeKernelLockServer(server).then(
          () => finish(reject, abortReason(signal)),
          error => finish(reject, error),
        );
      }
    };
    const onError = error => {
      if (aborted || signal?.aborted) {
        finish(reject, abortReason(signal));
        return;
      }
      if (error?.code === 'EADDRINUSE') {
        finish(resolve, null);
        return;
      }
      finish(reject, error);
    };
    const onListening = () => {
      if (aborted || signal?.aborted) {
        void closeKernelLockServer(server).then(
          () => finish(reject, abortReason(signal)),
          error => finish(reject, error),
        );
        return;
      }
      finish(resolve, server);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
}

function abortableDelay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function acquireKernelLock(canonicalTarget, { signal, maxWaitMs = DEFAULT_KERNEL_LOCK_WAIT_MS } = {}) {
  if (process.platform !== 'linux') return async () => {};
  const address = kernelLockAddress(canonicalTarget);
  const deadline = Date.now() + maxWaitMs;
  let delayMs = 2;

  while (true) {
    const server = await tryBindKernelLock(address, signal);
    if (server) {
      let closed = false;
      return async () => {
        if (closed) return;
        closed = true;
        await closeKernelLockServer(server);
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error(`timed out waiting for cross-process file mutation lock: ${canonicalTarget}`);
      error.code = 'MUTATION_LOCK_BUSY';
      throw error;
    }
    await abortableDelay(Math.min(delayMs, remaining), signal);
    delayMs = Math.min(15, delayMs * 2);
  }
}

export async function withMutationPaths(targets, fn, { signal, maxWaitMs = DEFAULT_KERNEL_LOCK_WAIT_MS } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('mutation coordinator requires at least one target path');
  }
  if (typeof fn !== 'function') throw new Error('mutation coordinator requires a callback');

  throwIfAborted(signal);
  const canonicalTargets = await Promise.all(targets.map(canonicalMutationTarget));
  throwIfAborted(signal);
  const orderedTargets = [...new Set(canonicalTargets)].sort();
  const releases = [];

  const lockTargets = async targets => {
    for (const target of targets) {
      throwIfAborted(signal);
      const releaseInProcess = await acquire(target, signal);
      let releaseKernel;
      try {
        releaseKernel = await acquireKernelLock(target, { signal, maxWaitMs });
      } catch (error) {
        releaseInProcess();
        throw error;
      }
      releases.push(async () => {
        try { await releaseKernel(); }
        finally { releaseInProcess(); }
      });
      throwIfAborted(signal);
    }
  };
  const identityOf = async target => {
    try {
      const stat = await fs.stat(target, { bigint: true });
      return `inode:${stat.dev}:${stat.ino}`;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };

  try {
    // Acquire all pathname leases before inode leases, in the same order in
    // every process. Existing hard-link aliases then share an inode lease.
    await lockTargets(orderedTargets);
    const identities = await Promise.all(orderedTargets.map(identityOf));
    await lockTargets([...new Set(identities.filter(Boolean))].sort());
    for (let index = 0; index < orderedTargets.length; index += 1) {
      if (await identityOf(orderedTargets[index]) !== identities[index]) {
        const error = new Error('file identity changed while acquiring mutation locks; reread and reconcile');
        error.code = 'MUTATION_TARGET_CHANGED';
        throw error;
      }
    }
    throwIfAborted(signal);
    return await fn();
  } finally {
    for (let i = releases.length - 1; i >= 0; i -= 1) await releases[i]();
  }
}

export function withMutationPath(target, fn, options) {
  return withMutationPaths([target], fn, options);
}
