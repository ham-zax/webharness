#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function usage() {
  return `Usage: scripts/render-config.mjs --profile <restricted|trusted-dev|personal> [options]\n\nOptions:\n  --check           Validate without writing generated state\n  --env-file PATH   Deployment env file (default: <repo>/.env)\n  --state-dir PATH  Persistent state root\n  --repo-root PATH  Repository root override\n  --help            Show this help\n`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') out.help = true;
    else if (arg === '--check') out.check = true;
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

const OWNER_RUNTIME_ENV_KEYS = ['GALLIUM_DRIVER', 'MOZ_ENABLE_WAYLAND'];
const OWNER_BROWSER_ENV_KEYS = new Set(['GALLIUM_DRIVER']);
const OWNER_BROWSER_FAST_ENV_KEYS = new Set(['GALLIUM_DRIVER', 'AGENT_BROWSER_PROFILE', 'AGENT_BROWSER_EXECUTABLE_PATH']);
const OWNER_ENV_KEYS = new Set([...OWNER_RUNTIME_ENV_KEYS, ...OWNER_BROWSER_FAST_ENV_KEYS]);
const OWNER_ENV_MAX_BYTES = 64 * 1024;

async function readOwnedRegularTextFile(file, label, maxBytes) {
  if (!path.isAbsolute(file)) throw new Error(`${label} must be an absolute path when set`);
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error(`${label} must reference a regular file`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if (stat.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  await fs.access(file, fsConstants.R_OK);
  return fs.readFile(file, 'utf8');
}

function parseOwnerEnv(text) {
  const values = parseEnv(text);
  for (const key of Object.keys(values)) {
    if (!OWNER_ENV_KEYS.has(key)) {
      throw new Error(`MCP_OWNER_ENV_FILE permits only: ${[...OWNER_ENV_KEYS].join(', ')}`);
    }
  }
  if (values.GALLIUM_DRIVER !== undefined && !/^[A-Za-z0-9._-]+$/.test(values.GALLIUM_DRIVER)) {
    throw new Error('GALLIUM_DRIVER in MCP_OWNER_ENV_FILE must be a simple driver token');
  }
  if (values.MOZ_ENABLE_WAYLAND !== undefined && !['0', '1'].includes(values.MOZ_ENABLE_WAYLAND)) {
    throw new Error('MOZ_ENABLE_WAYLAND in MCP_OWNER_ENV_FILE must be 0 or 1');
  }
  if (values.AGENT_BROWSER_PROFILE !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(values.AGENT_BROWSER_PROFILE)) {
    throw new Error('AGENT_BROWSER_PROFILE in MCP_OWNER_ENV_FILE must be a simple Chrome profile name');
  }
  if (values.AGENT_BROWSER_EXECUTABLE_PATH !== undefined && !path.isAbsolute(values.AGENT_BROWSER_EXECUTABLE_PATH)) {
    throw new Error('AGENT_BROWSER_EXECUTABLE_PATH in MCP_OWNER_ENV_FILE must be an absolute path');
  }
  return values;
}

function renderOwnerRuntimeEnv(values) {
  return OWNER_RUNTIME_ENV_KEYS
    .filter((key) => values[key] !== undefined)
    .map((key) => `${key}=${values[key]}\n`)
    .join('');
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

function resolveOneMcpEntry(override) {
  if (override !== undefined && override !== '') {
    if (!path.isAbsolute(override)) throw new Error('BRIDGE_ONE_MCP_ENTRY must be an absolute path when set');
    return override;
  }
  const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  if (!npmRoot) throw new Error('npm root -g returned an empty path');
  return path.join(npmRoot, '@1mcp', 'agent', 'build', 'index.js');
}

export async function renderConfig(options) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(options.repoRoot ?? path.join(scriptDir, '..'));
  const profile = options.profile;
  const checkOnly = options.check === true;
  if (!['restricted', 'trusted-dev', 'personal'].includes(profile)) {
    throw new Error('profile must be one of: restricted, trusted-dev, personal');
  }

  const home = process.env.HOME || os.homedir();
  const defaultStateBase = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  const stateDir = path.resolve(options.stateDir ?? process.env.MCP_BRIDGE_STATE_DIR ?? path.join(defaultStateBase, 'mcp-dev-bridge'));
  const runtimeDir = process.env.XDG_RUNTIME_DIR
    || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : null);
  const envFile = path.resolve(options.envFile ?? path.join(repoRoot, '.env'));

  const deployment = {
    ...(await readEnvFile(envFile, { optional: true })),
    ...Object.fromEntries(
      ['MCP_WORKSPACE_ROOT', 'MCP_PUBLIC_URL', 'MCP_TUNNEL_NAME', 'MCP_DEV_MAX_OUTPUT_BYTES', 'MCP_DEV_MAX_SPOOL_BYTES', 'MCP_DEV_SPOOL_TTL_SECONDS', 'MCP_DEV_SPOOL_MAX_TOTAL_BYTES', 'MCP_ONE_MCP_LOG_MAX_SIZE_BYTES', 'MCP_ONE_MCP_LOG_MAX_FILES', 'MCP_PERSONAL_DEFAULT_CWD', 'MCP_TERMINAL_FRONTEND', 'MCP_OWNER_CONTEXT_FILE', 'MCP_OWNER_ENV_FILE', 'BRIDGE_ONE_MCP_ENTRY'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
    ),
  };
  const profileValues = await readEnvFile(path.join(repoRoot, 'config', 'profiles', `${profile}.env`));

  const shellMode = profileValues.MCP_SHELL_MODE;
  if (!['allowlist', 'unrestricted'].includes(shellMode)) {
    throw new Error(`profile ${profile} must set MCP_SHELL_MODE=allowlist or unrestricted`);
  }

  const isPersonal = profile === 'personal';
  let personalDefaultCwd = null;
  let terminalFrontend = 'kitty';
  let ownerContextFile = null;
  let ownerEnv = {};
  if (isPersonal) {
    if (!runtimeDir || !path.isAbsolute(runtimeDir)) {
      throw new Error('personal profile requires an absolute XDG_RUNTIME_DIR or a user runtime directory');
    }
    if (profileValues.MCP_DEV_PATH_MODE !== 'user') {
      throw new Error('profile personal must set MCP_DEV_PATH_MODE=user');
    }
    personalDefaultCwd = deployment.MCP_PERSONAL_DEFAULT_CWD || home;
    if (typeof personalDefaultCwd !== 'string' || !path.isAbsolute(personalDefaultCwd)) {
      throw new Error('MCP_PERSONAL_DEFAULT_CWD must be an absolute path when set');
    }
    terminalFrontend = String(deployment.MCP_TERMINAL_FRONTEND ?? '').trim() || 'kitty';
    if (!['kitty', 'windows-terminal'].includes(terminalFrontend)) {
      throw new Error('MCP_TERMINAL_FRONTEND must be one of: kitty, windows-terminal');
    }
    ownerContextFile = String(deployment.MCP_OWNER_CONTEXT_FILE ?? '').trim() || null;
    if (ownerContextFile && !path.isAbsolute(ownerContextFile)) {
      throw new Error('MCP_OWNER_CONTEXT_FILE must be an absolute path when set');
    }
    const ownerEnvFile = String(deployment.MCP_OWNER_ENV_FILE ?? '').trim() || null;
    if (ownerEnvFile) {
      ownerEnv = parseOwnerEnv(
        await readOwnedRegularTextFile(ownerEnvFile, 'MCP_OWNER_ENV_FILE', OWNER_ENV_MAX_BYTES),
      );
      const browserExecutable = ownerEnv.AGENT_BROWSER_EXECUTABLE_PATH;
      if (browserExecutable !== undefined) {
        const stat = await fs.stat(browserExecutable).catch(() => null);
        if (!stat?.isFile()) {
          throw new Error('AGENT_BROWSER_EXECUTABLE_PATH in MCP_OWNER_ENV_FILE must reference an existing regular file');
        }
        try {
          await fs.access(browserExecutable, fsConstants.X_OK);
        } catch {
          throw new Error('AGENT_BROWSER_EXECUTABLE_PATH in MCP_OWNER_ENV_FILE must be executable');
        }
      }
    }
  }

  const devMaxOutputBytesRaw = deployment.MCP_DEV_MAX_OUTPUT_BYTES ?? '1048576';
  const devMaxOutputBytes = Number(devMaxOutputBytesRaw);
  if (!Number.isInteger(devMaxOutputBytes) || devMaxOutputBytes <= 0 || devMaxOutputBytes > 16 * 1024 * 1024) {
    throw new Error('MCP_DEV_MAX_OUTPUT_BYTES must be an integer from 1 to 16777216');
  }
  const devMaxSpoolBytesRaw = deployment.MCP_DEV_MAX_SPOOL_BYTES ?? String(64 * 1024 * 1024);
  const devMaxSpoolBytes = Number(devMaxSpoolBytesRaw);
  if (!Number.isInteger(devMaxSpoolBytes) || devMaxSpoolBytes <= 0 || devMaxSpoolBytes > 256 * 1024 * 1024) {
    throw new Error('MCP_DEV_MAX_SPOOL_BYTES must be an integer from 1 to 268435456');
  }
  const devSpoolTtlSecondsRaw = deployment.MCP_DEV_SPOOL_TTL_SECONDS ?? String(7 * 24 * 60 * 60);
  const devSpoolTtlSeconds = Number(devSpoolTtlSecondsRaw);
  if (!Number.isInteger(devSpoolTtlSeconds) || devSpoolTtlSeconds <= 0 || devSpoolTtlSeconds > 365 * 24 * 60 * 60) {
    throw new Error('MCP_DEV_SPOOL_TTL_SECONDS must be an integer from 1 to 31536000');
  }
  const devSpoolMaxTotalBytesRaw = deployment.MCP_DEV_SPOOL_MAX_TOTAL_BYTES ?? String(512 * 1024 * 1024);
  const devSpoolMaxTotalBytes = Number(devSpoolMaxTotalBytesRaw);
  if (!Number.isInteger(devSpoolMaxTotalBytes) || devSpoolMaxTotalBytes <= 0 || devSpoolMaxTotalBytes > 8 * 1024 * 1024 * 1024) {
    throw new Error('MCP_DEV_SPOOL_MAX_TOTAL_BYTES must be an integer from 1 to 8589934592');
  }
  if (devSpoolMaxTotalBytes < devMaxSpoolBytes) {
    throw new Error('MCP_DEV_SPOOL_MAX_TOTAL_BYTES must be >= MCP_DEV_MAX_SPOOL_BYTES');
  }

  const oneMcpLogMaxSizeRaw = deployment.MCP_ONE_MCP_LOG_MAX_SIZE_BYTES ?? String(10 * 1024 * 1024);
  const oneMcpLogMaxSize = Number(oneMcpLogMaxSizeRaw);
  if (!Number.isInteger(oneMcpLogMaxSize) || oneMcpLogMaxSize < 1024 * 1024 || oneMcpLogMaxSize > 64 * 1024 * 1024) {
    throw new Error('MCP_ONE_MCP_LOG_MAX_SIZE_BYTES must be an integer from 1048576 to 67108864');
  }
  const oneMcpLogMaxFilesRaw = deployment.MCP_ONE_MCP_LOG_MAX_FILES ?? '5';
  const oneMcpLogMaxFiles = Number(oneMcpLogMaxFilesRaw);
  if (!Number.isInteger(oneMcpLogMaxFiles) || oneMcpLogMaxFiles < 1 || oneMcpLogMaxFiles > 10) {
    throw new Error('MCP_ONE_MCP_LOG_MAX_FILES must be an integer from 1 to 10');
  }

  const workspaceRoot = isPersonal ? personalDefaultCwd : deployment.MCP_WORKSPACE_ROOT;
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

  const localInnerConfigPath = isPersonal ? path.join(stateDir, 'local-1mcp', 'mcp.json') : '';
  const oneMcpEntry = isPersonal ? resolveOneMcpEntry(deployment.BRIDGE_ONE_MCP_ENTRY) : '';
  const replacements = {
    __WORKSPACE_ROOT__: workspaceRoot,
    __REPO_ROOT__: repoRoot,
    __SHELL_ALLOW_COMMANDS__: profileValues.MCP_SHELL_ALLOW_COMMANDS ?? '',
    __SHELL_ALLOW_PATTERNS__: profileValues.MCP_SHELL_ALLOW_PATTERNS ?? '',
    __SHELL_ALLOW_DANGEROUS__: profileValues.MCP_SHELL_ALLOW_DANGEROUS ?? '',
    __SHELL_MODE__: shellMode,
    __DEV_STATE_DIR__: path.join(stateDir, 'dev'),
    __DEV_MAX_OUTPUT_BYTES__: String(devMaxOutputBytes),
    __DEV_MAX_SPOOL_BYTES__: String(devMaxSpoolBytes),
    __DEV_SPOOL_TTL_SECONDS__: String(devSpoolTtlSeconds),
    __DEV_SPOOL_MAX_TOTAL_BYTES__: String(devSpoolMaxTotalBytes),
    __TERMINAL_SOCKET__: runtimeDir ? path.join(runtimeDir, 'wsl-agent-terminal.sock') : '',
    __TERMINAL_FRONTEND__: terminalFrontend,
    __RUNTIME_DIR__: runtimeDir ?? '',
    __LOCAL_INNER_CONFIG__: localInnerConfigPath,
    __ONE_MCP_ENTRY__: oneMcpEntry,
  };
  const templateName = isPersonal ? 'mcp-personal.json' : 'mcp.json';
  const template = JSON.parse(await fs.readFile(path.join(repoRoot, 'config', 'templates', templateName), 'utf8'));
  const rendered = replaceStrings(template, replacements);
  const localRendered = isPersonal
    ? replaceStrings(JSON.parse(await fs.readFile(path.join(repoRoot, 'config', 'templates', 'mcp-local.json'), 'utf8')), replacements)
    : null;

  if (isPersonal) {
    rendered.mcpServers.dev.env.MCP_DEV_SHELL_MODE = shellMode;
    rendered.mcpServers.dev.env.MCP_DEV_PATH_MODE = profileValues.MCP_DEV_PATH_MODE;
    rendered.mcpServers.dev.env.MCP_DEV_DEFAULT_CWD = personalDefaultCwd;
    rendered.mcpServers.code.env.MCP_CODE_DEFAULT_CWD = personalDefaultCwd;
    if (ownerContextFile) rendered.mcpServers.dev.env.MCP_OWNER_CONTEXT_FILE = ownerContextFile;
    for (const key of OWNER_RUNTIME_ENV_KEYS) {
      if (ownerEnv[key] === undefined) continue;
      rendered.mcpServers.dev.env[key] = ownerEnv[key];
      rendered.mcpServers.terminal.env[key] = ownerEnv[key];
    }
    for (const key of OWNER_BROWSER_ENV_KEYS) {
      if (ownerEnv[key] === undefined) continue;
      localRendered.mcpServers['browser-devtools'].env[key] = ownerEnv[key];
    }
    for (const key of OWNER_BROWSER_FAST_ENV_KEYS) {
      if (ownerEnv[key] === undefined) continue;
      localRendered.mcpServers['browser-fast'].env[key] = ownerEnv[key];
    }
  } else {
    rendered.mcpServers.dev.env.MCP_DEV_PATH_MODE = 'workspace';
    if (profile === 'trusted-dev') delete rendered.mcpServers.shell;
  }

  const oneMcpDir = path.join(stateDir, '1mcp');
  const localOneMcpDir = isPersonal ? path.dirname(localInnerConfigPath) : null;
  const logDir = path.join(stateDir, 'logs');
  const oneMcpLogFile = path.join(logDir, 'one-mcp.log');
  const configPath = path.join(oneMcpDir, 'mcp.json');
  const appConfigPath = path.join(oneMcpDir, 'config.toml');
  const bridgeEnvPath = path.join(stateDir, 'bridge.env');
  const appConfig = [
    ...(isPersonal ? ['[admin]', 'enabled = false', ''] : []),
    '[auth]',
    'sessionTtl = 43200',
    '',
    '[logging]',
    `file = ${JSON.stringify(oneMcpLogFile)}`,
    'level = "info"',
    `maxSize = ${oneMcpLogMaxSize}`,
    `maxFiles = ${oneMcpLogMaxFiles}`,
    '',
  ].join('\n');
  const bridgeEnv = [
    `MCP_BRIDGE_PROFILE=${shellSingleQuote(profile)}`,
    `MCP_WORKSPACE_ROOT=${shellSingleQuote(workspaceRoot)}`,
    `MCP_PUBLIC_URL=${shellSingleQuote(publicUrl.replace(/\/$/, ''))}`,
    `MCP_TUNNEL_NAME=${shellSingleQuote(tunnelName)}`,
    `MCP_BRIDGE_ROOT=${shellSingleQuote(repoRoot)}`,
    `BRIDGE_STATE_DIR=${shellSingleQuote(stateDir)}`,
    '',
  ].join('\n');

  if (!checkOnly) {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await fs.chmod(stateDir, 0o700);
    await fs.mkdir(oneMcpDir, { recursive: true, mode: 0o700 });
    await fs.chmod(oneMcpDir, 0o700);
    if (localOneMcpDir) {
      await fs.mkdir(localOneMcpDir, { recursive: true, mode: 0o700 });
      await fs.chmod(localOneMcpDir, 0o700);
    }
    await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
    await fs.chmod(logDir, 0o700);

    if (isPersonal) await atomicWrite(path.join(stateDir, 'owner.env'), renderOwnerRuntimeEnv(ownerEnv));
    if (localRendered) await atomicWrite(localInnerConfigPath, `${JSON.stringify(localRendered, null, 2)}\n`);
    await atomicWrite(configPath, `${JSON.stringify(rendered, null, 2)}\n`);
    await atomicWrite(appConfigPath, appConfig);
    await atomicWrite(bridgeEnvPath, bridgeEnv);
  }

  return { profile, repoRoot, stateDir, oneMcpDir, configPath, localInnerConfigPath: localInnerConfigPath || null, appConfigPath, oneMcpLogFile, bridgeEnvPath, checkOnly };
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
    console.error('A trust profile is required. Choose --profile restricted, --profile trusted-dev, or --profile personal.');
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
      check: args.check,
    });
    console.log(`profile:     ${result.profile}`);
    console.log(`state dir:   ${result.stateDir}`);
    console.log(`${result.checkOnly ? 'validated' : '1MCP config'}: ${result.checkOnly ? 'configuration only (no files written)' : result.configPath}`);
  } catch (error) {
    console.error(`render-config: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
