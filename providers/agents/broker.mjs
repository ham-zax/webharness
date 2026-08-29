#!/usr/bin/env node
import crypto from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const BRIDGE_PORTS = [8765, 8766, 8767, 8768, 8769];
const BROKER_VERSION = '0.1.0';
const BRIDGE_PROTOCOL = 9;
const EXTENSION_VERSION = '2.0.4';
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const STATE_VERSION = 3;
const BINDING_TTL_MS = 2 * 60 * 1000;
const MAX_HTTP_BODY = 64 * 1024;
const MAX_RPC_LINE = 64 * 1024;
const RATE_LIMIT = 120;

function runtimeDir() {
  if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR;
  if (typeof process.getuid !== 'function') throw new Error('XDG_RUNTIME_DIR is required');
  return `/run/user/${process.getuid()}`;
}

function stateBase() {
  return process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
}

const config = {
  socketPath: process.env.MCP_AGENT_SOCKET || path.join(runtimeDir(), 'wsl-agent-agents.sock'),
  stateRoot: process.env.MCP_AGENT_STATE_ROOT || path.join(stateBase(), 'mcp-dev-bridge', 'agents'),
};
config.stateFile = path.join(config.stateRoot, 'state.json');

function log(type, data = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);
}

function fingerprint(session) {
  return crypto.createHash('sha256').update(session).digest('hex').slice(0, 12);
}

function cleanSession(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

function cleanConversation(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,200}$/.test(value) ? value : null;
}

function cleanMarker(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : null;
}

function cleanId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value) ? value : null;
}

