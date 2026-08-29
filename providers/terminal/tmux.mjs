import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { TerminalError } from './protocol.mjs';
import { ensureTranscript } from './transcript.mjs';

const execFileAsync = promisify(execFile);
const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MODULE_DIR = import.meta.dirname;
const PANE_ENTRY = path.join(MODULE_DIR, 'pane-entry.mjs');
const TRANSCRIPT_WRITER = path.join(MODULE_DIR, 'transcript-writer.mjs');
const TRANSCRIPT_FINALIZER_HOOK = 'pane-died[100]';
const TRANSCRIPT_FINALIZED_OPTION = '@wsl_agent_transcript_finalized';
const ORIGINAL_DEAD_PID_OPTION = '@wsl_agent_original_dead_pid';
const ORIGINAL_DEAD_STATUS_OPTION = '@wsl_agent_original_dead_status';
const COLLAB_CLIENT_PID_OPTION = '@wsl_agent_collab_client_pid';
const COLLAB_CLIENT_TTY_OPTION = '@wsl_agent_collab_client_tty';
const COLLAB_CLIENT_CREATED_OPTION = '@wsl_agent_collab_client_created';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function asPositiveInteger(value, field, fallback) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TerminalError('INVALID_ARGUMENT', `${field} must be a positive integer`);
  }
  return resolved;
}

function parseBoolean(value) {
  return value === '1' || value === 'on' || value === 'true';
}

