import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, address, stateDir, readPath] = process.argv.slice(2);
let url;
try {
  url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
} catch {
  console.error('Invalid MCP URL.');
  process.exit(2);
}

const SMOKE_TIMEOUT_MS = 30_000;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => originalFetch(input, {
  ...init,
  redirect: 'error',
  signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(SMOKE_TIMEOUT_MS)]) : AbortSignal.timeout(SMOKE_TIMEOUT_MS),
});

if (mode === '--public') {
  try {
    const ready = await fetch(new URL('/health/ready', url));
    const body = await ready.json();
    if (ready.status !== 200 || (body?.status !== 'ready' && body?.status !== 'available')) throw new Error();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }),
    });
    if (response.status !== 401 || !/\bBearer\s+\S/i.test(response.headers.get('www-authenticate') ?? '')) throw new Error();
    console.log('Readiness and unauthenticated Bearer refusal passed. Authorized tool access is not proven.');
  } catch {
    console.error('Readiness or unauthenticated Bearer refusal failed.');
    process.exitCode = 1;
  }
} else if (mode === '--auth') {
  let client;
  let transport;
  try {
    const state = JSON.parse(readFileSync(join(stateDir, 'oauth.json'), 'utf8'));
    const accessToken = typeof state?.tokens?.access_token === 'string' ? state.tokens.access_token.trim() : '';
    if (!accessToken) {
      console.error('Authenticated mode requires existing OAuth authorization.');
      process.exitCode = 2;
    } else {
      new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(readPath));
      const adapterRequire = createRequire(new URL('../providers/websession-adapter/package.json', import.meta.url));
      const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(adapterRequire.resolve('@modelcontextprotocol/client')).href);
      // Never supply an authProvider or refresh_token here: rotating a refresh
      // grant inside a non-persisted probe would invalidate the live oauth.json.
      transport = new StreamableHTTPClientTransport(new URL(url.href), {
        requestInit: {
          headers: {
            authorization: `Bearer ${accessToken}`,
            'user-agent': 'websession-smoke/1',
          },
        },
      });
      client = new Client(
        { name: 'websession-smoke', version: '0.1.0' },
        { capabilities: {}, versionNegotiation: { mode: 'auto' } },
      );
      await client.connect(transport, { signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS) });
      const listed = await client.listTools(undefined, { timeout: SMOKE_TIMEOUT_MS });
      if (!listed.tools.some(tool => tool.name === 'dev_read')) throw new Error();
      const result = await client.callTool({ name: 'dev_read', arguments: { path: readPath, offset: 1, limit: 1 } }, { timeout: SMOKE_TIMEOUT_MS });
      if (result.isError === true || !result.content?.some(part => part.type === 'text' && typeof part.text === 'string' && part.text.trim())) throw new Error();
      console.log('Authenticated dev_read succeeded.');
    }
  } catch {
    console.error('Authenticated MCP read failed.');
    process.exitCode = 1;
  } finally {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
  }
} else {
  console.error('Invalid smoke mode.');
  process.exitCode = 2;
}
