import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasActiveRuntimeLeases } from '../runtime-leases.mjs';

export function createWakeProxy({ port, backendPort, idleMs = 600000, startupMs = 30000,
  maxQueued = 64, hasActiveLeases = async () => false, startBackend, stopBackend }) {
  let state = 'asleep', active = 0, pending = 0, startPromise, stopPromise, timer, closing = false, lastFailure = false;
  for (const [name, value] of Object.entries({ idleMs, startupMs, maxQueued })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  let idleGeneration = 0, startupController, managedClosing = false;
  const sockets = new Set();
  const cancelIdle = () => { idleGeneration++; clearTimeout(timer); timer = undefined; };
  const stop = async () => {
    cancelIdle();
    if (stopPromise) return stopPromise;
    state = 'stopping';
    stopPromise = Promise.resolve().then(stopBackend).then(() => { state = 'asleep'; }, () => { state = 'failed'; })
      .finally(() => { stopPromise = undefined; });
    return stopPromise;
  };
  const armIdle = () => {
    cancelIdle();
    const generation = idleGeneration;
    if (!closing && state === 'ready' && active === 0) timer = setTimeout(async () => {
      try {
        const pinned = await hasActiveLeases();
        if (!closing && generation === idleGeneration && state === 'ready' && active === 0) {
          if (pinned) armIdle(); else await stop();
        }
      } catch { if (generation === idleGeneration) armIdle(); } // An unreadable lease must not evict live work.
    }, idleMs);
  };
  const ensureReady = async () => {
    cancelIdle();
    if (stopPromise) await stopPromise;
    if (closing) throw new Error('shutting down');
    if (state === 'ready') return;
    if (!startPromise) {
      if (state === 'failed') {
        if (active > 1) throw new Error('Backend recovery waits for in-flight requests');
        await stop();
      }
      state = 'starting';
      const controller = new AbortController();
      startupController = controller;
      const launch = Promise.resolve().then(() => startBackend(controller.signal));
      const cancelled = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      const startupTimer = setTimeout(() => controller.abort(new Error('Backend startup timed out')), startupMs);
      startPromise = Promise.race([launch, cancelled]).then(() => {
        if (closing || controller.signal.aborted) throw new Error('shutting down');
        state = 'ready'; lastFailure = false;
      }).catch(async (error) => {
        lastFailure = true; state = 'failed';
        controller.abort(error);
        // The startup callback must settle only after its controller is reaped.
        // Cleanup then runs after startup can no longer create another backend.
        await launch.catch(() => {});
        if (!managedClosing) await stop();
        state = 'failed'; throw error;
      }).finally(() => {
        clearTimeout(startupTimer); startPromise = undefined; startupController = undefined;
      });
    }
    await startPromise;
  };
  const server = http.createServer(async (req, res) => {
    const pathname = req.url?.split('?')[0];
    if (pathname === '/health/ready' || pathname === '/health/live') {
      let healthy = !closing && !lastFailure && state !== 'failed';
      if (healthy && state === 'ready') {
        healthy = await new Promise(resolve => {
          const probe = http.get({ hostname: '127.0.0.1', port: backendPort, path: '/health/ready', timeout: 1000 }, response => {
            response.resume(); resolve(response.statusCode === 200);
          });
          probe.once('error', () => resolve(false));
          probe.once('timeout', () => { probe.destroy(); resolve(false); });
        });
      }
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ status: healthy ? 'available' : 'failed', backend: state }));
      return;
    }
    if (closing || pending >= maxQueued) { res.writeHead(503); res.end('Gateway unavailable'); return; }
    pending++; active++; cancelIdle();
    let upstream;
    let released = false;
    const release = () => { if (!released) { released = true; active--; armIdle(); } };
    res.once('close', () => { upstream?.destroy(); release(); });
    req.once('aborted', () => { upstream?.destroy(); release(); });
    // Pause incoming bodies while the backend starts; Node applies TCP backpressure.
    req.pause();
    let timeout;
    try {
      await Promise.race([ensureReady(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Backend startup timed out')), startupMs);
      })]);
      if (res.destroyed || req.aborted || closing) return;
      upstream = http.request({ hostname: '127.0.0.1', port: backendPort,
        method: req.method, path: req.url, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode, response.rawHeaders);
        response.on('error', () => res.destroy());
        response.once('end', () => res.addTrailers(response.trailers));
        response.pipe(res);
      });
      upstream.on('error', () => {
        // Never replay a request: it may already have performed a mutation.
        state = 'failed'; lastFailure = true; cancelIdle();
        if (!res.headersSent) { res.writeHead(502); res.end('Backend connection failed'); }
        else res.destroy();
      });
      req.once('end', () => upstream.addTrailers(req.trailers));
      req.pipe(upstream);
      req.resume();
    } catch {
      if (!res.destroyed) { res.writeHead(503); res.end('Backend unavailable'); }
    } finally { clearTimeout(timeout); pending--; armIdle(); }
  });
  const rejectUpgrade = (_req, socket) => { socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
  server.on('connect', rejectUpgrade); server.on('upgrade', rejectUpgrade);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }),
    close: async ({ managed = false } = {}) => {
      closing = true; managedClosing = managed; startupController?.abort(new Error('shutting down'));
      cancelIdle(); server.close();
      for (const socket of sockets) socket.destroy();
      if (startPromise) await startPromise.catch(() => {});
      if (!managed) await stop();
    },
  };
}

// Each controller has its own process group. Abort terminates and reaps it
// before the caller runs the existing scoped backend cleanup. 1MCP's own
// setsid group remains owned by common.sh and is stopped by that cleanup.
export function runBackendControl(control, action, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [control, action], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    let aborted = false, termination;
    const killGroup = kind => {
      if (!child.pid) return;
      try { process.kill(-child.pid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const abort = () => {
      if (aborted) return;
      aborted = true;
      killGroup('SIGTERM');
      termination = new Promise(done => setTimeout(() => { killGroup('SIGKILL'); done(); }, 500));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', async code => {
      signal?.removeEventListener('abort', abort);
      if (termination) await termination;
      if (aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error(`${action} exited ${code}`));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const control = fileURLToPath(new URL('./backend-control.sh', import.meta.url));
  const proxy = createWakeProxy({ port: Number(process.env.MCP_ONE_MCP_PORT || 3050),
    backendPort: Number(process.env.BRIDGE_BACKEND_PORT || (Number(process.env.MCP_ONE_MCP_PORT || 3050) + 10)),
    idleMs: Number(process.env.BRIDGE_WAKE_IDLE_MS || 600000),
    startupMs: Number(process.env.BRIDGE_WAKE_STARTUP_MS || 30000),
    hasActiveLeases: () => hasActiveRuntimeLeases(process.env.MCP_LIFECYCLE_LEASE_DIR),
    startBackend: signal => runBackendControl(control, 'start', { signal }),
    stopBackend: () => runBackendControl(control, 'stop') });
  let shutdown;
  const close = managed => { shutdown ??= proxy.close({ managed }).finally(() => process.exit(0)); };
  process.once('SIGUSR2', () => close(true)); // Lifecycle owner stops the backend under its held lock.
  process.once('SIGTERM', () => close(false)); process.once('SIGINT', () => close(false));
  await proxy.listen();
}