function parseStatus(value) {
  if (value === '' || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

export function validateSessionName(name) {
  if (typeof name !== 'string' || !SESSION_NAME_RE.test(name)) {
    throw new TerminalError(
      'INVALID_SESSION_NAME',
      'session name must match ^[A-Za-z0-9._-]{1,64}$',
    );
  }
  return name;
}

export class TmuxBackend {
  constructor({
    tmuxBin = 'tmux',
    socketName = 'wsl-agent',
    socketPath,
    stateRoot,
    defaultCwd = process.env.HOME || os.homedir(),
    transcriptBudgetBytes = 16 * 1024 * 1024,
    nodeBin = process.execPath,
  } = {}) {
    if (!stateRoot) throw new TerminalError('INVALID_CONFIG', 'stateRoot is required');
    this.tmuxBin = tmuxBin;
    this.socketName = socketName;
    this.socketPath = socketPath;
    this.stateRoot = stateRoot;
    this.sessionsRoot = path.join(stateRoot, 'sessions');
    this.defaultCwd = defaultCwd;
    this.transcriptBudgetBytes = transcriptBudgetBytes;
    this.nodeBin = nodeBin;
  }

  baseArgs() {
    return this.socketPath
      ? ['-N', '-S', this.socketPath]
      : ['-N', '-L', this.socketName];
  }

  async run(args, { maxBuffer = 4 * 1024 * 1024 } = {}) {
    try {
      return await execFileAsync(this.tmuxBin, [...this.baseArgs(), ...args], {
        encoding: 'utf8',
        maxBuffer,
      });
    } catch (error) {
      const stderr = String(error?.stderr || '').trim();
      const message = stderr || error?.message || 'tmux command failed';
      const targetMissing = /can't find (?:session|window|pane)|no such (?:session|window|pane)/i.test(message);
      const unavailable = /no such file|error connecting|no server running|connection refused/i.test(message);
      const code = targetMissing ? 'SESSION_NOT_FOUND' : (unavailable ? 'TMUX_UNAVAILABLE' : 'TMUX_ERROR');
      throw new TerminalError(code, message, {
        command: args[0],
        exitCode: Number.isInteger(error?.code) ? error.code : undefined,
      });
    }
  }

  async ensureStateRoot() {
    await mkdir(this.sessionsRoot, { recursive: true, mode: 0o700 });
    await chmod(this.stateRoot, 0o700);
    await chmod(this.sessionsRoot, 0o700);
  }

  sessionDir(name) {
    validateSessionName(name);
    return path.join(this.sessionsRoot, name);
  }

  sessionDataDir(name, generation) {
    validateSessionName(name);
    if (typeof generation !== 'string' || !/^[0-9a-f-]{36}$/i.test(generation)) {
      throw new TerminalError('SESSION_STATE_CORRUPT', `invalid session generation for ${name}`);
    }
    return path.join(this.sessionDir(name), 'incarnations', generation);
  }

  async assertServer() {
    await this.run(['show-options', '-g', '-v', 'exit-empty']);
  }

  async installCollaborativeBindings() {
    await this.run(['bind-key', '-T', 'prefix', 'T', 'switch-client', '-r']);
  }

  async assertSession(name) {
    validateSessionName(name);
    await this.run(['has-session', '-t', `=${name}`]);
  }

  async resolveCwd(value) {
    const requested = value === undefined || value === ''
      ? this.defaultCwd
      : (path.isAbsolute(value) ? value : path.resolve(this.defaultCwd, value));
    if (typeof requested !== 'string' || requested.includes('\0')) {
      throw new TerminalError('INVALID_CWD', 'cwd must be a valid path');
    }
    let canonical;
    try {
      canonical = await realpath(requested);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new TerminalError('INVALID_CWD', `cwd must resolve to a directory: ${requested} (${error.message})`);
    }
    return canonical;
  }

  async listSessionNames() {
    const { stdout } = await this.run(['list-sessions', '-F', '#{session_name}']);
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  async listSessions() {
    const names = await this.listSessionNames();
    const sessions = [];
    for (const name of names) sessions.push(await this.sessionInfo(name));
    return sessions;
  }

  async sessionInfo(name) {
    validateSessionName(name);
    const format = [
      '#{session_name}',
      '#{pid}',
      '#{pane_pid}',
      '#{pane_dead}',
      '#{pane_dead_status}',
      `#{${TRANSCRIPT_FINALIZED_OPTION}}`,
      `#{${ORIGINAL_DEAD_PID_OPTION}}`,
      `#{${ORIGINAL_DEAD_STATUS_OPTION}}`,
      '#{pane_width}',
      '#{pane_height}',
      '#{session_attached}',
    ].join('|');
    const { stdout } = await this.run(['display-message', '-p', '-t', `${name}:0.0`, format]);
    const { stdout: remainStdout } = await this.run([
      'show-options', '-w', '-t', `${name}:0`, '-v', 'remain-on-exit',
    ]);
    const [
      sessionName,
      serverPid,
      panePid,
      paneDead,
      paneDeadStatus,
      transcriptFinalized,
      originalDeadPid,
      originalDeadStatus,
      width,
      height,
      attachedClients,
    ] = stdout.trimEnd().split('|');
    const finalized = parseBoolean(transcriptFinalized);
    const preservedPid = Number(originalDeadPid);
    return {
      name: sessionName,
      serverPid: Number(serverPid),
      panePid: finalized && Number.isSafeInteger(preservedPid) && preservedPid > 0
        ? preservedPid
        : Number(panePid),
      paneDead: finalized ? true : parseBoolean(paneDead),
      paneDeadStatus: finalized ? parseStatus(originalDeadStatus) : parseStatus(paneDeadStatus),
      cols: Number(width),
      rows: Number(height),
      attachedClients: Number(attachedClients),
      remainOnExit: parseBoolean(remainStdout.trim()),
    };
  }

  async listClients() {
    const { stdout } = await this.run([
      'list-clients',
      '-F',
      '#{client_pid}|#{client_session}|#{client_tty}|#{client_readonly}|#{client_created}',
    ]);
    return stdout.split('\n').filter(Boolean).map((line) => {
      const [pid, session, tty, readOnly, created] = line.split('|');
      return { pid: Number(pid), session, tty, readOnly: readOnly === '1', created };
    });
  }

  async setCollaborativeClient(name, client) {
    await this.assertSession(name);
    if (!client || !Number.isSafeInteger(client.pid) || client.pid <= 0) {
      throw new TerminalError('INVALID_ARGUMENT', 'collaborative client pid must be a positive integer');
    }
    if (typeof client.tty !== 'string' || client.tty.length === 0) {
      throw new TerminalError('INVALID_ARGUMENT', 'collaborative client tty must be a non-empty string');
    }
    if (typeof client.created !== 'string' || client.created.length === 0) {
      throw new TerminalError('INVALID_ARGUMENT', 'collaborative client creation time is required');
    }
    if (client.session !== name) {
      throw new TerminalError('INVALID_ARGUMENT', `client ${client.pid} is not attached to session ${name}`);
    }
    await this.run(['set-option', '-t', name, COLLAB_CLIENT_PID_OPTION, String(client.pid)]);
    await this.run(['set-option', '-t', name, COLLAB_CLIENT_TTY_OPTION, client.tty]);
    await this.run(['set-option', '-t', name, COLLAB_CLIENT_CREATED_OPTION, client.created]);
    return { pid: client.pid, tty: client.tty, created: client.created };
  }

  async clearCollaborativeClient(name) {
    await this.assertSession(name);
    await this.run(['set-option', '-q', '-u', '-t', name, COLLAB_CLIENT_PID_OPTION]);
    await this.run(['set-option', '-q', '-u', '-t', name, COLLAB_CLIENT_TTY_OPTION]);
    await this.run(['set-option', '-q', '-u', '-t', name, COLLAB_CLIENT_CREATED_OPTION]);
  }

  async collaborativeClient(name, clients = undefined) {
    await this.assertSession(name);
    const { stdout } = await this.run([
      'display-message', '-p', '-t', `${name}:0.0`,
      `#{${COLLAB_CLIENT_PID_OPTION}}|#{${COLLAB_CLIENT_TTY_OPTION}}|#{${COLLAB_CLIENT_CREATED_OPTION}}`,
    ]);
    const [pidRaw, tty = '', created = ''] = stdout.trimEnd().split('|');
    const pid = Number(pidRaw);
    if (!Number.isSafeInteger(pid) || pid <= 0 || tty.length === 0 || created.length === 0) return null;

    const currentClients = clients ?? await this.listClients();
    const client = currentClients.find((candidate) => (
      candidate.session === name
      && candidate.pid === pid
      && candidate.tty === tty
      && candidate.created === created
    ));
    if (client) return client;

    await this.clearCollaborativeClient(name);
    return null;
  }

  async setClientReadOnly({ name, pid, tty, created, readOnly }) {
    validateSessionName(name);
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof tty !== 'string' || tty.length === 0
        || typeof created !== 'string' || created.length === 0) {
      throw new TerminalError('INVALID_ARGUMENT', 'client pid, tty, and creation time are required');
    }
    if (typeof readOnly !== 'boolean') {
      throw new TerminalError('INVALID_ARGUMENT', 'readOnly must be a boolean');
    }
    const findClient = async () => (await this.listClients()).find((client) => (
      client.session === name && client.pid === pid && client.tty === tty && client.created === created
    ));
    const before = await findClient();
    if (!before) {
      throw new TerminalError('HUMAN_CLIENT_NOT_FOUND', `collaborative human client is not attached to session ${name}`);
    }
    if (before.readOnly === readOnly) return before;

    await this.run(['switch-client', '-c', tty, '-t', `=${name}`, '-r']);
    const after = await findClient();
    if (!after || after.readOnly !== readOnly) {
      throw new TerminalError(
        'HUMAN_CLIENT_STATE_MISMATCH',
        `unable to make collaborative human client ${readOnly ? 'read-only' : 'writable'} for session ${name}`,
      );
    }
    return after;
  }

  async readSessionMetadata(name) {
    const file = path.join(this.sessionDir(name), 'session.json');
    try {
      const metadata = JSON.parse(await readFile(file, 'utf8'));
      if (!metadata || typeof metadata !== 'object' || metadata.name !== name) {
        throw new Error('invalid session metadata');
      }
      return metadata;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof TerminalError) throw error;
      throw new TerminalError('SESSION_STATE_CORRUPT', `unable to read session metadata for ${name}: ${error.message}`);
    }
  }

  async writeSessionMetadata(name, metadata) {
    const dir = this.sessionDir(name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const file = path.join(dir, 'session.json');
    const temp = path.join(dir, `.session.json.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(metadata)}\n`, { mode: 0o600, flag: 'wx' });
      await chmod(temp, 0o600);
      await rename(temp, file);
      await chmod(file, 0o600);
    } finally {
      await unlink(temp).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  async sessionState(name) {
    const metadata = await this.readSessionMetadata(name);
    if (!metadata || typeof metadata.generation !== 'string' || metadata.generation.length === 0) {
      throw new TerminalError('SESSION_STATE_CORRUPT', `session generation is unavailable for ${name}`);
    }
    const dataDir = metadata.dataLayout === 'generation'
      ? this.sessionDataDir(name, metadata.generation)
      : this.sessionDir(name);
    return { metadata, generation: metadata.generation, dataDir };
  }

  async sessionGeneration(name) {
    return (await this.sessionState(name)).generation;
  }

  async resetPriorIncarnationState(name) {
    const dir = this.sessionDir(name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    for (const file of ['session.json', 'model-cursor.json']) {
      await unlink(path.join(dir, file)).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  async hasTranscriptPipe(name) {
    validateSessionName(name);
    const { stdout } = await this.run([
      'display-message', '-p', '-t', `${name}:0.0`, '#{pane_pipe}',
    ]);
    return parseBoolean(stdout.trim());
  }

  async transcriptFinalizerState(name) {
    validateSessionName(name);
    const { stdout } = await this.run([
      'display-message', '-p', '-t', `${name}:0.0`, [
        '#{pane_id}',
        '#{pane_pid}',
        '#{pane_dead}',
        '#{pane_dead_status}',
        '#{pane_dead_signal}',
        '#{pane_pipe}',
        `#{${TRANSCRIPT_FINALIZED_OPTION}}`,
      ].join('|'),
    ]);
    const [paneId, panePid, paneDead, paneDeadStatus, paneDeadSignal, panePipe, finalized] = stdout.trimEnd().split('|');
    return {
      paneId,
      panePid,
      paneDead: parseBoolean(paneDead),
      paneDeadStatus,
      paneDeadSignal,
      panePipe: parseBoolean(panePipe),
      finalized: parseBoolean(finalized),
    };
  }

  transcriptFinalizerArgs({ paneId, panePid, paneDeadStatus, paneDeadSignal }) {
    const screenBuffer = `wsl-agent-transcript-finalizer-${paneId}`;
    const tmuxCommand = [
      shellQuote(this.tmuxBin),
      ...this.baseArgs().map(shellQuote),
    ].join(' ');
    const terminationCommand = [
      'stty -echo;',
      'read -r _;',
      'stty echo;',
      `${tmuxCommand} save-buffer -b ${shellQuote(screenBuffer)} - | sed '$d';`,
      `${tmuxCommand} delete-buffer -b ${shellQuote(screenBuffer)};`,
      `if [ -n "${paneDeadSignal}" ]; then`,
      `kill -s "${paneDeadSignal}" "$$";`,
      'else',
      `exit "${paneDeadStatus}";`,
      'fi',
    ].join(' ');
    return [
      'capture-pane', '-t', paneId, '-b', screenBuffer, ';',
      'set-option', '-p', '-t', paneId, TRANSCRIPT_FINALIZED_OPTION, '1', ';',
      'set-option', '-p', '-t', paneId, ORIGINAL_DEAD_PID_OPTION, panePid, ';',
      'set-option', '-p', '-t', paneId, ORIGINAL_DEAD_STATUS_OPTION, paneDeadStatus, ';',
      'respawn-pane', '-k', '-t', paneId, terminationCommand, ';',
      'pipe-pane', '-t', paneId, ';',
      'set-hook', '-p', '-u', '-t', paneId, TRANSCRIPT_FINALIZER_HOOK, ';',
      'send-keys', '-t', paneId, 'Enter',
    ];
  }

  async installTranscriptFinalizer(name) {
    validateSessionName(name);
    const args = this.transcriptFinalizerArgs({
      paneId: '#{pane_id}',
      panePid: '#{pane_pid}',
      paneDeadStatus: '#{pane_dead_status}',
      paneDeadSignal: '#{pane_dead_signal}',
    });
    const shellCommand = [
      shellQuote(this.tmuxBin),
      ...this.baseArgs().map(shellQuote),
      ...args.map(shellQuote),
    ].join(' ');
    const guardedCommand = `if [ -n "#{pane_dead_status}#{pane_dead_signal}" ]; then ${shellCommand}; fi`;
    await this.run([
      'set-hook', '-p', '-t', `${name}:0.0`, TRANSCRIPT_FINALIZER_HOOK,
      `run-shell -b ${shellQuote(guardedCommand)}`,
    ]);
  }

  async finalizeDeadTranscriptPipe(name, state = undefined) {
    validateSessionName(name);
    const original = state ?? await this.transcriptFinalizerState(name);
    if (!original.paneDead || !original.panePipe || original.finalized) return false;
    if (original.paneDeadStatus === '' && original.paneDeadSignal === '') return false;

    await this.run(this.transcriptFinalizerArgs(original));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const current = await this.transcriptFinalizerState(name);
      if (current.paneDead && !current.panePipe) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new TerminalError('TMUX_ERROR', `timed out finalizing transcript pipe for ${name}`);
  }

  async installTranscriptPipe(name, sessionDir = this.sessionDir(name)) {
    await ensureTranscript(sessionDir, { budgetBytes: this.transcriptBudgetBytes });
    const pipeCommand = [
      shellQuote(this.nodeBin),
      shellQuote(TRANSCRIPT_WRITER),
      shellQuote(sessionDir),
      shellQuote(String(this.transcriptBudgetBytes)),
    ].join(' ');
    await this.run(['pipe-pane', '-o', '-t', `${name}:0.0`, pipeCommand]);
  }

  async openSession({ name, command = '', cwd, cols = 80, rows = 24 }) {
    validateSessionName(name);
    const resolvedCols = asPositiveInteger(cols, 'cols', 80);
    const resolvedRows = asPositiveInteger(rows, 'rows', 24);
    const resolvedCwd = await this.resolveCwd(cwd);
    await this.ensureStateRoot();
    const existing = await this.listSessionNames();
    if (existing.includes(name)) {
      throw new TerminalError('SESSION_EXISTS', `session already exists: ${name}`);
    }
    if (typeof command !== 'string') {
      throw new TerminalError('INVALID_ARGUMENT', 'command must be a string when provided');
    }

    await this.resetPriorIncarnationState(name);
    const generation = crypto.randomUUID();
    const sessionDir = this.sessionDataDir(name, generation);
    await ensureTranscript(sessionDir, { budgetBytes: this.transcriptBudgetBytes });
    const token = crypto.randomUUID();
    const gatePath = path.join(sessionDir, `.start-gate.${token}`);
    const commandPath = path.join(sessionDir, `.start-command.${token}`);
    await writeFile(commandPath, command, { mode: 0o600 });
    await chmod(commandPath, 0o600);

    const paneCommand = [
      shellQuote(this.nodeBin),
      shellQuote(PANE_ENTRY),
      shellQuote(gatePath),
      shellQuote(commandPath),
    ].join(' ');
    let created = false;
    try {
      await this.run([
        'new-session', '-d', '-s', name,
        '-c', resolvedCwd,
        '-x', String(resolvedCols),
        '-y', String(resolvedRows),
        paneCommand,
      ]);
      created = true;
      await this.run(['set-option', '-w', '-t', `${name}:0`, 'remain-on-exit', 'on']);
      await this.run([
        'resize-window', '-t', `${name}:0`,
        '-x', String(resolvedCols), '-y', String(resolvedRows),
      ]);
      await this.installTranscriptPipe(name, sessionDir);
      await this.installTranscriptFinalizer(name);
      await this.writeSessionMetadata(name, {
        version: 2,
        name,
        generation,
        dataLayout: 'generation',
        cwd: resolvedCwd,
        createdAt: new Date().toISOString(),
      });
      await writeFile(gatePath, 'go\n', { mode: 0o600 });
      await chmod(gatePath, 0o600);
      return await this.sessionInfo(name);
    } catch (error) {
      if (created) {
        try { await this.run(['kill-session', '-t', name]); } catch {}
      }
      await Promise.allSettled([unlink(gatePath), unlink(commandPath)]);
      throw error;
    }
  }

  async reconcileSession(name) {
    validateSessionName(name);
    await this.ensureStateRoot();
    const info = await this.sessionInfo(name);
    await this.run([
      'resize-window', '-t', `${name}:0`,
      '-x', String(info.cols), '-y', String(info.rows),
    ]);
    const prior = await this.readSessionMetadata(name);
    const generation = typeof prior?.generation === 'string' && prior.generation.length > 0
      ? prior.generation
      : crypto.randomUUID();
    const dataLayout = prior?.dataLayout === 'generation' ? 'generation' : 'legacy-flat';
    const dataDir = dataLayout === 'generation'
      ? this.sessionDataDir(name, generation)
      : this.sessionDir(name);
    const finalizer = await this.transcriptFinalizerState(name);
    if (finalizer.paneDead) {
      await this.finalizeDeadTranscriptPipe(name, finalizer);
    } else {
      if (!finalizer.panePipe) await this.installTranscriptPipe(name, dataDir);
      await this.installTranscriptFinalizer(name);
    }
    await this.writeSessionMetadata(name, {
      ...prior,
      version: 2,
      name,
      generation,
      dataLayout,
      recoveredAt: new Date().toISOString(),
    });
    return this.sessionInfo(name);
  }

  async reconcileSessions() {
    await this.ensureStateRoot();
    const names = await this.listSessionNames();
    const sessions = [];
    for (const name of names) sessions.push(await this.reconcileSession(name));
    return sessions;
  }

  async send({ name, text, key }) {
    validateSessionName(name);
    const hasText = typeof text === 'string';
    const hasKey = typeof key === 'string' && key.length > 0;
    if (hasText === hasKey) {
      throw new TerminalError('INVALID_ARGUMENT', 'session.send requires exactly one of text or key');
    }
    if (hasText) {
      await this.run(['send-keys', '-l', '-t', `${name}:0.0`, '--', text]);
    } else {
      if (!/^[A-Za-z0-9_+^-]{1,32}$/.test(key)) {
        throw new TerminalError('INVALID_ARGUMENT', 'key contains unsupported tmux key syntax');
      }
      await this.run(['send-keys', '-t', `${name}:0.0`, key]);
    }
    return this.sessionInfo(name);
  }

  async resize({ name, cols, rows }) {
    validateSessionName(name);
    const resolvedCols = asPositiveInteger(cols, 'cols');
    const resolvedRows = asPositiveInteger(rows, 'rows');
    if (resolvedCols > 1000 || resolvedRows > 1000) {
      throw new TerminalError('INVALID_ARGUMENT', 'terminal dimensions must be <= 1000');
    }
    await this.run([
      'resize-window', '-t', `${name}:0`,
      '-x', String(resolvedCols), '-y', String(resolvedRows),
    ]);
    return this.sessionInfo(name);
  }

  async captureScreen(name) {
    validateSessionName(name);
    const { stdout } = await this.run(['capture-pane', '-p', '-t', `${name}:0.0`], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  }

  async closeSession(name) {
    validateSessionName(name);
    await this.run(['kill-session', '-t', name]);
    return { name, closed: true };
  }
}
