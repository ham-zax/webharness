#!/usr/bin/env node
import crypto from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  TerminalError,
  decodeRequest,
  encodeResponse,
  errorResponse,
} from './protocol.mjs';
import { readModelCursor, writeModelCursor } from './model-cursor.mjs';
import { readTranscript, readTranscriptState } from './transcript.mjs';
import { TmuxBackend, validateSessionName } from './tmux.mjs';

const DEFAULT_TRANSCRIPT_BUDGET_BYTES = 16 * 1024 * 1024;
const DEFAULT_READ_MAX_BYTES = 64 * 1024;
const DEFAULT_LEASE_ATTACH_GRACE_MS = 5000;
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TerminalError('INVALID_CONFIG', `${name} must be a positive integer`);
  }
  return value;
}

function runtimeDir() {
  if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR;
  if (typeof process.getuid !== 'function') {
    throw new TerminalError('INVALID_CONFIG', 'XDG_RUNTIME_DIR is required on this platform');
  }
  return `/run/user/${process.getuid()}`;
}

function stateBase() {
  return process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
}

export function loadConfig() {
  return {
    socketPath: process.env.MCP_TERMINAL_SOCKET || path.join(runtimeDir(), 'wsl-agent-terminal.sock'),
    stateRoot: process.env.MCP_TERMINAL_STATE_ROOT || path.join(stateBase(), 'wsl-agent-terminal'),
    defaultCwd: process.env.MCP_TERMINAL_DEFAULT_CWD || process.env.HOME || os.homedir(),
    tmuxSocketName: process.env.MCP_TERMINAL_TMUX_SOCKET_NAME || 'wsl-agent',
    tmuxSocketPath: process.env.MCP_TERMINAL_TMUX_SOCKET_PATH || undefined,
    tmuxBin: process.env.MCP_TERMINAL_TMUX_BIN || 'tmux',
    transcriptBudgetBytes: positiveIntegerEnv(
      'MCP_TERMINAL_TRANSCRIPT_BUDGET_BYTES',
      DEFAULT_TRANSCRIPT_BUDGET_BYTES,
    ),
    readMaxBytes: positiveIntegerEnv('MCP_TERMINAL_READ_MAX_BYTES', DEFAULT_READ_MAX_BYTES),
    leaseAttachGraceMs: positiveIntegerEnv(
      'MCP_TERMINAL_LEASE_ATTACH_GRACE_MS',
      DEFAULT_LEASE_ATTACH_GRACE_MS,
    ),
  };
}

async function socketAcceptsConnections(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 200).unref();
  });
}

async function prepareSocket(socketPath) {
  await mkdir(path.dirname(socketPath), { recursive: true });
  try {
    const info = await lstat(socketPath);
    if (!info.isSocket()) {
      throw new TerminalError('SOCKET_PATH_CONFLICT', `broker socket path exists and is not a socket: ${socketPath}`);
    }
    if (await socketAcceptsConnections(socketPath)) {
      throw new TerminalError('BROKER_ALREADY_RUNNING', `another broker is accepting connections at ${socketPath}`);
    }
    await unlink(socketPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

function boundedReadLimit(value, configuredMax) {
  if (value === undefined) return configuredMax;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TerminalError('INVALID_ARGUMENT', 'maxBytes must be a positive integer');
  }
  return Math.min(value, configuredMax);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TerminalError('INVALID_ARGUMENT', `${field} must be a non-empty string`);
  }
  return value;
}

export function attachBrokerConnection(socket, dispatch) {
  socket.setEncoding('utf8');
  let buffered = '';
  let chain = Promise.resolve();

  socket.on('error', () => {
    socket.destroy();
  });

  socket.on('data', (chunk) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      socket.end(encodeResponse(errorResponse(null, new TerminalError(
        'REQUEST_TOO_LARGE',
        `request line exceeds ${MAX_PROTOCOL_LINE_BYTES} bytes`,
      ))));
      return;
    }
    while (true) {
      const newline = buffered.indexOf('\n');
      if (newline === -1) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      chain = chain.then(async () => {
        let id = null;
        try {
          const request = decodeRequest(line);
          id = request.id;
          const result = await dispatch(request);
          socket.write(encodeResponse({ id, ok: true, result }));
        } catch (error) {
          socket.write(encodeResponse(errorResponse(id, error)));
        }
      });
    }
  });
}

