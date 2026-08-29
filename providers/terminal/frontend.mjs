import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { TerminalError } from './protocol.mjs';
import { validateSessionName } from './tmux.mjs';

const DEFAULT_READY_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const WSLG_RUNTIME_DIR = '/mnt/wslg/runtime-dir';
const WSLG_WAYLAND = `${WSLG_RUNTIME_DIR}/wayland-0`;
const WSLG_X11 = ['/tmp/.X11-unix/X0', '/mnt/wslg/.X11-unix/X0'];
const WSLG_PULSE = '/mnt/wslg/PulseServer';
const CMD_UNSUPPORTED_VALUE = /[\u0000-\u001f"&|<>^()%!]/;
const execFileAsync = promisify(execFile);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isExecutable(candidate, accessFn) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  try {
    await accessFn(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveKittyBinary(env, accessFn) {
  const candidates = [];
  if (env.MCP_TERMINAL_KITTY_BIN) candidates.push(env.MCP_TERMINAL_KITTY_BIN);
  if (env.HOME) candidates.push(path.join(env.HOME, '.local', 'kitty.app', 'bin', 'kitty'));
  for (const entry of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(entry, 'kitty'));
  }
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isExecutable(candidate, accessFn)) return candidate;
  }
  return null;
}

async function isSocket(candidate, statFn) {
  try {
    return (await statFn(candidate)).isSocket() === true;
  } catch {
    return false;
  }
}

async function frontendEnv(env, statFn) {
  const childEnv = { ...env };
  if (!childEnv.WAYLAND_DISPLAY && await isSocket(WSLG_WAYLAND, statFn)) {
    childEnv.XDG_RUNTIME_DIR = WSLG_RUNTIME_DIR;
    childEnv.WAYLAND_DISPLAY = 'wayland-0';
  }
  if (!childEnv.DISPLAY) {
    for (const candidate of WSLG_X11) {
      if (await isSocket(candidate, statFn)) {
        childEnv.DISPLAY = ':0';
        break;
      }
    }
  }
  if (!childEnv.PULSE_SERVER && await isSocket(WSLG_PULSE, statFn)) {
    childEnv.PULSE_SERVER = `unix:${WSLG_PULSE}`;
  }
  return childEnv;
}

