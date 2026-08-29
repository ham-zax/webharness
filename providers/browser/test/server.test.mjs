import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRouter, addBrowserTarget, childConfig } from '../server.mjs';

test('browser facade adds locality and deployment path guidance without changing unrelated upstream metadata', () => {
  const upstream = {
    name: 'take_screenshot',
    description: 'Capture a screenshot',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'] },
        filePath: { type: 'string', description: 'Path to save the screenshot to.' }
      },
      required: ['format']
    },
    annotations: { readOnlyHint: true }
  };

  const tool = addBrowserTarget(upstream);
  assert.equal(tool.name, upstream.name);
  assert.equal(tool.description, upstream.description);
  assert.deepEqual(tool.annotations, upstream.annotations);
  assert.deepEqual(tool.inputSchema.required, ['format']);
  assert.deepEqual(tool.inputSchema.properties.format, upstream.inputSchema.properties.format);
  assert.match(tool.inputSchema.properties.filePath.description, /selected target.*OS temporary directory/i);
  assert.deepEqual(tool.inputSchema.properties.browser_target.enum, ['windows', 'linux']);
  assert.equal(upstream.inputSchema.properties.browser_target, undefined);
  assert.equal(upstream.inputSchema.properties.filePath.description, 'Path to save the screenshot to.');
});

test('browser router defaults to Windows, supports explicit Linux, and forwards native results unchanged', async () => {
  const calls = [];
  const imageResult = {
    content: [{ type: 'image', data: 'cG5n', mimeType: 'image/png' }],
    structuredContent: { source: 'native' }
  };
  const children = new Map();
  const childFactory = async target => {
    const child = {
      alive: true,
      async listTools() {
        return { tools: [{ name: 'take_screenshot', inputSchema: { type: 'object', properties: {} } }] };
      },
      async callTool(name, args) {
        calls.push({ target, name, args });
        return imageResult;
      },
      async close() { this.alive = false; }
    };
    children.set(target, child);
    return child;
  };

  const router = new BrowserRouter({ childFactory });
  const tools = await router.listTools();
  assert.deepEqual(tools[0].inputSchema.properties.browser_target.enum, ['windows', 'linux']);

  const windowsResult = await router.call({ tool: 'take_screenshot', arguments: { format: 'png' } });
  assert.strictEqual(windowsResult, imageResult);
  assert.deepEqual(calls.at(-1), { target: 'windows', name: 'take_screenshot', args: { format: 'png' } });

  const linuxResult = await router.call({
    tool: 'take_screenshot',
    arguments: { format: 'png', browser_target: 'linux' }
  });
  assert.strictEqual(linuxResult, imageResult);
  assert.deepEqual(calls.at(-1), { target: 'linux', name: 'take_screenshot', args: { format: 'png' } });

  await router.shutdown();
  assert.equal(children.get('windows').alive, false);
  assert.equal(children.get('linux').alive, false);
});

test('shutdown wins while a dead child is being replaced', async () => {
  let releaseClose;
  let markCloseStarted;
  const closeStarted = new Promise(resolve => { markCloseStarted = resolve; });
  const closeRelease = new Promise(resolve => { releaseClose = resolve; });
  const stale = {
    alive: false,
    async close() {
      markCloseStarted();
      await closeRelease;
    }
  };
  let replacementStarts = 0;
  const router = new BrowserRouter({
    childFactory: async () => {
      replacementStarts += 1;
      return { alive: true, async close() { this.alive = false; } };
    }
  });
  router.children.set('linux', stale);

  const replacement = router.child('linux');
  await closeStarted;
  const shutdown = router.shutdown();
  releaseClose();

  await shutdown;
  await assert.rejects(replacement, /BROWSER_ROUTER_CLOSED/);
  assert.equal(replacementStarts, 0);
  assert.equal(router.children.size, 0);
});

test('child configs keep Linux and Windows execution resource-local', () => {
  const env = {
    XDG_RUNTIME_DIR: '/run/user/1000',
    WAYLAND_DISPLAY: 'wayland-0',
    DISPLAY: ':0',
    PULSE_SERVER: 'unix:/mnt/wslg/PulseServer'
  };
  const linux = childConfig('linux', env);
  assert.equal(linux.command, 'npx');
  assert.deepEqual(linux.env, env);
  assert.ok(linux.args.includes('chrome-devtools-mcp@1.7.0'));

  assert.throws(() => childConfig('windows', env), /WINDOWS_BROWSER_URL_REQUIRED/);
  const windows = childConfig('windows', env, [], { browserUrl: 'http://127.0.0.1:43111' });
  assert.equal(windows.command, '/mnt/c/Windows/System32/cmd.exe');
  assert.equal(windows.cwd, '/mnt/c');
  assert.equal(windows.args.includes('--autoConnect'), false);
  assert.equal(windows.args.includes('--user-data-dir=%LOCALAPPDATA%\\Google\\Chrome\\User Data'), false);
  assert.deepEqual(windows.args.slice(windows.args.indexOf('--browserUrl'), windows.args.indexOf('--browserUrl') + 2), ['--browserUrl', 'http://127.0.0.1:43111']);

  const routed = childConfig('windows', env, ['--experimentalPageIdRouting'], { browserUrl: 'http://127.0.0.1:43111' });
  assert.ok(routed.args.includes('--experimentalPageIdRouting'));
  assert.equal(windows.args.includes('--experimentalPageIdRouting'), false);
});
