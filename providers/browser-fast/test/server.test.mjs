import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolveBrowserMemory } from '../browser-memory.mjs';
import { resolveLinuxBrowserBackend } from '../browser-backend-config.mjs';
import {
  AgentBrowserRunner,
  FastBrowser,
  actionCommand,
  createBrowserFastServer
} from '../server.mjs';

test('browser-fast exposes only observe and execute', async t => {
  const browser = {
    async observe() { return { snapshot: '', refs: {}, tabs: [] }; },
    async execute() { return { outcome: 'completed', steps: [] }; }
  };
  const server = createBrowserFastServer({ browser });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'browser-fast-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['observe', 'execute']);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.match(tools[0].description, /local policy\/site\/platform memory/i);
  assert.equal(tools[1].annotations.readOnlyHint, false);
  assert.equal(tools[1].annotations.idempotentHint, false);
  assert.match(tools[1].description, /never auto-retries/i);
  assert.match(tools[1].description, /exactly one new tab/i);
  const actionSchema = tools[1].inputSchema.properties.actions.items;
  assert.equal(actionSchema.properties.op.enum.includes('upload'), true);
  assert.equal(actionSchema.properties.artifact.pattern, '^[A-Za-z0-9._-]+$');
  assert.equal(actionSchema.properties.file, undefined);
  assert.deepEqual(tools[1].inputSchema.required, ['tab', 'actions']);
});

test('action mapping prefers observation refs and keeps batching vocabulary small', () => {
  assert.deepEqual(actionCommand({ op: 'navigate', url: 'https://example.test' }), ['open', 'https://example.test']);
  assert.deepEqual(actionCommand({ op: 'click', target: 'e3' }), ['click', '@e3']);
  assert.deepEqual(actionCommand({ op: 'fill', target: '@e4', value: 'hello' }), ['fill', '@e4', 'hello']);
  assert.deepEqual(actionCommand({ op: 'select', target: 'e5', values: ['senior'] }), ['select', '@e5', 'senior']);
  assert.deepEqual(actionCommand({ op: 'upload', target: 'e5', file: '/tmp/approved.pdf' }), ['upload', '@e5', '/tmp/approved.pdf']);
  assert.deepEqual(actionCommand({ op: 'wait', text: 'Submitted' }), ['wait', '--text', 'Submitted']);
  assert.deepEqual(actionCommand({ op: 'wait', milliseconds: 250 }), ['wait', '250']);
  assert.deepEqual(actionCommand({ op: 'tab_switch', tab: 't2' }), ['tab', 't2']);
  assert.throws(() => actionCommand({ op: 'upload', target: 'e5', artifact: 'document.current' }), /upload.file/);
  assert.throws(() => actionCommand({ op: 'wait', url: '**/done' }), /exactly one/);
  assert.throws(() => actionCommand({ op: 'select', target: 'e5', values: ['a', 'b'] }), /exactly one/);
});

