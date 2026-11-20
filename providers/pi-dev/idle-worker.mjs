import { fork } from 'node:child_process';

export class IdleExecutionWorker {
  constructor({ serverPath, idleMs = 1_800_000, env = process.env }) {
    this.serverPath = serverPath;
    this.env = env;
    this.idleMs = idleMs;
    this.child = null;
    this.starting = null;
    this.stopping = null;
    this.closed = false;
    this.calls = new Map();
    this.nextId = 0;
    this.backgroundJobs = 0;
    this.timer = null;
  }

  async start() {
    while (this.stopping) await this.stopping;
    if (this.closed) throw new Error('Dev execution worker is closed');
    if (this.starting) return this.starting;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null && this.child.connected) return;
    const child = fork(this.serverPath, ['--dev-execution-worker'], {
      env: this.env,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      detached: true,
      serialization: 'advanced',
    });
    this.child = child;
    this.starting = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (this.child === child) this.child = null;
        reject(new Error('Dev execution worker startup timed out'));
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 30_000);
      deadline.unref?.();
      child.on('message', message => {
        if (message.type === 'ready') {
          clearTimeout(deadline);
          resolve();
        } else if (message.type === 'result') {
          const pending = this.calls.get(message.id);
          if (!pending) return;
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.result);
        } else if (message.type === 'background') {
          this.backgroundJobs = Math.max(0, this.backgroundJobs + (Number(message.delta) || 0));
          this.scheduleIdle();
        }
      });
      child.once('error', error => {
        clearTimeout(deadline);
        if (this.child === child) this.child = null;
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(deadline);
        const error = new Error(`Dev execution worker exited (${signal ?? code}); the call was not replayed`);
        reject(error);
        for (const pending of this.calls.values()) {
          if (pending.child === child) pending.reject(error);
        }
        if (this.child === child) {
          this.child = null;
          this.backgroundJobs = 0;
        }
      });
    });
    try { await this.starting; }
    finally { this.starting = null; }
    this.scheduleIdle();
  }

  async call(name, args, signal, callId, rpcBudgetMs) {
    clearTimeout(this.timer);
    const id = ++this.nextId;
    // Reserve the call before startup so simultaneous calls cannot race eviction.
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    // Startup failure may reject an entry before the result is awaited.
    result.catch(() => {});
    this.calls.set(id, { resolve: resolveResult, reject: rejectResult });
    let child;
    const abort = () => {
      if (child?.connected) child.send({ type: 'cancel', id }, () => {});
    };
    try {
      await this.start();
      signal?.throwIfAborted();
      child = this.child;
      if (!child || !child.connected) {
        throw new Error('Dev execution worker exited before dispatch; the call was not replayed');
      }
      this.calls.get(id).child = child;
      signal?.addEventListener('abort', abort, { once: true });
      child.send({
        type: 'call',
        id,
        name,
        args,
        callId,
        ...(rpcBudgetMs !== undefined ? { rpcBudgetMs } : {}),
      }, error => { if (error) rejectResult(error); });
      return await result;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.calls.delete(id);
      this.scheduleIdle();
    }
  }

  scheduleIdle() {
    clearTimeout(this.timer);
    if (this.closed || !this.idleMs || this.calls.size || this.backgroundJobs > 0 || !this.child) return;
    this.timer = setTimeout(() => {
      if (!this.calls.size && this.backgroundJobs === 0) void this.stop();
    }, this.idleMs);
    this.timer.unref();
  }

  async stop() {
    if (this.stopping) return this.stopping;
    clearTimeout(this.timer);
    const child = this.child;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) {
      if (child && !child.pid && this.child === child) this.child = null;
      return;
    }
    const ready = !this.starting;
    this.stopping = (async () => {
      await new Promise(resolve => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(kill);
          child.off('exit', done);
          child.off('error', done);
          resolve();
        };
        const kill = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        }, 5000);
        kill.unref?.();
        child.once('exit', done);
        child.once('error', done);
        if (ready && child.connected) {
          child.send({ type: 'shutdown' }, () => {});
        } else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
        }
      });
    })();
    try { await this.stopping; }
    finally { this.stopping = null; }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.stop();
    if (this.starting) await this.starting.catch(() => {});
  }
}

let workerBackgroundActive = false;
const activeBackgroundJobs = new Set();

export function beginBackgroundWork(onShutdown = null) {
  let ended = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const entry = { onShutdown, done };
  activeBackgroundJobs.add(entry);
  if (workerBackgroundActive && process.connected && typeof process.send === 'function') {
    try { process.send({ type: 'background', delta: 1 }); } catch {}
  }
  return () => {
    if (ended) return;
    ended = true;
    activeBackgroundJobs.delete(entry);
    resolveDone();
    if (workerBackgroundActive && process.connected && typeof process.send === 'function') {
      try { process.send({ type: 'background', delta: -1 }); } catch {}
    }
  };
}

export function serveExecutionWorker(handlers) {
  workerBackgroundActive = true;
  const active = new Map();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    for (const item of active.values()) item.controller.abort();
    const bgWaits = [];
    for (const job of activeBackgroundJobs) {
      try { job.onShutdown?.(); } catch {}
      bgWaits.push(job.done);
    }
    await Promise.allSettled([...active.values()].map(item => item.promise));
    await Promise.allSettled(bgWaits);
    process.exit(0);
  };
  process.on('message', message => {
    if (message.type === 'shutdown') { void shutdown(); return; }
    if (message.type === 'cancel') { active.get(message.id)?.controller.abort(); return; }
    if (message.type !== 'call' || closing) return;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const handler = handlers.get(message.name);
        if (!handler) throw new Error(`Unknown Dev tool: ${message.name}`);
        const result = await handler(message.args, {
          signal: controller.signal,
          callId: message.callId,
          ...(message.rpcBudgetMs !== undefined ? { rpcBudgetMs: message.rpcBudgetMs } : {}),
        });
        if (process.connected) process.send({ type: 'result', id: message.id, result });
      } catch (error) {
        if (process.connected) process.send({ type: 'result', id: message.id, error: error instanceof Error ? error.message : String(error) });
      } finally { active.delete(message.id); }
    })();
    active.set(message.id, { controller, promise });
  });
  process.once('disconnect', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  process.send({ type: 'ready' });
}
