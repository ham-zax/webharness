import fs from 'node:fs';
import path from 'node:path';

const [agentRoot] = process.argv.slice(2);
if (!agentRoot || JSON.parse(fs.readFileSync(path.join(agentRoot, 'package.json'), 'utf8')).version !== '0.39.8') {
  throw new Error('Expected pinned @1mcp/agent 0.39.8');
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
