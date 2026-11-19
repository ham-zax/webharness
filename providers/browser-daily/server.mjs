#!/usr/bin/env node
// browser-daily: republishes the user's own everyday browser as a WebHarness MCP server.
//
// This provider owns no browser process. It is a transparent stdio proxy to
// `browse mcp`, which talks to the browse relay. The relay drives the browser the
// user already has open, with their tabs, logins and extensions, through the
// browse extension. Pairing and the relay lifecycle belong to browse.
//
// Several browsers can be paired to one relay. `status` lists them, and tools that
// open a tab take `browser` (an id or name from that list) to choose one.
//
// Tool shape: browse decides it from the MCP client name. Clients other than
// OpenCode receive `execute`, `status` and `tabs`, where `execute` runs JavaScript
// that can call every browse tool. Set OPENCODE_BROWSER_TOOLS=plain on the relay to
// force the flat tool list instead.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function isExecutableFile(candidate) {
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

function resolveBrowse() {
  const explicit = process.env.WH_BROWSE_BIN;
  if (explicit && isExecutableFile(explicit)) return explicit;
  const home = path.join(os.homedir(), ".local", "bin", "browse");
  if (isExecutableFile(home)) return home;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, "browse");
    // Debian ships /usr/bin/browse as a symlink to xdg-open; isExecutableFile skips it.
    if (isExecutableFile(cand)) return cand;
  }
  return null;
}

const bin = resolveBrowse();
if (!bin) {
  console.error(
    "browser-daily: browse is not installed. Run: curl -fsSL https://opencode.ai/browse/install | bash",
  );
  process.exit(1);
}

const child = spawn(bin, ["mcp"], { stdio: ["pipe", "pipe", "inherit"], env: process.env });

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);

child.on("error", (err) => {
  console.error(`browser-daily: failed to start browse: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => child.kill(sig));
}
