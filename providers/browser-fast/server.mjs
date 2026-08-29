import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureWindowsChrome } from '../browser/windows-chrome-runtime.mjs';
import { resolveLinuxBrowserBackend } from './browser-backend-config.mjs';
import { ManagedClearcoteRuntime } from './clearcote-runtime.mjs';
import { resolveBrowserMemory } from './browser-memory.mjs';

export const AGENT_BROWSER_VERSION = '0.35.0';
export const DEFAULT_SESSION_PREFIX = 'mcp-browser-fast';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_BROWSER_JS = path.join(DIR, 'node_modules', 'agent-browser', 'bin', 'agent-browser.js');
const WINDOWS_AGENT_BROWSER_SOURCE = path.join(DIR, 'node_modules', 'agent-browser', 'bin', 'agent-browser-win32-x64.exe');
const WINDOWS_RUNNER_SOURCE = path.join(DIR, 'windows-runner.cjs');
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const AGENT_BROWSER_MAX_OUTPUT_CHARS = 262144;
const DEFAULT_BROWSER_ARTIFACTS_FILE = path.join(os.homedir(), '.config', 'mcp-dev-bridge', 'browser-artifacts.json');

function fastError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw fastError('INVALID_ARGUMENT', `${name} must be a non-empty string`);
  return value;
}

function managedTargetPoint(box, humanize) {
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (!humanize || box.width < 6 || box.height < 6) return center;
  const centralSample = () => (Math.random() + Math.random() + Math.random()) / 3;
  return {
    x: box.x + box.width * (0.2 + centralSample() * 0.6),
    y: box.y + box.height * (0.2 + centralSample() * 0.6)
  };
}

function localDelay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function targetName(value) {
  const target = value ?? 'windows';
  if (target !== 'windows' && target !== 'linux') throw fastError('INVALID_BROWSER_TARGET', `expected windows or linux, got ${String(target)}`);
  return target;
}

function artifactName(value) {
  const name = requiredString(value, 'upload.artifact');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw fastError('INVALID_ARGUMENT', 'upload.artifact must contain only letters, numbers, dot, underscore, or hyphen');
  return name;
}

async function resolveApprovedArtifact(name, manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw fastError('BROWSER_FAST_ARTIFACTS_UNAVAILABLE', `approved artifact manifest not found: ${manifestPath}`);
    throw fastError('BROWSER_FAST_ARTIFACTS_INVALID', `could not read approved artifact manifest: ${manifestPath}`, error);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw fastError('BROWSER_FAST_ARTIFACTS_INVALID', 'approved artifact manifest must be a JSON object');
  }
  const configured = manifest[name];
  if (typeof configured !== 'string' || configured.length === 0) {
    throw fastError('BROWSER_FAST_ARTIFACT_NOT_APPROVED', `artifact is not approved: ${name}`);
  }
  if (!path.isAbsolute(configured)) throw fastError('BROWSER_FAST_ARTIFACTS_INVALID', `artifact path must be absolute: ${name}`);
  let resolved;
  try {
    resolved = await fs.realpath(configured);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error('not a regular file');
  } catch (error) {
    throw fastError('BROWSER_FAST_ARTIFACT_UNAVAILABLE', `approved artifact is unavailable: ${name}`, error);
  }
  return resolved;
}

function withoutLifecycle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { lifecycle: _lifecycle, ...rest } = value;
  return rest;
}

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function errorResult(error) {
  const code = typeof error?.code === 'string' ? error.code : 'BROWSER_FAST_FAILED';
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.startsWith(`${code}: `) ? raw.slice(code.length + 2) : raw;
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } }
  };
}

async function runProcess(command, args, { cwd, env, input, acceptNonZero = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const overflow = stream => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(fastError('BROWSER_FAST_OUTPUT_LIMIT', `${stream} exceeded ${MAX_OUTPUT_BYTES} bytes`));
    };

    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) return overflow('stdout');
      stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) return overflow('stderr');
      stderr.push(chunk);
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      reject(fastError('BROWSER_FAST_PROCESS_FAILED', `failed to start ${command}`, error));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      const result = {
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim()
      };
      if (result.code !== 0 && !acceptNonZero) {
        reject(fastError('BROWSER_FAST_COMMAND_FAILED', result.stderr || result.stdout || `${command} exited ${result.code}`));
        return;
      }
      resolve(result);
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function parseAgentBrowserBatch(result) {
  let items;
  try {
    items = JSON.parse(result.stdout || '[]');
  } catch (error) {
    throw fastError('BROWSER_FAST_INVALID_OUTPUT', result.stderr || 'agent-browser batch returned invalid JSON', error);
  }
  if (!Array.isArray(items)) throw fastError('BROWSER_FAST_INVALID_OUTPUT', 'agent-browser batch did not return an array');
  if (result.code !== 0 && items.length === 0) {
    throw fastError('BROWSER_FAST_COMMAND_FAILED', result.stderr || 'agent-browser batch failed before producing a step result');
  }
  return { items, stderr: result.stderr, exitCode: result.code };
}

