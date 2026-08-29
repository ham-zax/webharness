import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const backgroundSource = await readFile(
  path.resolve(import.meta.dirname, '../../../webharness-agents-extension/background.js'),
  'utf8'
);

class FakeStorageArea {
  constructor(initial = {}) {
    this.data = structuredClone(initial);
  }

  async get(keys) {
    const wanted = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      wanted.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])])
    );
  }

  async set(values) {
    this.data = { ...this.data, ...structuredClone(values) };
  }
}

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(data);
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function loadWorker({ local, session, fetch }) {
  let messageListener = null;
  const event = () => ({ addListener() {} });
  const chrome = {
    storage: { local, session },
    runtime: {
      getManifest: () => ({ version: '2.0.4' }),
      onMessage: {
        addListener(fn) {
          messageListener = fn;
        }
      },
      onInstalled: event(),
      onStartup: event()
    },
    windows: { update: async () => ({ id: 1 }) },
    scripting: {
      executeScript: async () => [],
      insertCSS: async () => undefined
    },
    alarms: {
      create() {},
      clear: async () => true,
      onAlarm: event()
    },
    tabs: {
      create: async () => ({ id: 99 }),
      query: async () => [],
      update: async (id) => ({ id, windowId: 1 }),
      get: async (id) => ({ id, url: 'https://chatgpt.com/', status: 'complete' }),
      sendMessage: async () => ({ ok: true }),
      remove: async () => undefined,
      onCreated: event(),
      onRemoved: event(),
      onUpdated: event()
    }
  };

  vm.runInNewContext(
    backgroundSource,
    {
      chrome,
      fetch,
      AbortController,
      setTimeout,
      clearTimeout,
      URL,
      URLSearchParams,
      TextEncoder,
      console
    },
    { filename: 'background.js' }
  );

  assert.ok(messageListener, 'background.js must register its runtime message listener');

  return {
    send(message, tabId, documentId) {
      return new Promise((resolve, reject) => {
        try {
          const keep = messageListener(
            message,
            { tab: { id: tabId }, documentId, frameId: 0 },
            resolve
          );
          if (keep !== true) reject(new Error('message listener did not keep the response channel open'));
        } catch (error) {
          reject(error);
        }
      });
    }
  };
}

test('stale 401 cannot erase a bearer installed by concurrent recovery', async () => {
  const local = new FakeStorageArea({ port: 8765, token: 'A' });
  const session = new FakeStorageArea();
  const firstRequestDispatched = deferred();
  const releaseFirst401 = deferred();
  let aRequests = 0;
  let pairCount = 0;

  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const authorization = (init.headers ?? {}).authorization;

    if (url.pathname === '/hello') {
      return response(200, {
        app: 'webharness-agents',
        version: 'webharness-agents',
        bridge: 9,
        compatible: true,
        paired: true,
        disconnected: false
      });
    }
    if (url.pathname === '/pair') {
      pairCount += 1;
      return response(200, { token: pairCount === 1 ? 'B' : 'C' });
    }
    if (url.pathname === '/settings') {
      if (authorization === 'Bearer A') {
        aRequests += 1;
        if (aRequests === 1) {
          firstRequestDispatched.resolve();
          return releaseFirst401.promise;
        }
        return response(401, { error: 'not_paired' });
      }
      return response(200, { ok: true });
    }
    return response(404, {});
  };

  const worker = loadWorker({ local, session, fetch });
  const requestX = worker.send({ type: 'settings_get' }, 1, 'document-1');
  await firstRequestDispatched.promise;

  const recoveryResult = await worker.send({ type: 'settings_get' }, 2, 'document-2');
  assert.equal(recoveryResult.ok, true);
  assert.equal(local.data.token, 'B');
  assert.equal(pairCount, 1);

  releaseFirst401.resolve(response(401, { error: 'not_paired' }));
  const staleResult = await requestX;
  assert.equal(staleResult.ok, true);
  assert.equal(local.data.token, 'B');
  assert.equal(pairCount, 1);
});

test('current bearer 401 still performs one normal recovery', async () => {
  const local = new FakeStorageArea({ port: 8765, token: 'A' });
  const session = new FakeStorageArea();
  let pairCount = 0;
  const seenAuth = [];

  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const authorization = (init.headers ?? {}).authorization;

    if (url.pathname === '/hello') {
      return response(200, {
        app: 'webharness-agents',
        version: 'webharness-agents',
        bridge: 9,
        compatible: true,
        paired: true,
        disconnected: false
      });
    }
    if (url.pathname === '/pair') {
      pairCount += 1;
      return response(200, { token: 'B' });
    }
    if (url.pathname === '/settings') {
      seenAuth.push(authorization);
      return authorization === 'Bearer A'
        ? response(401, { error: 'not_paired' })
        : response(200, { ok: true });
    }
    return response(404, {});
  };

  const worker = loadWorker({ local, session, fetch });
  const result = await worker.send({ type: 'settings_get' }, 1, 'document-1');

  assert.equal(result.ok, true);
  assert.deepEqual(seenAuth, ['Bearer A', 'Bearer B']);
  assert.equal(local.data.token, 'B');
  assert.equal(pairCount, 1);
});
