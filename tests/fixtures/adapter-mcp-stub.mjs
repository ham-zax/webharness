import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const adapterRequire = createRequire(new URL('../../providers/websession-adapter/package.json', import.meta.url));
const { Server, createMcpHandler } = adapterRequire('@modelcontextprotocol/server');

const pattern = 'héllo🌍\n';
const size = 100 * 1024;
const repeated = pattern.repeat(Math.floor((size - 1) / Buffer.byteLength(pattern)));
export const BIG_RESULT = `${repeated}${'x'.repeat(size - 1 - Buffer.byteLength(repeated))}\n`;

const tools = [
  { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'sleep', inputSchema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] } },
  { name: 'big', inputSchema: { type: 'object', properties: {} } },
  { name: 'mixed', inputSchema: { type: 'object', properties: {} } },
];

export function createStubServer() {
  const server = new Server({ name: 'adapter-test-stub', version: '1' }, {
    capabilities: { tools: {} }, instructions: 'Adapter integration test instructions.',
  });
  server.setRequestHandler('tools/list', () => ({ tools }));
  server.setRequestHandler('tools/call', async ({ params }) => {
    const args = params.arguments || {};
    switch (params.name) {
      case 'echo': return { content: [{ type: 'text', text: args.text }] };
      case 'sleep':
        await new Promise(resolve => setTimeout(resolve, args.seconds * 1000));
        return { content: [{ type: 'text', text: 'slept' }] };
      case 'big': return { content: [{ type: 'text', text: BIG_RESULT }] };
      case 'mixed': return { content: [
        { type: 'text', text: 'mixed text' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ] };
      default: throw new Error('unknown test tool');
    }
  });
  return server;
}

async function toRequest(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach(entry => headers.append(name, entry));
    else headers.set(name, value);
  }
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    init.body = Buffer.concat(chunks);
  }
  return new Request(new URL(req.url ?? '/', 'http://127.0.0.1'), init);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Modern 2026-07-28 serving through createMcpHandler, so the adapter probe
  // exercises the same stateless HTTP era as 1MCP 0.39.8.
  const handler = createMcpHandler(createStubServer, { onerror: error => console.error(error) });
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    try {
      const response = await handler.fetch(await toRequest(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    }
  });
  httpServer.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(httpServer.address().port)));
}
