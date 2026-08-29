import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RepoChildPool } from '../pool.mjs';
import * as serverModule from '../server.mjs';

const { CodeRouter } = serverModule;

const execFileAsync = promisify(execFile);

test('code facade defaults omitted cwd to the current user home', async t => {
  const previousHome = process.env.HOME;
  process.env.HOME = '/tmp/wsl-portable-code-home';
  const calls = [];
  const router = {
    async call(call) {
      calls.push(call);
      return { repoRoot: '/repo', result: { content: [{ type: 'text', text: 'symbol' }] } };
    }
  };
  const server = serverModule.createCodeFacadeServer({ router });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'code-facade-default-home-test', version: '1.0.0' });
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await client.close();
    await server.close();
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.callTool({ name: 'code_symbol', arguments: { name: 'Demo' } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/tmp/wsl-portable-code-home');
});

async function gitRepo(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['-C', root, 'init', '-q']);
  return fs.realpath(root);
}

function recordingFactory() {
  let next = 0;
  const children = [];
  const factory = async root => {
    const id = ++next;
    let alive = true;
    const child = {
      root,
      pid: 20000 + id,
      get alive() { return alive; },
      async callTool(name, args) { return { id, root, name, args }; },
      async close() { alive = false; }
    };
    children.push(child);
    return child;
  };
  return { factory, children };
}

test('winning model-facing facade exposes only code_search, code_context, and code_symbol', async t => {
  assert.equal(typeof serverModule.createCodeFacadeServer, 'function');

  const router = {
    async call() {
      return { repoRoot: '/repo', result: { content: [{ type: 'text', text: 'unused' }] } };
    }
  };
  const server = serverModule.createCodeFacadeServer({ router, defaultCwd: '/tmp' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'code-facade-catalog-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map(tool => tool.name).sort(), ['code_context', 'code_search', 'code_symbol']);
  assert.ok(tools.every(tool => !tool.name.startsWith('codedb_')));
  assert.ok(tools.every(tool => tool.name !== 'code'));

  const search = tools.find(tool => tool.name === 'code_search');
  const context = tools.find(tool => tool.name === 'code_context');
  const symbol = tools.find(tool => tool.name === 'code_symbol');
  for (const tool of [search, context, symbol]) {
    assert.match(tool.description, /persistent.*CodeDB|CodeDB.*persistent/i);
    assert.match(tool.description, /disk.*RAM|RAM.*disk/i);
    assert.match(tool.description, /large.*unfamiliar|unfamiliar.*large/i);
    assert.match(tool.description, /bash.*rg.*read|rg.*read/i);
    assert.match(tool.inputSchema.properties.cwd.description, /intended Git repository/i);
    assert.match(tool.inputSchema.properties.cwd.description, /pass.*explicit/i);
  }
  assert.match(search.description, /prefer.*code_symbol|code_symbol.*prefer/i);
  assert.match(context.description, /first.touch/i);
  assert.match(context.description, /not.*always|do not.*automatically/i);
  assert.match(symbol.description, /known|guessed/i);
});

test('code_search maps one native request to rooted codedb_search and returns lean TextContent', async t => {
  const calls = [];
  const router = {
    async call(call) {
      calls.push(call);
      return {
        repoRoot: '/repo',
        result: { content: [{ type: 'text', text: "1 results for 'needle':\n  src/search.ts:7: needle" }] }
      };
    }
  };
  const server = serverModule.createCodeFacadeServer({ router, defaultCwd: '/tmp' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'code-facade-search-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: 'code_search',
    arguments: { query: 'needle', cwd: '/repo/src', limit: 7 }
  });

  assert.deepEqual(calls, [{
    cwd: '/repo/src',
    tool: 'codedb_search',
    arguments: { query: 'needle', scope: true, compact: true, max_results: 7 }
  }]);
  assert.deepEqual(result.content, [{ type: 'text', text: "1 results for 'needle':\n  src/search.ts:7: needle" }]);
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.isError, undefined);
});

test('code_context uses the configured default cwd and maps limit to a compact CodeDB token budget', async t => {
  const calls = [];
  const router = {
    async call(call) {
      calls.push(call);
      return {
        repoRoot: '/repo',
        result: { content: [{ type: 'text', text: '# Task\ncompact context' }] }
      };
    }
  };
  const server = serverModule.createCodeFacadeServer({ router, defaultCwd: '/repo' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'code-facade-context-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: 'code_context',
    arguments: { task: 'Prepare a bounded change context', limit: 1200 }
  });

  assert.deepEqual(calls, [{
    cwd: '/repo',
    tool: 'codedb_context',
    arguments: { task: 'Prepare a bounded change context', detail: 'compact', max_tokens: 1200 }
  }]);
  assert.deepEqual(result.content, [{ type: 'text', text: '# Task\ncompact context' }]);
});

test('code_symbol maps a known definition lookup without exposing project switching', async t => {
  const calls = [];
  const router = {
    async call(call) {
      calls.push(call);
      return {
        repoRoot: '/repo',
        result: { content: [{ type: 'text', text: "1 results for 'Thing':\n  src/thing.ts:4 Thing" }] }
      };
    }
  };
  const server = serverModule.createCodeFacadeServer({ router, defaultCwd: '/tmp' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'code-facade-symbol-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: 'code_symbol',
    arguments: { name: 'Thing', cwd: '/repo/src' }
  });

  assert.deepEqual(calls, [{
    cwd: '/repo/src',
    tool: 'codedb_symbol',
    arguments: { name: 'Thing', body: false }
  }]);
  assert.deepEqual(result.content, [{ type: 'text', text: "1 results for 'Thing':\n  src/thing.ts:4 Thing" }]);
  assert.equal(Object.hasOwn(calls[0].arguments, 'project'), false);
});

test('model-facing facade preserves CodeDB isError results as native TextContent failures', async t => {
  const router = {
    async call() {
      return {
        repoRoot: '/repo',
        result: {
          isError: true,
          content: [{ type: 'text', text: 'CODEDB_BACKEND_FAILURE: ranked search unavailable' }]
        }
      };
    }
  };
  const server = serverModule.createCodeFacadeServer({ router, defaultCwd: '/repo' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'code-facade-error-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({ name: 'code_search', arguments: { query: 'needle' } });

  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: 'CODEDB_BACKEND_FAILURE: ranked search unavailable' }]);
  assert.equal(result.structuredContent, undefined);
});

