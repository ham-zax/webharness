#!/usr/bin/env node
// CLI for webharness browser MCP providers, backed by a per-tier background daemon
// so browser state (managed CloakBrowser runtimes, tabs) survives between calls.
// Install: ln -sf ~/repo/webharness/scripts/wh-browser.cjs ~/.local/bin/wh-browser
// Usage: wh-browser <fast|devtools> tools             (tool names + arg names)
//        wh-browser <fast|devtools> schema <tool>      (full input schema)
//        wh-browser <fast|devtools> <tool> ['<json>'|-] (- = read JSON from stdin)
//        wh-browser <fast|devtools|all> stop           (stop daemon(s))
//        wh-browser status                                 (running daemons)
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const P = process.env.WH_PROVIDERS || path.resolve(__dirname, "..", "providers");
const RUN = path.join(process.env.XDG_RUNTIME_DIR || "/tmp", "wh-browser");
const IDLE_MS = Number(process.env.WH_BROWSER_IDLE_MS || 30 * 60 * 1000);
const CALL_TIMEOUT_MS = 15 * 60 * 1000;
const base = { XDG_RUNTIME_DIR: "/run/user/1000", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0",
  PULSE_SERVER: "unix:/mnt/wslg/PulseServer", GALLIUM_DRIVER: "d3d12" };
const servers = {
  fast: { dir: "browser-fast", env: {} },
  devtools: { dir: "browser", env: {} },
};
const sock = (tier) => path.join(RUN, `${tier}.sock`);

// ---------- daemon: owns one MCP server child, serves newline-JSON requests on a socket
function daemon(tier) {
  const srv = servers[tier];
  const child = spawn("node", [`${P}/${srv.dir}/server.mjs`], {
    env: { ...process.env, ...base, ...srv.env }, stdio: ["pipe", "pipe", "ignore"] });
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
      data += d; if (!data.endsWith("\n")) return;
      touch();
      const { method, params } = JSON.parse(data);
      if (method === "shutdown") { c.end("{}\n"); return shutdown(); }
      await ready;
      const r = await req(method, params);
      c.end(JSON.stringify(r) + "\n");
      touch();
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

async function main() {
  const [tier, cmd, arg] = process.argv.slice(2);
  if (tier === "__daemon") return daemon(cmd);
  if (tier === "status") {
    for (const t of Object.keys(servers)) console.log(`${t}: ${(await alive(t)) ? "running" : "stopped"}`);
    return;
  }
  if (cmd === "stop") {
    for (const t of tier === "all" ? Object.keys(servers) : [tier])
      if (await alive(t)) await call(t, "shutdown", {}).catch(() => {});
    return;
  }
  if (!servers[tier] || !cmd) {
    console.error("usage: wh-browser <fast|devtools> <tools|schema <tool>|stop|<tool> [json|-]> | status");
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
