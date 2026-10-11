// Cleanup for the implicit blank page that agent-browser creates when
// attaching a NEW pinned session to an EXTERNAL Chromium CDP endpoint.
// Never close a page merely because its URL is blank; ownership is proved by
// the session's own first active target ID and a before/after CDP inventory.
const TARGET_ID = /^[a-f0-9]{32}$/i;

export async function readExternalCdpPages(port, { fetchImpl = fetch } = {}) {
  if (!/^\d{2,5}$/.test(String(port)) || +port > 65535) throw Error('Invalid external Chrome CDP port');
  const root = `http://127.0.0.1:${port}`;
  const [version, tabs] = await Promise.all(['/json/version', '/json/list'].map(async uri => {
    const response = await fetchImpl(root + uri, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw Error('External CDP inventory unavailable');
    return response.json();
  }));
  const websocket = String(version.webSocketDebuggerUrl || '');
  if (!websocket.startsWith(`ws://127.0.0.1:${port}/devtools/browser/`) || !Array.isArray(tabs)) {
    throw Error('External CDP endpoint identity changed');
  }
  return { websocket, pages: new Map(tabs.filter(t => t.type === 'page' && TARGET_ID.test(String(t.id || '')))
    .map(t => [t.id, String(t.url || '')])) };
}

export function ownedBootstrapPage({ before, after, activeTargetId, selectedTargetId }) {
  if (!TARGET_ID.test(String(selectedTargetId || '')) || !before.pages.has(selectedTargetId)) {
    throw Error('Requested browser tab was not in the pre-session inventory');
  }
  if (after.websocket !== before.websocket) throw Error('External Chrome restarted during session bootstrap');
  const added = [...after.pages].filter(([id]) => !before.pages.has(id));
  if (added.length === 0) return null; // Reattached to a pre-existing session, not a new allocation.
  if (added.length !== 1 || added[0][0] !== activeTargetId || added[0][1] !== 'about:blank') {
    throw Error('New pinned Agent Browser page ownership is ambiguous');
  }
  return activeTargetId;
}

export async function closeExternalOwnedPage(websocket, targetId, { WebSocketImpl = WebSocket } = {}) {
  if (!TARGET_ID.test(targetId)) throw Error('Invalid owned tab identity');
  const endpoint = new URL(websocket);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1'
      || !endpoint.port || !endpoint.pathname.startsWith('/devtools/browser/')) {
    throw Error('Unsafe external browser websocket endpoint');
  }
  await new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(endpoint.href);
    let ended = false;
    const timeout = setTimeout(() => finish(new Error('Exact tab cleanup timed out')), 3500);
    const finish = error => {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      socket.close();
      error ? reject(error) : resolve();
    };
    socket.addEventListener('open', () => {
      try { socket.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId } })); }
      catch { finish(new Error('CDP cleanup dispatch failed')); }
    });
    socket.addEventListener('message', event => {
      let response;
      try { response = JSON.parse(String(event.data || '')); } catch { return; }
      if (response.id !== 1) return;
      finish(response.error || response.result?.success !== true ? new Error('Chrome did not confirm exact page closure') : null);
    });
    socket.addEventListener('close', () => finish(new Error('CDP disconnected during exact page cleanup')));
    socket.addEventListener('error', () => finish(new Error('CDP exact page cleanup connection failed')));
  });
}