test('browser memory resolves exact sites and reusable platforms without first-label collisions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-fast-memory-test-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  await fs.mkdir(path.join(root, 'policies', 'account.example.test'), { recursive: true });
  await fs.writeFile(path.join(root, 'policies', 'account.example.test', 'manual.md'), 'Authenticated interaction is manual-only.');

  await fs.mkdir(path.join(root, 'platforms', 'hosted-forms'), { recursive: true });
  await fs.writeFile(path.join(root, 'platforms', 'hosted-forms', 'match.json'), JSON.stringify({ host_suffixes: ['forms.example.test'] }));
  await fs.writeFile(path.join(root, 'platforms', 'hosted-forms', 'strategy.md'), 'Verify the final confirmation state.');

  await fs.mkdir(path.join(root, 'sites', 'careers.example.test'), { recursive: true });
  await fs.writeFile(path.join(root, 'sites', 'careers.example.test', 'application.md'), 'Custom company form memory.');

  const custom = await resolveBrowserMemory('https://careers.example.test/apply/123', { root });
  assert.equal(custom.host, 'careers.example.test');
  assert.deepEqual(custom.matches.map(item => [item.kind, item.key]), [['site', 'careers.example.test']]);
  assert.match(custom.matches[0].content, /Custom company form memory/);

  const unrelated = await resolveBrowserMemory('https://careers.other.test/apply/123', { root });
  assert.equal(unrelated.host, 'careers.other.test');
  assert.deepEqual(unrelated.matches, []);

  await fs.mkdir(path.join(root, 'sites', 'tenant.forms.example.test'), { recursive: true });
  await fs.writeFile(path.join(root, 'sites', 'tenant.forms.example.test', 'local.md'), 'This host has a site-specific quirk.');
  const hosted = await resolveBrowserMemory('https://tenant.forms.example.test/application/1', { root });
  assert.deepEqual(hosted.matches.map(item => [item.kind, item.key]), [
    ['site', 'tenant.forms.example.test'],
    ['platform', 'hosted-forms']
  ]);

  const policy = await resolveBrowserMemory('https://www.account.example.test/settings', { root });
  assert.equal(policy.host, 'account.example.test');
  assert.deepEqual(policy.matches.map(item => [item.kind, item.key]), [['policy', 'account.example.test']]);
});

test('browser memory bounds returned file count and content size', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-fast-memory-bounds-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const site = path.join(root, 'sites', 'example.test');
  await fs.mkdir(site, { recursive: true });
  await fs.writeFile(path.join(site, 'a.md'), 'abcdefghij');
  await fs.writeFile(path.join(site, 'b.md'), 'klmnopqrst');

  const memory = await resolveBrowserMemory('https://example.test/', {
    root,
    maxFiles: 1,
    maxFileBytes: 4,
    maxTotalBytes: 4
  });
  assert.equal(memory.matches.length, 1);
  assert.equal(memory.matches[0].content, 'abcd');
  assert.equal(memory.matches[0].truncated, true);
});

test('upload resolves only approved artifacts and delegates target path translation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-fast-artifact-test-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, 'document.pdf');
  const manifest = path.join(root, 'browser-artifacts.json');
  await fs.writeFile(file, 'document-bytes');
  await fs.writeFile(manifest, JSON.stringify({ 'document.current': file }));

  const calls = [];
  const runner = {
    async pathForTarget(target, approvedPath) {
      assert.equal(target, 'windows');
      assert.equal(approvedPath, file);
      return `WIN:${approvedPath}`;
    },
    async batch(target, commands, options) {
      calls.push({ target, commands, options });
      if (commands.length === 1 && commands[0][0] === 'tab' && commands[0][1] === 'list') {
        return { exitCode: 0, items: [{ success: true, result: { tabs: [{ active: true, targetId: 'TAB-1', url: 'https://example.test/' }] } }] };
      }
      if (commands.length === 1 && commands[0][0] === 'upload') {
        return { exitCode: 0, items: [{ success: true, result: { uploaded: true } }] };
      }
      throw new Error(`unexpected commands: ${JSON.stringify(commands)}`);
    }
  };
  const browser = new FastBrowser({ runner, artifactManifestPath: manifest });
  const result = await browser.execute({
    browser_target: 'windows',
    tab: 'TAB-1',
    final_state: 'none',
    actions: [{ op: 'upload', target: 'e5', artifact: 'document.current' }]
  });

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(calls[1].commands, [['upload', '@e5', `WIN:${file}`]]);
  await assert.rejects(
    browser.execute({ browser_target: 'windows', tab: 'TAB-1', final_state: 'none', actions: [{ op: 'upload', target: 'e5', artifact: 'not-approved' }] }),
    /BROWSER_FAST_ARTIFACT_NOT_APPROVED/
  );
});

