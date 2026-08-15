#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function usage() {
  return `Usage: scripts/render-config.mjs --profile <restricted|trusted-dev> [options]\n\nOptions:\n  --env-file PATH   Deployment env file (default: <repo>/.env)\n  --state-dir PATH  Persistent state root\n  --repo-root PATH  Repository root override\n  --help            Show this help\n`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') out.help = true;
    else if (arg === '--profile' || arg === '--env-file' || arg === '--state-dir' || arg === '--repo-root') {
      const value = argv[++i];
      if (!value) throw new Error(`missing value for ${arg}`);
      out[arg.slice(2)] = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) throw new Error(`invalid env line: ${raw}`);
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function readEnvFile(file, { optional = false } = {}) {
  try {
    return parseEnv(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return {};
    throw error;
  }
}

function replaceStrings(value, replacements) {
  if (typeof value === 'string') {
    let result = value;
    for (const [token, replacement] of Object.entries(replacements)) {
      result = result.split(token).join(replacement);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, replacements)]));
  }
  return value;
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function atomicWrite(file, content, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await fs.writeFile(temp, content, { encoding: 'utf8', mode });
  await fs.chmod(temp, mode);
  await fs.rename(temp, file);
}

export async function renderConfig(options) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(options.repoRoot ?? path.join(scriptDir, '..'));
  const profile = options.profile;
  if (!['restricted', 'trusted-dev'].includes(profile)) {
    throw new Error('profile must be one of: restricted, trusted-dev');
  }

  const home = process.env.HOME || os.homedir();
  const defaultStateBase = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  const stateDir = path.resolve(options.stateDir ?? process.env.MCP_BRIDGE_STATE_DIR ?? path.join(defaultStateBase, 'mcp-dev-bridge'));
  const envFile = path.resolve(options.envFile ?? path.join(repoRoot, '.env'));

  const deployment = {
    ...(await readEnvFile(envFile, { optional: true })),
    ...Object.fromEntries(
      ['MCP_WORKSPACE_ROOT', 'MCP_PUBLIC_URL', 'MCP_TUNNEL_NAME', 'MCP_DEV_MAX_OUTPUT_BYTES'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
    ),
  };
  const profileValues = await readEnvFile(path.join(repoRoot, 'config', 'profiles', `${profile}.env`));

  const shellMode = profileValues.MCP_SHELL_MODE;
  if (!['disabled', 'unrestricted'].includes(shellMode)) {
    throw new Error(`profile ${profile} must set MCP_SHELL_MODE=disabled or unrestricted`);
  }

  const devMaxOutputBytesRaw = deployment.MCP_DEV_MAX_OUTPUT_BYTES ?? '1048576';
  const devMaxOutputBytes = Number(devMaxOutputBytesRaw);
  if (!Number.isInteger(devMaxOutputBytes) || devMaxOutputBytes <= 0 || devMaxOutputBytes > 16 * 1024 * 1024) {
    throw new Error('MCP_DEV_MAX_OUTPUT_BYTES must be an integer from 1 to 16777216');
  }

  const workspaceRoot = deployment.MCP_WORKSPACE_ROOT;
  const publicUrl = deployment.MCP_PUBLIC_URL;
  const tunnelName = deployment.MCP_TUNNEL_NAME ?? '';
  if (!workspaceRoot) throw new Error(`MCP_WORKSPACE_ROOT is required in ${envFile} or the environment`);
  if (!path.isAbsolute(workspaceRoot)) throw new Error('MCP_WORKSPACE_ROOT must be an absolute path');
  if (!publicUrl) throw new Error(`MCP_PUBLIC_URL is required in ${envFile} or the environment`);
  let parsedUrl;
  try {
    parsedUrl = new URL(publicUrl);
  } catch {
    throw new Error('MCP_PUBLIC_URL must be an absolute URL');
  }
  if (parsedUrl.protocol !== 'https:') throw new Error('MCP_PUBLIC_URL must use https');

  const template = JSON.parse(await fs.readFile(path.join(repoRoot, 'config', 'templates', 'mcp.json'), 'utf8'));
  const rendered = replaceStrings(template, {
    __WORKSPACE_ROOT__: workspaceRoot,
    __REPO_ROOT__: repoRoot,
    __SHELL_MODE__: shellMode,
    __DEV_STATE_DIR__: path.join(stateDir, 'dev'),
    __DEV_MAX_OUTPUT_BYTES__: String(devMaxOutputBytes),
  });

  const oneMcpDir = path.join(stateDir, '1mcp');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDir, 0o700);
  await fs.mkdir(oneMcpDir, { recursive: true, mode: 0o700 });
  await fs.chmod(oneMcpDir, 0o700);

  const configPath = path.join(oneMcpDir, 'mcp.json');
  await atomicWrite(configPath, `${JSON.stringify(rendered, null, 2)}\n`);

  const bridgeEnv = [
    `MCP_BRIDGE_PROFILE=${shellSingleQuote(profile)}`,
    `MCP_WORKSPACE_ROOT=${shellSingleQuote(workspaceRoot)}`,
    `MCP_PUBLIC_URL=${shellSingleQuote(publicUrl.replace(/\/$/, ''))}`,
    `MCP_TUNNEL_NAME=${shellSingleQuote(tunnelName)}`,
    `MCP_BRIDGE_ROOT=${shellSingleQuote(repoRoot)}`,
    `BRIDGE_STATE_DIR=${shellSingleQuote(stateDir)}`,
    '',
  ].join('\n');
  const bridgeEnvPath = path.join(stateDir, 'bridge.env');
  await atomicWrite(bridgeEnvPath, bridgeEnv);

  return { profile, repoRoot, stateDir, oneMcpDir, configPath, bridgeEnvPath };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.profile) {
    console.error('A trust profile is required. Choose --profile restricted or --profile trusted-dev.');
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    const result = await renderConfig({
      profile: args.profile,
      envFile: args['env-file'],
      stateDir: args['state-dir'],
      repoRoot: args['repo-root'],
    });
    console.log(`profile:     ${result.profile}`);
    console.log(`state dir:   ${result.stateDir}`);
    console.log(`1MCP config: ${result.configPath}`);
  } catch (error) {
    console.error(`render-config: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