export async function createBroker(config = loadConfig()) {
  process.umask(0o077);
  await mkdir(config.stateRoot, { recursive: true, mode: 0o700 });
  await chmod(config.stateRoot, 0o700);

  const tmux = new TmuxBackend({
    tmuxBin: config.tmuxBin,
    socketName: config.tmuxSocketName,
    socketPath: config.tmuxSocketPath,
    stateRoot: config.stateRoot,
    defaultCwd: config.defaultCwd,
    transcriptBudgetBytes: config.transcriptBudgetBytes,
  });
  await tmux.assertServer();
  await tmux.installCollaborativeBindings();
  const reconciled = await tmux.reconcileSessions();
  const leases = new Map();
  const modelReadChains = new Map();
  const lifecycleChains = new Map();

  async function serializeLifecycle(name, fn) {
    const previous = lifecycleChains.get(name) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    lifecycleChains.set(name, current);
    try {
      return await current;
    } finally {
      if (lifecycleChains.get(name) === current) lifecycleChains.delete(name);
    }
  }

  async function serializeModelRead(name, fn) {
    const previous = modelReadChains.get(name) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    modelReadChains.set(name, current);
    try {
      return await current;
    } finally {
      if (modelReadChains.get(name) === current) modelReadChains.delete(name);
    }
  }

  function createHumanLease(clientId, { clientPid = null, observed = false } = {}) {
    const acquiredAtMs = Date.now();
    return {
      leaseId: crypto.randomUUID(),
      clientId: requireString(clientId, 'clientId'),
      acquiredAt: new Date(acquiredAtMs).toISOString(),
      acquiredAtMs,
      clientPid,
      boundAtMs: clientPid === null ? null : acquiredAtMs,
      observed,
    };
  }

  function leaseResult(name, lease) {
    return {
      name,
      leaseId: lease.leaseId,
      clientId: lease.clientId,
      acquiredAt: lease.acquiredAt,
    };
  }

  async function reconcileHumanControl(name) {
    const now = Date.now();
    const clients = (await tmux.listClients()).filter((client) => client.session === name);
    let lease = leases.get(name);

    if (lease) {
      const deadlineBase = lease.boundAtMs ?? lease.acquiredAtMs;
      if (lease.clientPid !== null) {
        const attached = clients.find((client) => client.pid === lease.clientPid);
        if (attached) {
          lease.observed = true;
          await tmux.setCollaborativeClient(name, attached);
          if (attached.readOnly === true) {
            leases.delete(name);
            lease = undefined;
          }
        } else if (lease.observed || now - deadlineBase >= config.leaseAttachGraceMs) {
          leases.delete(name);
          lease = undefined;
        }
      } else if (now - deadlineBase >= config.leaseAttachGraceMs) {
        leases.delete(name);
        lease = undefined;
      }
    }

    const writableClients = clients.filter((client) => client.readOnly !== true);
    let designated = await tmux.collaborativeClient(name, clients);
    if (writableClients.length === 1) {
      const writer = writableClients[0];
      if (!designated || designated.pid !== writer.pid || designated.tty !== writer.tty
          || designated.created !== writer.created) {
        await tmux.setCollaborativeClient(name, writer);
        designated = writer;
      }
    }

    return {
      humanHasControl: writableClients.length > 0 || leases.has(name),
      clients,
      writableClients,
      designated,
      lease: leases.get(name) ?? null,
    };
  }

  async function assertModelMayMutate(name, { forceClose = false } = {}) {
    if (forceClose) return;
    const control = await reconcileHumanControl(name);
    if (control.humanHasControl) {
      throw new TerminalError('HUMAN_HAS_CONTROL', `human has control of session ${name}`);
    }
  }

  function generationMismatch(name, expected, actual) {
    return new TerminalError(
      'SESSION_GENERATION_MISMATCH',
      `session generation changed for ${name}`,
      { expectedGeneration: expected, actualGeneration: actual },
    );
  }

  async function dispatch(request) {
    const { op, params } = request;
    switch (op) {
      case 'session.open': {
        const name = requireString(params.name, 'name');
        return serializeLifecycle(name, async () => {
          const session = await tmux.openSession({
            name,
            command: params.command === undefined ? '' : params.command,
            cwd: params.cwd,
            cols: params.cols,
            rows: params.rows,
          });
          const state = await tmux.sessionState(name);
          await writeModelCursor(state.dataDir, 0);
          return session;
        });
      }
      case 'session.open_human': {
        const name = requireString(params.name, 'name');
        const clientId = requireString(params.clientId, 'clientId');
        return serializeLifecycle(name, async () => {
          if (leases.has(name)) {
            throw new TerminalError('HUMAN_HAS_CONTROL', `human already has control of session ${name}`);
          }
          const lease = createHumanLease(clientId);
          leases.set(name, lease);
          try {
            const session = await tmux.openSession({
              name,
              command: params.command === undefined ? '' : params.command,
              cwd: params.cwd,
              cols: params.cols,
              rows: params.rows,
            });
            const state = await tmux.sessionState(name);
            await writeModelCursor(state.dataDir, 0);
            return { ...session, ...leaseResult(name, lease) };
          } catch (error) {
            if (leases.get(name)?.leaseId === lease.leaseId) leases.delete(name);
            throw error;
          }
        });
      }
      case 'session.list': {
        const sessions = await tmux.listSessions();
        const listed = [];
        for (const session of sessions) {
          const control = await reconcileHumanControl(session.name);
          listed.push({
            ...session,
            humanLease: control.humanHasControl,
            humanAttached: control.designated !== null,
          });
        }
        return { sessions: listed };
      }
      case 'session.read': {
        const name = requireString(params.name, 'name');
        validateSessionName(name);
        const expectedGeneration = params.expectedGeneration === undefined
          ? undefined
          : requireString(params.expectedGeneration, 'expectedGeneration');
        const maxBytes = boundedReadLimit(params.maxBytes, config.readMaxBytes);
        const recoveryTailBytes = Math.min(params.recoveryTailBytes || 4096, config.readMaxBytes);
        return serializeLifecycle(name, async () => {
          await tmux.sessionInfo(name);
          const beforeState = await tmux.sessionState(name);
          if (expectedGeneration !== undefined && beforeState.generation !== expectedGeneration) {
            throw generationMismatch(name, expectedGeneration, beforeState.generation);
          }
          const result = await readTranscript(beforeState.dataDir, {
            cursor: params.cursor === undefined ? 0 : params.cursor,
            maxBytes,
            recoveryTailBytes,
          });
          const afterState = await tmux.sessionState(name);
          if (afterState.generation !== beforeState.generation) {
            throw generationMismatch(name, beforeState.generation, afterState.generation);
          }
          if (expectedGeneration !== undefined && afterState.generation !== expectedGeneration) {
            throw generationMismatch(name, expectedGeneration, afterState.generation);
          }
          return result;
        });
      }
      case 'session.observe': {
        const name = requireString(params.name, 'name');
        validateSessionName(name);
        return serializeLifecycle(name, async () => {
          const beforeState = await tmux.sessionState(name);
          const info = await tmux.sessionInfo(name);
          const transcript = await readTranscriptState(beforeState.dataDir);
          const afterState = await tmux.sessionState(name);
          if (afterState.generation !== beforeState.generation) {
            throw generationMismatch(name, beforeState.generation, afterState.generation);
          }
          return {
            name,
            generation: beforeState.generation,
            paneDead: info.paneDead,
            paneDeadStatus: info.paneDeadStatus,
            panePid: info.panePid,
            transcript: {
              baseOffset: transcript.baseOffset,
              endOffset: transcript.endOffset,
            },
          };
        });
      }
      case 'model.read': {
        const name = requireString(params.name, 'name');
        validateSessionName(name);
        if (params.snapshot !== undefined && typeof params.snapshot !== 'boolean') {
          throw new TerminalError('INVALID_ARGUMENT', 'snapshot must be a boolean when provided');
        }
        const maxBytes = boundedReadLimit(params.maxBytes, config.readMaxBytes);
        const recoveryTailBytes = Math.min(params.recoveryTailBytes || 4096, config.readMaxBytes);
        return serializeLifecycle(name, async () => {
          await tmux.sessionInfo(name);
          if (params.snapshot === true) {
            return { snapshot: true, text: await tmux.captureScreen(name) };
          }
          return serializeModelRead(name, async () => {
            const state = await tmux.sessionState(name);
            const cursor = params.cursor === undefined
              ? await readModelCursor(state.dataDir)
              : params.cursor;
            const result = await readTranscript(state.dataDir, { cursor, maxBytes, recoveryTailBytes });
            await writeModelCursor(state.dataDir, result.nextCursor);
            return result;
          });
        });
      }
      case 'session.send': {
        const name = requireString(params.name, 'name');
        await assertModelMayMutate(name);
        return tmux.send({
          name,
          text: params.text,
          key: params.key,
        });
      }
      case 'session.resize': {
        const name = requireString(params.name, 'name');
        await assertModelMayMutate(name);
        return tmux.resize({
          name,
          cols: params.cols,
          rows: params.rows,
        });
      }
      case 'session.close': {
        const name = requireString(params.name, 'name');
        return serializeLifecycle(name, async () => {
          await assertModelMayMutate(name, { forceClose: params.force === true });
          leases.delete(name);
          return tmux.closeSession(name);
        });
      }
      case 'lease.acquire_human': {
        const name = requireString(params.name, 'name');
        await tmux.sessionInfo(name);
        const control = await reconcileHumanControl(name);
        if (control.humanHasControl) {
          throw new TerminalError('HUMAN_HAS_CONTROL', `human already has control of session ${name}`);
        }
        const lease = createHumanLease(params.clientId);
        leases.set(name, lease);
        return leaseResult(name, lease);
      }
      case 'lease.bind_human': {
        const name = requireString(params.name, 'name');
        const leaseId = requireString(params.leaseId, 'leaseId');
        const clientPid = params.clientPid;
        if (!Number.isSafeInteger(clientPid) || clientPid <= 0) {
          throw new TerminalError('INVALID_ARGUMENT', 'clientPid must be a positive integer');
        }
        await tmux.sessionInfo(name);
        const lease = leases.get(name);
        if (!lease || lease.leaseId !== leaseId) {
          throw new TerminalError('LEASE_MISMATCH', `human lease id does not match session ${name}`);
        }
        lease.clientPid = clientPid;
        lease.boundAtMs = Date.now();
        const control = await reconcileHumanControl(name);
        return {
          name,
          leaseId,
          clientPid,
          observed: control.lease?.observed === true,
        };
      }
      case 'lease.release_human': {
        const name = requireString(params.name, 'name');
        const leaseId = requireString(params.leaseId, 'leaseId');
        const lease = leases.get(name);
        if (!lease) return { name, released: false };
        if (lease.leaseId !== leaseId) {
          throw new TerminalError('LEASE_MISMATCH', `human lease id does not match session ${name}`);
        }
        leases.delete(name);
        return { name, released: true };
      }
      case 'control.give_model': {
        const name = requireString(params.name, 'name');
        await tmux.sessionInfo(name);
        const control = await reconcileHumanControl(name);
        const designated = control.designated;
        if (!designated) {
          throw new TerminalError('HUMAN_CLIENT_NOT_FOUND', `no collaborative human client is attached to session ${name}`);
        }
        const conflictingWriters = control.writableClients.filter((client) => (
          client.pid !== designated.pid || client.tty !== designated.tty
          || client.created !== designated.created
        ));
        if (conflictingWriters.length > 0) {
          throw new TerminalError(
            'MULTIPLE_HUMAN_CLIENTS',
            `multiple writable human clients are attached to session ${name}`,
          );
        }
        if (control.lease?.clientPid !== null
            && control.lease?.clientPid !== undefined
            && control.lease.clientPid !== designated.pid) {
          throw new TerminalError('HUMAN_HAS_CONTROL', `another human lease controls session ${name}`);
        }
        const client = await tmux.setClientReadOnly({
          name, pid: designated.pid, tty: designated.tty, created: designated.created, readOnly: true,
        });
        leases.delete(name);
        const after = await reconcileHumanControl(name);
        if (after.humanHasControl) {
          throw new TerminalError(
            'HUMAN_HAS_CONTROL',
            `human control remains active for session ${name}`,
          );
        }
        return { name, humanHasControl: false, clientPid: client.pid, clientTty: client.tty };
      }
      case 'control.take_human': {
        const name = requireString(params.name, 'name');
        await tmux.sessionInfo(name);
        const control = await reconcileHumanControl(name);
        const designated = control.designated;
        if (!designated) {
          throw new TerminalError('HUMAN_CLIENT_NOT_FOUND', `no collaborative human client is attached to session ${name}`);
        }
        if (control.writableClients.length > 1) {
          throw new TerminalError(
            'MULTIPLE_HUMAN_CLIENTS',
            `multiple writable human clients are attached to session ${name}`,
          );
        }
        if (control.writableClients.length === 1) {
          return {
            name,
            humanHasControl: true,
            clientPid: control.writableClients[0].pid,
            clientTty: control.writableClients[0].tty,
          };
        }
        if (control.lease) {
          throw new TerminalError('HUMAN_HAS_CONTROL', `human lease already controls session ${name}`);
        }
        const lease = createHumanLease(`control-take:${name}`, {
          clientPid: designated.pid,
          observed: true,
        });
        leases.set(name, lease);
        const client = await tmux.setClientReadOnly({
          name, pid: designated.pid, tty: designated.tty, created: designated.created, readOnly: false,
        });
        return {
          name,
          humanHasControl: true,
          clientPid: client.pid,
          clientTty: client.tty,
          leaseId: lease.leaseId,
        };
      }
      default:
        throw new TerminalError('UNSUPPORTED_OPERATION', `unsupported operation: ${op}`);
    }
  }

  await prepareSocket(config.socketPath);
  const server = net.createServer((socket) => attachBrokerConnection(socket, dispatch));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(config.socketPath, 0o600);

  return {
    config,
    tmux,
    reconciled,
    server,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try {
        await unlink(config.socketPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}

async function main() {
  const broker = await createBroker();
  process.stderr.write(
    `wsl-agent terminal broker ready: ${broker.config.socketPath}; reconciled=${broker.reconciled.length}\n`,
  );
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await broker.close();
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`terminal broker shutdown failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    process.stderr.write(`terminal broker failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