export class AgentBrowserRunner {
  constructor({
    env = process.env,
    processRunner = runProcess,
    windowsSource = WINDOWS_AGENT_BROWSER_SOURCE,
    windowsRunnerSource = WINDOWS_RUNNER_SOURCE,
    windowsChromeEnsure,
    linuxBackendResolve = resolveLinuxBrowserBackend,
    clearcoteRuntime = new ManagedClearcoteRuntime()
  } = {}) {
    this.env = env;
    this.processRunner = processRunner;
    this.windowsSource = windowsSource;
    this.windowsRunnerSource = windowsRunnerSource;
    this.windowsChromeEnsure = windowsChromeEnsure ?? (() => ensureWindowsChrome({ processRunner: this.processRunner }));
    this.linuxBackendResolve = linuxBackendResolve;
    this.clearcoteRuntime = clearcoteRuntime;
    this.windowsAgentRuntimePromise = null;
    this.linuxSessions = new Map();
  }

  async windowsAgentRuntime(chrome) {
    if (!this.windowsAgentRuntimePromise) {
      this.windowsAgentRuntimePromise = (async () => {
        const runtimeDir = path.join(chrome.localAppData, 'mcp-dev-bridge', 'agent-browser', AGENT_BROWSER_VERSION);
        const windowsRuntimeDir = `${chrome.windowsLocalAppData}\\mcp-dev-bridge\\agent-browser\\${AGENT_BROWSER_VERSION}`;
        const executable = path.join(runtimeDir, 'agent-browser.exe');
        const helper = path.join(runtimeDir, 'windows-runner.cjs');
        const sourceStat = await fs.stat(this.windowsSource);
        let install = false;
        try {
          install = (await fs.stat(executable)).size !== sourceStat.size;
        } catch {
          install = true;
        }
        await fs.mkdir(runtimeDir, { recursive: true });
        if (install) await fs.copyFile(this.windowsSource, executable);
        await fs.copyFile(this.windowsRunnerSource, helper);
        return {
          executable,
          helper,
          nodeExecutable: chrome.nodeExecutable,
          windowsExecutable: `${windowsRuntimeDir}\\agent-browser.exe`,
          windowsHelper: `${windowsRuntimeDir}\\windows-runner.cjs`
        };
      })().catch(error => {
        this.windowsAgentRuntimePromise = null;
        throw error;
      });
    }
    return this.windowsAgentRuntimePromise;
  }

  async windowsRuntime() {
    const chrome = await this.windowsChromeEnsure();
    return { ...chrome, ...(await this.windowsAgentRuntime(chrome)) };
  }

  async runWindowsAgentBrowser(runtime, args, { input, acceptNonZero = false } = {}) {
    const wrapped = await this.processRunner(runtime.nodeExecutable, [
      runtime.windowsHelper,
      runtime.windowsExecutable,
      JSON.stringify(args),
      String(MAX_OUTPUT_BYTES)
    ], {
      cwd: '/mnt/c',
      input,
      acceptNonZero: true
    });
    let result;
    try {
      result = JSON.parse(wrapped.stdout || '{}');
    } catch (error) {
      throw fastError('WINDOWS_AGENT_BROWSER_HELPER_INVALID', wrapped.stderr || 'Windows Agent Browser helper returned invalid JSON', error);
    }
    if (wrapped.code !== 0 || result?.error) {
      throw fastError('WINDOWS_AGENT_BROWSER_HELPER_FAILED', result?.error || wrapped.stderr || `Windows Agent Browser helper exited ${wrapped.code}`);
    }
    const normalized = {
      code: Number.isInteger(result?.code) ? result.code : -1,
      signal: result?.signal ?? null,
      stdout: typeof result?.stdout === 'string' ? result.stdout : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr : ''
    };
    if (normalized.code !== 0 && !acceptNonZero) {
      throw fastError('BROWSER_FAST_COMMAND_FAILED', normalized.stderr || normalized.stdout || `agent-browser exited ${normalized.code}`);
    }
    return normalized;
  }

