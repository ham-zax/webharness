#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { AgentBrokerClient } from './rpc-client.mjs';

const SESSION_KEY = 'openai/session';

function defaultSocketPath() {
  if (process.env.MCP_AGENT_SOCKET) return process.env.MCP_AGENT_SOCKET;
  if (process.env.XDG_RUNTIME_DIR) return `${process.env.XDG_RUNTIME_DIR}/wsl-agent-agents.sock`;
  if (typeof process.getuid === 'function') return `/run/user/${process.getuid()}/wsl-agent-agents.sock`;
  throw new Error('MCP_AGENT_SOCKET or XDG_RUNTIME_DIR is required');
}

function cleanSession(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

function resultText(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function errorResult(code, message) {
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { status: 'error', code },
  };
}

function renderBrokerResult(result) {
  if (result?.kind === 'binding_required') {
    return {
      content: [{
        type: 'text',
        text: `AGENT_BINDING_REQUIRED: the WebHarness Agents extension must bind this ChatGPT session.\nWEBHARNESS_AGENT_BIND:${result.marker}\nRetry the same agents action after binding completes.`,
      }],
    };
  }
  if (result?.kind === 'error') return errorResult(result.code || 'AGENT_ERROR', result.message || 'Agents request failed');
  if (result?.kind === 'status') {
    return resultText(`AGENTS_STATUS: role=${result.role}; workers=${Array.isArray(result.workers) ? result.workers.length : 0}`, result);
  }
  if (result?.kind === 'spawned') {
    const names = Array.isArray(result.workers) ? result.workers.map((worker) => worker.agent) : [];
    return resultText(`AGENT_SPAWN_STAGED: ${names.join(', ')}; waiting for the extension to ACK the worker conversations.`, result);
  }
  if (result?.kind === 'messaged') {
    return resultText(`AGENT_MESSAGES_QUEUED: ${result.queued}; waking=${result.waking?.join(',') || 'none'}`, result);
  }
  if (result?.kind === 'finished') {
    return resultText(`AGENT_FINISHED: ${result.worker.agent}; worker is sleeping and its conversation is retained.`, result);
  }
  return errorResult('AGENT_BROKER_INVALID_RESPONSE', 'Agent Broker returned an unsupported response');
}

export function createAgentsMcpServer({ client } = {}) {
  if (!client || typeof client.request !== 'function') throw new TypeError('client with request() is required');

  const task = z.object({
    task: z.string().min(1).max(8000),
    label: z.string().min(1).max(80).optional(),
  }).strict();
  const message = z.object({
    to: z.string().min(1).max(128),
    text: z.string().min(1).max(8000),
  }).strict();
  const agentId = z.string().min(1).max(128);
  const actionInputSchema = z.discriminatedUnion('action', [
    z.object({
      action: z.literal('spawn'),
      tasks: z.array(task).min(1).max(8),
      context: z.string().max(8000).optional(),
    }).strict(),
    z.object({
      action: z.literal('message'),
      messages: z.array(message).min(1).max(16),
    }).strict(),
    z.object({
      action: z.literal('status'),
      agents: z.array(agentId).min(1).max(8).optional(),
    }).strict(),
    z.object({
      action: z.literal('finish'),
      result: z.string().min(1).max(16000),
    }).strict(),
  ]);
  const inputSchema = z.object({
    action: z.enum(['spawn', 'message', 'status', 'finish']),
    tasks: z.array(task).min(1).max(8).optional(),
    context: z.string().max(8000).optional(),
    messages: z.array(message).min(1).max(16).optional(),
    agents: z.array(agentId).min(1).max(8).optional(),
    result: z.string().min(1).max(16000).optional(),
  }).strict();

  const server = new McpServer({ name: 'agents', version: '0.1.0' });
  server.registerTool('agents', {
    description: 'Coordinate parallel ChatGPT worker conversations through the WebHarness Agent Broker. Spawn 1..8 workers, message workers or prime, inspect role-appropriate state, or finish the current worker. Caller identity comes only from ChatGPT openai/session metadata; browser conversation IDs and credentials are never model arguments.',
    inputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (args, extra) => {
    const parsed = actionInputSchema.safeParse(args);
    if (!parsed.success) return errorResult('AGENT_INVALID_ARGUMENTS', parsed.error.issues[0]?.message || 'invalid agents arguments');
    const session = cleanSession(extra?._meta?.[SESSION_KEY]);
    if (!session) return errorResult('AGENT_IDENTITY_UNAVAILABLE', 'connector did not provide a valid openai/session value');
    try {
      const result = await client.request('agents_call', { session, input: parsed.data });
      return renderBrokerResult(result);
    } catch (error) {
      return errorResult(
        typeof error?.code === 'string' ? error.code : 'AGENT_ERROR',
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  return server;
}

export async function runAgentsMcpStdio({ socketPath = defaultSocketPath() } = {}) {
  const client = new AgentBrokerClient({ socketPath });
  const server = createAgentsMcpServer({ client });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}

async function main() {
  const runtime = await runAgentsMcpStdio();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await runtime.server.close();
  };
  process.stdin.once('end', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Agents MCP failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