test('failed tab-context validation is always fail-closed before action dispatch', async () => {
  const calls = [];
  const runner = {
    async batch(target, commands, options) {
      calls.push({ target, commands, options });
      return { exitCode: 1, items: [], contextError: 'tab not found' };
    }
  };
  const browser = new FastBrowser({ runner });
  const result = await browser.execute({
    browser_target: 'linux',
    tab: 'STALE-TARGET',
    stop_on_error: false,
    final_state: 'none',
    actions: [
      { op: 'fill', target: 'e1', value: 'Hamza' },
      { op: 'click', target: 'e2' }
    ]
  });

  assert.equal(result.outcome, 'failed');
  assert.match(result.context_error, /tab not found/);
  assert.deepEqual(result.steps.map(step => step.status), ['not_run', 'not_run']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    target: 'linux',
    commands: [['tab', 'list']],
    options: { bail: true, tab: 'STALE-TARGET' }
  });
});

test('partial execution is explicit and never replayed after a later failure', async () => {
  const calls = [];
  const runner = {
    async batch(target, commands, options) {
      calls.push({ target, commands, options });
      if (commands.length === 1 && commands[0][0] === 'tab' && commands[0][1] === 'list') {
        return {
          exitCode: 0,
          items: [{ success: true, result: { tabs: [{ active: true, tabId: 't2', targetId: 'ABC', title: 'Submitted', url: 'https://example.test/submitted' }] } }]
        };
      }
      if (commands.length === 1 && commands[0][0] === 'fill') {
        return { exitCode: 0, items: [{ success: true, result: { filled: '@e1', lifecycle: { noisy: true } } }] };
      }
      if (commands.length === 1 && commands[0][0] === 'click') {
        return { exitCode: 0, items: [{ success: true, result: { clicked: '@e2', lifecycle: { noisy: true } } }] };
      }
      if (commands.length === 1 && commands[0][0] === 'wait') {
        return { exitCode: 1, items: [{ success: false, error: 'Timed out waiting for text' }] };
      }
      if (commands.length === 1 && commands[0][0] === 'tab' && commands[0][1] === 'ABC') {
        return { exitCode: 0, items: [{ success: true, result: { tabId: 't2', targetId: 'ABC' } }] };
      }
      if (commands.length === 2 && commands[0][0] === 'snapshot') return {
        exitCode: 0,
        items: [
          { success: true, result: { origin: 'https://example.test/submitted', snapshot: '- heading "Submitted"', refs: {} } },
          { success: true, result: { tabs: [{ active: true, tabId: 't2', targetId: 'ABC', title: 'Submitted', url: 'https://example.test/submitted' }] } }
        ]
      };
      throw new Error(`unexpected commands: ${JSON.stringify(commands)}`);
    }
  };
  const browser = new FastBrowser({ runner });
  const result = await browser.execute({
    browser_target: 'linux',
    tab: 'ABC',
    actions: [
      { op: 'fill', target: 'e1', value: 'Hamza' },
      { op: 'click', target: 'e2' },
      { op: 'wait', text: 'Application submitted' }
    ]
  });

  assert.equal(result.outcome, 'partial');
  assert.equal(result.failed_at, 2);
  assert.deepEqual(result.steps.map(step => step.status), ['completed', 'completed', 'failed']);
  assert.deepEqual(result.steps[0].result, { filled: '@e1' });
  assert.equal(result.final_state.active_tab, 'ABC');
  assert.equal(result.final_state.origin, 'https://example.test/submitted');
  assert.equal(calls.filter(call => call.commands[0]?.[0] === 'fill').length, 1);
  assert.equal(calls.filter(call => call.commands[0]?.[0] === 'click').length, 1);
  assert.equal(calls.filter(call => call.commands[0]?.[0] === 'wait').length, 1);
});

test('Windows upload paths are translated through wslpath while Linux paths stay local', async () => {
  const calls = [];
  const runner = new AgentBrowserRunner({
    processRunner: async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: '\\\\wsl.localhost\\Ubuntu\\home\\tester\\document.pdf', stderr: '' };
    }
  });
  assert.equal(await runner.pathForTarget('linux', '/home/tester/document.pdf'), '/home/tester/document.pdf');
  assert.equal(await runner.pathForTarget('windows', '/home/tester/document.pdf'), '\\\\wsl.localhost\\Ubuntu\\home\\tester\\document.pdf');
  assert.deepEqual(calls, [{ command: 'wslpath', args: ['-w', '/home/tester/document.pdf'] }]);
});