async function defaultKillProcessGroup(pid, signal = 'SIGTERM') {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function defaultWaitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once?.('exit', onExit);
    child.once?.('close', onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

function fallbackMessage(wslTermPath, name) {
  return `${wslTermPath} attach ${name}`;
}

function isCmdValueSupported(value) {
  return typeof value === 'string' && value.length > 0 && !CMD_UNSUPPORTED_VALUE.test(value);
}

function quoteCmdValue(value, label) {
  if (!isCmdValueSupported(value)) {
    throw new Error(`${label} contains unsupported CMD metacharacters or control characters`);
  }
  return `"${value}"`;
}

function parseWslDistro(windowsRoot) {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\.*)?$/i.exec(String(windowsRoot || '').trim());
  return match?.[1] ?? null;
}

async function resolveWslDistro(env, execFileFn) {
  const configured = String(env.WSL_DISTRO_NAME || '').trim();
  if (isCmdValueSupported(configured)) return configured;
  try {
    const { stdout } = await execFileFn('wslpath', ['-w', '/'], { encoding: 'utf8' });
    return parseWslDistro(stdout);
  } catch {
    return null;
  }
}

function buildWindowsTerminalCommand({ distro, user, nodeBin, wslTermPath, name }) {
  return [
    'wt.exe',
    '-w', 'new',
    'new-tab',
    '--title', quoteCmdValue(`Terminal: ${name}`, 'title'),
    '--suppressApplicationTitle',
    'wsl.exe',
    '-d', quoteCmdValue(distro, 'WSL distribution'),
    '-u', quoteCmdValue(user, 'Linux user'),
    '--exec',
    '/usr/bin/env',
    quoteCmdValue(`TERMINAL_NODE_BIN=${nodeBin}`, 'Node executable'),
    quoteCmdValue(wslTermPath, 'wsl-term path'),
    'present',
    quoteCmdValue(name, 'session name'),
  ].join(' ');
}

export function createFrontendController({
  client,
  env = process.env,
  repoRoot = path.resolve(import.meta.dirname, '../..'),
  accessFn = access,
  statFn = stat,
  spawnFn = spawn,
  execFileFn = execFileAsync,
  userInfoFn = os.userInfo,
  nodeBin = process.execPath,
  killProcessGroup = defaultKillProcessGroup,
  waitForChildExit = defaultWaitForChildExit,
  sleep = delay,
  now = Date.now,
  readinessTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  cleanupTimeoutMs = 500,
} = {}) {
  const inflight = new Map();
  const wslTermPath = path.join(repoRoot, 'bin', 'wsl-term');

  async function sessionState(name) {
    if (!client || typeof client.request !== 'function') {
      throw new TypeError('frontend controller requires a broker client with request()');
    }
    const result = await client.request('session.list', {});
    const session = result.sessions.find((candidate) => candidate.name === name);
    if (!session) throw new TerminalError('SESSION_NOT_FOUND', `terminal session not found: ${name}`);
    return session;
  }

  async function waitForAttachmentProgress(name, state) {
    if (!state.humanLease || state.humanAttached) return state;
    const deadline = now() + readinessTimeoutMs;
    let current = state;
    while (current.humanLease && !current.humanAttached) {
      if (now() >= deadline) {
        throw new TerminalError(
          'FRONTEND_NOT_READY',
          `human frontend attachment is still settling for ${name}; re-list before retrying or attaching manually`,
        );
      }
      await sleep(pollIntervalMs);
      current = await sessionState(name);
    }
    return current;
  }

  async function waitForKittyPresented(name, child, launchState) {
    const deadline = now() + readinessTimeoutMs;
    while (true) {
      if (launchState.error) {
        throw new TerminalError(
          'FRONTEND_LAUNCH_FAILED',
          `Kitty failed to launch for ${name}: ${launchState.error.message}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new TerminalError(
          'FRONTEND_LAUNCH_FAILED',
          `Kitty exited before the frontend was ready for ${name}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
        );
      }
      const state = await sessionState(name);
      if (state.humanAttached) return state;
      if (now() >= deadline) {
        throw new TerminalError(
          'FRONTEND_NOT_READY',
          `Kitty did not establish a collaborative frontend for ${name}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  async function cleanupLaunchedFrontend(child) {
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
    try {
      await killProcessGroup(child.pid, 'SIGTERM');
      const exited = await waitForChildExit(child, cleanupTimeoutMs);
      if (!exited) {
        await killProcessGroup(child.pid, 'SIGKILL');
        await waitForChildExit(child, cleanupTimeoutMs);
      }
    } catch {
      // Preserve the original actionable frontend error rather than masking it with cleanup failure.
    }
  }

  async function launchKitty(name) {
    const kittyBin = await resolveKittyBinary(env, accessFn);
    if (!kittyBin) {
      throw new TerminalError(
        'FRONTEND_UNAVAILABLE',
        `Kitty is unavailable for ${name}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
      );
    }

    const childEnv = await frontendEnv(env, statFn);
    let child;
    try {
      child = spawnFn(
        kittyBin,
        ['--title', `Terminal: ${name}`, wslTermPath, 'present', name],
        { detached: true, stdio: 'ignore', env: childEnv },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TerminalError(
        'FRONTEND_LAUNCH_FAILED',
        `Kitty failed to start for ${name}: ${message}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
      );
    }
    const launchState = { error: null };
    if (child && typeof child.once === 'function') {
      child.once('error', (error) => { launchState.error = error; });
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new TerminalError(
        'FRONTEND_LAUNCH_FAILED',
        `Kitty did not start for ${name}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
      );
    }

    try {
      await waitForKittyPresented(name, child, launchState);
    } catch (error) {
      await cleanupLaunchedFrontend(child);
      throw error;
    }
    if (typeof child.unref === 'function') child.unref();
    return { name, status: 'launch-attempted' };
  }

  function windowsLauncherFailure(child, launchState) {
    if (launchState.error) return launchState.error.message;
    const exitCode = launchState.exitCode ?? child?.exitCode;
    const signalCode = launchState.signalCode ?? child?.signalCode;
    if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
      return `launcher exited with code ${exitCode}`;
    }
    if (signalCode) return `launcher exited with signal ${signalCode}`;
    return null;
  }

  async function waitForWindowsPresented(name, child, launchState) {
    const deadline = now() + readinessTimeoutMs;
    while (true) {
      const state = await sessionState(name);
      if (state.humanAttached) return state;

      const failure = windowsLauncherFailure(child, launchState);
      if (failure && !state.humanLease) {
        throw new TerminalError(
          'FRONTEND_LAUNCH_FAILED',
          `Windows Terminal failed to launch for ${name}: ${failure}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
        );
      }

      if (now() >= deadline) {
        const finalState = await sessionState(name);
        if (finalState.humanAttached) return finalState;
        if (finalState.humanLease) {
          throw new TerminalError(
            'FRONTEND_NOT_READY',
            `Windows Terminal attachment is still settling for ${name}; re-list before retrying or attaching manually`,
          );
        }
        const finalFailure = windowsLauncherFailure(child, launchState);
        if (finalFailure) {
          throw new TerminalError(
            'FRONTEND_LAUNCH_FAILED',
            `Windows Terminal failed to launch for ${name}: ${finalFailure}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
          );
        }
        throw new TerminalError(
          'FRONTEND_NOT_READY',
          `Windows Terminal did not establish a collaborative frontend for ${name}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  async function launchWindowsTerminal(name) {
    const distro = await resolveWslDistro(env, execFileFn);
    if (!distro) {
      throw new TerminalError(
        'FRONTEND_UNAVAILABLE',
        `current WSL distribution could not be resolved for ${name}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
      );
    }

    let user;
    try {
      user = userInfoFn().username;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TerminalError(
        'FRONTEND_UNAVAILABLE',
        `Linux process account could not be resolved for ${name}: ${message}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
      );
    }

    let command;
    try {
      command = buildWindowsTerminalCommand({ distro, user, nodeBin, wslTermPath, name });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TerminalError(
        'FRONTEND_LAUNCH_FAILED',
        `Windows Terminal command is unsafe for ${name}: ${message}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
      );
    }

    let child;
    try {
      child = spawnFn(
        'cmd.exe',
        ['/d', '/c', command],
        { cwd: '/mnt/c', detached: true, stdio: 'ignore' },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TerminalError(
        'FRONTEND_LAUNCH_FAILED',
        `Windows Terminal failed to start for ${name}: ${message}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
      );
    }

    const launchState = { error: null, exitCode: null, signalCode: null };
    if (child && typeof child.once === 'function') {
      child.once('error', (error) => { launchState.error = error; });
      child.once('exit', (code, signal) => {
        launchState.exitCode = code;
        launchState.signalCode = signal;
      });
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new TerminalError(
        'FRONTEND_LAUNCH_FAILED',
        `Windows Terminal did not start for ${name}; attach manually with ${fallbackMessage(wslTermPath, name)}`,
      );
    }
    if (typeof child.unref === 'function') child.unref();

    await waitForWindowsPresented(name, child, launchState);
    return { name, status: 'launch-attempted' };
  }

  async function doEnsurePresented(name) {
    let state = await sessionState(name);
    if (state.humanAttached) return { name, status: 'reused' };

    state = await waitForAttachmentProgress(name, state);
    if (state.humanAttached) return { name, status: 'reused' };

    const frontend = String(env.MCP_TERMINAL_FRONTEND || '').trim() || 'kitty';
    if (frontend === 'kitty') return launchKitty(name);
    if (frontend === 'windows-terminal') return launchWindowsTerminal(name);
    throw new TerminalError(
      'FRONTEND_UNAVAILABLE',
      `configured Terminal frontend ${JSON.stringify(frontend)} is unsupported; expected kitty or windows-terminal; attach manually with ${fallbackMessage(wslTermPath, name)}`,
    );
  }

  function ensurePresented(name) {
    validateSessionName(name);
    const existing = inflight.get(name);
    if (existing) return existing;
    const operation = doEnsurePresented(name).finally(() => {
      if (inflight.get(name) === operation) inflight.delete(name);
    });
    inflight.set(name, operation);
    return operation;
  }

  return { ensurePresented };
}
