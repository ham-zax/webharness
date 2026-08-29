#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { BrokerClient } from './broker-client.mjs';
import { validateSessionName } from './tmux.mjs';

function socketPath() {
  if (process.env.MCP_TERMINAL_SOCKET) return process.env.MCP_TERMINAL_SOCKET;
  if (process.env.XDG_RUNTIME_DIR) return `${process.env.XDG_RUNTIME_DIR}/wsl-agent-terminal.sock`;
  if (typeof process.getuid === 'function') return `/run/user/${process.getuid()}/wsl-agent-terminal.sock`;
  throw new Error('MCP_TERMINAL_SOCKET or XDG_RUNTIME_DIR is required');
}

function tmuxArgs() {
  const args = ['-N'];
  if (process.env.MCP_TERMINAL_TMUX_SOCKET_PATH) {
    args.push('-S', process.env.MCP_TERMINAL_TMUX_SOCKET_PATH);
  } else {
    args.push('-L', process.env.MCP_TERMINAL_TMUX_SOCKET_NAME || 'wsl-agent');
  }
  return args;
}

function tmuxBin() {
  return process.env.MCP_TERMINAL_TMUX_BIN || 'tmux';
}

function renderSession(session) {
  const state = session.paneDead
    ? `dead exit=${session.paneDeadStatus ?? 'unknown'}`
    : 'live';
  return [
    session.name,
    state,
    `pid=${session.panePid}`,
    `${session.cols}x${session.rows}`,
    `human=${session.humanLease ? 'yes' : 'no'}`,
  ].join(' ');
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function requireInteractive(command) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`wsl-term ${command} requires an interactive TTY`);
  }
}

function listTmuxClients() {
  const result = spawnSync(
    tmuxBin(),
    [...tmuxArgs(), 'list-clients', '-F', '#{client_pid}|#{client_session}|#{client_tty}|#{client_readonly}'],
    { encoding: 'utf8', env: process.env },
  );
  if (result.status !== 0) {
    const message = String(result.stderr || '').trim() || 'tmux list-clients failed';
    throw new Error(message);
  }
  return String(result.stdout || '').split('\n').filter(Boolean).map((line) => {
    const [pid, session, tty, readOnly] = line.split('|');
    return { pid: Number(pid), session, tty, readOnly: readOnly === '1' };
  });
}

function setWindowSizeManual(name) {
  const result = spawnSync(
    tmuxBin(),
    [...tmuxArgs(), 'set-window-option', '-t', `=${name}:0`, 'window-size', 'manual'],
    { encoding: 'utf8', env: process.env },
  );
  if (result.status !== 0) {
    const message = String(result.stderr || '').trim() || 'tmux set-window-option window-size manual failed';
    throw new Error(message);
  }
}

function resizeWindowToTerminal(name, clientPid) {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) return false;
  const client = listTmuxClients().find((candidate) => (
    candidate.pid === clientPid && candidate.session === name
  ));
  if (!client || client.readOnly) return false;

  const result = spawnSync(
    tmuxBin(),
    [...tmuxArgs(), 'resize-window', '-t', `=${name}:0`, '-x', String(cols), '-y', String(rows)],
    { encoding: 'utf8', env: process.env },
  );
  if (result.status !== 0) {
    const message = String(result.stderr || '').trim() || 'tmux resize-window failed';
    throw new Error(message);
  }
  return true;
}

