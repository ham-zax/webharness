import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

export async function makeSandbox(t, { budgetBytes = 1024 * 1024 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wsl-agent-terminal-test-'));
  const socketPath = path.join(dir, 'tmux.sock');
  const brokerSocket = path.join(dir, 'broker.sock');
  const stateRoot = path.join(dir, 'state');
  const tmux = spawn('tmux', ['-D', '-S', socketPath, '-f', '/dev/null'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tmuxStderr = [];
  tmux.stderr.on('data', (chunk) => tmuxStderr.push(chunk));
  await waitFor(async () => {
    const probe = spawnSync('tmux', ['-N', '-S', socketPath, 'show-options', '-g', '-v', 'exit-empty'], {
      encoding: 'utf8',
    });
    return probe.status === 0;
  }, { timeoutMs: 3000, description: `tmux server (${Buffer.concat(tmuxStderr).toString('utf8')})` });

  const env = {
    ...process.env,
    MCP_TERMINAL_SOCKET: brokerSocket,
    MCP_TERMINAL_STATE_ROOT: stateRoot,
    MCP_TERMINAL_DEFAULT_CWD: '/tmp',
    MCP_TERMINAL_TMUX_SOCKET_PATH: socketPath,
    MCP_TERMINAL_TRANSCRIPT_BUDGET_BYTES: String(budgetBytes),
  };

  const cleanup = async () => {
    try {
      spawnSync('tmux', ['-N', '-S', socketPath, 'kill-server']);
    } catch {}
    if (!tmux.killed) tmux.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  };
  t.after(cleanup);

  return { dir, socketPath, brokerSocket, stateRoot, tmux, env };
}

export async function startBroker(t, sandbox) {
  const child = spawn(process.execPath, [path.join(ROOT, 'broker.mjs')], {
    env: sandbox.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.testStderr = stderr;
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  await waitFor(async () => {
    try {
      const response = await brokerRequest(sandbox.brokerSocket, { id: 'probe', op: 'session.list', params: {} });
      return response.ok === true;
    } catch {
      if (child.exitCode !== null) {
        assert.fail(`broker exited ${child.exitCode}: ${Buffer.concat(stderr).toString('utf8')}`);
      }
      return false;
    }
  }, { timeoutMs: 3000, description: 'broker socket' });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await onceExit(child).catch(() => {});
    }
  });
  return child;
}

export async function brokerRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`broker request timed out: ${request.op}`));
    }, 3000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      const line = buffered.slice(0, newline);
      socket.end();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 20, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

export function tmuxValue(socketPath, target, format) {
  const result = spawnSync('tmux', ['-N', '-S', socketPath, 'display-message', '-p', '-t', target, format], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function processExists(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export async function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode ?? child.signalCode;
  }
  return new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve(code ?? signal));
    child.once('error', reject);
  });
}
