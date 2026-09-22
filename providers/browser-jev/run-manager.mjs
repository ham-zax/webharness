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

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw managerError(
    'JEV_RUN_CANCELLED',
    'autonomous run was cancelled by the caller',
    signal.reason instanceof Error ? signal.reason : undefined
  );
}

const MAX_COLLECTION_ITEM_CHARS = 2000;

function scrollExhausted(rawSnapshot) {
  const actions = rawSnapshot?.page?.actions;
  if (!Array.isArray(actions)) return false;
  return !actions.some(action => (
    action?.id === 'scroll_down'
    || (action?.kind === 'scroll' && Number(action?.delta) > 0)
  ));
}

function extractTextRecords(text, config) {
  if (typeof text !== 'string' || !text) return [];
  const records = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (current === null) {
      if (line.startsWith(config.start_prefix)) current = [line];
      continue;
    }
    if (line.startsWith(config.start_prefix) && line !== current[0]) {
      current = [line];
      continue;
    }
    current.push(line);
    if (line === config.end_exact) {
      records.push(current.join('\n').slice(0, MAX_COLLECTION_ITEM_CHARS));
      current = null;
    }
  }
  return records;
}

function createCollection(config) {
  if (!config) return null;
  return {
    config,
    seen: new Set(),
    items: [],
    started: false,
    stableObservations: 0,
    settlePending: false,
    lastHistoryLength: 0,
    scrollExhausted: false,
    truncated: false,
    complete: false,
    pageIdentity: null
  };
}

function collectionNavigationSuccess(state, success) {
  const navigationSuccess = {};
  for (const key of ['url_contains', 'title_contains', 'text_contains']) {
    if (success[key] !== undefined) navigationSuccess[key] = success[key];
  }
  return Object.keys(navigationSuccess).length > 0
    && verifySuccess(state, navigationSuccess).passed === true;
}

function rawDocumentIdentity(rawSnapshot) {
  const documentId = rawSnapshot?.page?.document_id;
  if (
    Array.isArray(documentId)
    && documentId.length === 2
    && Number.isFinite(documentId[0])
    && typeof documentId[1] === 'string'
  ) {
    return JSON.stringify(documentId);
  }
  const url = rawSnapshot?.page?.url;
  return typeof url === 'string' ? `url:${url}` : null;
}

function resetCollectionProgress(collection, historyLength, pageIdentity = null) {
  collection.seen.clear();
  collection.items.length = 0;
  collection.started = false;
  collection.stableObservations = 0;
  collection.settlePending = false;
  collection.lastHistoryLength = historyLength;
  collection.scrollExhausted = false;
  collection.truncated = false;
  collection.complete = false;
  collection.pageIdentity = pageIdentity;
}

function updateCollection(collection, rawSnapshot, { eligible }) {
  if (!collection) return;
  const history = Array.isArray(rawSnapshot?.history) ? rawSnapshot.history : [];
  const pageIdentity = rawDocumentIdentity(rawSnapshot);
  if (!eligible) {
    resetCollectionProgress(collection, history.length);
    return;
  }
  if (collection.pageIdentity !== pageIdentity) {
    resetCollectionProgress(collection, history.length, pageIdentity);
  }

  const wireRecords = rawSnapshot?.page?.collection_records;
  const records = Array.isArray(wireRecords)
    ? wireRecords
      .filter(record => typeof record === 'string' && record)
      .map(record => record.slice(0, MAX_COLLECTION_ITEM_CHARS))
    : extractTextRecords(rawSnapshot?.page?.text, collection.config);
  let added = 0;
  for (const record of records) {
    if (collection.seen.has(record)) continue;
    if (collection.seen.size >= collection.config.max_items) {
      collection.truncated = true;
      continue;
    }
    collection.seen.add(record);
    collection.items.push(record);
    added += 1;
  }

  const historyAdvanced = history.length > collection.lastHistoryLength;
  const lastEntry = history.at(-1);
  const providerOwned = lastEntry?.source === 'collection';
  collection.lastHistoryLength = history.length;

  if (collection.seen.size > 0) {
    collection.started = true;
    if (added > 0) {
      collection.stableObservations = 0;
      collection.settlePending = false;
    } else if (historyAdvanced && providerOwned && lastEntry.kind === 'scroll') {
      collection.settlePending = true;
    } else if (
      historyAdvanced
      && providerOwned
      && lastEntry.kind === 'wait'
      && collection.settlePending
    ) {
      collection.stableObservations += 1;
      collection.settlePending = false;
    }
  }
  collection.scrollExhausted = scrollExhausted(rawSnapshot);
  if (collection.started && collection.scrollExhausted) {
    collection.settlePending = true;
  }
  collection.complete = !collection.truncated
    && collection.seen.size >= collection.config.min_unique
    && collection.stableObservations >= collection.config.stable_observations;
}

function publicCollection(collection) {
  if (!collection) return undefined;
  return {
    items: [...collection.items],
    unique_count: collection.seen.size,
    stable_observations: collection.stableObservations,
    scroll_exhausted: collection.scrollExhausted,
    truncated: collection.truncated,
    complete: collection.complete
  };
}

function collectionTraversalReady(run) {
  if (!run.collection?.started || run.collection.complete || !run.state) return false;
  return collectionNavigationSuccess(run.state, run.success);
}

function terminalAutonomousResult(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const { elements: _elements, decision: _decision, ...result } = state;
  return result;
}