function cleanClient(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function cleanTask(value) {
  if (typeof value !== 'string') return null;
  const task = value.trim();
  return task.length > 0 && task.length <= 8000 ? task : null;
}

function emptyState() {
  return {
    version: STATE_VERSION,
    pairing: { token: null, origin: null },
    bindings: {},
    primeSession: null,
    primeConversation: null,
    runSerial: 0,
    runId: null,
    workerSerial: 0,
    workers: {},
    commands: [],
    messageSeq: 0,
    messages: {},
  };
}

function normalizeCommand(value) {
  if (!value || !cleanId(value.id) || typeof value.agent !== 'string') return null;
  return {
    id: value.id,
    type: 'worker',
    agent: value.agent.slice(0, 128),
    conversationId: cleanConversation(value.conversationId),
    text: typeof value.text === 'string' ? value.text.slice(0, 24000) : '',
    owner: cleanClient(value.owner),
    ack: value.ack && typeof value.ack === 'object'
      ? {
          status: value.ack.status === 'failed' ? 'failed' : 'sent',
          conversationId: cleanConversation(value.ack.conversationId),
          agent: typeof value.ack.agent === 'string' ? value.ack.agent.slice(0, 128) : null,
          error: typeof value.ack.error === 'string' ? value.ack.error.slice(0, 1000) : null,
        }
      : null,
  };
}

function normalizeState(value) {
  if (!value || value.version !== STATE_VERSION) return emptyState();
  const state = emptyState();
  const token = typeof value.pairing?.token === 'string' && value.pairing.token.length >= 20 ? value.pairing.token : null;
  const origin = typeof value.pairing?.origin === 'string' && EXTENSION_ORIGIN.test(value.pairing.origin) ? value.pairing.origin : null;
  if (token && origin) state.pairing = { token, origin };
  if (value.bindings && typeof value.bindings === 'object' && !Array.isArray(value.bindings)) {
    for (const [session, conversationId] of Object.entries(value.bindings)) {
      if (cleanSession(session) && cleanConversation(conversationId)) state.bindings[session] = conversationId;
    }
  }
  state.primeSession = cleanSession(value.primeSession);
  state.primeConversation = cleanConversation(value.primeConversation);
  state.runSerial = Number.isSafeInteger(value.runSerial) && value.runSerial >= 0 ? value.runSerial : 0;
  state.runId = typeof value.runId === 'string' && /^run-[1-9][0-9]*$/.test(value.runId) ? value.runId : null;
  state.workerSerial = Number.isSafeInteger(value.workerSerial) && value.workerSerial >= 0 ? value.workerSerial : 0;
  if (value.workers && typeof value.workers === 'object' && !Array.isArray(value.workers)) {
    for (const [agent, worker] of Object.entries(value.workers)) {
      if (!/^worker-[1-9][0-9]*$/.test(agent) || !worker || typeof worker !== 'object') continue;
      state.workers[agent] = {
        agent,
        label: typeof worker.label === 'string' ? worker.label.slice(0, 80) : null,
        task: cleanTask(worker.task) || '',
        conversationId: cleanConversation(worker.conversationId),
        state: ['invited', 'active', 'failed', 'sleeping', 'detached', 'waking'].includes(worker.state) ? worker.state : 'invited',
        commandId: cleanId(worker.commandId),
        result: typeof worker.result === 'string' ? worker.result.slice(0, 16000) : null,
      };
    }
  }
  if (Array.isArray(value.commands)) {
    state.commands = value.commands.map(normalizeCommand).filter(Boolean).slice(0, 64);
  }
  state.messageSeq = Number.isSafeInteger(value.messageSeq) && value.messageSeq >= 0 ? value.messageSeq : 0;
  if (value.messages && typeof value.messages === 'object' && !Array.isArray(value.messages)) {
    for (const [recipient, entries] of Object.entries(value.messages)) {
      if ((recipient !== 'prime' && !/^worker-[1-9][0-9]*$/.test(recipient)) || !Array.isArray(entries)) continue;
      state.messages[recipient] = entries.slice(-200).flatMap((entry) => {
        if (!entry || !Number.isSafeInteger(entry.seq) || typeof entry.text !== 'string') return [];
        return [{
          seq: entry.seq,
          from: typeof entry.from === 'string' ? entry.from.slice(0, 128) : 'unknown',
          text: entry.text.slice(0, 16000),
          kind: entry.kind === 'result' ? 'result' : 'message',
        }];
      });
    }
  }
  return state;
}

async function loadState() {
  await mkdir(config.stateRoot, { recursive: true, mode: 0o700 });
  await chmod(config.stateRoot, 0o700);
  try {
    return normalizeState(JSON.parse(await readFile(config.stateFile, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
}

async function saveState() {
  const temp = `${config.stateFile}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, config.stateFile);
  await chmod(config.stateFile, 0o600);
}

async function socketAcceptsConnections(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 200).unref();
  });
}

async function prepareSocket(socketPath) {
  await mkdir(path.dirname(socketPath), { recursive: true });
  try {
    const info = await lstat(socketPath);
    if (!info.isSocket()) throw Object.assign(new Error(`socket path conflict: ${socketPath}`), { code: 'SOCKET_PATH_CONFLICT' });
    if (await socketAcceptsConnections(socketPath)) {
      throw Object.assign(new Error(`another Agents broker is accepting connections at ${socketPath}`), { code: 'BROKER_ALREADY_RUNNING' });
    }
    await unlink(socketPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

let state = await loadState();
let bridgePort = null;
let lastExtensionSeenAt = 0;
let lastExtensionVersion = null;
let lastExtensionProtocol = null;
let lastBridgeError = null;
const challenges = new Map();
const challengeBySession = new Map();
const rate = new Map();

function pruneChallenges(now = Date.now()) {
  for (const [marker, entry] of challenges) {
    if (entry.expiresAt > now) continue;
    challenges.delete(marker);
    if (challengeBySession.get(entry.session) === marker) challengeBySession.delete(entry.session);
  }
}

function bindStatus(session) {
  const conversationId = state.bindings[session] || null;
  if (conversationId) return { bound: true, conversationId };
  const now = Date.now();
  pruneChallenges(now);
  const current = challengeBySession.get(session);
  if (current && challenges.get(current)?.expiresAt > now) return { bound: false, marker: current };
  const marker = crypto.randomBytes(24).toString('base64url');
  challenges.set(marker, { session, expiresAt: now + BINDING_TTL_MS });
  challengeBySession.set(session, marker);
  log('binding_challenge', { session: fingerprint(session) });
  return { bound: false, marker };
}

async function commitBinding(marker, conversationId) {
  pruneChallenges();
  const entry = challenges.get(marker);
  if (!entry) return { status: 404, body: { error: 'binding_expired' } };
  const existingConversation = state.bindings[entry.session] || null;
  const existingSession = Object.entries(state.bindings).find(([, bound]) => bound === conversationId)?.[0] || null;
  if ((existingConversation && existingConversation !== conversationId) || (existingSession && existingSession !== entry.session)) {
    return { status: 409, body: { error: 'binding_conflict' } };
  }
  state.bindings[entry.session] = conversationId;
  challenges.delete(marker);
  if (challengeBySession.get(entry.session) === marker) challengeBySession.delete(entry.session);
  await saveState();
  log('session_bound', { session: fingerprint(entry.session) });
  return { status: 200, body: { bound: true, conversationId } };
}

function commandView(command) {
  if (!command) return null;
  return {
    id: command.id,
    agent: command.agent,
    status: command.ack?.status || (command.owner ? 'redeemed' : 'staged'),
    conversationId: command.ack?.conversationId || command.conversationId || null,
    error: command.ack?.error || null,
  };
}

function pendingCommand() {
  return state.commands.find((command) => !command.ack) || null;
}

function activeWorkerCount() {
  return Object.values(state.workers).filter((worker) => ['invited', 'active', 'detached', 'waking'].includes(worker.state)).length;
}

function beginRunIfIdle() {
  if (activeWorkerCount() !== 0) return;
  state.runSerial += 1;
  state.runId = `run-${state.runSerial}`;
}

function inbox(recipient) {
  return Array.isArray(state.messages[recipient]) ? state.messages[recipient] : [];
}

function queueMessage(recipient, from, text, kind = 'message') {
  const current = inbox(recipient);
  if (current.length >= 200) return false;
  state.messageSeq += 1;
  current.push({ seq: state.messageSeq, from, text, kind });
  state.messages[recipient] = current;
  return true;
}

function workerView(worker) {
  return {
    agent: worker.agent,
    label: worker.label,
    state: worker.state,
    conversationId: worker.conversationId,
    command: commandView(state.commands.find((command) => command.id === worker.commandId)),
    result: worker.result || null,
    pendingMessages: inbox(worker.agent).length,
  };
}

function roleFor(session) {
  if (state.primeSession === session) return { role: 'prime', worker: null };
  const conversationId = state.bindings[session] || null;
  if (conversationId) {
    const worker = Object.values(state.workers).find((item) => item.conversationId === conversationId) || null;
    if (worker) return { role: 'worker', worker };
  }
  return { role: state.primeSession ? 'stranger' : 'unclaimed', worker: null };
}

function stageRevival(worker, text) {
  beginRunIfIdle();
  const commandId = crypto.randomBytes(16).toString('base64url');
  const command = {
    id: commandId,
    type: 'worker',
    agent: worker.agent,
    conversationId: worker.conversationId,
    text,
    owner: null,
    ack: null,
  };
  state.commands.push(command);
  worker.commandId = commandId;
  worker.state = 'waking';
  log('worker_revival_staged', { id: commandId, agent: worker.agent });
}

async function stageWorkers(tasks, context) {
  const shared = typeof context === 'string' && context.length > 0 ? context : null;
  const created = [];
  for (const item of tasks) {
    state.workerSerial += 1;
    const agent = `worker-${state.workerSerial}`;
    const commandId = crypto.randomBytes(16).toString('base64url');
    const text = [
      `You are ${agent}, a WebHarness Agents worker.`,
      item.label ? `Label: ${item.label}` : null,
      shared ? `Shared context:\n${shared}` : null,
      `Task:\n${item.task}`,
      'Use the normal WebHarness tools when useful. When finished, call agents finish with your concise final report.',
    ].filter(Boolean).join('\n\n');
    const worker = {
      agent,
      label: item.label || null,
      task: item.task,
      conversationId: null,
      state: 'invited',
      commandId,
      result: null,
    };
    const command = {
      id: commandId,
      type: 'worker',
      agent,
      conversationId: null,
      text,
      owner: null,
      ack: null,
    };
    state.workers[agent] = worker;
    state.commands.push(command);
    created.push(workerView(worker));
    log('worker_staged', { id: commandId, agent });
  }
  await saveState();
  return created;
}

async function agentsCall(session, input) {
  const conversationId = state.bindings[session] || null;
  if (!conversationId) return { kind: 'binding_required', ...bindStatus(session) };
  const action = typeof input?.action === 'string' ? input.action : '';
  const identity = roleFor(session);
  if (action === 'status') {
    if (identity.role === 'prime') {
      const selected = Array.isArray(input.agents) && input.agents.length > 0 ? new Set(input.agents) : null;
      const workers = Object.values(state.workers)
        .filter((worker) => !selected || selected.has(worker.agent))
        .map(workerView);
      return { kind: 'status', role: 'prime', workers, inbox: inbox('prime').slice(0, 32) };
    }
    if (identity.role === 'worker') return { kind: 'status', role: 'worker', workers: [workerView(identity.worker)], inbox: inbox(identity.worker.agent).slice(0, 32) };
    return { kind: 'status', role: identity.role, workers: [] };
  }
  if (action === 'message') {
    if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 16) {
      return { kind: 'error', code: 'AGENT_INVALID_REQUEST', message: 'message requires 1..16 messages' };
    }
    const prepared = [];
    for (const item of input.messages) {
      const to = typeof item?.to === 'string' ? item.to : '';
      const text = typeof item?.text === 'string' && item.text.length > 0 && item.text.length <= 8000 ? item.text : null;
      if (!text) return { kind: 'error', code: 'AGENT_INVALID_REQUEST', message: 'every message text must be non-empty and <= 8000 characters' };
      if (identity.role === 'prime') {
        const worker = state.workers[to];
        if (!worker) return { kind: 'error', code: 'AGENT_NOT_FOUND', message: `unknown worker: ${to || 'missing'}` };
        prepared.push({ recipient: to, from: 'prime', text, worker });
      } else if (identity.role === 'worker') {
        if (to !== 'prime') return { kind: 'error', code: 'AGENT_INVALID_ROLE', message: 'workers may message only prime' };
        prepared.push({ recipient: 'prime', from: identity.worker.agent, text, worker: null });
      } else {
        return { kind: 'error', code: 'AGENT_INVALID_ROLE', message: 'unclaimed or foreign conversations cannot send agent messages' };
      }
    }
    const bySleepingWorker = new Map();
    for (const item of prepared) {
      if (inbox(item.recipient).length >= 200) return { kind: 'error', code: 'AGENT_CAPACITY', message: `message queue is full for ${item.recipient}` };
      if (item.worker?.state === 'sleeping') {
        if (!item.worker.conversationId) return { kind: 'error', code: 'AGENT_COMMAND_FAILED', message: `sleeping worker ${item.worker.agent} has no bound conversation` };
        const list = bySleepingWorker.get(item.worker.agent) || [];
        list.push(item.text);
        bySleepingWorker.set(item.worker.agent, list);
      }
    }
    for (const item of prepared) queueMessage(item.recipient, item.from, item.text);
    for (const [agent, texts] of bySleepingWorker) {
      const worker = state.workers[agent];
      stageRevival(worker, texts.length === 1 ? texts[0] : texts.map((text, index) => `Message ${index + 1}:\n${text}`).join('\n\n'));
    }
    await saveState();
    return { kind: 'messaged', role: identity.role, queued: prepared.length, waking: [...bySleepingWorker.keys()] };
  }
  if (action === 'finish') {
    if (identity.role !== 'worker') return { kind: 'error', code: 'AGENT_NOT_ACTIVE', message: 'finish is available only to a bound worker' };
    const result = typeof input.result === 'string' && input.result.length > 0 && input.result.length <= 16000 ? input.result : null;
    if (!result) return { kind: 'error', code: 'AGENT_INVALID_REQUEST', message: 'finish requires a non-empty result <= 16000 characters' };
    if (identity.worker.state === 'sleeping') {
      if (identity.worker.result === result) return { kind: 'finished', role: 'worker', worker: workerView(identity.worker) };
      return { kind: 'error', code: 'AGENT_NOT_ACTIVE', message: 'worker is already sleeping' };
    }
    if (!['active', 'detached'].includes(identity.worker.state)) return { kind: 'error', code: 'AGENT_NOT_ACTIVE', message: `worker is not active: ${identity.worker.state}` };
    identity.worker.result = result;
    identity.worker.state = 'sleeping';
    queueMessage('prime', identity.worker.agent, result, 'result');
    await saveState();
    log('worker_finished', { agent: identity.worker.agent });
    return { kind: 'finished', role: 'worker', worker: workerView(identity.worker) };
  }
  if (action !== 'spawn') return { kind: 'error', code: 'AGENT_ACTION_UNAVAILABLE', message: `action not implemented yet: ${action || 'missing'}` };
  if (identity.role === 'worker') return { kind: 'error', code: 'AGENT_INVALID_ROLE', message: 'workers cannot spawn workers' };
  if (identity.role === 'stranger') return { kind: 'error', code: 'AGENTS_BUSY', message: 'another prime owns the active swarm' };
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 8) {
    return { kind: 'error', code: 'AGENT_INVALID_REQUEST', message: 'spawn requires 1..8 tasks' };
  }
  const tasks = [];
  for (const item of input.tasks) {
    const task = cleanTask(item?.task);
    const label = typeof item?.label === 'string' && item.label.length > 0 && item.label.length <= 80 ? item.label : null;
    if (!task) return { kind: 'error', code: 'AGENT_INVALID_REQUEST', message: 'every spawn task must be non-empty and <= 8000 characters' };
    tasks.push({ task, label });
  }
  const context = input.context === undefined ? null : typeof input.context === 'string' && input.context.length <= 8000 ? input.context : undefined;
  if (context === undefined) return { kind: 'error', code: 'AGENT_INVALID_REQUEST', message: 'context must be <= 8000 characters' };
  if (state.primeSession && state.primeSession !== session) return { kind: 'error', code: 'AGENTS_BUSY', message: 'another prime owns the active swarm' };
  const active = Object.values(state.workers).filter((worker) => ['invited', 'active', 'detached', 'waking'].includes(worker.state)).length;
  if (active + tasks.length > 8) return { kind: 'error', code: 'AGENT_CAPACITY', message: 'spawn would exceed the eight-worker active capacity' };
  beginRunIfIdle();
  state.primeSession = session;
  state.primeConversation = conversationId;
  const workers = await stageWorkers(tasks, context);
  await saveState();
  log('prime_claimed', { session: fingerprint(session) });
  return { kind: 'spawned', role: 'prime', workers };
}

function extensionHeaders(req) {
  const origin = typeof req.headers.origin === 'string' && EXTENSION_ORIGIN.test(req.headers.origin) ? req.headers.origin : null;
  const version = typeof req.headers['x-extension-version'] === 'string' ? req.headers['x-extension-version'] : null;
  const protocol = Number(req.headers['x-extension-protocol']);
  return { origin, version, protocol };
}

function noteExtension(ext) {
  if (!ext.origin) return;
  lastExtensionSeenAt = Date.now();
  lastExtensionVersion = ext.version;
  lastExtensionProtocol = Number.isFinite(ext.protocol) ? ext.protocol : null;
}

function compatibleExtension(req) {
  const ext = extensionHeaders(req);
  return Boolean(ext.origin && ext.version === EXTENSION_VERSION && ext.protocol === BRIDGE_PROTOCOL);
}

function authorizedExtension(req) {
  const ext = extensionHeaders(req);
  const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const originAllowed = rawOrigin === '' || Boolean(state.pairing.origin && ext.origin === state.pairing.origin);
  return Boolean(
    state.pairing.token
    && originAllowed
    && ext.version === EXTENSION_VERSION
    && ext.protocol === BRIDGE_PROTOCOL
    && req.headers.authorization === `Bearer ${state.pairing.token}`
  );
}

function allowRate(origin) {
  const now = Date.now();
  const current = rate.get(origin);
  if (!current || now - current.startedAt >= 1000) {
    rate.set(origin, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT;
}

function send(res, status, body, origin = null) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (origin && EXTENSION_ORIGIN.test(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
    headers['access-control-allow-headers'] = 'authorization, content-type, x-extension-version, x-extension-protocol';
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_HTTP_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 });
  }
}

async function browserHandler(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const ext = extensionHeaders(req);
  noteExtension(ext);
  if (req.method === 'OPTIONS') return send(res, 204, {}, ext.origin);
  if (req.method === 'GET' && url.pathname === '/hello') {
    return send(res, 200, {
      app: 'webharness-agents',
      version: BROKER_VERSION,
      bridge: BRIDGE_PROTOCOL,
      compatible: ext.version === EXTENSION_VERSION && ext.protocol === BRIDGE_PROTOCOL,
      paired: state.pairing.token !== null,
      disconnected: false,
    }, ext.origin);
  }
  if (req.method === 'POST' && url.pathname === '/pair') {
    if (!compatibleExtension(req)) return send(res, 426, { error: 'incompatible_extension', expectedVersion: EXTENSION_VERSION, expectedProtocol: BRIDGE_PROTOCOL }, ext.origin);
    if (!allowRate(ext.origin)) return send(res, 429, { error: 'rate_limited' }, ext.origin);
    state.pairing = { token: crypto.randomBytes(24).toString('base64url'), origin: ext.origin };
    await saveState();
    log('paired', { origin: ext.origin, extensionVersion: ext.version });
    return send(res, 200, { token: state.pairing.token }, ext.origin);
  }
  if (!authorizedExtension(req)) return send(res, 401, { error: 'not_paired' }, ext.origin);
  if (!allowRate(ext.origin)) return send(res, 429, { error: 'rate_limited' }, ext.origin);

  if (req.method === 'POST' && url.pathname === '/bindings') {
    const body = await readJson(req);
    const marker = cleanMarker(body.marker);
    const conversationId = cleanConversation(body.conversationId);
    if (!marker || !conversationId) return send(res, 400, { error: 'bad_binding' }, ext.origin);
    const result = await commitBinding(marker, conversationId);
    return send(res, result.status, result.body, ext.origin);
  }
  if (req.method === 'POST' && url.pathname === '/activity') {
    const body = await readJson(req);
    const conversationId = cleanConversation(body.conversationId);
    const since = Number(body.since) || 0;
    const pending = conversationId && conversationId === state.primeConversation ? pendingCommand() : null;
    const agentCommand = pending ? { id: pending.id, conversationId: pending.conversationId || null } : null;
    if (agentCommand) log('agent_command_offered', { conversationId, id: agentCommand.id });
    return send(res, 200, {
      sessionId: conversationId,
      entries: [],
      stream: [],
      nextSince: since,
      pendingTools: 0,
      activeTurnId: null,
      tokens: 0,
      bootstrap: state.commands.some((command) => command.ack?.conversationId === conversationId) ? 'worker' : null,
      agentCommand,
      agentsStatus: {
        prime: state.primeSession ? fingerprint(state.primeSession) : null,
        run: activeWorkerCount() > 0 ? state.runId : null,
        activeWorkers: activeWorkerCount(),
        sleepingWorkers: Object.values(state.workers).filter((worker) => worker.state === 'sleeping').length,
        pendingCommands: state.commands.filter((command) => !command.ack).length,
        lastBridgeError,
      },
    }, ext.origin);
  }
  if (req.method === 'POST' && url.pathname === '/events') {
    const body = await readJson(req);
    const events = Array.isArray(body.events) ? body.events.slice(0, 64) : [];
    const tools = events.flatMap((event) =>
      event && event.kind === 'tool_evidence' && Array.isArray(event.calls)
        ? event.calls.slice(0, 16).map((call) => ({
            tool: typeof call?.tool === 'string' ? call.tool : null,
            answered: call?.answered === true,
            binding: typeof call?.binding === 'string',
          }))
        : []
    ).slice(0, 16);
    log('events', { conversationId: cleanConversation(body.conversationId), count: events.length, tools });
    return send(res, 200, { accepted: events.length }, ext.origin);
  }
  if (req.method === 'POST' && url.pathname === '/closed') {
    const body = await readJson(req);
    log('closed', { conversationId: cleanConversation(body.conversationId) });
    return send(res, 200, { ok: true }, ext.origin);
  }
  if (req.method === 'POST' && url.pathname === '/commands/redeem') {
    const body = await readJson(req);
    const id = cleanId(body.id);
    const client = cleanClient(body.client);
    const command = id ? state.commands.find((item) => item.id === id) : null;
    if (!id || !client || !command || command.ack) return send(res, 404, { error: 'command_not_found' }, ext.origin);
    const requestedConversation = cleanConversation(body.conversationId);
    if (command.owner && command.owner !== client) return send(res, 409, { error: 'command_owned' }, ext.origin);
    if (command.conversationId) {
      if (requestedConversation !== command.conversationId) return send(res, 409, { error: 'wrong_conversation' }, ext.origin);
    } else if (requestedConversation) {
      return send(res, 409, { error: 'fresh_command_requires_new_chat' }, ext.origin);
    }
    if (!command.owner) {
      command.owner = client;
      await saveState();
    }
    log('command_redeemed', { id, client });
    return send(res, 200, { command: {
      id: command.id,
      type: command.type,
      agent: command.agent,
      conversationId: command.conversationId,
      text: command.text,
    } }, ext.origin);
  }
  if (req.method === 'POST' && url.pathname === '/commands/ack') {
    const body = await readJson(req);
    const id = cleanId(body.id);
    const command = id ? state.commands.find((item) => item.id === id) : null;
    if (!id || !command) return send(res, 404, { error: 'command_not_found' }, ext.origin);
    const client = cleanClient(body.client);
    if (command.owner && client && client !== command.owner) return send(res, 409, { error: 'command_owned' }, ext.origin);
    const nextAck = {
      status: body.status === 'failed' ? 'failed' : 'sent',
      conversationId: cleanConversation(body.conversationId),
      agent: typeof body.agent === 'string' ? body.agent.slice(0, 128) : null,
      error: typeof body.error === 'string' ? body.error.slice(0, 1000) : null,
    };
    if (command.ack) {
      const same = JSON.stringify(command.ack) === JSON.stringify(nextAck);
      return send(res, same ? 200 : 409, same ? { committed: true, command: command.ack } : { error: 'command_ack_conflict' }, ext.origin);
    }
    command.ack = nextAck;
    if (nextAck.conversationId) command.conversationId = nextAck.conversationId;
    const worker = state.workers[command.agent];
    if (worker) {
      worker.conversationId = nextAck.conversationId || worker.conversationId;
      worker.state = nextAck.status === 'failed' ? 'failed' : 'active';
    }
    await saveState();
    log('command_ack', { id, status: nextAck.status, agent: nextAck.agent });
    return send(res, 200, { committed: true, command: command.ack }, ext.origin);
  }
  return send(res, 404, { error: 'not_found' }, ext.origin);
}

async function dispatchRpc(request) {
  const op = typeof request?.op === 'string' ? request.op : '';
  const params = request?.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params : {};
  if (op === 'health') return { version: STATE_VERSION, socketPath: config.socketPath, stateRoot: config.stateRoot, bridgePort, paired: Boolean(state.pairing.token && state.pairing.origin) };
  if (op === 'status') {
    const activeWorkers = activeWorkerCount();
    const sleepingWorkers = Object.values(state.workers).filter((worker) => worker.state === 'sleeping').length;
    return {
      bridgePort,
      paired: Boolean(state.pairing.token && state.pairing.origin),
      bindings: Object.keys(state.bindings).length,
      prime: state.primeSession ? fingerprint(state.primeSession) : null,
      activeRunId: activeWorkers > 0 ? state.runId : null,
      activeWorkers,
      sleepingWorkers,
      extension: {
        version: lastExtensionVersion,
        protocol: lastExtensionProtocol,
        heartbeatAgeMs: lastExtensionSeenAt > 0 ? Math.max(0, Date.now() - lastExtensionSeenAt) : null,
      },
      lastBridgeError,
      workers: Object.values(state.workers).map(workerView),
      pendingCommands: state.commands.filter((command) => !command.ack).length,
    };
  };
  if (op === 'bind_status') {
    const session = cleanSession(params.session);
    if (!session) throw Object.assign(new Error('session must be a non-empty bounded string'), { code: 'AGENT_IDENTITY_UNAVAILABLE' });
    return bindStatus(session);
  }
  if (op === 'agents_call') {
    const session = cleanSession(params.session);
    if (!session) throw Object.assign(new Error('session must be a non-empty bounded string'), { code: 'AGENT_IDENTITY_UNAVAILABLE' });
    return agentsCall(session, params.input ?? {});
  }
  throw Object.assign(new Error(`unknown broker operation: ${op || 'missing'}`), { code: 'UNKNOWN_OPERATION' });
}

function attachRpc(socket) {
  socket.setEncoding('utf8');
  let buffered = '';
  let closed = false;
  const finish = (payload) => {
    if (closed) return;
    closed = true;
    socket.end(`${JSON.stringify(payload)}\n`);
  };
  socket.on('data', (chunk) => {
    if (closed) return;
    buffered += chunk;
    if (Buffer.byteLength(buffered, 'utf8') > MAX_RPC_LINE) return finish({ id: null, ok: false, error: { code: 'INVALID_REQUEST', message: 'broker request exceeds maximum line size' } });
    const newline = buffered.indexOf('\n');
    if (newline === -1) return;
    let request;
    try {
      request = JSON.parse(buffered.slice(0, newline));
    } catch {
      return finish({ id: null, ok: false, error: { code: 'INVALID_REQUEST', message: 'broker request is not valid JSON' } });
    }
    Promise.resolve(dispatchRpc(request)).then(
      (result) => finish({ id: request?.id ?? null, ok: true, result }),
      (error) => finish({ id: request?.id ?? null, ok: false, error: { code: error?.code || 'BROKER_ERROR', message: error?.message || 'broker request failed' } }),
    );
  });
}

async function listenBridge() {
  for (const port of BRIDGE_PORTS) {
    const server = http.createServer((req, res) => {
      Promise.resolve(browserHandler(req, res)).catch((error) => {
        const message = String(error?.message || error || 'broker error').slice(0, 500);
        lastBridgeError = { at: new Date().toISOString(), path: String(req.url || '/').slice(0, 200), message };
        log('browser_request_error', { path: req.url || '/', message });
        if (!res.headersSent) send(res, Number(error?.status) || 500, { error: 'broker_error' }, req.headers.origin || null);
        else res.end();
      });
    });
    const result = await new Promise((resolve) => {
      server.once('error', (error) => resolve({ ok: false, error }));
      server.listen(port, '127.0.0.1', () => resolve({ ok: true }));
    });
    if (result.ok) {
      bridgePort = port;
      return server;
    }
    server.close();
    if (result.error?.code !== 'EADDRINUSE') throw result.error;
  }
  throw new Error('no free Agents bridge port in 8765..8769');
}

async function listenRpc() {
  await prepareSocket(config.socketPath);
  const server = net.createServer(attachRpc);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socketPath, resolve);
  });
  await chmod(config.socketPath, 0o600);
  return server;
}

const bridgeServer = await listenBridge();
const rpcServer = await listenRpc();
log('ready', { bridgePort, socketPath: config.socketPath, stateRoot: config.stateRoot });

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([
    new Promise((resolve) => bridgeServer.close(resolve)),
    new Promise((resolve) => rpcServer.close(resolve)),
  ]);
  try {
    await unlink(config.socketPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