test('Linux browser backend config defaults to Chrome and rejects Firefox explicitly', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-fast-backend-config-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const configFile = path.join(root, 'browser-fast.json');

  assert.deepEqual(await resolveLinuxBrowserBackend({ configFile }), {
    browser: 'chrome',
    session: 'mcp-browser-fast-linux'
  });

  await fs.writeFile(configFile, JSON.stringify({ version: 1, linux: { browser: 'firefox' } }));
  await assert.rejects(
    resolveLinuxBrowserBackend({ configFile }),
    error => error?.code === 'UNSUPPORTED_BROWSER_BACKEND' && /cannot drive it/.test(error.message)
  );
});

test('Linux runner hot-switches from managed Chrome to a Clearcote CDP session', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-fast-backend-switch-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const configFile = path.join(root, 'browser-fast.json');
  const calls = [];
  const processRunner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: JSON.stringify([{ success: true, result: {} }]), stderr: '' };
  };
  const runner = new AgentBrowserRunner({
    env: {
      AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome',
      AGENT_BROWSER_PROFILE: 'Default'
    },
    processRunner,
    linuxBackendResolve: () => resolveLinuxBrowserBackend({ configFile })
  });

  await fs.writeFile(configFile, JSON.stringify({ version: 1, linux: { browser: 'chrome' } }));
  await runner.linuxBatch([['tab', 'list']]);
  await fs.writeFile(configFile, JSON.stringify({ version: 1, linux: { browser: 'clearcote', cdpPort: 9222 } }));
  await runner.linuxBatch([['tab', 'list']]);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes('mcp-browser-fast-linux'), true);
  assert.equal(calls[0].args.includes('--cdp'), false);
  assert.equal(calls[0].options.env.AGENT_BROWSER_EXECUTABLE_PATH, '/usr/bin/google-chrome');
  assert.equal(calls[1].args.includes('mcp-browser-fast-linux-clearcote-9222'), true);
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf('--cdp'), calls[1].args.indexOf('--cdp') + 2), ['--cdp', '9222']);
  assert.equal(calls[1].options.env.AGENT_BROWSER_EXECUTABLE_PATH, undefined);
  assert.equal(calls[1].options.env.AGENT_BROWSER_PROFILE, undefined);
});

