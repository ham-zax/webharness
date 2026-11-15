import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createHttpDiagnosticLog } from './http-diagnostics.mjs';

export const TRACE_BODY_LIMIT = 64 * 1024;
const MAX_WINDOW_MS = 3600_000;
const sensitive = /authorization|cookie|token|secret|password|passwd|credential|assertion|api.?key|code_verifier|code_challenge|csrf|xsrf|^code$|^auth$/i;
const fingerprint = value => `[sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}]`;
const controlPath = root => path.join(root, 'http-trace.json');
export const traceLogPath = root => path.join(root, 'logs', 'http-wire-trace.log');

export function readTraceControl(root, now = Date.now()) {
  let fd;
  try {
    fd = fs.openSync(controlPath(root), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) || stat.uid !== process.getuid()) return null;
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.id)) return null;
    if (!Number.isSafeInteger(value.started_ms) || !Number.isSafeInteger(value.expires_ms)) return null;
    if (value.started_ms > now || value.expires_ms <= now || value.expires_ms - value.started_ms > MAX_WINDOW_MS) return null;
    return value;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function startTrace(root, seconds = 1800, now = Date.now()) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('Trace duration must be 1..3600 seconds');
  const control = { version: 1, id: randomUUID(), started_ms: now, expires_ms: now + seconds * 1000 };
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = `${controlPath(root)}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(control)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, controlPath(root));
  } finally { fs.rmSync(temporary, { force: true }); }
  return control;
}

export function stopTrace(root) {
  fs.rmSync(controlPath(root), { force: true });
}

function cleanText(value) {
  return value.replace(/(https?:\/\/[^\s?"']+)\?[^\s"']+/g, '$1?[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(password|passwd|secret|[\w]*token|api_key)\s*[:=]\s*(["'])(.*?)\2/gi, '$1=$2[REDACTED]$2')
    .replace(/[A-Za-z0-9_.~-]{32,}/g, fingerprint);
}

export function redactTraceValue(value, depth = 0) {
  if (depth > 16) return '[DEPTH LIMIT]';
  if (typeof value === 'string') return cleanText(value);
  if (Array.isArray(value)) return value.map(item => redactTraceValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /session.*id/i.test(key) ? fingerprint(item)
      : sensitive.test(key) && !(key === 'code' && typeof item === 'number') ? '[REDACTED]'
        : redactTraceValue(item, depth + 1),
  ]));
}

function cleanHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key,
    (sensitive.test(key) || /auth|key/i.test(key)) && !/^(www-authenticate|proxy-authenticate)$/i.test(key) ? '[REDACTED]'
      : /session.*id/i.test(key) ? fingerprint(value)
        : /^(location|referer)$/i.test(key) ? cleanText(String(value).split('?')[0])
          : redactTraceValue(value),
  ]));
}

function bodyValue(buffer, bytes, contentType, allowed, complete) {
  if (!allowed) return { bytes, omitted: 'authentication_or_other_route' };
  if (bytes > TRACE_BODY_LIMIT) return { bytes, omitted: 'capture_limit' };
  if (!complete) return { bytes, omitted: 'incomplete' };
  if (!bytes) return { bytes, value: '' };
  const text = buffer.toString('utf8');
  try {
    if (/application\/(?:[\w.+-]*\+)?json|application\/json-rpc/i.test(contentType)) {
      return { bytes, format: 'json', value: redactTraceValue(JSON.parse(text)) };
    }
    if (/text\/event-stream/i.test(contentType)) {
      const events = text.split(/\r?\n\r?\n/).filter(Boolean).map(event => {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        return { framing: cleanText(event.split(/\r?\n/).filter(line => !line.startsWith('data:')).join('\n')), data: data ? redactTraceValue(JSON.parse(data)) : null };
      });
      return { bytes, format: 'sse', events };
    }
  } catch { return { bytes, omitted: 'unparseable' }; }
  return { bytes, omitted: 'unsupported_content_type' };
}

export function createHttpWireTrace(root, { now = Date.now, logger = createHttpDiagnosticLog(traceLogPath(root), { maxQueued: 64, maxRecordBytes: 512 * 1024 }) } = {}) {
  return {
    observe(req, res, requestId) {
      const control = readTraceControl(root, now());
      if (!control) return undefined;
      const started = performance.now();
      const pathname = (req.url || '').split('?')[0];
      const allowed = ['/mcp', '/sse', '/messages'].includes(pathname) || pathname.startsWith('/.well-known/');
      const known = allowed || ['/authorize', '/register', '/token', '/oauth/consent'].includes(pathname);
      const removers = [];
      const finishers = [];
      let active = true;
      const log = (event, fields = {}) => {
        try {
          if (active && now() < control.expires_ms && readTraceControl(root, now())?.id === control.id) {
            logger.log({ timestamp: new Date(now()).toISOString(), capture_id: control.id, request_id: requestId,
              event, elapsed_ms: Math.round(performance.now() - started), ...fields });
          }
        } catch { /* Diagnostics must never interrupt forwarding. */ }
      };
      const listen = (stream, event, handler) => {
        stream.on(event, handler);
        removers.push(() => stream.removeListener(event, handler));
      };
      const collect = (stream, direction) => {
        let chunks = [], bytes = 0, finished = false;
        const data = chunk => {
          if (!active || now() >= control.expires_ms) { chunks = []; return; }
          if (bytes === 0) log(`${direction}_first_byte`);
          bytes += chunk.length;
          if (allowed && bytes <= TRACE_BODY_LIMIT) chunks.push(Buffer.from(chunk));
          else chunks = [];
        };
        const finish = complete => {
          if (finished) return;
          finished = true;
          log(`${direction}_body`, { body: bodyValue(Buffer.concat(chunks), bytes, stream.headers?.['content-type'] || '', allowed, complete) });
          chunks = [];
        };
        finishers.push(() => finish(false));
        listen(stream, 'data', data);
        listen(stream, 'end', () => finish(true));
        listen(stream, 'close', () => finish(false));
        removers.push(() => { chunks = []; });
      };
      log('request_headers', { method: req.method, http_version: req.httpVersion, path: known ? pathname : '[other]', query_present: (req.url || '').includes('?'),
        ...(req.headers.authorization ? { credential_fingerprint: fingerprint(req.headers.authorization) } : {}), headers: cleanHeaders(req.headers) });
      const expiry = setTimeout(() => cleanup(), Math.max(1, control.expires_ms - now()));
      expiry.unref();
      const cleanup = () => {
        active = false;
        clearTimeout(expiry);
        for (const remove of removers) remove();
      };
      listen(res, 'close', () => {
        for (const finish of finishers) finish();
        log('response_completed', { status: res.statusCode, outcome: res.writableFinished ? 'finished' : 'disconnected' });
        cleanup();
      });
      return {
        requestBody() { try { if (active && now() < control.expires_ms) collect(req, 'request'); } catch {} },
        response(response) {
          try {
            if (!active || now() >= control.expires_ms) return;
            log('response_headers', { status: response.statusCode, headers: cleanHeaders(response.headers) });
            collect(response, 'response');
          } catch {}
        },
      };
    },
    flush: () => logger.flush(),
  };
}