function unmetUrlContains(run) {
  return (run.state?.verification?.checks?.url_contains ?? [])
    .filter(item => item?.passed === false && typeof item.expected === 'string')
    .map(item => item.expected);
}

function runtimeContext(run) {
  const parts = [];
  const checks = run.state?.verification?.checks ?? {};
  const unmet = [];
  for (const [key, label] of [
    ['url_contains', 'URL must contain'],
    ['title_contains', 'title must contain'],
    ['text_contains', 'visible text must contain']
  ]) {
    for (const item of checks[key] ?? []) {
      if (item?.passed === false && typeof item.expected === 'string') {
        unmet.push(`${label} ${JSON.stringify(item.expected)}`);
      }
    }
  }
  for (const [operation, item] of Object.entries(checks.required_operations ?? {})) {
    if (item?.passed === false) unmet.push(`history must include operation ${operation}`);
  }
  if (unmet.length > 0) {
    parts.push(`Unmet deterministic success requirements: ${unmet.join('; ')}.`);
  }
  if (run.collection) {
    const { config } = run.collection;
    parts.push(
      `Deterministic collection progress: ${run.collection.seen.size}/${config.min_unique} required unique records; `
      + `${run.collection.stableObservations}/${config.stable_observations} stable observations; `
      + `scroll exhausted=${run.collection.scrollExhausted}.`
    );
    if (!run.collection.started) {
      parts.push('The collection has not started yet. First navigate to the page/section where matching records are visible. Do not choose DONE yet.');
    } else if (!run.collection.complete) {
      parts.push('Continue exposing more matching visible records. Prefer scrolling; use WAIT when lazy content needs to settle. Do not choose DONE yet.');
    }
    if (run.collection.truncated) {
      parts.push('The bounded collector reached max_items before completion; do not claim success.');
    }
  }
  if (run.state?.verification?.passed !== true && run.collection?.complete === true) {
    parts.push('The collection is complete but other deterministic success checks have not all passed yet. Continue the goal and do not choose DONE yet.');
  } else if (!run.collection && run.state?.verification?.passed !== true) {
    parts.push('The provider deterministic success checks have not all passed yet. Continue the goal and do not choose DONE yet.');
  }
  return parts.join(' ');
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
    snapshot.goal = run.goal;
    if (snapshot.page) {
      snapshot.page.scroll ??= {};
      snapshot.page.scroll.exhausted = scrollExhausted(rawSnapshot);
    }
    if (!failure) {
      updateCollection(run.collection, rawSnapshot, {
        eligible: collectionNavigationSuccess(snapshot, run.success)
      });
    }
    const collection = publicCollection(run.collection);
    if (collection) snapshot.collection = collection;
    const verification = verifySuccess(snapshot, run.success);
    let status = snapshot.status ?? run.status ?? 'ready';
    let reason;
    if (failure) {
      status = 'failed';
      reason = { code: failure.code ?? 'JEV_WORKER_FAILED', message: failure.message };
    } else if (run.collection && verification.passed) {
      status = 'done';
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
        BROWSER_JEV_PROFILE_KEY: backend.queueKey,
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
        goal: args.goal,
        success: args.scenario.success,
        collection: createCollection(args.scenario.collection),
        state: null,
        status: 'starting',
        cleanupStarted: false
      };
      try {
        const first = await worker.request('start', {
          url: args.url,
          goal: args.goal,
          wait_for_scroll: Boolean(args.scenario.collection)
        });
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

  async runToTerminal(input, { signal } = {}) {
    let runId;
    let finalState;
    let primaryError;
    try {
      throwIfAborted(signal);
      finalState = await this.start(input);
      runId = finalState.run_id;
      throwIfAborted(signal);
      while (
        finalState.verification?.passed !== true
        && !['blocked', 'failed', 'stopped'].includes(finalState.status)
      ) {
        finalState = await this.tick(runId, { autonomous: true });
        throwIfAborted(signal);
      }
      if (finalState.verification?.passed === true && !['blocked', 'failed'].includes(finalState.status)) {
        finalState = { ...finalState, status: 'done' };
      }
      return terminalAutonomousResult(finalState);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (runId && this.runs.has(runId)) {
        try {
          await this.stop(runId);
        } catch (cleanupError) {
          if (!primaryError) throw cleanupError;
        }
      }
    }
  }

  async tick(runId, { autonomous = false } = {}) {
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
        const managedProgress = autonomous || current.collection;
        let raw;
        if (collectionTraversalReady(current)) {
          raw = await current.worker.request('collect', {
            prefer_wait: current.collection.settlePending,
            start_prefix: current.collection.config.start_prefix,
            end_exact: current.collection.config.end_exact,
            max_records: current.collection.config.max_items
          });
        } else {
          const unmetUrls = unmetUrlContains(current);
          if (unmetUrls.length > 0) {
            const navigation = await current.worker.request('navigate', { url_contains: unmetUrls });
            raw = navigation.provider_navigation?.matched === true
              ? navigation
              : await current.worker.request('tick', managedProgress ? {
                context: runtimeContext(current),
                allow_done: current.state?.verification?.passed === true,
                allow_blocked: !current.collection || current.state?.verification?.passed === true,
                settle_after_scroll: Boolean(current.collection)
              } : {});
          } else {
            raw = await current.worker.request('tick', managedProgress ? {
              context: runtimeContext(current),
              allow_done: current.state?.verification?.passed === true,
              allow_blocked: !current.collection || current.state?.verification?.passed === true,
              settle_after_scroll: Boolean(current.collection)
            } : {});
          }
        }
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