  async windowsBatch(commands, { bail = true } = {}) {
    const runtime = await this.windowsRuntime();
    const args = [
      '--session', `${DEFAULT_SESSION_PREFIX}-windows`,
      '--cdp', runtime.wsEndpoint,
      '--pin-tab',
      '--idle-timeout', '0',
      '--max-output', String(AGENT_BROWSER_MAX_OUTPUT_CHARS),
      'batch'
    ];
    if (bail) args.push('--bail');
    args.push('--json');
    const result = await this.runWindowsAgentBrowser(runtime, args, {
      input: JSON.stringify(commands),
      acceptNonZero: true
    });
    return parseAgentBrowserBatch(result);
  }

  async linuxAgentBatch(backend, commands, { bail = true } = {}) {
    const session = backend.session;
    const env = { ...this.env, AGENT_BROWSER_NO_XVFB: '1' };
    if (backend.cdp !== undefined) {
      delete env.AGENT_BROWSER_EXECUTABLE_PATH;
      delete env.AGENT_BROWSER_PROFILE;
      delete env.AGENT_BROWSER_ARGS;
    }
    this.linuxSessions.set(session, env);
    const idleTimeout = backend.browser === 'clearcote' && backend.managed === true ? '0' : '1h';
    const args = [
      AGENT_BROWSER_JS,
      '--session', session,
      ...(backend.cdp === undefined ? [] : ['--cdp', backend.cdp]),
      '--headed',
      '--pin-tab',
      '--idle-timeout', idleTimeout,
      '--max-output', String(AGENT_BROWSER_MAX_OUTPUT_CHARS),
      'batch'
    ];
    if (bail) args.push('--bail');
    args.push('--json');
    const result = await this.processRunner(process.execPath, args, {
      env,
      input: JSON.stringify(commands),
      acceptNonZero: true
    });
    return parseAgentBrowserBatch(result);
  }

  isManagedClearcoteCommand(command) {
    const op = command?.[0];
    return ['click', 'fill', 'type', 'check', 'uncheck', 'select', 'press', 'hover', 'drag'].includes(op)
      || (op === 'mouse' && command?.[1] === 'wheel');
  }

  async activeManagedPage(backend) {
    const listed = await this.linuxAgentBatch(backend, [['tab', 'list']], { bail: true });
    const item = listed.items[0];
    if (item?.success !== true) throw fastError('BROWSER_FAST_COMMAND_FAILED', item?.error || 'failed to inspect current tab');
    const tabs = item.result?.tabs ?? [];
    const active = tabs.find(tab => tab.active === true) ?? tabs[0];
    const targetId = active?.targetId ?? active?.tabId;
    if (!targetId) throw fastError('BROWSER_FAST_COMMAND_FAILED', 'browser has no active tab');
    return this.clearcoteRuntime.pageForTarget(targetId);
  }

  async managedRefBox(backend, ref) {
    const batch = await this.linuxAgentBatch(backend, [['get', 'box', ref]], { bail: true });
    const item = batch.items[0];
    if (item?.success !== true) return { error: item?.error || `could not resolve ${ref}` };
    const box = item.result ?? {};
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return { error: `invalid bounding box for ${ref}` };
    return { box };
  }

  async managedFocus(backend, ref) {
    const batch = await this.linuxAgentBatch(backend, [['focus', ref]], { bail: true });
    const item = batch.items[0];
    return item?.success === true ? null : item?.error || `could not focus ${ref}`;
  }

