const DEFAULT_TIMEOUT_MS = 5000;

function loopbackUrl(value, protocols) {
  const url = new URL(value);
  if (
    !protocols.includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !url.port
    || url.username
    || url.password
  ) {
    throw new Error('browser endpoint must be a credential-free loopback URL with an explicit port');
  }
  return url;
}

// Read Chromium's opener relationship without selecting or mutating a tab.
export async function readTargetInfo(endpoint, targetId, {
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  let url = loopbackUrl(endpoint, ['http:', 'https:', 'ws:', 'wss:']);
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    const response = await fetchImpl(new URL('/json/version', url), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error('browser endpoint discovery failed');
    url = loopbackUrl((await response.json()).webSocketDebuggerUrl, ['ws:', 'wss:']);
  }

  return await new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url.href);
    let settled = false;
    const finish = (error, info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      // Keep the error listener until close, including a timeout during connect.
      socket.addEventListener('close', () => socket.removeEventListener('error', onError), { once: true });
      socket.close();
      if (error) reject(error);
      else resolve(info);
    };
    const onOpen = () => {
      try {
        socket.send(JSON.stringify({ id: 1, method: 'Target.getTargetInfo', params: { targetId } }));
      } catch {
        finish(new Error('browser target request failed'));
      }
    };
    const onMessage = event => {
      let response;
      try { response = JSON.parse(event.data); } catch { return finish(new Error('invalid browser target response')); }
      if (!response || typeof response !== 'object' || Array.isArray(response)) return finish(new Error('invalid browser target response'));
      if (response.id !== 1) return;
      const info = response.result?.targetInfo;
      if (response.error || info?.targetId !== targetId || info.type !== 'page') {
        finish(new Error('browser target ownership is unavailable'));
      } else {
        finish(null, info);
      }
    };
    const onError = () => finish(new Error('browser target connection failed'));
    const onClose = () => finish(new Error('browser target connection closed before responding'));
    const timer = setTimeout(() => finish(new Error('browser target lookup timed out')), timeoutMs);
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}