async function watchSession(name) {
  validateSessionName(name);
  requireInteractive('watch');

  const args = [...tmuxArgs(), 'attach-session', '-r', '-t', `=${name}`];
  const child = spawn(tmuxBin(), args, {
    stdio: 'inherit',
    env: process.env,
  });
  const signalHandlers = new Map();
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    for (const signal of ['SIGTERM', 'SIGHUP']) {
      const handler = () => {
        if (child.exitCode === null) child.kill(signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    const result = await waitForChild(child);
    if (result.code !== null) return result.code;
    return 128;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

async function listSessions(client) {
  const result = await client.request('session.list', {});
  if (result.sessions.length > 0) {
    process.stdout.write(`${result.sessions.map(renderSession).join('\n')}\n`);
  }
  return 0;
}

async function attachSession(client, name, {
  lease: providedLease,
  readOnly = false,
  commandName = 'attach',
} = {}) {
  validateSessionName(name);
  requireInteractive(commandName);

  const lease = providedLease ?? await client.request('lease.acquire_human', {
    name,
    clientId: `wsl-term:${process.pid}`,
  });
  let child = null;
  let resizeHandler = null;
  const signalHandlers = new Map();
  try {
    if (readOnly) setWindowSizeManual(name);
    const args = [
      ...tmuxArgs(),
      'attach-session',
      ...(readOnly ? ['-r'] : []),
      '-t', `=${name}`,
    ];
    child = spawn(tmuxBin(), args, {
      stdio: 'inherit',
      env: process.env,
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    await client.request('lease.bind_human', {
      name,
      leaseId: lease.leaseId,
      clientPid: child.pid,
    });

    if (!readOnly) resizeWindowToTerminal(name, child.pid);
    resizeHandler = () => {
      try {
        resizeWindowToTerminal(name, child.pid);
      } catch (error) {
        process.stderr.write(`wsl-term resize failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    };
    process.stdout.on('resize', resizeHandler);

    for (const signal of ['SIGTERM', 'SIGHUP']) {
      const handler = () => {
        if (child && child.exitCode === null) child.kill(signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    const result = await waitForChild(child);
    if (result.code !== null) return result.code;
    return 128;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (resizeHandler) process.stdout.off('resize', resizeHandler);
    try {
      await client.request('lease.release_human', { name, leaseId: lease.leaseId });
    } catch {}
  }
}

async function presentSession(client, name) {
  return attachSession(client, name, { readOnly: true, commandName: 'present' });
}

async function newSession(client, name) {
  validateSessionName(name);
  requireInteractive('new');
  const params = {
    name,
    clientId: `wsl-term:${process.pid}`,
  };
  if (Number.isInteger(process.stdout.columns) && process.stdout.columns > 0) {
    params.cols = process.stdout.columns;
  }
  if (Number.isInteger(process.stdout.rows) && process.stdout.rows > 0) {
    params.rows = process.stdout.rows;
  }
  const opened = await client.request('session.open_human', params);
  return attachSession(client, name, { lease: opened });
}

async function giveSession(client, name) {
  validateSessionName(name);
  await client.request('control.give_model', { name });
  process.stdout.write(`model control: ${name}\n`);
  return 0;
}

async function takeSession(client, name) {
  validateSessionName(name);
  await client.request('control.take_human', { name });
  process.stdout.write(`human control: ${name}\n`);
  return 0;
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, name, ...rest] = argv;
  const commands = ['list', 'new', 'watch', 'present', 'attach', 'give', 'take'];
  if (rest.length > 0 || !commands.includes(command)) {
    throw new Error('usage: wsl-term list | wsl-term new <session> | wsl-term watch <session> | wsl-term present <session> | wsl-term attach <session> | wsl-term give <session> | wsl-term take <session>');
  }
  if (command !== 'list' && (!name || name.length === 0)) {
    throw new Error(`usage: wsl-term ${command} <session>`);
  }
  if (command === 'list' && name !== undefined) {
    throw new Error('usage: wsl-term list');
  }

  if (command === 'watch') return watchSession(name);
  const client = new BrokerClient({ socketPath: socketPath() });
  switch (command) {
    case 'list': return listSessions(client);
    case 'new': return newSession(client, name);
    case 'present': return presentSession(client, name);
    case 'attach': return attachSession(client, name);
    case 'give': return giveSession(client, name);
    case 'take': return takeSession(client, name);
    default: throw new Error(`unsupported wsl-term command: ${command}`);
  }
}

async function main() {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    const code = typeof error?.code === 'string' ? `${error.code}: ` : '';
    process.stderr.write(`${code}${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
