import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function runtimeUsesConfig(argv, configDir) {
  const configPath = path.join(configDir, 'mcp.json');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config-dir' && argv[i + 1] === configDir) return true;
    if (argv[i] === `--config-dir=${configDir}`) return true;
    if (argv[i] === '--config' && argv[i + 1] === configPath) return true;
    if (argv[i] === `--config=${configPath}`) return true;
  }
  return false;
}

function matchingRuntimeExists(configDir, procRoot) {
  let entries;
  try {
    entries = fs.readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return true;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let argv;
    try {
      argv = fs.readFileSync(path.join(procRoot, entry.name, 'cmdline'))
        .toString('utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (argv.some(value => value.includes('@1mcp/agent/build/index.js')) &&
        argv.includes('serve') && runtimeUsesConfig(argv, configDir)) return true;
  }
  return false;
}

export function reclaimStaleRuntimeOwnership(configDir, { procRoot = '/proc' } = {}) {
  const ownerDir = path.join(configDir, 'runtime.owner');
  if (!fs.existsSync(ownerDir) || matchingRuntimeExists(configDir, procRoot)) return false;

  const staleDir = `${ownerDir}.webharness-stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(ownerDir, staleDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  fs.rmSync(staleDir, { recursive: true, force: true });
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const configDir = process.argv[2];
  if (!configDir) throw new Error('usage: one-mcp-runtime-ownership.mjs CONFIG_DIR');
  if (reclaimStaleRuntimeOwnership(configDir)) {
    process.stderr.write(`reclaimed stale 1MCP runtime ownership: ${path.join(configDir, 'runtime.owner')}\n`);
  }
}
