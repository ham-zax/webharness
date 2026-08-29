import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('broker did not become ready')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'ready') {
          clearTimeout(timer);
          resolve(event);
          return;
        }
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`broker exited before ready: ${code}`));
    });
  });
}

test('activity accepts a valid bearer when Chrome omits Origin', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'webharness-agents-origin-'));
  const brokerPath = path.resolve(import.meta.dirname, '../broker.mjs');
  const child = spawn(process.execPath, [brokerPath], {
    env: {
      ...process.env,
      MCP_AGENT_STATE_ROOT: path.join(temp, 'state'),
      MCP_AGENT_SOCKET: path.join(temp, 'broker.sock')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    const ready = await waitForReady(child);
    const base = `http://127.0.0.1:${ready.bridgePort}`;
    const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
    const versionHeaders = {
      'x-extension-version': '2.0.4',
      'x-extension-protocol': '9'
    };

    const paired = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: {
        ...versionHeaders,
        origin: extensionOrigin,
        'content-type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(paired.status, 200);
    const { token } = await paired.json();
    assert.equal(typeof token, 'string');

    const activity = await fetch(`${base}/activity`, {
      method: 'POST',
      headers: {
        ...versionHeaders,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ conversationId: 'conversation-123', since: 0 })
    });
    assert.equal(activity.status, 200);

    const webOrigin = await fetch(`${base}/activity`, {
      method: 'POST',
      headers: {
        ...versionHeaders,
        authorization: `Bearer ${token}`,
        origin: 'https://example.com',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ conversationId: 'conversation-123', since: 0 })
    });
    assert.equal(webOrigin.status, 401);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