test('Windows Agent Browser runner provisions native runtime and validates tab context before non-bailing actions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-fast-windows-test-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, 'agent-browser-win32-x64.exe');
  const helperSource = path.join(root, 'windows-runner-source.cjs');
  await fs.writeFile(source, 'pinned-binary');
  await fs.writeFile(helperSource, 'helper-source');
  const nativeCalls = [];
  const processRunner = async (command, args, options = {}) => {
    if (command === '/mnt/c/Program Files/nodejs/node.exe') {
      nativeCalls.push({ command, args, options });
      const commands = options.input ? JSON.parse(options.input) : [];
      let inner;
      if (commands.length === 1 && commands[0][0] === 'tab' && commands[0][1] === 'list') {
        inner = {
          code: 0,
          stdout: JSON.stringify([{ success: true, result: { tabs: [
            { active: true, tabId: 't1', targetId: 'TARGET-ABC', title: 'Example', url: 'https://example.test/' }
          ] } }]),
          stderr: ''
        };
      } else {
        inner = {
          code: 1,
          stdout: JSON.stringify([
            { success: true, result: { filled: '@e1' } },
            { success: false, error: 'click failed' }
          ]),
          stderr: ''
        };
      }
      return { code: 0, stdout: JSON.stringify({ ...inner, signal: null }), stderr: '' };
    }
    throw new Error(`unexpected process ${command}`);
  };

  const windowsChromeEnsure = async () => ({
    localAppData: root,
    windowsLocalAppData: 'C:\\Users\\Hamza\\AppData\\Local',
    nodeExecutable: '/mnt/c/Program Files/nodejs/node.exe',
    browserUrl: 'http://127.0.0.1:43111',
    wsEndpoint: 'ws://127.0.0.1:43111/devtools/browser/abc-123',
    profileDir: path.join(root, 'mcp-dev-bridge', 'chrome-profile'),
    windowsProfileDir: 'C:\\Users\\Hamza\\AppData\\Local\\mcp-dev-bridge\\chrome-profile'
  });
  const runner = new AgentBrowserRunner({ processRunner, windowsSource: source, windowsRunnerSource: helperSource, windowsChromeEnsure });
  const result = await runner.batch('windows', [
    ['fill', '@e1', 'Hamza'],
    ['click', '@e2']
  ], { bail: false, tab: 'TARGET-ABC' });

  assert.equal(nativeCalls.length, 2);
  assert.deepEqual(JSON.parse(nativeCalls[0].options.input), [['tab', 'list']]);
  const contextArgs = JSON.parse(nativeCalls[0].args[2]);
  assert.equal(contextArgs.includes('--bail'), true);
  assert.equal(contextArgs.includes('--pin-tab'), true);
  assert.equal(contextArgs.includes('ws://127.0.0.1:43111/devtools/browser/abc-123'), true);
  assert.deepEqual(JSON.parse(nativeCalls[1].options.input), [
    ['fill', '@e1', 'Hamza'],
    ['click', '@e2']
  ]);
  const actionArgs = JSON.parse(nativeCalls[1].args[2]);
  assert.equal(actionArgs.includes('--bail'), false);
  assert.deepEqual(result.items.map(item => item.success), [true, false]);

  const beforeStale = nativeCalls.length;
  const stale = await runner.batch('windows', [['click', '@e2']], { bail: false, tab: 'STALE' });
  assert.match(stale.contextError, /TAB_CONTEXT_MISMATCH/);
  assert.deepEqual(stale.items, []);
  assert.equal(nativeCalls.length, beforeStale + 1);

  const runtimeDir = path.join(root, 'mcp-dev-bridge', 'agent-browser', '0.35.0');
  assert.equal(await fs.readFile(path.join(runtimeDir, 'agent-browser.exe'), 'utf8'), 'pinned-binary');
  assert.equal(await fs.readFile(path.join(runtimeDir, 'windows-runner.cjs'), 'utf8'), 'helper-source');
});

