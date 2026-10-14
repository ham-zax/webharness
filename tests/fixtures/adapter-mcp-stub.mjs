import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Server } from '../../providers/websession-adapter/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { StreamableHTTPServerTransport } from '../../providers/websession-adapter/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '../../providers/websession-adapter/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const httpServer = createServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const server = new Server({ name: 'adapter-test-stub', version: '1' }, {
      capabilities: { tools: {} }, instructions: 'Adapter integration test instructions.',
    });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
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
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  httpServer.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(httpServer.address().port)));
}
