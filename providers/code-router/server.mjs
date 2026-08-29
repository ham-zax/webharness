import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CodeDbChild, defaultCodeDbBin, verifyCodeDbBinary } from './codedb-child.mjs';
import { RepoChildPool } from './pool.mjs';
import { resolveRepoRoot } from './repo-root.mjs';

function routerError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export class CodeRouter {
  constructor({ pool, resolveRoot = resolveRepoRoot } = {}) {
    if (!pool) throw new TypeError('pool is required');
    if (typeof resolveRoot !== 'function') throw new TypeError('resolveRoot must be a function');
    this.pool = pool;
    this.resolveRoot = resolveRoot;
    this.closed = false;
  }

  inspect() {
    return this.pool.inspect();
  }

  async pruneInvalidRepositories() {
    for (const { root } of this.pool.inspect()) {
      let resolved = null;
      try { resolved = await this.resolveRoot(root); } catch { /* invalid root */ }
      if (resolved !== root) await this.pool.release(root);
    }
  }

  async call({ cwd, tool, arguments: args = {} } = {}) {
    if (this.closed) throw routerError('ROUTER_CLOSED', 'code router is shut down');
    if (typeof tool !== 'string' || tool.length === 0) throw new TypeError('tool is required');

    let repoRoot;
    try {
      repoRoot = await this.resolveRoot(cwd);
    } catch (error) {
      try { await this.pruneInvalidRepositories(); } catch { /* preserve the discovery error */ }
      throw error;
    }

    const result = await this.pool.call(repoRoot, tool, args);
    return { repoRoot, result };
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.close();
  }
}

export function createCodeFacadeServer({ router, defaultCwd = process.env.HOME || os.homedir() } = {}) {
  if (!router || typeof router.call !== 'function') throw new TypeError('router with call() is required');
  if (typeof defaultCwd !== 'string' || defaultCwd.length === 0) throw new TypeError('defaultCwd must be a non-empty path');

  const server = new McpServer({ name: 'code', version: '0.1.0' });
  const cwd = z.string().min(1).describe('Path inside the intended Git repository. Pass it explicitly for multi-repository work; omission uses the configured Code default cwd and may fail when that path is not inside a Git repository.');
  const modelResult = result => ({
    content: result.content,
    ...(result.isError ? { isError: true } : {})
  });

  server.registerTool('code_search', {
    description: 'Ranked repository-rooted search for exploratory text when the exact symbol is unknown; prefer code_symbol when a symbol or definition name is known or guessable. First use may start a persistent rooted CodeDB child and create or update substantial on-disk index state, consuming significant disk and RAM. For a large or unfamiliar repository with unknown CodeDB state, prefer Dev bash with rg plus focused read before invoking Code automatically.',
    inputSchema: {
      query: z.string().min(1),
      cwd: cwd.optional(),
      limit: z.number().int().positive().max(200).optional().describe('Maximum ranked results')
    }
  }, async args => {
    const searchArgs = { query: args.query, scope: true, compact: true };
    if (args.limit !== undefined) searchArgs.max_results = args.limit;
    const { result } = await router.call({
      cwd: args.cwd ?? defaultCwd,
      tool: 'codedb_search',
      arguments: searchArgs
    });
    return modelResult(result);
  });

  server.registerTool('code_context', {
    description: 'Compact repository-rooted first-touch task orientation with definitions, focused bodies, graph neighbors, ranked files, and snippets; first-touch does not mean always call this first. It uses the same persistent CodeDB child/index lifecycle and can consume significant disk and RAM. For a large or unfamiliar repository with unknown CodeDB state, prefer Dev bash with rg plus focused read unless CodeDB-backed repository intelligence is specifically needed.',
    inputSchema: {
      task: z.string().min(3),
      cwd: cwd.optional(),
      limit: z.number().int().min(256).max(4000).optional().describe('Approximate output-token budget')
    }
  }, async args => {
    const contextArgs = { task: args.task, detail: 'compact' };
    if (args.limit !== undefined) contextArgs.max_tokens = args.limit;
    const { result } = await router.call({
      cwd: args.cwd ?? defaultCwd,
      tool: 'codedb_context',
      arguments: contextArgs
    });
    return modelResult(result);
  });

  server.registerTool('code_symbol', {
    description: 'Locate a known or guessed symbol definition in the Git repository containing cwd; prefer this over code_search when the symbol name is known. It shares the same persistent CodeDB child/index lifecycle, so first use can consume significant disk and RAM. For a large or unfamiliar repository with unknown CodeDB state, prefer Dev bash with rg plus focused read before invoking Code automatically.',
    inputSchema: {
      name: z.string().min(1),
      cwd: cwd.optional()
    }
  }, async args => {
    const { result } = await router.call({
      cwd: args.cwd ?? defaultCwd,
      tool: 'codedb_symbol',
      arguments: { name: args.name, body: false }
    });
    return modelResult(result);
  });

  return server;
}

export async function createCodeRouter({ bin = defaultCodeDbBin(), maxActive = 4 } = {}) {
  const verified = await verifyCodeDbBinary(bin);
  return new CodeRouter({
    pool: new RepoChildPool({
      maxActive,
      childFactory: root => CodeDbChild.start({ root, bin: verified.path })
    })
  });
}

export async function runCodeFacadeStdio({
  bin = defaultCodeDbBin(),
  maxActive = 4,
  defaultCwd = process.env.MCP_CODE_DEFAULT_CWD || process.env.HOME || os.homedir()
} = {}) {
  const router = await createCodeRouter({ bin, maxActive });
  const server = createCodeFacadeServer({ router, defaultCwd });
  const transport = new StdioServerTransport();
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await router.shutdown();
      await server.close();
    })();
    return shutdownPromise;
  };

  await server.connect(transport);
  const serverClose = transport.onclose;
  transport.onclose = () => {
    serverClose?.();
    void shutdown();
  };

  return { router, server, transport, shutdown };
}

async function main() {
  const runtime = await runCodeFacadeStdio();
  let exitStarted = false;

  process.stdin.once('end', () => {
    void runtime.shutdown();
  });

  const shutdownAndExit = () => {
    if (exitStarted) return;
    exitStarted = true;
    void runtime.shutdown().then(
      () => process.exit(0),
      error => {
        process.stderr.write(`Code facade shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    );
  };

  process.once('SIGTERM', shutdownAndExit);
  process.once('SIGINT', shutdownAndExit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
