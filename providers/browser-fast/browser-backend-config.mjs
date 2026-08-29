import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BROWSER_FAST_CONFIG_FILE = path.join(
  os.homedir(),
  '.config',
  'mcp-dev-bridge',
  'browser-fast.json'
);
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_PROFILE_NAME_LENGTH = 64;
const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;

function configError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, location) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw configError('BROWSER_FAST_CONFIG_INVALID', `${location} contains unknown key: ${unknown[0]}`);
  }
}

function requiredProfileName(value, location) {
  if (
    typeof value !== 'string'
    || value.length > MAX_PROFILE_NAME_LENGTH
    || value === '.'
    || value === '..'
    || !PROFILE_NAME.test(value)
  ) {
    throw configError(
      'BROWSER_FAST_CONFIG_INVALID',
      `${location} must be 1-${MAX_PROFILE_NAME_LENGTH} characters using only letters, numbers, dot, underscore, or hyphen, and cannot be . or ..`
    );
  }
  return value;
}

function optionalString(value, location) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw configError('BROWSER_FAST_CONFIG_INVALID', `${location} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(value, location) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw configError('BROWSER_FAST_CONFIG_INVALID', `${location} must be a boolean`);
  return value;
}

function resolveManagedClearcote(config, requestedProfile) {
  rejectUnknownKeys(config, new Set(['version', 'linux', 'clearcote', '_comment']), 'browser-fast config');
  rejectUnknownKeys(config.linux, new Set(['browser', 'profile']), 'browser-fast config linux');

  let profileName = requestedProfile;
  if (profileName === undefined && config.linux.browser === 'clearcote') profileName = config.linux.profile;
  if (profileName === undefined && isRecord(config.clearcote?.profiles)) {
    const profiles = Object.keys(config.clearcote.profiles);
    if (profiles.length === 1) [profileName] = profiles;
  }
  profileName = requiredProfileName(profileName, 'browser-fast Clearcote profile');
  if (!isRecord(config.clearcote)) throw configError('BROWSER_FAST_CONFIG_INVALID', 'browser-fast config clearcote must be an object');
  rejectUnknownKeys(config.clearcote, new Set(['profiles']), 'browser-fast config clearcote');
  if (!isRecord(config.clearcote.profiles)) throw configError('BROWSER_FAST_CONFIG_INVALID', 'browser-fast config clearcote.profiles must be an object');

  const raw = config.clearcote.profiles[profileName];
  if (!isRecord(raw)) throw configError('BROWSER_FAST_CONFIG_INVALID', `clearcote profile is not defined: ${profileName}`);
  rejectUnknownKeys(
    raw,
    new Set(['fingerprint', 'platform', 'brand', 'headless', 'humanize', 'lightStealth', 'timezone', 'acceptLanguage']),
    `browser-fast config clearcote.profiles.${profileName}`
  );

  const platform = optionalString(raw.platform, `clearcote profile ${profileName}.platform`);
  if (platform !== undefined && !['windows', 'linux', 'macos', 'android'].includes(platform)) {
    throw configError('BROWSER_FAST_CONFIG_INVALID', `clearcote profile ${profileName}.platform must be windows, linux, macos, or android`);
  }

  const profile = {
    fingerprint: optionalString(raw.fingerprint, `clearcote profile ${profileName}.fingerprint`) ?? profileName,
    ...(platform === undefined ? {} : { platform }),
    ...(raw.brand === undefined ? {} : { brand: optionalString(raw.brand, `clearcote profile ${profileName}.brand`) }),
    headless: optionalBoolean(raw.headless, `clearcote profile ${profileName}.headless`) ?? false,
    humanize: optionalBoolean(raw.humanize, `clearcote profile ${profileName}.humanize`) ?? true,
    ...(raw.lightStealth === undefined ? {} : { lightStealth: optionalBoolean(raw.lightStealth, `clearcote profile ${profileName}.lightStealth`) }),
    ...(raw.timezone === undefined ? {} : { timezone: optionalString(raw.timezone, `clearcote profile ${profileName}.timezone`) }),
    ...(raw.acceptLanguage === undefined ? {} : { acceptLanguage: optionalString(raw.acceptLanguage, `clearcote profile ${profileName}.acceptLanguage`) })
  };

  return {
    browser: 'clearcote',
    managed: true,
    profileName,
    profile,
    session: `mcp-browser-fast-linux-clearcote-${profileName}`
  };
}

export async function resolveLinuxBrowserBackend({
  configFile = DEFAULT_BROWSER_FAST_CONFIG_FILE,
  readFile = fs.readFile,
  lstat = fs.lstat,
  browser: requestedBrowser,
  profile: requestedProfile
} = {}) {
  if (requestedBrowser !== undefined && !['chrome', 'clearcote'].includes(requestedBrowser)) {
    throw configError('BROWSER_FAST_BACKEND_INVALID', 'browser backend must be chrome or clearcote');
  }
  if (requestedProfile !== undefined) requiredProfileName(requestedProfile, 'browser profile');
  if (requestedBrowser === 'chrome' && requestedProfile !== undefined) {
    throw configError('BROWSER_FAST_BACKEND_INVALID', 'browser profile is only valid with the clearcote backend');
  }
  let stat;
  try {
    stat = await lstat(configFile);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (requestedBrowser === 'clearcote') {
        throw configError('BROWSER_FAST_CONFIG_UNAVAILABLE', 'managed Clearcote requires browser-fast configuration with at least one profile');
      }
      return { browser: 'chrome', session: 'mcp-browser-fast-linux' };
    }
    throw configError('BROWSER_FAST_CONFIG_UNAVAILABLE', `could not inspect ${configFile}`, error);
  }
  if (!stat.isFile()) throw configError('BROWSER_FAST_CONFIG_INVALID', `${configFile} must be a regular file`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw configError('BROWSER_FAST_CONFIG_INVALID', `${configFile} must be owned by the current user`);
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    throw configError('BROWSER_FAST_CONFIG_INVALID', `${configFile} exceeds the ${MAX_CONFIG_BYTES}-byte limit`);
  }

  let text;
  try {
    text = await readFile(configFile, 'utf8');
  } catch (error) {
    throw configError('BROWSER_FAST_CONFIG_UNAVAILABLE', `could not read ${configFile}`, error);
  }

  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw configError('BROWSER_FAST_CONFIG_INVALID', `${configFile} is not valid JSON`, error);
  }
  if (!isRecord(config)) throw configError('BROWSER_FAST_CONFIG_INVALID', `${configFile} must contain a JSON object`);
  if (!isRecord(config.linux)) throw configError('BROWSER_FAST_CONFIG_INVALID', 'browser-fast config linux must be an object');

  if (config.version === 2) {
    const configuredBrowser = config.linux.browser;
    if (configuredBrowser === 'firefox') {
      throw configError(
        'UNSUPPORTED_BROWSER_BACKEND',
        'Firefox does not expose Chromium CDP and Agent Browser 0.35.0 cannot drive it; use chrome or clearcote'
      );
    }
    if (configuredBrowser === 'chrome') {
      rejectUnknownKeys(config, new Set(['version', 'linux', 'clearcote', '_comment']), 'browser-fast config');
      rejectUnknownKeys(config.linux, new Set(['browser']), 'browser-fast config linux');
    } else if (configuredBrowser === 'clearcote') {
      rejectUnknownKeys(config, new Set(['version', 'linux', 'clearcote', '_comment']), 'browser-fast config');
      rejectUnknownKeys(config.linux, new Set(['browser', 'profile']), 'browser-fast config linux');
      requiredProfileName(config.linux.profile, 'browser-fast config linux.profile');
    } else {
      throw configError('BROWSER_FAST_CONFIG_INVALID', 'browser-fast config linux.browser must be chrome, clearcote, or firefox');
    }

    const browser = requestedBrowser ?? configuredBrowser;
    if (browser === 'chrome') {
      if (requestedProfile !== undefined) {
        throw configError('BROWSER_FAST_BACKEND_INVALID', 'browser profile is only valid with the clearcote backend');
      }
      return { browser, session: 'mcp-browser-fast-linux' };
    }
    return resolveManagedClearcote(config, requestedProfile);
  }

  rejectUnknownKeys(config, new Set(['version', 'linux', '_comment']), 'browser-fast config');
  if (config.version !== 1) throw configError('BROWSER_FAST_CONFIG_INVALID', 'browser-fast config version must be 1 or 2');
  rejectUnknownKeys(config.linux, new Set(['browser', 'cdpPort']), 'browser-fast config linux');

  const configuredBrowser = config.linux.browser;
  if (configuredBrowser === 'firefox') {
    throw configError(
      'UNSUPPORTED_BROWSER_BACKEND',
      'Firefox does not expose Chromium CDP and Agent Browser 0.35.0 cannot drive it; use chrome or clearcote'
    );
  }
  if (!['chrome', 'clearcote'].includes(configuredBrowser)) {
    throw configError('BROWSER_FAST_CONFIG_INVALID', 'browser-fast config linux.browser must be chrome, clearcote, or firefox');
  }
  const browser = requestedBrowser ?? configuredBrowser;
  if (browser === 'chrome') {
    if (requestedProfile !== undefined) {
      throw configError('BROWSER_FAST_BACKEND_INVALID', 'browser profile is only valid with the clearcote backend');
    }
    return { browser, session: 'mcp-browser-fast-linux' };
  }
  if (configuredBrowser !== 'clearcote' || requestedProfile !== undefined) {
    throw configError('BROWSER_FAST_BACKEND_INVALID', 'V1 Clearcote can only use its configured external cdpPort; use V2 for per-call managed Clearcote profiles');
  }

  const cdpPort = config.linux.cdpPort;
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
    throw configError('BROWSER_FAST_CONFIG_INVALID', 'clearcote requires linux.cdpPort to be an integer from 1 to 65535');
  }
  return {
    browser,
    cdp: String(cdpPort),
    session: `mcp-browser-fast-linux-clearcote-${cdpPort}`
  };
}
