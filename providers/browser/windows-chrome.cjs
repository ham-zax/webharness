const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const profileDir = process.argv[2];
const timeoutMs = Number(process.argv[3] || 15000);
const activePortFile = path.join(profileDir, 'DevToolsActivePort');

function findChrome() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function readEndpoint() {
  try {
    const [rawPort, websocketPath] = fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\//.test(websocketPath || '')) return null;
    return {
      port,
      browserUrl: `http://127.0.0.1:${port}`,
      wsEndpoint: `ws://127.0.0.1:${port}${websocketPath}`
    };
  } catch {
    return null;
  }
}

function probe(endpoint) {
  return new Promise(resolve => {
    const request = http.get(`${endpoint.browserUrl}/json/version`, { timeout: 750 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve(false);
        try {
          const value = JSON.parse(body);
          resolve(typeof value.webSocketDebuggerUrl === 'string');
        } catch {
          resolve(false);
        }
      });
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

async function currentEndpoint() {
  const endpoint = readEndpoint();
  if (!endpoint) return null;
  return await probe(endpoint) ? endpoint : null;
}

async function main() {
  if (!profileDir || !path.isAbsolute(profileDir)) throw new Error('profile directory must be an absolute Windows path');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('invalid startup timeout');

  fs.mkdirSync(profileDir, { recursive: true });
  const existing = await currentEndpoint();
  if (existing) return { ...existing, profileDir, launched: false };

  try { fs.rmSync(activePortFile, { force: true }); } catch {}
  const chrome = findChrome();
  if (!chrome) throw new Error('Google Chrome executable was not found in standard Windows locations');

  const child = spawn(chrome, [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = await currentEndpoint();
    if (endpoint) return { ...endpoint, profileDir, launched: true, chrome };
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`dedicated MCP Chrome did not publish a healthy DevToolsActivePort within ${timeoutMs}ms; close any Chrome using ${profileDir} and retry`);
}

main().then(
  result => process.stdout.write(JSON.stringify(result)),
  error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
);
