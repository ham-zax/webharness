import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [mode, address, stateDir, readPath] = process.argv.slice(2);
let url;
try {
  url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
} catch {
  console.error('Invalid MCP URL.');
  process.exit(2);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => originalFetch(input, {
  ...init,
  redirect: 'error',
  signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
});

if (mode === '--public') {
  try {
    const ready = await fetch(new URL('/health/ready', url));
    const body = await ready.json();
    if (ready.status !== 200 || body?.status !== 'ready') throw new Error();
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
  let temporary;
  let connection;
  try {
    const state = JSON.parse(readFileSync(join(stateDir, 'oauth.json'), 'utf8'));
    if (!state?.tokens?.access_token) {
      console.error('Authenticated mode requires existing OAuth authorization.');
      process.exitCode = 2;
    } else {
      new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(readPath));
      temporary = mkdtempSync(join(tmpdir(), 'webharness-smoke-'));
      copyFileSync(join(stateDir, 'oauth.json'), join(temporary, 'oauth.json'));
      const { connectMcp } = await import('../providers/websession-adapter/mcp-client.mjs');
      connection = await connectMcp({ mcpUrl: url.href, stateDir: temporary, callbackUrl: 'http://127.0.0.1:9/callback', signal: AbortSignal.timeout(5000) });
      const listed = await connection.client.listTools(undefined, { timeout: 5000 });
      if (!listed.tools.some(tool => tool.name === 'dev_read')) throw new Error();
      const result = await connection.client.callTool({ name: 'dev_read', arguments: { path: readPath, offset: 1, limit: 1 } }, { timeout: 5000 });
      if (result.isError === true || !result.content?.some(part => part.type === 'text' && typeof part.text === 'string' && part.text.trim())) throw new Error();
      console.log('Authenticated dev_read succeeded.');
    }
  } catch {
    console.error('Authenticated MCP read failed.');
    process.exitCode = 1;
  } finally {
    await connection?.close();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
} else {
  console.error('Invalid smoke mode.');
  process.exitCode = 2;
}
