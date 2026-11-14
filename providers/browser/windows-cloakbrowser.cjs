const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const [runtimeDir, profileDir, rawTimeoutMs, rawOptionsJson] = process.argv.slice(2);
const timeoutMs = Number(rawTimeoutMs || 30000);
const options = rawOptionsJson ? JSON.parse(rawOptionsJson) : {};
const activePortFile = path.join(profileDir, 'DevToolsActivePort');
const CLOAKBROWSER_VERSION = '0.7.2';

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

function ensureCloakBrowserPackage() {
  const pkgFile = path.join(runtimeDir, 'node_modules', 'cloakbrowser', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    if (pkg.version === CLOAKBROWSER_VERSION) return;
  } catch {}
  fs.mkdirSync(runtimeDir, { recursive: true });
  const npmCmd = process.env.ComSpec || 'cmd.exe';
  execFileSync(npmCmd, ['/d', '/c', 'npm', 'install', '--no-save', '--prefix', runtimeDir, `cloakbrowser@${CLOAKBROWSER_VERSION}`], {
    cwd: runtimeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000
  });
}

async function main() {
  if (!runtimeDir || !path.isAbsolute(runtimeDir)) throw new Error('runtime directory must be an absolute Windows path');
  if (!profileDir || !path.isAbsolute(profileDir)) throw new Error('profile directory must be an absolute Windows path');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('invalid startup timeout');

  fs.mkdirSync(profileDir, { recursive: true });
  const existing = await currentEndpoint();
  if (existing) return { ...existing, profileDir, launched: false };

  try { fs.rmSync(activePortFile, { force: true }); } catch {}
  ensureCloakBrowserPackage();

  const distDir = path.join(runtimeDir, 'node_modules', 'cloakbrowser', 'dist');
  const { buildLaunchOptions } = await import(pathToFileURL(path.join(distDir, 'playwright.js')).href);
  const { persistentSeedArgs } = await import(pathToFileURL(path.join(distDir, 'profile-seed.js')).href);

  const launchOpts = await buildLaunchOptions({
    headless: options.headless ?? false,
    ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
    ...(options.geoip === undefined ? {} : { geoip: options.geoip }),
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.extensions === undefined ? {} : { extensionPaths: options.extensions }),
    args: [
      ...(options.fingerprint === undefined ? [] : [`--fingerprint=${options.fingerprint}`]),
      ...(options.platform === undefined ? [] : [`--fingerprint-platform=${options.platform}`]),
      '--test-type'
    ]
  });

  const seedArgs = persistentSeedArgs(profileDir, launchOpts.args);
  const proxyArgs = launchOpts.proxy?.server && !launchOpts.args.some(a => a.startsWith('--proxy-server='))
    ? [`--proxy-server=${launchOpts.proxy.server}`, ...(launchOpts.proxy.bypass ? [`--proxy-bypass-list=${launchOpts.proxy.bypass}`] : [])]
    : [];

  const finalArgs = [
    ...launchOpts.args,
    ...seedArgs,
    ...proxyArgs,
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ];

  const child = spawn(launchOpts.executablePath, finalArgs, {
    detached: true,
    stdio: 'ignore',
    env: launchOpts.env || process.env,
    windowsHide: options.headless === true
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = await currentEndpoint();
    if (endpoint) return { ...endpoint, profileDir, launched: true, executable: launchOpts.executablePath };
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Windows CloakBrowser did not publish a healthy DevToolsActivePort within ${timeoutMs}ms`);
}

main().then(
  result => process.stdout.write(JSON.stringify(result)),
  error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
);
