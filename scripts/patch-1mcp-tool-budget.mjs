import fs from 'node:fs';
import path from 'node:path';

const [agentRoot] = process.argv.slice(2);
if (!agentRoot || JSON.parse(fs.readFileSync(path.join(agentRoot, 'package.json'), 'utf8')).version !== '0.40.0') {
  throw new Error('Expected pinned @1mcp/agent 0.40.0');
}

const contextFile = 'core/server/webharnessToolMetadata.js';
const contextSource = `import { AsyncLocalStorage } from 'node:async_hooks';

const metadata = new AsyncLocalStorage();
const localTransports = new WeakSet();
const callIdKey = 'webharness/call-id';
const budgetKey = 'webharness/rpc-budget-ms';
const validBudget = value => Number.isSafeInteger(value) && value >= 5_000 && value <= 300_000;

export function withWebHarnessToolMetadata(req, _res, next) {
    if (process.env.BRIDGE_COLD_START !== '1' || req.method !== 'POST' || req.path !== '/mcp')
        return next();
    const id = req.headers['x-webharness-request-id'];
    if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
        return next();
    const header = req.headers['x-webharness-rpc-budget-ms'];
    const policyBudget = typeof header === 'string' && /^[0-9]{4,6}$/.test(header) ? Number(header) : undefined;
    const hint = req.body?.method === 'tools/call' ? req.body.params?._meta?.[budgetKey] : undefined;
    return metadata.run({
        [callIdKey]: id,
        ...(validBudget(policyBudget) ? { [budgetKey]: validBudget(hint) ? Math.min(hint, policyBudget) : policyBudget } : {}),
    }, next);
}

export function gatewayCallId() {
    return metadata.getStore()?.[callIdKey];
}

export function registerWebHarnessTransport(name, transport) {
    if (name === 'local' || name === 'dev')
        localTransports.add(transport);
}

export function applyWebHarnessToolMetadata(method, transport, params) {
    const active = metadata.getStore();
    if (method !== 'tools/call' || !active || !localTransports.has(transport))
        return params;
    return { ...params, _meta: { ...params?._meta, ...active } };
}
`;