test('server.mjs stdio entrypoint exposes only the winning Code facade catalog', async t => {
  const serverPath = path.resolve('server.mjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, MCP_CODE_DEFAULT_CWD: '/tmp' },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'code-facade-stdio-test', version: '1.0.0' });
  t.after(() => client.close());

  await client.connect(transport);
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map(tool => tool.name).sort(), ['code_context', 'code_search', 'code_symbol']);
});

test('routes nested cwd calls to one canonical rooted child and returns the chosen root', async t => {
  const root = await gitRepo(t, 'code-router-server-');
  const one = path.join(root, 'src', 'one');
  const two = path.join(root, 'src', 'two');
  await fs.mkdir(one, { recursive: true });
  await fs.mkdir(two, { recursive: true });
  const { factory, children } = recordingFactory();
  const pool = new RepoChildPool({ childFactory: factory });
  const router = new CodeRouter({ pool });
  t.after(() => router.shutdown());

  const first = await router.call({ cwd: one, tool: 'codedb_status', arguments: {} });
  const second = await router.call({ cwd: two, tool: 'codedb_search', arguments: { query: 'x' } });

  assert.equal(first.repoRoot, root);
  assert.equal(second.repoRoot, root);
  assert.equal(first.result.id, second.result.id);
  assert.equal(children.length, 1);
});

test('routes different repositories to independent children', async t => {
  const rootA = await gitRepo(t, 'code-router-server-a-');
  const rootB = await gitRepo(t, 'code-router-server-b-');
  const { factory } = recordingFactory();
  const pool = new RepoChildPool({ childFactory: factory });
  const router = new CodeRouter({ pool });
  t.after(() => router.shutdown());

  const [a, b] = await Promise.all([
    router.call({ cwd: rootA, tool: 'codedb_status', arguments: {} }),
    router.call({ cwd: rootB, tool: 'codedb_status', arguments: {} })
  ]);

  assert.notEqual(a.result.id, b.result.id);
  assert.equal(router.inspect().length, 2);
});

test('outside a Git repository preserves explicit NO_REPOSITORY', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'code-router-server-none-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const { factory } = recordingFactory();
  const router = new CodeRouter({ pool: new RepoChildPool({ childFactory: factory }) });
  t.after(() => router.shutdown());

  await assert.rejects(
    () => router.call({ cwd, tool: 'codedb_status', arguments: {} }),
    error => error.code === 'NO_REPOSITORY'
  );
  assert.equal(router.inspect().length, 0);
});

test('failed root discovery prunes an already-active repository that disappeared', async t => {
  const root = await gitRepo(t, 'code-router-server-gone-');
  const { factory, children } = recordingFactory();
  const pool = new RepoChildPool({ childFactory: factory });
  const router = new CodeRouter({ pool });
  t.after(() => router.shutdown());

  await router.call({ cwd: root, tool: 'codedb_status', arguments: {} });
  assert.equal(router.inspect().length, 1);
  await fs.rm(root, { recursive: true, force: true });

  await assert.rejects(() => router.call({ cwd: root, tool: 'codedb_status', arguments: {} }));
  assert.equal(router.inspect().length, 0);
  assert.equal(children[0].alive, false);
});

test('losing Git repository identity reaps the rooted child even when the directory survives', async t => {
  const root = await gitRepo(t, 'code-router-server-no-git-');
  const { factory, children } = recordingFactory();
  const pool = new RepoChildPool({ childFactory: factory });
  const router = new CodeRouter({ pool });
  t.after(() => router.shutdown());

  await router.call({ cwd: root, tool: 'codedb_status', arguments: {} });
  await fs.rm(path.join(root, '.git'), { recursive: true, force: true });

  await assert.rejects(
    () => router.call({ cwd: root, tool: 'codedb_status', arguments: {} }),
    error => error.code === 'NO_REPOSITORY'
  );
  assert.equal(router.inspect().length, 0);
  assert.equal(children[0].alive, false);
});

test('shutdown closes the pool and rejects later routed work', async t => {
  const root = await gitRepo(t, 'code-router-server-close-');
  const { factory, children } = recordingFactory();
  const router = new CodeRouter({ pool: new RepoChildPool({ childFactory: factory }) });

  await router.call({ cwd: root, tool: 'codedb_status', arguments: {} });
  await router.shutdown();

  assert.equal(children[0].alive, false);
  assert.equal(router.inspect().length, 0);
  await assert.rejects(
    () => router.call({ cwd: root, tool: 'codedb_status', arguments: {} }),
    error => error.code === 'ROUTER_CLOSED'
  );
});
