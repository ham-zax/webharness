import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { BrowserJevBackendResolver } from './backend.mjs';
import {
  TERMINAL_STATUSES,
  sanitizeSnapshot,
  validateStartArguments,
  verifySuccess
} from './contracts.mjs';
import { loadWorkerEnvironment } from './credentials.mjs';
import { JevWorkerClient } from './worker-client.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PYTHON = path.join(DIR, '.venv', 'bin', 'python');
const DEFAULT_WORKER = path.join(DIR, 'worker.py');

function managerError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export class BrowserJevRunManager {
  constructor({
    backendResolver = new BrowserJevBackendResolver(),
    credentialLoader = loadWorkerEnvironment,
    credentialFile = process.env.MCP_BROWSER_JEV_ENV_FILE,
    baseEnv = process.env,
    workerFactory = options => JevWorkerClient.start(options),
    python = DEFAULT_PYTHON,
    script = DEFAULT_WORKER,
    idFactory = () => randomUUID().replaceAll('-', '')
  } = {}) {
    this.backendResolver = backendResolver;
    this.credentialLoader = credentialLoader;
    this.credentialFile = credentialFile;
    this.baseEnv = baseEnv;
    this.workerFactory = workerFactory;
    this.python = python;
    this.script = script;
    this.idFactory = idFactory;
    this.runs = new Map();
    this.operationTails = new Map();
  }

  async queued(key, operation) {
    const previous = this.operationTails.get(key) ?? Promise.resolve();
    let release;
    const turn = new Promise(resolve => { release = resolve; });
    this.operationTails.set(key, turn);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(key) === turn) this.operationTails.delete(key);
    }
  }

  present(run, rawSnapshot, { failure } = {}) {
    const snapshot = sanitizeSnapshot(rawSnapshot);
    const verification = verifySuccess(snapshot, run.success);
    let status = snapshot.status ?? run.status ?? 'ready';
    let reason;
    if (failure) {
      status = 'failed';
      reason = { code: failure.code ?? 'JEV_WORKER_FAILED', message: failure.message };
    } else if (status === 'done' && !verification.passed) {
      status = 'blocked';
      reason = {
        code: 'DONE_VERIFICATION_FAILED',
        message: 'Jev selected DONE before every deterministic success check passed'
      };
    }
    return {
      run_id: run.id,
      browser_target: run.backend.browserTarget,
      browser_backend: run.backend.browserBackend,
      browser_profile: run.backend.browserProfile ?? null,
      ...snapshot,
      status,
      verification,
      ...(reason ? { reason } : {})
    };
  }

  run(runId) {
    const run = this.runs.get(runId);
    if (!run) throw managerError('JEV_RUN_NOT_FOUND', `unknown run: ${runId}`);
    return run;
  }

  async start(input) {
    const args = validateStartArguments(input);
    const backend = await this.backendResolver.resolve(args.scenario);
    const id = this.idFactory();
    const daemonName = `jev-${id.slice(0, 32)}`;
    return await this.queued(backend.queueKey, async () => {
      const credentials = await this.credentialLoader({
        file: this.credentialFile,
        baseEnv: this.baseEnv
      });
      const env = {
        ...credentials,
        BU_CDP_URL: backend.browserUrl,
        BU_NAME: daemonName,
        PYTHONUNBUFFERED: '1'
      };
      const worker = await this.workerFactory({ python: this.python, script: this.script, env });
      const run = {
        id,
        backend: {
          browserTarget: backend.browserTarget,
          browserBackend: backend.browserBackend,
          browserProfile: backend.browserProfile,
          queueKey: backend.queueKey
        },
        worker,
        success: args.scenario.success,
        state: null,
        status: 'starting',
        cleanupStarted: false
      };
      try {
        const first = await worker.request('start', { url: args.url, goal: args.goal });
        run.state = this.present(run, first);
        run.status = run.state.status;
        this.runs.set(id, run);
        return run.state;
      } catch (error) {
        await worker.close().catch(() => {});
        throw error;
      }
    });
  }

  async tick(runId) {
    const run = this.run(runId);
    if (TERMINAL_STATUSES.has(run.status)) {
      throw managerError('JEV_RUN_TERMINAL', `run ${runId} is terminal (${run.status})`);
    }
    return await this.queued(run.backend.queueKey, async () => {
      const current = this.run(runId);
      if (TERMINAL_STATUSES.has(current.status)) {
        throw managerError('JEV_RUN_TERMINAL', `run ${runId} is terminal (${current.status})`);
      }
      try {
        const raw = await current.worker.request('tick', {});
        current.state = this.present(current, raw);
        current.status = current.state.status;
        return current.state;
      } catch (error) {
        current.state = this.present(current, current.state ?? {}, { failure: error });
        current.status = 'failed';
        throw error;
      }
    });
  }

  state(runId) {
    return this.run(runId).state;
  }

  async stop(runId) {
    const run = this.run(runId);
    return await this.queued(run.backend.queueKey, async () => {
      const current = this.run(runId);
      if (current.cleanupStarted) return { run_id: runId, status: 'stopped' };
      current.cleanupStarted = true;
      let requestError;
      try {
        await current.worker.request('stop', {});
      } catch (error) {
        requestError = error;
      } finally {
        await current.worker.close().catch(() => {});
        current.status = 'stopped';
        this.runs.delete(runId);
      }
      if (requestError) throw requestError;
      return { run_id: runId, status: 'stopped' };
    });
  }

  async close() {
    const runIds = [...this.runs.keys()];
    await Promise.allSettled(runIds.map(runId => this.stop(runId)));
  }
}