  async managedClearcoteCommand(backend, command) {
    const op = command[0];
    const humanize = backend.profile?.humanize === true;
    const fail = error => ({ command, success: false, error });
    const uncertain = error => ({ command, success: false, uncertain: true, error });
    let page;
    try {
      page = await this.activeManagedPage(backend);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    try {
      if (op === 'click' || op === 'hover') {
        const ref = command[1];
        const focusError = await this.managedFocus(backend, ref);
        if (!focusError) {
          const focused = page.locator(':focus');
          if (await focused.count() === 1) {
            if (op === 'click') await focused.click();
            else await focused.hover();
            return { command, success: true, error: null, result: { target: ref } };
          }
        }

        const resolved = await this.managedRefBox(backend, ref);
        if (resolved.error) return fail(focusError || resolved.error);
        const point = managedTargetPoint(resolved.box, humanize);
        if (op === 'click') await page.mouse.click(point.x, point.y);
        else await page.mouse.move(point.x, point.y);
        return { command, success: true, error: null, result: { target: ref } };
      }

      if (op === 'drag') {
        const source = await this.managedRefBox(backend, command[1]);
        if (source.error) return fail(source.error);
        const destination = await this.managedRefBox(backend, command[2]);
        if (destination.error) return fail(destination.error);
        const sourcePoint = managedTargetPoint(source.box, humanize);
        const destinationPoint = managedTargetPoint(destination.box, humanize);
        const persona = humanize ? page._clearcotePersona : null;
        const heldGlide = humanize ? page._clearcoteHeldGlide : null;
        await page.mouse.move(sourcePoint.x, sourcePoint.y);
        if (humanize) await localDelay(100 + Math.random() * 100);
        await page.mouse.down();
        try {
          if (persona) await localDelay(persona.grabMinMs + Math.random() * (persona.grabMaxMs - persona.grabMinMs));
          if (typeof heldGlide === 'function') await heldGlide(destinationPoint.x, destinationPoint.y);
          else await page.mouse.move(destinationPoint.x, destinationPoint.y);
          if (persona) await localDelay(persona.releaseMinMs + Math.random() * (persona.releaseMaxMs - persona.releaseMinMs));
        } finally {
          await page.mouse.up();
        }
        return { command, success: true, error: null, result: { source: command[1], destination: command[2] } };
      }

      if (op === 'mouse' && command[1] === 'wheel') {
        await page.mouse.wheel(Number(command[3]), Number(command[2]));
        return { command, success: true, error: null, result: { delta_y: Number(command[2]), delta_x: Number(command[3]) } };
      }

      if (op === 'press') {
        await page.keyboard.press(command[1]);
        return { command, success: true, error: null, result: { key: command[1] } };
      }

      if (['fill', 'type', 'check', 'uncheck', 'select'].includes(op)) {
        const ref = command[1];
        const focusError = await this.managedFocus(backend, ref);
        if (focusError) return fail(focusError);
        const focused = page.locator(':focus');
        if (op === 'fill') await focused.fill(command[2]);
        else if (op === 'type') {
          if (humanize) await focused.hover();
          await focused.type(command[2]);
        }
        else if (op === 'check') await focused.check();
        else if (op === 'uncheck') await focused.uncheck();
        else await focused.selectOption(command[2]);
        return { command, success: true, error: null, result: { target: ref } };
      }

      return null;
    } catch (error) {
      return uncertain(error instanceof Error ? error.message : String(error));
    }
  }

  async managedLinuxBatch(backend, commands, { bail = true } = {}) {
    const items = [];
    const stderr = [];
    let exitCode = 0;
    let index = 0;

    while (index < commands.length) {
      if (this.isManagedClearcoteCommand(commands[index])) {
        const item = await this.managedClearcoteCommand(backend, commands[index]);
        items.push(item);
        if (item?.success !== true) {
          exitCode = 1;
          if (bail) break;
        }
        index += 1;
        continue;
      }

      let end = index + 1;
      while (end < commands.length && !this.isManagedClearcoteCommand(commands[end])) end += 1;
      const batch = await this.linuxAgentBatch(backend, commands.slice(index, end), { bail });
      items.push(...batch.items);
      if (batch.stderr) stderr.push(batch.stderr);
      if (batch.exitCode !== 0) exitCode = batch.exitCode;
      if (bail && batch.items.some(item => item?.success !== true)) break;
      index = end;
    }

    return { items, stderr: stderr.join('\n'), exitCode };
  }

  async linuxBatch(commands, { bail = true } = {}) {
    const selected = await this.linuxBackendResolve();
    if (selected.managed === true) {
      const runtime = await this.clearcoteRuntime.ensure(selected);
      const backend = { ...selected, cdp: runtime.cdp };
      return this.managedLinuxBatch(backend, commands, { bail });
    }
    await this.clearcoteRuntime.close();
    return this.linuxAgentBatch(selected, commands, { bail });
  }

  async targetBatch(target, commands, options) {
    return target === 'windows'
      ? this.windowsBatch(commands, options)
      : this.linuxBatch(commands, options);
  }

  async pathForTarget(target, file) {
    if (target !== 'windows') return file;
    const translated = await this.processRunner('wslpath', ['-w', file]);
    if (!translated.stdout) throw fastError('BROWSER_FAST_ARTIFACT_PATH_FAILED', `could not translate artifact path for Windows: ${file}`);
    return translated.stdout;
  }

  async batch(target, commands, { bail = true, tab } = {}) {
    if (tab !== undefined) {
      try {
        const requestedTab = requiredString(tab, 'tab');
        const listing = await this.targetBatch(target, [['tab', 'list']], { bail: true });
        const listed = listing.items[0];
        if (listed?.success !== true) {
          return { items: [], stderr: listing.stderr, exitCode: 1, contextError: listed?.error || 'failed to inspect current tab context' };
        }
        const tabs = listed.result?.tabs ?? [];
        const current = tabs.find(item => item.active === true) ?? tabs[0];
        const currentTab = current?.targetId ?? current?.tabId;
        if (!currentTab || currentTab !== requestedTab) {
          return {
            items: [],
            stderr: listing.stderr,
            exitCode: 1,
            contextError: `TAB_CONTEXT_MISMATCH: requested ${requestedTab}, current ${currentTab ?? 'none'}; observe the intended tab before executing`
          };
        }
      } catch (error) {
        return { items: [], stderr: '', exitCode: 1, contextError: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      return await this.targetBatch(target, commands, { bail });
    } catch (error) {
      if (target !== 'windows') throw error;
      const message = error instanceof Error ? error.message : String(error);
      return {
        items: commands.map(command => ({ command, success: false, uncertain: true, error: message })),
        stderr: '',
        exitCode: 1
      };
    }
  }

  async close() {
    const sessions = [...this.linuxSessions];
    this.linuxSessions.clear();
    await Promise.all(sessions.map(([session, env]) => this.processRunner(process.execPath, [
      AGENT_BROWSER_JS,
      '--session', session,
      'close'
    ], { env, acceptNonZero: true }).catch(() => {})));
    await this.clearcoteRuntime.close();
  }
}

function snapshotCommand(scope, includeUrls) {
  const command = ['snapshot'];
  if (scope === 'interactive') command.push('-i');
  else if (scope === 'compact') command.push('-c', '-d', '6');
  else if (scope !== 'full') throw fastError('INVALID_ARGUMENT', `unknown observe scope: ${String(scope)}`);
  if (includeUrls) command.push('-u');
  return command;
}

function directRef(value, name) {
  const ref = requiredString(value, name);
  return ref.startsWith('e') && /^e\d+$/.test(ref) ? `@${ref}` : ref;
}

function directTarget(action) {
  return directRef(action.target, `${action.op}.target`);
}

export function actionCommand(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw fastError('INVALID_ARGUMENT', 'each action must be an object');
  const op = requiredString(action.op, 'action.op');
  switch (op) {
    case 'navigate': return ['open', requiredString(action.url, 'navigate.url')];
    case 'back': return ['back'];
    case 'forward': return ['forward'];
    case 'reload': return ['reload'];
    case 'click': return ['click', directTarget(action)];
    case 'fill': return ['fill', directTarget(action), requiredString(action.value, 'fill.value')];
    case 'type': return ['type', directTarget(action), requiredString(action.value, 'type.value')];
    case 'check': return ['check', directTarget(action)];
    case 'uncheck': return ['uncheck', directTarget(action)];
    case 'upload': return ['upload', directTarget(action), requiredString(action.file, 'upload.file')];
    case 'select': {
      if (!Array.isArray(action.values) || action.values.length !== 1 || typeof action.values[0] !== 'string') {
        throw fastError('INVALID_ARGUMENT', 'select.values must contain exactly one string');
      }
      return ['select', directTarget(action), action.values[0]];
    }
    case 'press': return ['press', requiredString(action.key, 'press.key')];
    case 'hover': return ['hover', directTarget(action)];
    case 'drag': return ['drag', directTarget(action), directRef(action.destination, 'drag.destination')];
    case 'scroll': {
      const deltaX = action.delta_x ?? 0;
      const deltaY = action.delta_y ?? 0;
      if (!Number.isInteger(deltaX) || !Number.isInteger(deltaY) || (deltaX === 0 && deltaY === 0)) {
        throw fastError('INVALID_ARGUMENT', 'scroll requires integer delta_x/delta_y with at least one non-zero value');
      }
      return ['mouse', 'wheel', String(deltaY), String(deltaX)];
    }
    case 'wait': {
      const modes = [action.text !== undefined, action.milliseconds !== undefined].filter(Boolean).length;
      if (modes !== 1) throw fastError('INVALID_ARGUMENT', 'wait requires exactly one of text or milliseconds');
      if (action.text !== undefined) return ['wait', '--text', requiredString(action.text, 'wait.text')];
      if (!Number.isInteger(action.milliseconds) || action.milliseconds < 0) throw fastError('INVALID_ARGUMENT', 'wait.milliseconds must be a non-negative integer');
      return ['wait', String(action.milliseconds)];
    }
    case 'tab_list': return ['tab', 'list'];
    case 'tab_new': return action.url === undefined ? ['tab', 'new'] : ['tab', 'new', requiredString(action.url, 'tab_new.url')];
    case 'tab_switch': return ['tab', requiredString(action.tab, 'tab_switch.tab')];
    case 'tab_close': return action.tab === undefined ? ['tab', 'close'] : ['tab', 'close', requiredString(action.tab, 'tab_close.tab')];
    default: throw fastError('INVALID_ARGUMENT', `unsupported action op: ${op}`);
  }
}

export class FastBrowser {
  constructor({ runner = new AgentBrowserRunner(), memoryRoot, artifactManifestPath = DEFAULT_BROWSER_ARTIFACTS_FILE } = {}) {
    if (!runner || typeof runner.batch !== 'function') throw new TypeError('runner with batch() is required');
    this.runner = runner;
    this.memoryRoot = memoryRoot;
    this.artifactManifestPath = artifactManifestPath;
    this.operationTails = new Map();
  }

  async withTargetLock(target, operation) {
    const previous = this.operationTails.get(target) ?? Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.operationTails.set(target, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(target) === tail) this.operationTails.delete(target);
    }
  }

  async close() {
    if (typeof this.runner.close === 'function') await this.runner.close();
  }

  async listTabsUnlocked(target, options = {}) {
    const listed = await this.runner.batch(target, [['tab', 'list']], { bail: true, ...options });
    if (listed.contextError) return { error: listed.contextError };
    const item = listed.items[0];
    if (item?.success !== true) return { error: item?.error || 'tab list failed' };
    return { tabs: item.result?.tabs ?? [] };
  }

  async observeUnlocked(target, { scope = 'interactive', include_urls = true, tab } = {}) {
    let selectedTab = tab === undefined ? undefined : requiredString(tab, 'tab');
    if (selectedTab === undefined) {
      const listed = await this.listTabsUnlocked(target);
      if (listed.error) throw fastError('BROWSER_FAST_OBSERVE_FAILED', listed.error);
      const tabs = listed.tabs;
      const current = tabs.find(item => item.active === true) ?? tabs[0];
      selectedTab = current?.targetId ?? current?.tabId;
      if (!selectedTab) throw fastError('BROWSER_FAST_OBSERVE_FAILED', 'browser has no tab available');
    }
    const selected = await this.runner.batch(target, [['tab', selectedTab]], { bail: true });
    if (selected.contextError) throw fastError('BROWSER_FAST_OBSERVE_FAILED', selected.contextError);
    const selectedItem = selected.items[0];
    if (selectedItem?.success !== true) throw fastError('BROWSER_FAST_OBSERVE_FAILED', selectedItem?.error || `failed to select tab ${selectedTab}`);

    const commands = [snapshotCommand(scope, include_urls), ['tab', 'list']];
    const batch = await this.runner.batch(target, commands, { bail: true });
    if (batch.contextError) throw fastError('BROWSER_FAST_OBSERVE_FAILED', batch.contextError);
    const { items } = batch;
    if (items.some(item => item?.success !== true)) {
      const failed = items.find(item => item?.success !== true);
      throw fastError('BROWSER_FAST_OBSERVE_FAILED', failed?.error || 'observe command failed');
    }
    const snapshotItem = items[0]?.result ?? {};
    const tabItem = items[1]?.result ?? {};
    const tabs = (tabItem.tabs ?? []).map(item => ({
      tab_id: item.targetId ?? item.tabId,
      target_id: item.targetId,
      active: item.active === true,
      title: item.title,
      url: item.url
    }));
    const origin = snapshotItem.origin ?? tabs.find(item => item.active)?.url ?? null;
    const memory = await resolveBrowserMemory(origin, { root: this.memoryRoot });
    return {
      browser_target: target,
      active_tab: tabs.find(item => item.active)?.tab_id ?? null,
      origin,
      snapshot: snapshotItem.snapshot ?? '',
      refs: snapshotItem.refs ?? {},
      tabs,
      memory
    };
  }

  async observe({ browser_target, scope = 'interactive', include_urls = true, tab } = {}) {
    const target = targetName(browser_target);
    return this.withTargetLock(target, () => this.observeUnlocked(target, { scope, include_urls, tab }));
  }

  async execute({ browser_target, actions, stop_on_error = true, final_state = 'interactive', tab } = {}) {
    const target = targetName(browser_target);
    const requestedTab = requiredString(tab, 'tab');
    if (!Array.isArray(actions) || actions.length === 0) throw fastError('INVALID_ARGUMENT', 'actions must be a non-empty array');
    const preparedActions = [];
    for (const action of actions) {
      if (action?.op !== 'upload') {
        preparedActions.push(action);
        continue;
      }
      const artifact = artifactName(action.artifact);
      const approvedPath = await resolveApprovedArtifact(artifact, this.artifactManifestPath);
      const file = typeof this.runner.pathForTarget === 'function'
        ? await this.runner.pathForTarget(target, approvedPath)
        : approvedPath;
      preparedActions.push({ ...action, file });
    }
    const actionCommands = preparedActions.map(actionCommand);

    return this.withTargetLock(target, async () => {
      const initial = await this.listTabsUnlocked(target, { tab: requestedTab });
      if (initial.error) {
        return {
          browser_target: target,
          outcome: 'failed',
          context_error: initial.error,
          steps: actions.map((action, index) => ({ index, op: action.op, status: 'not_run' }))
        };
      }

      const items = new Array(actions.length);
      let transitionError;
      let index = 0;

      while (index < actionCommands.length && !transitionError) {
        const relativeClick = actionCommands.slice(index).findIndex(command => command[0] === 'click');
        const clickIndex = relativeClick === -1 ? actionCommands.length : index + relativeClick;

        if (clickIndex > index) {
          const batch = await this.runner.batch(target, actionCommands.slice(index, clickIndex), {
            bail: stop_on_error !== false
          });
          if (batch.contextError) {
            transitionError = batch.contextError;
            break;
          }
          for (let itemIndex = 0; itemIndex < clickIndex - index; itemIndex += 1) {
            items[index + itemIndex] = batch.items[itemIndex];
          }
          if (stop_on_error !== false && batch.items.some(item => item?.success !== true)) break;
          index = clickIndex;
        }

        if (index >= actionCommands.length) break;

        const before = index === 0 ? initial : await this.listTabsUnlocked(target);
        if (before.error) {
          transitionError = `failed to inspect tabs before click: ${before.error}`;
          break;
        }
        const beforeIds = new Set(before.tabs.map(item => item.targetId ?? item.tabId).filter(Boolean));
        const click = await this.runner.batch(target, [actionCommands[index]], { bail: true });
        if (click.contextError) {
          transitionError = click.contextError;
          break;
        }
        const clickItem = click.items[0];
        items[index] = clickItem;
        index += 1;

        if (clickItem?.success === true || clickItem?.uncertain === true) {
          const after = await this.listTabsUnlocked(target);
          if (after.error) {
            transitionError = `click completed but new-tab detection failed: ${after.error}`;
            break;
          }
          const newTabs = after.tabs.filter(item => {
            const id = item.targetId ?? item.tabId;
            return id && !beforeIds.has(id);
          });
          if (newTabs.length > 1) {
            transitionError = `click opened multiple new tabs (${newTabs.length}); refusing to choose one`;
            break;
          }
          if (newTabs.length === 1) {
            const newTab = newTabs[0].targetId ?? newTabs[0].tabId;
            const selected = await this.runner.batch(target, [['tab', newTab]], { bail: true });
            const selectedItem = selected.items[0];
            if (selected.contextError || selectedItem?.success !== true) {
              transitionError = `click opened tab ${newTab}, but binding it failed: ${selected.contextError || selectedItem?.error || 'tab selection failed'}`;
              break;
            }
          }
        }

        if (stop_on_error !== false && clickItem?.success !== true) break;
      }

      const steps = actions.map((action, index) => {
        const item = items[index];
        if (!item) return { index, op: action.op, status: 'not_run' };
        if (item.success === true) return { index, op: action.op, status: 'completed', result: withoutLifecycle(item.result) };
        if (item.uncertain === true) return { index, op: action.op, status: 'unknown', error: item.error || 'action outcome is uncertain' };
        return { index, op: action.op, status: 'failed', error: item.error || 'browser action failed' };
      });
      const failedAt = steps.find(step => step.status === 'failed' || step.status === 'unknown')?.index;
      const completedCount = steps.filter(step => step.status === 'completed').length;
      const hasUnknown = steps.some(step => step.status === 'unknown');
      const outcome = hasUnknown
        ? completedCount > 0 ? 'partial' : 'unknown'
        : completedCount === 0 && (failedAt !== undefined || transitionError)
          ? 'failed'
          : failedAt !== undefined || transitionError || steps.some(step => step.status === 'not_run')
            ? 'partial'
            : 'completed';

      let finalState;
      let finalStateError;
      if (final_state !== 'none') {
        try {
          if (!['interactive', 'compact', 'full'].includes(final_state)) throw fastError('INVALID_ARGUMENT', `unknown final_state: ${String(final_state)}`);
          finalState = await this.observeUnlocked(target, {
            scope: final_state,
            include_urls: true
          });
        } catch (error) {
          finalStateError = error instanceof Error ? error.message : String(error);
        }
      }

      return {
        browser_target: target,
        outcome,
        failed_at: failedAt,
        transition_error: transitionError,
        steps,
        final_state: finalState,
        final_state_error: finalStateError
      };
    });
  }
}

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: ['navigate', 'back', 'forward', 'reload', 'click', 'fill', 'type', 'check', 'uncheck', 'upload', 'select', 'press', 'hover', 'drag', 'scroll', 'wait', 'tab_list', 'tab_new', 'tab_switch', 'tab_close']
    },
    target: { type: 'string', minLength: 1, description: 'Opaque element ref/uid from the latest observe result. Do not invent CSS/XPath selectors.' },
    value: { type: 'string' },
    artifact: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9._-]+$', description: 'Logical approved artifact name from the local browser-artifacts manifest; arbitrary filesystem paths are not accepted.' },
    values: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1 },
    key: { type: 'string', minLength: 1 },
    destination: { type: 'string', minLength: 1, description: 'Opaque destination element ref/uid from the latest observe result for drag.' },
    delta_x: { type: 'integer', description: 'Horizontal wheel delta in CSS pixels; positive scrolls right.' },
    delta_y: { type: 'integer', description: 'Vertical wheel delta in CSS pixels; positive scrolls down.' },
    text: { type: 'string', minLength: 1 },
    url: { type: 'string', minLength: 1 },
    milliseconds: { type: 'integer', minimum: 0 },
    tab: { type: 'string', minLength: 1 }
  },
  required: ['op'],
  additionalProperties: false
};

