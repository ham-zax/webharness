#!/usr/bin/env node
// CLI for webharness browser MCP providers, backed by a per-tier background daemon
// so browser state (managed CloakBrowser runtimes, tabs) survives between calls.
// Install: ln -sf ~/repo/webharness/scripts/wh-browser.cjs ~/.local/bin/wh-browser
// Usage: wh-browser <fast|devtools|daily> tools        (tool names + arg names)
//        wh-browser <fast|devtools|daily> schema <tool> (full input schema)
//        wh-browser <fast|devtools|daily> <tool> ['<json>'|-] (- = read JSON from stdin)
//        wh-browser <fast|devtools|all> stop           (stop daemon(s); daily has none)
//        wh-browser status                             (running daemons)
//        wh-browser profile list|add|remove ...        (manage CloakBrowser profiles)
//        wh-browser proxy set <profile> <url|off>      (set or clear profile proxy)
//        wh-browser open|login [profile] [url]         (launch visible CloakBrowser for manual login)
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(path.dirname(fs.realpathSync(__filename)), "..");
const P = process.env.WH_PROVIDERS || path.join(ROOT, "providers");
const STATE_HOME = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
const CONFIG_DIR = path.join(os.homedir(), ".config", "mcp-dev-bridge");
const BROWSER_FAST_CONFIG = path.join(CONFIG_DIR, "browser-fast.json");
const CLOAK_PROFILES_DIR = path.join(STATE_HOME, "mcp-dev-bridge", "cloakbrowser", "profiles");
const LOCAL_SERVERS_FILE = path.join(CONFIG_DIR, "local-servers.json");
const OWNER_GUI_ENV_FILE = process.env.MCP_OWNER_ENV_FILE || path.join(CONFIG_DIR, "owner", "gui.env");
const BROWSE_BIN = process.env.WH_BROWSE_BIN || path.join(os.homedir(), ".local", "bin", "browse");

const IDLE_MS = Number(process.env.WH_BROWSER_IDLE_MS || 30 * 60 * 1000);
const CALL_TIMEOUT_MS = 15 * 60 * 1000;
const PROFILE_RE = /^[A-Za-z0-9._-]+$/;

function safeRead(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function isWslHost() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  return /microsoft|wsl/i.test(safeRead("/proc/sys/kernel/osrelease"));
}

function parseEnvFile(file) {
  const out = {};
  const text = safeRead(file);
  if (!text) return out;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

function localServerEnv(serverName) {
  const text = safeRead(LOCAL_SERVERS_FILE);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    const env = parsed?.mcpServers?.[serverName]?.env;
    return env && typeof env === "object" && !Array.isArray(env) ? env : {};
  } catch {
    return {};
  }
}

function buildDaemonEnv(tier) {
  const serverName = tier === "fast" ? "browser-fast" : "browser-devtools";
  const wsl = isWslHost();
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const defaults = wsl
    ? {
        XDG_RUNTIME_DIR: `/run/user/${uid}`,
        WAYLAND_DISPLAY: "wayland-0",
        DISPLAY: ":0",
        PULSE_SERVER: "unix:/mnt/wslg/PulseServer",
        GALLIUM_DRIVER: "d3d12",
      }
    : {
        XDG_RUNTIME_DIR: `/run/user/${uid}`,
        DISPLAY: ":99",
      };
  const ownerGuiEnv = wsl ? parseEnvFile(OWNER_GUI_ENV_FILE) : {};
  const configuredEnv = localServerEnv(serverName);
  // Precedence: explicit caller process.env > local-servers.json > owner gui.env > host defaults.
  return { ...defaults, ...ownerGuiEnv, ...configuredEnv, ...process.env };
}