test('browser-fast serializes complete operations per target and carries explicit tab context', async () => {
  const calls = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const runner = {
    async batch(target, commands, options) {
      calls.push({ target, commands, options });
      if (options.tab === 't1') {
        markFirstStarted();
        await firstGate;
      }
      if (commands.length === 1 && commands[0][0] === 'tab' && commands[0][1] === 'list') {
        return {
          exitCode: 0,
          items: [{ success: true, result: { tabs: [{ active: true, tabId: options.tab, targetId: options.tab }] } }]
        };
      }
      return {
        exitCode: 0,
        items: commands.map(command => ({ success: true, result: { command } }))
      };
    }
  };
  const browser = new FastBrowser({ runner });
  const first = browser.execute({
    browser_target: 'linux',
    tab: 't1',
    final_state: 'none',
    actions: [{ op: 'wait', milliseconds: 1 }]
  });
  await firstStarted;
  const second = browser.execute({
    browser_target: 'linux',
    tab: 't2',
    final_state: 'none',
    actions: [{ op: 'wait', milliseconds: 1 }]
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls.map(call => call.options.tab).filter(Boolean), ['t1', 't2']);
});

test('observe explicitly rebinds the current target and attaches bounded site memory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-fast-observe-memory-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'sites', 'example.test'), { recursive: true });
  await fs.writeFile(path.join(root, 'sites', 'example.test', 'application.md'), 'Use the current form state; do not replay an unknown submit.');

  const calls = [];
  const runner = {
    async batch(target, commands, options) {
      calls.push({ target, commands, options });
      if (calls.length === 1) {
        assert.deepEqual(commands, [['tab', 'list']]);
        return {
          exitCode: 0,
          items: [{ success: true, result: { tabs: [
            { active: true, tabId: 't2', targetId: 'TARGET-STABLE-ABC', title: 'Example', url: 'https://example.test/' }
          ] } }]
        };
      }
      if (calls.length === 2) {
        assert.deepEqual(commands, [['tab', 'TARGET-STABLE-ABC']]);
        return { exitCode: 0, items: [{ success: true, result: { tabId: 't2', targetId: 'TARGET-STABLE-ABC' } }] };
      }
      assert.deepEqual(commands[0][0], 'snapshot');
      assert.deepEqual(commands[1], ['tab', 'list']);
      return {
        exitCode: 0,
        items: [
          { success: true, result: { origin: 'https://example.test/', snapshot: '- button "Apply" [ref=e1]', refs: { e1: { role: 'button', name: 'Apply' } } } },
          { success: true, result: { tabs: [
            { active: true, tabId: 't2', targetId: 'TARGET-STABLE-ABC', title: 'Example', url: 'https://example.test/' }
          ] } }
        ]
      };
    }
  };
  const browser = new FastBrowser({ runner, memoryRoot: root });
  const observed = await browser.observe({ browser_target: 'windows' });
  assert.equal(observed.active_tab, 'TARGET-STABLE-ABC');
  assert.equal(observed.tabs[0].tab_id, 'TARGET-STABLE-ABC');
  assert.equal(observed.tabs[0].target_id, 'TARGET-STABLE-ABC');
  assert.equal(observed.memory.host, 'example.test');
  assert.deepEqual(observed.memory.matches.map(item => [item.kind, item.key]), [['site', 'example.test']]);
  assert.match(observed.memory.matches[0].content, /do not replay an unknown submit/);
  assert.equal(calls.length, 3);
});

test('execute follows exactly one target opened by a click before later actions', async () => {
  const calls = [];
  const opener = { active: true, tabId: 't1', targetId: 'OPENER', title: 'Opener', url: 'https://example.test/' };
  const popup = { active: false, tabId: 't2', targetId: 'POPUP', title: 'Popup', url: 'https://example.test/popup' };
  const runner = {
    async batch(target, commands, options) {
      calls.push({ target, commands, options });
      if (commands.length === 2 && commands[0][0] === 'click') {
        return {
          exitCode: 1,
          items: [
            { success: true, result: { clicked: '@e1' } },
            { success: false, error: 'Timed out waiting for Popup Ready' }
          ]
        };
      }
      if (commands.length === 1 && commands[0][0] === 'tab' && commands[0][1] === 'list') {
        const afterClick = calls.some(call => call.commands.length === 1 && call.commands[0][0] === 'click');
        const afterBind = calls.some(call => call.commands.length === 1 && call.commands[0][0] === 'tab' && call.commands[0][1] === 'POPUP');
        return {
          exitCode: 0,
          items: [{ success: true, result: { tabs: afterClick ? [{ ...opener, active: !afterBind }, { ...popup, active: afterBind }] : [opener] } }]
        };
      }
      if (commands.length === 1 && commands[0][0] === 'tab' && commands[0][1] === 'POPUP') {
        return { exitCode: 0, items: [{ success: true, result: { tabId: 't2', targetId: 'POPUP' } }] };
      }
      if (commands.length === 1 && commands[0][0] === 'click') {
        return { exitCode: 0, items: [{ success: true, result: { clicked: '@e1' } }] };
      }
      if (commands.length === 1 && commands[0][0] === 'wait') {
        return { exitCode: 0, items: [{ success: true, result: { text: 'Popup Ready' } }] };
      }
      if (commands.length === 2 && commands[0][0] === 'snapshot') {
        return {
          exitCode: 0,
          items: [
            { success: true, result: { origin: popup.url, snapshot: '- heading "Popup Ready"', refs: {} } },
            { success: true, result: { tabs: [{ ...opener, active: false }, { ...popup, active: true }] } }
          ]
        };
      }
      throw new Error(`unexpected commands: ${JSON.stringify(commands)}`);
    }
  };
  const browser = new FastBrowser({ runner });
  const result = await browser.execute({
    browser_target: 'windows',
    tab: 'OPENER',
    actions: [
      { op: 'click', target: 'e1' },
      { op: 'wait', text: 'Popup Ready' }
    ]
  });

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.steps.map(step => step.status), ['completed', 'completed']);
  assert.equal(result.final_state.active_tab, 'POPUP');
  assert.equal(result.final_state.origin, popup.url);
  assert.equal(calls.some(call => call.commands.length === 1 && call.commands[0][0] === 'tab' && call.commands[0][1] === 'POPUP'), true);
});

