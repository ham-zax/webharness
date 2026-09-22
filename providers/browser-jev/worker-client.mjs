import { spawn } from 'node:child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function clientError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export class JevWorkerClient {
  static async start({
    python,
    script,
    env,
    spawnProcess = spawn,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
  }) {
    const child = spawnProcess(python, [script], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    return new JevWorkerClient(child, { timeoutMs, maxOutputBytes });
  }

  constructor(child, { timeoutMs, maxOutputBytes }) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.nextId = 0;
    this.pending = null;
    this.stdoutBuffer = '';
    this.stderrBytes = 0;
    this.closed = false;
    this.fatalError = null;

    child.stdout.on('data', chunk => this.onStdout(chunk));
    child.stderr.on('data', chunk => this.onStderr(chunk));
    child.once('error', () => this.fail(clientError('JEV_WORKER_START_FAILED', 'worker process could not be started')));
    child.once('exit', (code, signal) => {
      if (!this.closed) this.fail(clientError('JEV_WORKER_EXITED', `worker exited before completing the request (${code ?? signal ?? 'unknown'})`));
    });
  }

  onStdout(chunk) {
    if (this.closed) return;
    this.stdoutBuffer += chunk.toString('utf8');
    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > this.maxOutputBytes) {
        this.fail(clientError('JEV_WORKER_OUTPUT_LIMIT', 'one worker response exceeded the output limit'));
        return;
      }
      this.onLine(line);
      if (this.closed) return;
    }
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxOutputBytes) {
      this.fail(clientError('JEV_WORKER_OUTPUT_LIMIT', 'one worker response exceeded the output limit'));
    }
  }

  onStderr(chunk) {
    if (this.closed) return;
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > this.maxOutputBytes) {
      this.fail(clientError('JEV_WORKER_OUTPUT_LIMIT', 'worker stderr exceeded the output limit'));
    }
  }

  onLine(line) {
    if (!this.pending) {
      this.fail(clientError('JEV_WORKER_PROTOCOL_INVALID', 'worker emitted an unexpected response'));
      return;
    }
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this.fail(clientError('JEV_WORKER_PROTOCOL_INVALID', 'worker response was invalid JSON'));
      return;
    }
    if (!response || typeof response !== 'object' || Array.isArray(response) || response.id !== this.pending.id) {
      this.fail(clientError('JEV_WORKER_PROTOCOL_INVALID', 'worker response id did not match the request'));
      return;
    }
    const pending = this.takePending();
    if (response.ok === true && Object.hasOwn(response, 'result')) {
      pending.resolve(response.result);
      return;
    }
    if (response.ok === false && response.error && typeof response.error.message === 'string') {
      pending.reject(clientError(
        typeof response.error.code === 'string' ? response.error.code : 'JEV_WORKER_ERROR',
        response.error.message
      ));
      return;
    }
    pending.reject(clientError('JEV_WORKER_PROTOCOL_INVALID', 'worker response had an invalid shape'));
  }

  takePending() {
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    return pending;
  }

  fail(error) {
    if (!this.fatalError) this.fatalError = error;
    if (this.pending) this.takePending().reject(error);
    if (!this.closed) {
      this.closed = true;
      try { this.child.kill('SIGTERM'); } catch {}
    }
  }

  async request(command, arguments_) {
    if (this.fatalError) throw this.fatalError;
    if (this.closed) throw clientError('JEV_WORKER_CLOSED', 'worker is closed');
    if (this.pending) throw clientError('JEV_WORKER_BUSY', 'worker already has an outstanding request');
    const id = String(++this.nextId);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(clientError('JEV_WORKER_TIMEOUT', 'worker request timed out'));
      }, this.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      try {
        this.child.stdin.write(`${JSON.stringify({ id, command, arguments: arguments_ })}\n`, error => {
          if (error && this.pending?.id === id) {
            this.fail(clientError('JEV_WORKER_WRITE_FAILED', 'worker request could not be written'));
          }
        });
      } catch {
        this.fail(clientError('JEV_WORKER_WRITE_FAILED', 'worker request could not be written'));
      }
    });
  }

  async waitForExit(timeoutMs) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return true;
    return await new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child.off('exit', onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.child.once('exit', onExit);
    });
  }

  async close() {
    if (this.pending) this.takePending().reject(clientError('JEV_WORKER_CLOSED', 'worker closed with a request outstanding'));
    if (!this.closed) {
      this.closed = true;
      try { this.child.stdin.end(); } catch {}
    }
    if (await this.waitForExit(750)) return;
    try { this.child.kill('SIGTERM'); } catch {}
    if (await this.waitForExit(1000)) return;
    try { this.child.kill('SIGKILL'); } catch {}
    await this.waitForExit(1000);
  }
}

