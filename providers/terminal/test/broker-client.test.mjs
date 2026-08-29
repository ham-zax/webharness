import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrokerClient } from '../broker-client.mjs';

async function tempSocket(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'terminal-broker-client-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'broker.sock');
}

function serveOne(socketPath, response) {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      if (!buffered.includes('\n')) return;
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

test('broker client reconnects while the broker socket is briefly unavailable', async (t) => {
  const socketPath = await tempSocket(t);
  const client = new BrokerClient({ socketPath, retryWindowMs: 1000, retryIntervalMs: 20 });

  const requestPromise = client.request('session.list', {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  const server = await serveOne(socketPath, { id: 1, ok: true, result: { sessions: [{ name: 'kept' }] } });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await requestPromise;
  assert.deepEqual(result, { sessions: [{ name: 'kept' }] });
});

test('broker client request abort cancels unavailable-socket retries promptly and leaves no delayed retry', async (t) => {
  const socketPath = await tempSocket(t);
  const client = new BrokerClient({ socketPath, retryWindowMs: 1000, retryIntervalMs: 100 });
  const controller = new AbortController();
  const started = Date.now();
  const pending = client.request('session.list', {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    pending,
    (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 300, `abort waited through broker retry window: ${elapsed}ms`);

  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(connections, 0, 'aborted request retried after returning');
});

test('broker client abort cancels an in-flight connected request and closes its socket', async (t) => {
  const socketPath = await tempSocket(t);
  let acceptedSocket;
  let acceptedResolve;
  const accepted = new Promise((resolve) => { acceptedResolve = resolve; });
  const server = net.createServer((socket) => {
    acceptedSocket = socket;
    acceptedResolve();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => {
    acceptedSocket?.destroy();
    return new Promise((resolve) => server.close(resolve));
  });

  const client = new BrokerClient({ socketPath, retryWindowMs: 1000, requestTimeoutMs: 3000 });
  const controller = new AbortController();
  const pending = client.request('session.list', {}, { signal: controller.signal });
  await accepted;
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(acceptedSocket.destroyed, true);
});

test('broker client abort retry stress leaves no delayed connects or AbortSignal listeners', async (t) => {
  const socketPath = await tempSocket(t);
  const client = new BrokerClient({ socketPath, retryWindowMs: 1000, retryIntervalMs: 50 });
  const controllers = Array.from({ length: 12 }, () => new AbortController());
  const requests = controllers.map((controller, index) => {
    const pending = client.request('session.list', {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20 + index);
    return pending;
  });
  const settled = await Promise.allSettled(requests);
  assert.ok(settled.every((entry) => entry.status === 'rejected'));
  for (const controller of controllers) {
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }

  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(connections, 0, 'aborted requests left retry work behind');
});

test('broker client preserves Terminal error code and details', async (t) => {
  const socketPath = await tempSocket(t);
  const server = await serveOne(socketPath, {
    id: 1,
    ok: false,
    error: {
      code: 'CURSOR_AHEAD',
      message: 'cursor 4 is beyond transcript end 3',
      details: { baseOffset: 0, endOffset: 3 },
    },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new BrokerClient({ socketPath, retryWindowMs: 200, retryIntervalMs: 10 });

  await assert.rejects(
    () => client.request('model.read', { name: 'x' }),
    (error) => {
      assert.equal(error.code, 'CURSOR_AHEAD');
      assert.deepEqual(error.details, { baseOffset: 0, endOffset: 3 });
      assert.match(error.message, /beyond transcript end 3/);
      return true;
    },
  );
});
