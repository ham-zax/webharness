#!/usr/bin/env node
// Drop-in `agent-browser` for raw CLI callers on an EXTERNAL Chromium CDP port.
// Every argument passes through unchanged. A new pinned session silently
// allocates an about:blank page that `agent-browser close` leaves behind, so
// this records that page when the session starts and closes it once the session
// has moved to another tab or ended. Only a page proven to be this session's
// own allocation, and still blank, is ever closed. A session whose first
// command also opens a tab (`tab new`) adds two pages at once; ownership is then
// unproven and nothing is reclaimed, so start a session with `tab list`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readExternalCdpPages, cliBootstrapPage, closeExternalOwnedPage } from './external-pinned-session.mjs';

const DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const AGENT_BROWSER_JS = path.join(DIR, 'node_modules', 'agent-browser', 'bin', 'agent-browser.js');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
};
const port = String(option('--cdp') ?? process.env.AGENT_BROWSER_CDP ?? '');
const session = String(option('--session') ?? process.env.AGENT_BROWSER_SESSION ?? '');
const tracked = /^\d{2,5}$/.test(port) && /^[\w.-]{1,100}$/.test(session);
const socketDir = process.env.AGENT_BROWSER_SOCKET_DIR
  || (process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'agent-browser') : path.join(os.homedir(), '.agent-browser'));
const sessionFile = suffix => path.join(socketDir, `${session}.${suffix}`);
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

async function settle(before) {
  const record = readJson(sessionFile('wh-bootstrap'));
  const pinnedTargetId = readJson(sessionFile('target'))?.targetId;
  if (!record) {
    if (!before) return;
    const targetId = cliBootstrapPage({ before, after: await readExternalCdpPages(port), pinnedTargetId });
    if (targetId) {
      fs.writeFileSync(sessionFile('wh-bootstrap'), JSON.stringify({ port, websocket: before.websocket, targetId }), { mode: 0o600 });
    }
    return;
  }
  // `close` returns before the session daemon has removed its socket.
  if (args.includes('close') && !args.includes('tab')) {
    for (let waited = 0; waited < 1500 && fs.existsSync(sessionFile('sock')); waited += 50) await delay(50);
  }
  if (fs.existsSync(sessionFile('sock')) && pinnedTargetId === record.targetId) return; // Still the session's working tab.
  const current = await readExternalCdpPages(record.port);
  if (current.websocket === record.websocket && current.pages.get(record.targetId) === 'about:blank') {
    await closeExternalOwnedPage(record.websocket, record.targetId);
  }
  fs.rmSync(sessionFile('wh-bootstrap'), { force: true });
}

let before = null;
if (tracked && !fs.existsSync(sessionFile('sock')) && !fs.existsSync(sessionFile('wh-bootstrap'))) {
  before = await readExternalCdpPages(port).catch(() => null);
}
const child = spawn(process.execPath, [AGENT_BROWSER_JS, ...args], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exit(127); });
child.on('exit', async (code, signal) => {
  if (tracked) await settle(before).catch(() => {}); // Never change the command's own result.
  process.exit(code ?? (signal ? 1 : 0));
});
