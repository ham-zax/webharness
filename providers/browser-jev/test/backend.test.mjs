import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  BrowserJevBackendResolver,
  extractAgentBrowserCdpUrl,
  toLoopbackBrowserUrl
} from '../backend.mjs';

test('Windows uses the managed Chrome runtime for the selected profile', async () => {
  const calls = [];
  const resolver = new BrowserJevBackendResolver({
    ensureWindows: async options => {
      calls.push(options);
      return { browserUrl: 'http://127.0.0.1:9222', wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/id' };
    }
  });
  const result = await resolver.resolve({
    browser_target: 'windows', browser_backend: 'chrome', browser_profile: 'work'
  });
  assert.deepEqual(calls, [{ profile: 'work' }]);
  assert.deepEqual(result, {
    browserTarget: 'windows',
    browserBackend: 'chrome',
    browserProfile: 'work',
    browserUrl: 'http://127.0.0.1:9222',
    queueKey: 'windows:chrome:work'
  });
});

test('Linux Clearcote resolves its live endpoint on every call', async () => {
  const reads = [];
  let port = 9300;
  const stateRoot = '/state/clearcote';
  const resolver = new BrowserJevBackendResolver({
    stateRoot,
    resolveLinux: async () => ({ browser: 'clearcote', managed: true, profileName: 'x-main' }),
    readEndpoint: async (profileDir, options) => {
      reads.push({ profileDir, options });
      port += 1;
      return { browserUrl: `http://127.0.0.1:${port}` };
    },
    runnerFactory: () => { throw new Error('must not construct AgentBrowserRunner for Clearcote'); }
  });
  const selection = { browser_target: 'linux', browser_backend: 'clearcote', browser_profile: 'x-main' };
  assert.equal((await resolver.resolve(selection)).browserUrl, 'http://127.0.0.1:9301');
  assert.equal((await resolver.resolve(selection)).browserUrl, 'http://127.0.0.1:9302');
  assert.deepEqual(reads, [
    { profileDir: path.resolve(stateRoot, 'profiles', 'x-main'), options: { allowMissing: true } },
    { profileDir: path.resolve(stateRoot, 'profiles', 'x-main'), options: { allowMissing: true } }
  ]);
});

test('inactive Clearcote fails with browser-fast initialization instructions', async () => {
  const resolver = new BrowserJevBackendResolver({
    resolveLinux: async () => ({ browser: 'clearcote', managed: true, profileName: 'x-main' }),
    readEndpoint: async () => null,
    runnerFactory: () => { throw new Error('must not construct AgentBrowserRunner for Clearcote'); }
  });
  await assert.rejects(
    resolver.resolve({ browser_target: 'linux', browser_backend: 'clearcote', browser_profile: 'x-main' }),
    error => error.code === 'LINUX_BROWSER_NOT_RUNNING' && /browser-fast/.test(error.message)
  );
});

test('Linux Chrome dispatches exactly get cdp-url through the resolved session', async () => {
  const calls = [];
  const resolver = new BrowserJevBackendResolver({
    resolveLinux: async args => {
      assert.deepEqual(args, { browser: 'chrome', profile: 'work' });
      return { browser: 'chrome', profileName: 'work', session: 'resolved-session' };
    },
    runnerFactory: () => ({
      linuxBatch: async (commands, options) => {
        calls.push({ commands, options });
        return {
          items: [{ success: true, result: { cdpUrl: 'ws://127.0.0.1:9333/devtools/browser/value?secret=no' } }]
        };
      }
    })
  });
  const result = await resolver.resolve({
    browser_target: 'linux', browser_backend: 'chrome', browser_profile: 'work'
  });
  assert.deepEqual(calls, [{
    commands: [['get', 'cdp-url']],
    options: { bail: true, browserBackend: 'chrome', browserProfile: 'work' }
  }]);
  assert.deepEqual(result, {
    browserTarget: 'linux',
    browserBackend: 'chrome',
    browserProfile: 'work',
    browserUrl: 'http://127.0.0.1:9333',
    queueKey: 'linux:chrome:work'
  });
});

test('extracts only one successful Agent Browser result', () => {
  for (const [result, expected] of [
    ['ws://localhost:9001/devtools/browser/a', 'ws://localhost:9001/devtools/browser/a'],
    [{ url: 'http://localhost:9002' }, 'http://localhost:9002'],
    [{ cdpUrl: 'ws://localhost:9003/x' }, 'ws://localhost:9003/x'],
    [{ cdp_url: 'ws://localhost:9004/x' }, 'ws://localhost:9004/x'],
    [{ wsEndpoint: 'ws://localhost:9005/x' }, 'ws://localhost:9005/x']
  ]) {
    assert.equal(extractAgentBrowserCdpUrl({ success: true, result }), expected);
  }
  for (const item of [
    null,
    { success: false, error: 'no' },
    { success: true },
    { success: true, result: { other: 'ws://localhost:1' } }
  ]) {
    assert.throws(() => extractAgentBrowserCdpUrl(item), /CDP URL/);
  }
});

test('normalizes only credential-free loopback HTTP and WebSocket URLs', () => {
  assert.equal(toLoopbackBrowserUrl('ws://127.0.0.1:9222/devtools/browser/id?q=1'), 'http://127.0.0.1:9222');
  assert.equal(toLoopbackBrowserUrl('wss://localhost:9443/devtools/browser/id'), 'https://localhost:9443');
  assert.equal(toLoopbackBrowserUrl('http://[::1]:9222/json/version'), 'http://[::1]:9222');
  for (const value of [
    'ws://192.168.1.2:9222/x',
    'ws://user:pass@127.0.0.1:9222/x',
    'ftp://127.0.0.1:21/x',
    'ws://127.0.0.1:0/x',
    'ws://127.0.0.1:65536/x',
    'not a URL'
  ]) {
    assert.throws(() => toLoopbackBrowserUrl(value), /loopback|CDP URL|port|scheme/i);
  }
});

test('rejects malformed batch output before worker startup', async () => {
  for (const batch of [
    { items: [] },
    { items: [{ success: true, result: 'ws://localhost:9001' }, { success: true, result: 'ws://localhost:9002' }] },
    { items: [{ success: false, error: 'unavailable' }] }
  ]) {
    const resolver = new BrowserJevBackendResolver({
      resolveLinux: async () => ({ browser: 'chrome', profileName: undefined }),
      runnerFactory: () => ({ linuxBatch: async () => batch })
    });
    await assert.rejects(
      resolver.resolve({ browser_target: 'linux', browser_backend: 'chrome' }),
      /exactly one successful|CDP URL/
    );
  }
});