const patches = [
  ['sdk/legacy/transport/http/server.js',
    '        this.app.use(httpRequestBodyLogger);',
    '        this.app.use(withWebHarnessToolMetadata);\n        this.app.use(httpRequestBodyLogger);',
    'withWebHarnessToolMetadata', '../../../../'],
  ['sdk/legacy/transport/transportFactory.js',
    '    const transport = new Transport(stdioParams);',
    '    const transport = new Transport(stdioParams);\n    registerWebHarnessTransport(name, transport);',
    'registerWebHarnessTransport', '../../../'],
  ['sdk/legacy/client/runtime/modernSdkClientAdapter.js',
    '            message.params = injectTraceContext(message.params);',
    '            message.params = injectTraceContext(applyWebHarnessToolMetadata(request.method, this.handles.transport, message.params));',
    'applyWebHarnessToolMetadata', '../../../../'],
  ['sdk/legacy/client/runtime/legacySdkClientAdapter.js',
    '        const params = injectTraceContext(request.params === undefined ? undefined : toJsonValue(request.params));',
    '        const params = injectTraceContext(applyWebHarnessToolMetadata(request.method, this.handles.transport, request.params === undefined ? undefined : toJsonValue(request.params)));',
    'applyWebHarnessToolMetadata', '../../../../'],
  ['sdk/legacy/server/protocol/toolRequestHandlers.js',
    'const requested = { callId: randomUUID(), requestedTool: request.params.name };',
    'const requested = { callId: gatewayCallId() ?? randomUUID(), requestedTool: request.params.name };',
    'gatewayCallId', '../../../../'],
  ['core/capabilities/capabilityCatalog.js',
    'const requested = { callId: randomUUID(), requestedServer: args.server, requestedTool: args.toolName };',
    'const requested = { callId: gatewayCallId() ?? randomUUID(), requestedServer: args.server, requestedTool: args.toolName };',
    'gatewayCallId', '../../'],
  ['core/validation/schemaPolicy.js',
    '    compileMs: 250,\n    evaluateMs: 50,',
    '    compileMs: 1500,\n    evaluateMs: 250,'],
  ['sdk/legacy/client/runtime/clientManager.js',
    `            if (isUnknownMessageIdError(error)) {
                logger.error('clientManager.client.received.a.response.for.an.unknown.message.id.a605b144');`,
    `            if (isUnknownMessageIdError(error)) {
                if (this.isShuttingDown) {
                    return;
                }
                logger.error('clientManager.client.received.a.response.for.an.unknown.message.id.a605b144');`],
  ['logger/logger.js',
    `export function writeBackendDiagnostic(entry) {
    if (!isBackendDiagnosticEntry(entry))
        return;
    sink.warn(\`[\${entry.displayName}] \${entry.content}\`, {
        serverName: entry.canonicalName,
        source: 'backend-stderr',
        backendLogSequence: entry.sequence,
        backendLogSourceId: entry.sourceId,
        backendLogEventKind: entry.kind,
        ...(entry.count === undefined ? {} : { count: entry.count }),
        ...(entry.truncated ? { truncated: true } : {}),
    });
}`,
    `function isWebHarnessInfoStderr(content) {
    if (typeof content !== 'string' || !content.startsWith('{') || !content.endsWith('}'))
        return false;
    try {
        const parsed = JSON.parse(content);
        return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            && typeof parsed.event === 'string' && parsed.event.startsWith('call_')
            && parsed.outcome !== 'error' && parsed.outcome !== 'partial_error');
    }
    catch {
        return false;
    }
}
export function writeBackendDiagnostic(entry) {
    if (!isBackendDiagnosticEntry(entry))
        return;
    const level = isWebHarnessInfoStderr(entry.content) ? 'info' : 'warn';
    if (!sink.isLevelEnabled(level))
        return;
    sink.log({
        level,
        message: \`[\${entry.displayName}] \${entry.content}\`,
        serverName: entry.canonicalName,
        source: 'backend-stderr',
        backendLogSequence: entry.sequence,
        backendLogSourceId: entry.sourceId,
        backendLogEventKind: entry.kind,
        ...(entry.count === undefined ? {} : { count: entry.count }),
        ...(entry.truncated ? { truncated: true } : {}),
    });
}`],
  ['transport/http/middlewares/errorHandler.js',
    `import logger from '../../../logger/logger.js';
import { ErrorCode } from '../../../sdk/contracts/index.js';
import { z } from 'zod';
const protocolVersionHeaderSchema = z.string();
export default function errorHandler(err, req, res, _next) {
    logger.error('errorHandler.express.error.037179d1', { error: err });
    const rawClaimedVersion = req.headers?.['mcp-protocol-version'];
    const parsedVersion = protocolVersionHeaderSchema.safeParse(rawClaimedVersion);
    const claimedVersion = parsedVersion.success ? parsedVersion.data : undefined;
    if (req.path === '/mcp' &&
        claimedVersion !== undefined &&
        !LEGACY_PROTOCOL_REVISIONS.includes(claimedVersion) &&
        err instanceof SyntaxError) {
        res.status(400).json({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
        });
        return;
    }
    res.status(500).json({
        error: {
            code: ErrorCode.InternalError,
            message: 'Internal server error',
        },
    });
}`,
    `import { httpContentType, sanitizeHttpPath } from '../../../logger/httpDiagnostics.js';
import logger, { writeHttpDiagnostic } from '../../../logger/logger.js';
import { sanitizeForLogging } from '../../../logger/secureLogger.js';
import { ErrorCode } from '../../../sdk/contracts/index.js';
import { z } from 'zod';
const protocolVersionHeaderSchema = z.string();
const WH_UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function boundedSafeToken(value, maxLen = 64) {
    if (typeof value !== 'string')
        return undefined;
    const clean = value.trim();
    if (!clean)
        return undefined;
    const sanitized = sanitizeForLogging(clean);
    const text = typeof sanitized === 'string' ? sanitized : clean;
    return text.length > maxLen ? text.slice(0, maxLen) : text;
}
function sanitizeExpressErrorSummary(err) {
    const raw = typeof err?.message === 'string' ? err.message.split(/\\r?\\n/, 1)[0].trim() : '';
    if (!raw)
        return undefined;
    let text = raw;
    if (err instanceof SyntaxError || err?.type === 'entity.parse.failed') {
        // Never log raw request body snippets embedded in JSON.parse SyntaxError messages.
        text = text.replace(/,\\s*"[\\s\\S]*$/, '').replace(/\\s+in JSON at position \\d+.*$/, '').trim() || 'JSON parse error';
    }
    const sanitized = sanitizeForLogging(text);
    const clean = typeof sanitized === 'string' ? sanitized : text;
    return clean.length > 160 ? \`\${clean.slice(0, 160)}...\` : clean;
}
function topStackFrame(err) {
    if (typeof err?.stack !== 'string')
        return undefined;
    const frame = err.stack.split(/\\r?\\n/).slice(1).map((line) => line.trim()).find((line) => line.startsWith('at '));
    return boundedSafeToken(frame, 160);
}
export default function errorHandler(err, req, res, _next) {
    logger.error('errorHandler.express.error.037179d1', { error: err });
    const rawStatus = Number.isInteger(err?.status) ? err.status : (Number.isInteger(err?.statusCode) ? err.statusCode : undefined);
    const errorStatus = rawStatus !== undefined && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
    const rawReqId = req?.headers?.['x-webharness-request-id'];
    const rawContentLen = req?.headers?.['content-length'];
    const rawCode = err?.code;
    const errorCode = typeof rawCode === 'number' && Number.isSafeInteger(rawCode)
        ? String(rawCode)
        : boundedSafeToken(rawCode, 64);
    const diag = {
        method: typeof req?.method === 'string' ? req.method : 'unknown',
        path: sanitizeHttpPath(req?.originalUrl ?? req?.path),
        ...(typeof rawReqId === 'string' && WH_UUID_RE.test(rawReqId) ? { requestId: rawReqId } : {}),
        ...(boundedSafeToken(err?.name, 64) ? { errorName: boundedSafeToken(err?.name, 64) } : {}),
        ...(boundedSafeToken(err?.type, 64) ? { errorType: boundedSafeToken(err?.type, 64) } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(errorStatus !== undefined ? { errorStatus } : {}),
        contentType: httpContentType(req?.headers?.['content-type']),
        ...(typeof rawContentLen === 'string' && /^\\d{1,12}$/.test(rawContentLen) ? { contentLength: Number(rawContentLen) } : {}),
        ...(boundedSafeToken(req?.headers?.['content-encoding'], 32) ? { contentEncoding: boundedSafeToken(req?.headers?.['content-encoding'], 32) } : {}),
        ...(sanitizeExpressErrorSummary(err) ? { errorSummary: sanitizeExpressErrorSummary(err) } : {}),
        ...(topStackFrame(err) ? { stackTop: topStackFrame(err) } : {}),
    };
    writeHttpDiagnostic('error', 'http.express-error', diag);
    if (res.headersSent || res.writableEnded || res.destroyed)
        return;
    const rawClaimedVersion = req.headers?.['mcp-protocol-version'];
    const parsedVersion = protocolVersionHeaderSchema.safeParse(rawClaimedVersion);
    const claimedVersion = parsedVersion.success ? parsedVersion.data : undefined;
    if (req.path === '/mcp' &&
        err instanceof SyntaxError &&
        (err?.type === 'entity.parse.failed' ||
            (claimedVersion !== undefined && !LEGACY_PROTOCOL_REVISIONS.includes(claimedVersion)))) {
        res.status(400).json({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
        });
        return;
    }
    if (err?.expose === true && errorStatus !== undefined && errorStatus >= 400 && errorStatus < 500) {
        const message = errorStatus === 413
            ? 'Payload too large'
            : errorStatus === 415
                ? 'Unsupported media type'
                : 'Bad request';
        res.status(errorStatus).json({
            error: {
                code: ErrorCode.InvalidRequest,
                message,
            },
        });
        return;
    }
    res.status(500).json({
        error: {
            code: ErrorCode.InternalError,
            message: 'Internal server error',
        },
    });
}`],
];

const build = path.join(agentRoot, 'build');
const writes = new Map();
for (const [file, before, after, name, prefix] of patches) {
  const target = path.join(build, file);
  const source = fs.readFileSync(target, 'utf8');
  const importLine = name ? `import { ${name} } from '${prefix}${contextFile}';\n` : '';
  if (source.includes(after) && (!importLine || source.startsWith(importLine))) continue;
  if (source.split(before).length !== 2 || (importLine && source.includes(importLine))) {
    throw new Error(`Unexpected source shape in ${file}`);
  }
  writes.set(target, importLine + source.replace(before, after));
}
const contextPath = path.join(build, contextFile);
if (fs.existsSync(contextPath) && fs.readFileSync(contextPath, 'utf8') !== contextSource) {
  throw new Error(`Unexpected existing file ${contextFile}`);
}
if (!fs.existsSync(contextPath)) writes.set(contextPath, contextSource);
for (const [file, source] of writes) fs.writeFileSync(file, source);