export function createBrowserFastServer({ browser } = {}) {
  if (!browser || typeof browser.observe !== 'function' || typeof browser.execute !== 'function') {
    throw new TypeError('browser with observe() and execute() is required');
  }
  const server = new Server(
    { name: 'browser-fast', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Fast resource-local browser interaction. Observe once for stable refs/tabs plus bounded local site memory, execute mechanical sequences locally, and never assume failed or partial batches are safe to replay.'
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    {
      name: 'observe',
      description: 'Return compact interactive browser state with stable tab IDs, element refs, and bounded read-only local policy/site/platform memory for the current URL when available. Unknown sites remain valid with empty memory.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          browser_target: { type: 'string', enum: ['windows', 'linux'], description: 'Omit for the dedicated persistent Windows MCP Chrome profile; use linux for the configured Linux browser backend (managed Chrome or managed Clearcote).' },
          scope: { type: 'string', enum: ['interactive', 'compact', 'full'], default: 'interactive' },
          include_urls: { type: 'boolean', default: true },
          tab: { type: 'string', minLength: 1, description: 'Optional stable tab ID or CDP target ID to select before observing.' }
        },
        additionalProperties: false
      }
    },
    {
      name: 'execute',
      description: 'Execute multiple mechanical browser actions locally in one call, including hover, wheel scroll, drag, and upload by logical approved artifact name rather than arbitrary path. Managed Clearcote routes supported input through its humanized Playwright layer while Agent Browser keeps refs and tab identity. After a click, exactly one new tab is followed before later actions; multiple new tabs stop the sequence without guessing. Defaults to fail-fast, never auto-retries, and reports completed/failed/unknown/not-run steps plus final compact state so partial external side effects are explicit.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          browser_target: { type: 'string', enum: ['windows', 'linux'], description: 'Omit for the dedicated persistent Windows MCP Chrome profile; use linux for the configured Linux browser backend (managed Chrome or managed Clearcote).' },
          tab: { type: 'string', minLength: 1, description: 'Required tab ID from the latest observe result. Execution validates that the pinned Agent Browser session is still on this exact tab and fails closed on mismatch; it does not switch tabs.' },
          actions: { type: 'array', items: ACTION_SCHEMA, minItems: 1, maxItems: 64 },
          stop_on_error: { type: 'boolean', default: true, description: 'Stop at the first failed action. The executor never retries actions automatically.' },
          final_state: { type: 'string', enum: ['none', 'interactive', 'compact', 'full'], default: 'interactive' }
        },
        required: ['tab', 'actions'],
        additionalProperties: false
      }
    }
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.name === 'observe') return jsonResult(await browser.observe(request.params.arguments ?? {}));
      if (request.params.name === 'execute') return jsonResult(await browser.execute(request.params.arguments ?? {}));
      return errorResult(fastError('UNKNOWN_BROWSER_FAST_TOOL', `unknown tool: ${request.params.name}`));
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}

export async function runBrowserFastStdio() {
  const browser = new FastBrowser();
  const server = createBrowserFastServer({ browser });
  const transport = new StdioServerTransport();
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await browser.close();
      await server.close();
    })();
    return shutdownPromise;
  };

  await server.connect(transport);
  const serverClose = transport.onclose;
  transport.onclose = () => {
    serverClose?.();
    void shutdown();
  };

  return { browser, server, transport, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await runBrowserFastStdio();
  process.stdin.once('end', () => { void runtime.shutdown(); });
  const shutdownAndExit = () => {
    void runtime.shutdown().then(
      () => process.exit(0),
      error => {
        process.stderr.write(`Browser Fast shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    );
  };
  process.once('SIGTERM', shutdownAndExit);
  process.once('SIGINT', shutdownAndExit);
}