const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${typeof process.getuid === "function" ? process.getuid() : 1000}`;
const RUN = path.join(RUNTIME_DIR, "wh-browser");
const servers = {
  fast: { dir: "browser-fast" },
  devtools: { dir: "browser" },
};
const sock = (tier) => path.join(RUN, `${tier}.sock`);

// ---------- daemon: owns one MCP server child, serves newline-JSON requests on a socket
function daemon(tier) {
  const srv = servers[tier];
  const child = spawn(process.execPath, [`${P}/${srv.dir}/server.mjs`], {
    env: buildDaemonEnv(tier), stdio: ["pipe", "pipe", "ignore"]
  });
  const pending = new Map(); let buf = ""; let id = 0;
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      try { const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
    }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const req = (method, params) => new Promise((res) => {
    const n = ++id; pending.set(n, res); send({ jsonrpc: "2.0", id: n, method, params });
  });
  let idle;
  const shutdown = () => { try { fs.unlinkSync(sock(tier)); } catch {} child.kill(); process.exit(0); };
  const touch = () => { clearTimeout(idle); idle = setTimeout(shutdown, IDLE_MS); };
  child.on("exit", () => { try { fs.unlinkSync(sock(tier)); } catch {} process.exit(1); });
  process.on("SIGTERM", shutdown);

  const ready = req("initialize", { protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "wh-browser", version: "2" } })
    .then(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }));

  const server = net.createServer((c) => {
    let data = "";
    c.on("data", async (d) => {
      data += d;
      let idx;
      while ((idx = data.indexOf("\n")) >= 0) {
        const line = data.slice(0, idx);
        data = data.slice(idx + 1);
        if (!line.trim()) continue;
        touch();
        const { method, params } = JSON.parse(line);
        if (method === "shutdown") { c.end("{}\n"); return shutdown(); }
        await ready;
        const r = await req(method, params);
        c.end(JSON.stringify(r) + "\n");
        touch();
      }
    });
  });
  try { fs.unlinkSync(sock(tier)); } catch {}
  server.listen(sock(tier), () => { touch(); if (process.send) process.send("ready"); });
}

// ---------- client
function call(tier, method, params) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock(tier)); let out = "";
    c.setTimeout(CALL_TIMEOUT_MS, () => { c.destroy(); reject(new Error("call timed out")); });
    c.on("connect", () => c.write(JSON.stringify({ method, params }) + "\n"));
    c.on("data", (d) => (out += d));
    c.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    c.on("error", reject);
  });
}
const alive = (tier) => new Promise((res) => {
  const c = net.connect(sock(tier)); c.on("connect", () => { c.destroy(); res(true); }); c.on("error", () => res(false));
});
async function ensure(tier) {
  if (await alive(tier)) return;
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  await new Promise((res, rej) => {
    const d = spawn(process.execPath, [__filename, "__daemon", tier],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    d.once("message", () => { d.disconnect(); d.unref(); res(); });
    d.once("exit", (code) => rej(new Error(`daemon for ${tier} exited (${code})`)));
  });
}

// ---------- profile + proxy config helpers
function validProfileName(name) {
  if (!name || name.length > 64 || name === "." || name === ".." || !PROFILE_RE.test(name)) {
    throw new Error(`Invalid profile name: ${name}`);
  }
  return name;
}

function readBrowserFastConfig() {
  if (!fs.existsSync(BROWSER_FAST_CONFIG)) {
    return {
      version: 2,
      linux: { browser: "cloakbrowser", profile: "x-main" },
      cloakbrowser: { profiles: { "x-main": { headless: false, humanize: true } } },
    };
  }
  return JSON.parse(fs.readFileSync(BROWSER_FAST_CONFIG, "utf8"));
}

function writeBrowserFastConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = path.join(CONFIG_DIR, `.browser-fast.json.tmp.${process.pid}.${randomUUID()}`);
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, BROWSER_FAST_CONFIG);
}

function redactProxy(proxy) {
  if (!proxy) return null;
  if (typeof proxy === "string") {
    try {
      const u = new URL(proxy);
      if (u.username || u.password) { u.username = "***"; u.password = "***"; }
      return u.toString();
    } catch { return "<configured>"; }
  }
  if (typeof proxy === "object") {
    return {
      server: proxy.server,
      ...(proxy.bypass ? { bypass: proxy.bypass } : {}),
      ...(proxy.username ? { auth: true } : {}),
    };
  }
  return "<configured>";
}

async function profileLiveStatus(name) {
  const portFile = path.join(CLOAK_PROFILES_DIR, name, "DevToolsActivePort");
  if (!fs.existsSync(portFile)) return "stopped";
  const [rawPort] = safeRead(portFile).trim().split(/\r?\n/);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "stale";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) });
    return res.ok ? `running:${port}` : "stale";
  } catch {
    return "stopped";
  }
}

function requireV2CloakConfig() {
  const cfg = readBrowserFastConfig();
  if (cfg.version !== 2 || !cfg.cloakbrowser?.profiles) {
    throw new Error(`Expected V2 CloakBrowser config at ${BROWSER_FAST_CONFIG}`);
  }
  return cfg;
}

async function handleProfileCommand(args) {
  const [sub, name, ...rest] = args;
  if (sub === "list") {
    const cfg = readBrowserFastConfig();
    if (cfg.version !== 2) {
      console.log(JSON.stringify({ version: cfg.version, linux: cfg.linux }, null, 2));
      return;
    }
    const profiles = await Promise.all(Object.entries(cfg.cloakbrowser?.profiles || {}).map(async ([key, p]) => ({
      name: key,
      default: cfg.linux?.browser === "cloakbrowser" && cfg.linux?.profile === key,
      headless: p.headless ?? false,
      humanize: p.humanize ?? true,
      proxy: redactProxy(p.proxy),
      geoip: p.geoip ?? false,
      status: await profileLiveStatus(key),
    })));
    console.log(JSON.stringify({ default_browser: cfg.linux?.browser, default_profile: cfg.linux?.profile, profiles }, null, 2));
    return;
  }
  if (sub === "add") {
    validProfileName(name);
    const cfg = requireV2CloakConfig();
    if (cfg.cloakbrowser.profiles[name]) throw new Error(`Profile already exists: ${name}`);
    const entry = { headless: false, humanize: true };
    let setDefault = false;
    for (let i = 0; i < rest.length; i += 1) {
      const flag = rest[i];
      if (flag === "--headless") entry.headless = true;
      else if (flag === "--no-humanize") entry.humanize = false;
      else if (flag === "--geoip") entry.geoip = true;
      else if (flag === "--default") setDefault = true;
      else if (flag === "--proxy") { entry.proxy = rest[++i]; if (!entry.proxy) throw new Error("--proxy requires a URL"); }
      else throw new Error(`Unknown flag: ${flag}`);
    }
    cfg.cloakbrowser.profiles[name] = entry;
    if (setDefault) cfg.linux = { browser: "cloakbrowser", profile: name };
    writeBrowserFastConfig(cfg);
    console.log(JSON.stringify({ added: name, default: setDefault, profile: { ...entry, proxy: redactProxy(entry.proxy) } }, null, 2));
    return;
  }
  if (sub === "remove") {
    validProfileName(name);
    const cfg = requireV2CloakConfig();
    if (!cfg.cloakbrowser.profiles[name]) throw new Error(`Profile not found: ${name}`);
    if (cfg.linux?.profile === name) throw new Error(`Cannot remove active default profile ${name}`);
    delete cfg.cloakbrowser.profiles[name];
    writeBrowserFastConfig(cfg);
    console.log(JSON.stringify({ removed: name }, null, 2));
    return;
  }
  throw new Error("usage: wh-browser profile <list|add <name> [--headless] [--no-humanize] [--proxy URL] [--geoip] [--default]|remove <name>>");
}

function handleProxyCommand(args) {
  const [sub, name, value, ...rest] = args;
  if (sub !== "set" || !name || !value) {
    throw new Error("usage: wh-browser proxy set <profile> <proxy-url|off> [--geoip|--no-geoip]");
  }
  validProfileName(name);
  const cfg = requireV2CloakConfig();
  const entry = cfg.cloakbrowser.profiles[name];
  if (!entry) throw new Error(`Profile not found: ${name}`);
  if (value === "off" || value === "none" || value === "clear") {
    delete entry.proxy;
    delete entry.geoip;
  } else {
    entry.proxy = value;
  }
  for (const flag of rest) {
    if (flag === "--geoip") entry.geoip = true;
    else if (flag === "--no-geoip") delete entry.geoip;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  writeBrowserFastConfig(cfg);
  console.log(JSON.stringify({
    profile: name,
    proxy: redactProxy(entry.proxy),
    geoip: entry.geoip ?? false,
    note: "Active profile restarts automatically on the next browser-fast call.",
  }, null, 2));
}

async function handleOpenCommand(args) {
  let profile;
  let url;
  for (const arg of args) {
    if (!url && /^https?:\/\//i.test(arg)) url = arg;
    else if (!profile) profile = validProfileName(arg);
    else if (!url) url = arg;
    else throw new Error("usage: wh-browser open [profile] [url]");
  }
  await ensure("fast");
  const observeArgs = { browser_target: "linux", browser_backend: "cloakbrowser", scope: "compact" };
  if (profile) observeArgs.browser_profile = profile;
  const obs = await call("fast", "tools/call", { name: "observe", arguments: observeArgs });
  if (obs.error || obs.result?.isError) {
    const text = obs.error?.message || obs.result?.content?.map((c) => c.text).join("\n") || "observe failed";
    throw new Error(text);
  }
  const state = obs.result.structuredContent || JSON.parse(obs.result.content[0].text);
  let activeTab = state.active_tab;
  let finalUrl = state.origin;
  if (url) {
    const exec = await call("fast", "tools/call", {
      name: "execute",
      arguments: {
        browser_target: "linux",
        browser_backend: "cloakbrowser",
        ...(state.browser_profile ? { browser_profile: state.browser_profile } : {}),
        tab: activeTab,
        actions: [{ op: "navigate", url }],
        final_state: "compact",
      },
    });
    if (exec.error || exec.result?.isError) {
      const text = exec.error?.message || exec.result?.content?.map((c) => c.text).join("\n") || "navigate failed";
      throw new Error(text);
    }
    const execState = exec.result.structuredContent || JSON.parse(exec.result.content[0].text);
    activeTab = execState.final_state?.active_tab || activeTab;
    finalUrl = execState.final_state?.origin || url;
  }
  console.log(JSON.stringify({
    profile: state.browser_profile,
    active_tab: activeTab,
    url: finalUrl,
    tabs: state.tabs?.length ?? 0,
  }, null, 2));
}

// ---------- daily tier: the user's own everyday browser through browse (no daemon of ours)
// browse owns its relay and its own idle lifecycle, so this tier shells out to the
// browse CLI instead of spawning an MCP server. Every browse tool is available.
// Aliases: `user` and `main` mean the same tier.
function isExecutableBrowse(candidate) {
  try {
    const real = fs.realpathSync(candidate);
    if (/xdg-open$/.test(real)) return false;
    if (!fs.statSync(real).isFile()) return false;
    fs.accessSync(real, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function browseBin() {
  if (isExecutableBrowse(BROWSE_BIN)) return BROWSE_BIN;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, "browse");
    // Debian ships /usr/bin/browse as a symlink to xdg-open; isExecutableBrowse skips it.
    if (isExecutableBrowse(cand)) return cand;
  }
  return null;
}

function runBrowse(args, input) {
  const bin = browseBin();
  if (!bin) {
    console.error("browse is not installed. Run: curl -fsSL https://opencode.ai/browse/install | bash");
    return 1;
  }
  const r = spawnSync(bin, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status ?? 1;
}

function runMainTier(cmd, arg) {
  if (!cmd || cmd === "tools") return runBrowse(["tools"]);
  if (cmd === "schema") return arg ? runBrowse([arg, "--help"]) : 2;
  // The relay stops itself after 30 minutes idle; never kill it, other agents share it.
  if (cmd === "stop") return 0;
  const raw = arg === "-" ? fs.readFileSync(0, "utf8") : arg || "{}";
  try { JSON.parse(raw); } catch (e) {
    console.error(`invalid JSON arguments: ${e.message}`);
    return 2;
  }
  return runBrowse([cmd, "--json", raw]);
}

async function main() {
  const [tier, cmd, arg, ...rest] = process.argv.slice(2);
  if (tier === "__daemon") return daemon(cmd);
  if (tier === "daily" || tier === "user" || tier === "main") process.exit(runMainTier(cmd, arg));
  if (tier === "status") {
    for (const t of Object.keys(servers)) console.log(`${t}: ${(await alive(t)) ? "running" : "stopped"}`);
    const bin = browseBin();
    let dailyState = "not installed";
    if (bin) {
      const r = spawnSync(bin, ["status", "--json"], { encoding: "utf8", timeout: 5000 });
      if (r.error && r.error.code === "ETIMEDOUT") {
        dailyState = "installed (status timed out)";
      } else {
        try {
          const s = JSON.parse(r.stdout || "{}");
          const names = (s.extension?.browsers || []).map((b) => b.name).join(", ");
          dailyState = s.connected ? `connected (${names || "browser"})` : "installed, not connected";
        } catch { dailyState = "installed"; }
      }
    }
    console.log(`daily: ${dailyState}`);
    return;
  }
  if (tier === "profile") return handleProfileCommand([cmd, arg, ...rest].filter((x) => x !== undefined));
  if (tier === "proxy") return handleProxyCommand([cmd, arg, ...rest].filter((x) => x !== undefined));
  if (tier === "open" || tier === "login") return handleOpenCommand([cmd, arg, ...rest].filter((x) => x !== undefined));
  if (cmd === "stop") {
    for (const t of tier === "all" ? Object.keys(servers) : [tier])
      if (await alive(t)) await call(t, "shutdown", {}).catch(() => {});
    return;
  }
  if (!servers[tier] || !cmd) {
    console.error("usage: wh-browser <fast|devtools|daily> <tools|schema <tool>|stop|<tool> [json|-]> | status | profile ... | proxy ... | open [profile] [url]");
    process.exit(2);
  }
  await ensure(tier);
  let out, code = 0;
  if (cmd === "tools" || cmd === "schema") {
    const r = await call(tier, "tools/list", {});
    if (r.error) { out = r.error.message || JSON.stringify(r.error); code = 1; }
    else {
      const tools = r.result.tools;
      out = cmd === "tools"
        ? tools.map((t) => `${t.name}(${Object.keys(t.inputSchema?.properties || {}).join(", ")})`).join("\n")
        : JSON.stringify(tools.find((t) => t.name === arg) || { error: `no tool ${arg}` }, null, 1);
    }
  } else {
    const raw = arg === "-" ? fs.readFileSync(0, "utf8") : arg;
    const r = await call(tier, "tools/call", { name: cmd, arguments: raw ? JSON.parse(raw) : {} });
    if (r.error) { out = JSON.stringify(r.error); code = 1; }
    else {
      if (r.result.isError) code = 1;
      out = r.result.content.map((c) => c.type === "text" ? c.text : `[${c.type} ${c.mimeType || ""} omitted]`).join("\n");
      if (!out && r.result.structuredContent) out = JSON.stringify(r.result.structuredContent);
    }
  }
  process.stdout.write(out + "\n");
  process.exit(code);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
