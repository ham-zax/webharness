#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_FILE = path.join(ROOT, 'config', 'browser-fast.example.json');
const MAX_CONFIG_BYTES = 16 * 1024;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

// Clearcote was the managed backend before CloakBrowser. Its configs no longer load,
// so they are converted here; a Clearcote profile directory is never reused.
function isMaintainedV1Clearcote9222(config) {
  return exactKeys(config, ['version', 'linux'])
    && config.version === 1
    && exactKeys(config.linux, ['browser', 'cdpPort'])
    && config.linux.browser === 'clearcote'
    && config.linux.cdpPort === 9222;
}

function isMaintainedV2Chrome(config) {
  const profile = config?.clearcote?.profiles?.['x-main'];
  return exactKeys(config, ['version', 'linux', 'clearcote'])
    && config.version === 2
    && exactKeys(config.linux, ['browser'])
    && config.linux.browser === 'chrome'
    && exactKeys(config.clearcote, ['profiles'])
    && exactKeys(config.clearcote.profiles, ['x-main'])
    && exactKeys(profile, ['fingerprint', 'platform', 'brand', 'headless', 'humanize', 'lightStealth'])
    && profile.fingerprint === 'x-main'
    && profile.platform === 'linux'
    && profile.brand === 'Chrome'
    && profile.headless === false
    && profile.humanize === true
    && profile.lightStealth === false;
}

function isCurrentMaintainedConfig(config) {
  return config?.version === 2
    && config?.linux?.browser === 'cloakbrowser'
    && config?.linux?.profile === 'x-main'
    && isRecord(config?.cloakbrowser?.profiles?.['x-main']);
}

function usesClearcote(config) {
  return config?.clearcote !== undefined || config?.linux?.browser === 'clearcote';
}

// Keeps what CloakBrowser understands. Clearcote's string fingerprint, brand, lightStealth
// and linux/android platform have no equivalent and are dropped.
function convertClearcoteProfile(profile) {
  if (!isRecord(profile)) return {};
  const locale = typeof profile.acceptLanguage === 'string' ? profile.acceptLanguage.split(/[,;]/)[0].trim() : '';
  return {
    ...(['windows', 'macos'].includes(profile.platform) ? { platform: profile.platform } : {}),
    ...(profile.headless === undefined ? {} : { headless: profile.headless }),
    ...(profile.humanize === undefined ? {} : { humanize: profile.humanize }),
    ...(profile.timezone === undefined ? {} : { timezone: profile.timezone }),
    ...(locale ? { locale } : {}),
    ...(profile.extensions === undefined ? {} : { extensions: profile.extensions })
  };
}

function convertClearcoteConfig(config) {
  const { clearcote, linux, _comment, ...rest } = config;
  const profiles = isRecord(clearcote?.profiles) ? clearcote.profiles : null;
  return {
    ...(typeof _comment === 'string' ? { _comment: _comment.replaceAll('Clearcote', 'CloakBrowser') } : {}),
    ...rest,
    linux: isRecord(linux) && linux.browser === 'clearcote' ? { ...linux, browser: 'cloakbrowser' } : linux,
    ...(profiles === null ? {} : {
      cloakbrowser: {
        profiles: Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, convertClearcoteProfile(profile)]))
      }
    })
  };
}

async function readOwnedConfig(configFile) {
  let stat;
  try {
    stat = await fs.lstat(configFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`${configFile} must be a regular file`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${configFile} must be owned by the current user`);
  }
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`${configFile} exceeds the ${MAX_CONFIG_BYTES}-byte limit`);
  const text = await fs.readFile(configFile, 'utf8');
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`${configFile} is not valid JSON`, { cause: error });
  }
  if (!isRecord(config)) throw new Error(`${configFile} must contain a JSON object`);
  return { text, config };
}

async function prepareTemp(configFile, text) {
  const directory = path.dirname(configFile);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(configFile)}.tmp.${process.pid}.${randomUUID()}`);
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    return temp;
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function installIfMissing(configFile, text) {
  const temp = await prepareTemp(configFile, text);
  try {
    await fs.link(temp, configFile);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function replaceIfUnchanged(configFile, text, expectedText) {
  const temp = await prepareTemp(configFile, text);
  try {
    const latest = await readOwnedConfig(configFile);
    if (latest === null || latest.text !== expectedText) return false;
    await fs.rename(temp, configFile);
    await fs.chmod(configFile, 0o600);
    return true;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function main() {
  const home = process.env.HOME || os.homedir();
  if (!path.isAbsolute(home)) throw new Error('HOME must be absolute');
  const configFile = path.join(home, '.config', 'mcp-dev-bridge', 'browser-fast.json');
  const templateText = await fs.readFile(TEMPLATE_FILE, 'utf8');
  const template = JSON.parse(templateText);
  if (!isCurrentMaintainedConfig(template)) throw new Error(`maintained browser-fast template is invalid: ${TEMPLATE_FILE}`);

  const existing = await readOwnedConfig(configFile);
  if (existing === null) {
    const installed = await installIfMissing(configFile, templateText);
    process.stdout.write(installed
      ? `installed maintained browser-fast config: ${configFile}\n`
      : `browser-fast config appeared during setup; preserved existing file: ${configFile}\n`);
    return;
  }

  if (isCurrentMaintainedConfig(existing.config)) {
    process.stdout.write(`browser-fast config already uses maintained cloakbrowser/x-main policy: ${configFile}\n`);
    return;
  }

  if (isMaintainedV1Clearcote9222(existing.config) || isMaintainedV2Chrome(existing.config)) {
    const replaced = await replaceIfUnchanged(configFile, templateText, existing.text);
    process.stdout.write(replaced
      ? `migrated maintained browser-fast config to cloakbrowser/x-main: ${configFile}\n`
      : `browser-fast config changed during migration check; preserved latest file: ${configFile}\n`);
    return;
  }

  if (usesClearcote(existing.config)) {
    const converted = `${JSON.stringify(convertClearcoteConfig(existing.config), null, 2)}\n`;
    const replaced = await replaceIfUnchanged(configFile, converted, existing.text);
    process.stdout.write(replaced
      ? `converted owner-managed Clearcote browser-fast config to CloakBrowser: ${configFile}\n`
      : `browser-fast config changed during migration check; preserved latest file: ${configFile}\n`);
    return;
  }

  process.stdout.write(`preserved owner-managed browser-fast config: ${configFile}\n`);
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