test('execute fails closed after a click opens multiple targets without relabeling the click', async () => {
  const calls = [];
  const opener = { active: true, tabId: 't1', targetId: 'OPENER', title: 'Opener', url: 'https://example.test/' };
  const runner = {
    async batch(target, commands, options) {
      calls.push({ target, commands, options });
      if (commands.length === 2 && commands[0][0] === 'click') {
        return {
          exitCode: 0,
          items: [
            { success: true, result: { clicked: '@e1' } },
            { success: true, result: { text: 'should not have run' } }
          ]
        };
      }
      if (commands.length === 1 && commands[0][0] === 'tab' && commands[0][1] === 'list') {
        const afterClick = calls.some(call => call.commands.length === 1 && call.commands[0][0] === 'click');
        return {
          exitCode: 0,
          items: [{ success: true, result: { tabs: afterClick
            ? [opener,
                { active: false, tabId: 't2', targetId: 'POPUP-1', title: 'Popup 1', url: 'https://example.test/1' },
                { active: false, tabId: 't3', targetId: 'POPUP-2', title: 'Popup 2', url: 'https://example.test/2' }]
            : [opener] } }]
        };
      }
      if (commands.length === 1 && commands[0][0] === 'click') {
        return { exitCode: 0, items: [{ success: true, result: { clicked: '@e1' } }] };
      }
      throw new Error(`unexpected commands: ${JSON.stringify(commands)}`);
    }
  };
  const browser = new FastBrowser({ runner });
  const result = await browser.execute({
    browser_target: 'windows',
    tab: 'OPENER',
    final_state: 'none',
    actions: [
      { op: 'click', target: 'e1' },
      { op: 'wait', text: 'Popup Ready' }
    ]
  });

  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.steps.map(step => step.status), ['completed', 'not_run']);
  assert.match(result.transition_error, /multiple new tabs/i);
  assert.equal(calls.some(call => call.commands[0]?.[0] === 'wait'), false);
  assert.equal(calls.some(call => call.commands[0]?.[0] === 'tab' && /^POPUP-/.test(call.commands[0][1])), false);
});

test('uncertain mutating failures are never reported as safe failures', async () => {
  const runner = {
    async batch(_target, commands) {
      if (commands.length === 1 && commands[0][0] === 'tab' && commands[0][1] === 'list') {
        return {
          exitCode: 0,
          items: [{ success: true, result: { tabs: [{ active: true, tabId: 't1', targetId: 'TARGET-STABLE-ABC' }] } }]
        };
      }
      return { exitCode: 1, items: [{ success: false, uncertain: true, error: 'click result lost after dispatch' }] };
    }
  };
  const browser = new FastBrowser({ runner });
  const result = await browser.execute({
    browser_target: 'windows',
    tab: 'TARGET-STABLE-ABC',
    final_state: 'none',
    actions: [{ op: 'click', target: '7_2' }]
  });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.steps[0].status, 'unknown');
});
