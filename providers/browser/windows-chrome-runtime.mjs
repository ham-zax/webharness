import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WINDOWS_CHROME_HELPER_SOURCE = path.join(DIR, 'windows-chrome.cjs');
const WINDOWS_CMD = '/mnt/c/Windows/System32/cmd.exe';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const STARTUP_TIMEOUT_MS = 15000;

function runtimeError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export async function runWindowsHostProcess(command, args, { cwd = '/mnt/c', input, acceptNonZero = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const overflow = stream => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(runtimeError('WINDOWS_HOST_OUTPUT_LIMIT', `${stream} exceeded ${MAX_OUTPUT_BYTES} bytes`));
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
      reject(runtimeError('WINDOWS_HOST_PROCESS_FAILED', `failed to start ${command}`, error));
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
        reject(runtimeError('WINDOWS_HOST_COMMAND_FAILED', result.stderr || result.stdout || `${command} exited ${result.code}`));
        return;
      }
      resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

let hostPromise = null;

export async function resolveWindowsHost({ processRunner = runWindowsHostProcess } = {}) {
  if (!hostPromise) {
    hostPromise = (async () => {
      const local = await processRunner(WINDOWS_CMD, ['/d', '/c', 'echo', '%LOCALAPPDATA%'], { cwd: '/mnt/c' });
      const windowsLocalAppData = local.stdout.replace(/\r/g, '').trim();
      if (!/^[A-Za-z]:\\/.test(windowsLocalAppData)) throw runtimeError('WINDOWS_LOCALAPPDATA_INVALID', 'could not resolve Windows LOCALAPPDATA');

      const node = await processRunner(WINDOWS_CMD, ['/d', '/c', 'where', 'node'], { cwd: '/mnt/c' });
      const windowsNode = node.stdout.replace(/\r/g, '').split('\n').find(line => /^[A-Za-z]:\\.*node\.exe$/i.test(line.trim()))?.trim();
      if (!windowsNode) throw runtimeError('WINDOWS_NODE_NOT_FOUND', 'could not resolve native Windows node.exe');

      const [translatedLocal, translatedNode] = await Promise.all([
        processRunner('wslpath', ['-u', windowsLocalAppData]),
        processRunner('wslpath', ['-u', windowsNode])
      ]);
      const localAppData = translatedLocal.stdout.trim();
      const nodeExecutable = translatedNode.stdout.trim();
      const runtimeDir = path.join(localAppData, 'mcp-dev-bridge', 'chrome-runtime');
      const windowsRuntimeDir = `${windowsLocalAppData}\\mcp-dev-bridge\\chrome-runtime`;
      const profileDir = path.join(localAppData, 'mcp-dev-bridge', 'chrome-profile');
      const windowsProfileDir = `${windowsLocalAppData}\\mcp-dev-bridge\\chrome-profile`;
      const helper = path.join(runtimeDir, 'windows-chrome.cjs');
      const windowsHelper = `${windowsRuntimeDir}\\windows-chrome.cjs`;

      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.copyFile(WINDOWS_CHROME_HELPER_SOURCE, helper);
      return {
        windowsLocalAppData,
        localAppData,
        windowsNode,
        nodeExecutable,
        profileDir,
        windowsProfileDir,
        helper,
        windowsHelper
      };
    })().catch(error => {
      hostPromise = null;
      throw error;
    });
  }
  return hostPromise;
}

export async function ensureWindowsChrome({ processRunner = runWindowsHostProcess } = {}) {
  const host = await resolveWindowsHost({ processRunner });
  await fs.copyFile(WINDOWS_CHROME_HELPER_SOURCE, host.helper);
  const result = await processRunner(host.nodeExecutable, [
    host.windowsHelper,
    host.windowsProfileDir,
    String(STARTUP_TIMEOUT_MS)
  ], { cwd: '/mnt/c' });

  let endpoint;
  try {
    endpoint = JSON.parse(result.stdout || '{}');
  } catch (error) {
    throw runtimeError('WINDOWS_MCP_CHROME_INVALID_OUTPUT', result.stderr || 'Windows MCP Chrome helper returned invalid JSON', error);
  }
  if (typeof endpoint.browserUrl !== 'string' || typeof endpoint.wsEndpoint !== 'string') {
    throw runtimeError('WINDOWS_MCP_CHROME_START_FAILED', result.stderr || 'Windows MCP Chrome helper did not return a DevTools endpoint');
  }
  return { ...host, ...endpoint };
}

export const WINDOWS_MCP_CHROME_PROFILE_SUFFIX = 'mcp-dev-bridge\\chrome-profile';
