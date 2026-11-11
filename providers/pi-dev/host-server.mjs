#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createStdioErrorReporter } from './stdio-diagnostics.mjs';

import { runWindowsSleep } from './windows-power.mjs';

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  };
}

function createHostServer() {
  const server = new McpServer({ name: 'host', version: '0.1.0' });
  server.registerTool('pc_sleep', {
    title: 'Sleep Windows PC',
    description: 'Put the Windows host into sleep after a 10-second grace period. Optionally schedule one Windows Task Scheduler wake time first. This Personal Workstation action requires confirm=true from a direct user request. wake_at must be an ISO 8601 timestamp with Z or an explicit UTC offset and must be at least two minutes in the future. Omitting wake_at clears the previous MCP wake task before sleeping.',
    inputSchema: z.object({
      confirm: z.literal(true).describe('Must be true only after the user directly requests that the PC sleep'),
      wake_at: z.string().min(1).optional().describe('Optional ISO 8601 wake timestamp ending in Z or an explicit UTC offset'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (args, ctx) => {
    try {
      const signal = AbortSignal.any([ctx.mcpReq.signal, shutdownController.signal]);
      const text = await runWindowsSleep({ wakeAt: args.wake_at, signal });
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}

const shutdownController = new AbortController();
const handle = serveStdio(createHostServer, {
  onerror: createStdioErrorReporter('host'),
});
let closing = null;
const shutdown = () => {
  if (closing) return closing;
  closing = (async () => {
    shutdownController.abort();
    await handle.close();
  })();
  return closing;
};
process.stdin.once('end', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
