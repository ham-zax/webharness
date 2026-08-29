#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const EXTENSIONS_DIR = path.join(ROOT, 'extensions');
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ARTIFACT_RE = /^[A-Za-z0-9._-]+$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function configRoot(env = process.env) {
  for (const key of ['MCP_EXTENSION_CONFIG_ROOT', 'MCP_BROWSER_ARTIFACTS_FILE']) {
    if (typeof env[key] === 'string' && env[key].trim()) fail('UNSUPPORTED_EXTENSION_OVERRIDE', `${key} is not a supported extension-manager configuration override`);
  }
  const configured = typeof env.MCP_EXTENSION_TEST_CONFIG_ROOT === 'string' ? env.MCP_EXTENSION_TEST_CONFIG_ROOT.trim() : '';
  if (configured) {
    if (env.NODE_ENV !== 'test') fail('EXTENSION_TEST_CONFIG_ROOT_FORBIDDEN', 'MCP_EXTENSION_TEST_CONFIG_ROOT is test-only');
    return path.resolve(configured);
  }
  return path.join(os.homedir(), '.config', 'mcp-dev-bridge');
}

function extensionName(value) {
  if (typeof value !== 'string' || !NAME_RE.test(value)) fail('INVALID_EXTENSION_NAME', 'extension name must match ^[a-z0-9][a-z0-9-]{0,63}$');
  return value;
}

function safeRelative(value, field) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) fail('INVALID_EXTENSION_MANIFEST', `${field} must be a non-empty relative path`);
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) fail('INVALID_EXTENSION_MANIFEST', `${field} must stay inside its declared root`);
  return normalized;
}

async function readJson(file, options = {}) {
  const hasMissing = Object.prototype.hasOwnProperty.call(options, 'missing');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && hasMissing) return options.missing;
    if (error instanceof SyntaxError) fail('INVALID_JSON', `invalid JSON: ${file}`);
    throw error;
  }
}

async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

async function writePrivateJson(file, value) {
  await ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}

function extensionDir(name) {
  return path.join(EXTENSIONS_DIR, name);
}

async function loadManifest(name) {
  const dir = extensionDir(name);
  const manifest = await readJson(path.join(dir, 'extension.json'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.version !== 1 || manifest.name !== name) {
    fail('INVALID_EXTENSION_MANIFEST', `invalid manifest for extension: ${name}`);
  }
  if (manifest.skill !== undefined) safeRelative(manifest.skill, 'skill');
  if (!Array.isArray(manifest.memory)) fail('INVALID_EXTENSION_MANIFEST', 'memory must be an array');
  if (!Array.isArray(manifest.required_artifacts)) fail('INVALID_EXTENSION_MANIFEST', 'required_artifacts must be an array');
  if (!Array.isArray(manifest.required_sources)) fail('INVALID_EXTENSION_MANIFEST', 'required_sources must be an array');
  for (const source of manifest.required_sources) {
    if (typeof source !== 'string' || !ARTIFACT_RE.test(source)) fail('INVALID_EXTENSION_MANIFEST', `invalid source key: ${String(source)}`);
  }
  for (const artifact of manifest.required_artifacts) {
    if (typeof artifact !== 'string' || !ARTIFACT_RE.test(artifact)) fail('INVALID_EXTENSION_MANIFEST', `invalid artifact name: ${String(artifact)}`);
    if (!artifact.startsWith(`${name}.`)) fail('INVALID_EXTENSION_MANIFEST', `artifact aliases must use the extension namespace ${name}.: ${artifact}`);
  }
  for (const item of manifest.memory) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('INVALID_EXTENSION_MANIFEST', 'memory entries must be objects');
    safeRelative(item.source, 'memory.source');
    safeRelative(item.target, 'memory.target');
    if (item.lifetime !== 'extension' && item.lifetime !== 'shared') fail('INVALID_EXTENSION_MANIFEST', 'memory.lifetime must be extension or shared');
  }
  return { dir, manifest };
}

function browserMemoryRoot(root) {
  const configured = typeof process.env.MCP_BROWSER_MEMORY_DIR === 'string' ? process.env.MCP_BROWSER_MEMORY_DIR.trim() : '';
  return configured ? path.resolve(configured) : path.join(root, 'browser-memory');
}

function artifactsFile(root) {
  return path.join(root, 'browser-artifacts.json');
}

function localConfigFile(root, name) {
  return path.join(root, 'extensions', 'config', `${name}.json`);
}

function stateFile(root, name) {
  return path.join(root, 'extensions', 'enabled', `${name}.json`);
}

async function planMemoryFile(extensionRoot, memoryRoot, item) {
  const source = path.resolve(extensionRoot, safeRelative(item.source, 'memory.source'));
  const sourcePrefix = `${path.resolve(extensionRoot)}${path.sep}`;
  if (!source.startsWith(sourcePrefix)) fail('INVALID_EXTENSION_MANIFEST', `memory source escapes extension: ${item.source}`);
  const target = path.resolve(memoryRoot, safeRelative(item.target, 'memory.target'));
  const targetPrefix = `${path.resolve(memoryRoot)}${path.sep}`;
  if (!target.startsWith(targetPrefix)) fail('INVALID_EXTENSION_MANIFEST', `memory target escapes browser-memory root: ${item.target}`);
  const content = await fs.readFile(source);
  try {
    const existing = await fs.readFile(target);
    if (item.lifetime === 'extension') fail('EXTENSION_MEMORY_CONFLICT', `extension-lifetime browser-memory target already exists: ${item.target}`);
    if (!existing.equals(content)) fail('EXTENSION_MEMORY_CONFLICT', `browser-memory target already differs: ${item.target}`);
    return { item, target, content, needsCreate: false };
  } catch (error) {
    if (error?.code === 'ENOENT') return { item, target, content, needsCreate: true };
    throw error;
  }
}

async function applyMemoryPlan(plan) {
  if (!plan.needsCreate) return { created: false };
  await ensurePrivateDir(path.dirname(plan.target));
  try {
    await fs.writeFile(plan.target, plan.content, { flag: 'wx', mode: 0o600 });
    await fs.chmod(plan.target, 0o600);
    return { created: true };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (plan.item.lifetime === 'extension') fail('EXTENSION_MEMORY_CONFLICT', `extension-lifetime browser-memory target appeared during install: ${plan.item.target}`);
    const existing = await fs.readFile(plan.target);
    if (!existing.equals(plan.content)) fail('EXTENSION_MEMORY_CONFLICT', `browser-memory target changed during install: ${plan.item.target}`);
    return { created: false };
  }
}

async function install(name) {
  const root = configRoot();
  const enabledFile = stateFile(root, name);
  try {
    await fs.access(enabledFile);
    return { status: 'already_enabled', name, state: enabledFile };
  } catch {}

  const { dir, manifest } = await loadManifest(name);
  const localConfig = await readJson(localConfigFile(root, name), { missing: {} });
  if (Object.keys(localConfig).length > 0 && localConfig.version !== 1) fail('INVALID_EXTENSION_CONFIG', `extension config version must be 1: ${localConfigFile(root, name)}`);
  const configuredArtifacts = localConfig?.artifacts && typeof localConfig.artifacts === 'object' && !Array.isArray(localConfig.artifacts)
    ? localConfig.artifacts
    : {};
  const configuredSources = localConfig?.sources && typeof localConfig.sources === 'object' && !Array.isArray(localConfig.sources)
    ? localConfig.sources
    : {};
  const sourceValues = {};
  for (const source of manifest.required_sources) {
    const configured = configuredSources[source];
    if (typeof configured !== 'string' || configured.length === 0 || !path.isAbsolute(configured)) {
      fail('EXTENSION_CONFIG_REQUIRED', `configure absolute source ${source} in ${localConfigFile(root, name)}`);
    }
    const resolved = await fs.realpath(configured).catch(() => null);
    if (!resolved) fail('EXTENSION_SOURCE_UNAVAILABLE', `source is unavailable: ${source}`);
    sourceValues[source] = resolved;
  }
  const artifactValues = {};
  for (const artifact of manifest.required_artifacts) {
    const configured = configuredArtifacts[artifact];
    if (typeof configured !== 'string' || configured.length === 0 || !path.isAbsolute(configured)) {
      fail('EXTENSION_CONFIG_REQUIRED', `configure absolute artifact ${artifact} in ${localConfigFile(root, name)}`);
    }
    const resolved = await fs.realpath(configured).catch(() => null);
    if (!resolved) fail('EXTENSION_ARTIFACT_UNAVAILABLE', `artifact is unavailable: ${artifact}`);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) fail('EXTENSION_ARTIFACT_UNAVAILABLE', `artifact is not a regular file: ${artifact}`);
    artifactValues[artifact] = resolved;
  }

  const memoryRoot = browserMemoryRoot(root);
  const memoryPlans = [];
  for (const item of manifest.memory) memoryPlans.push(await planMemoryFile(dir, memoryRoot, item));

  const artifactPath = artifactsFile(root);
  let artifactManifestExisted = true;
  try {
    await fs.access(artifactPath);
  } catch {
    artifactManifestExisted = false;
  }
  const artifactManifest = await readJson(artifactPath, { missing: {} });
  if (!artifactManifest || typeof artifactManifest !== 'object' || Array.isArray(artifactManifest)) fail('INVALID_ARTIFACT_MANIFEST', `artifact manifest must be an object: ${artifactPath}`);
  const nextArtifactManifest = { ...artifactManifest };
  for (const [artifact, value] of Object.entries(artifactValues)) {
    if (artifactManifest[artifact] !== undefined && artifactManifest[artifact] !== value) {
      fail('EXTENSION_ARTIFACT_CONFLICT', `artifact alias already points elsewhere: ${artifact}`);
    }
    nextArtifactManifest[artifact] = value;
  }

  const installedMemory = [];
  const createdMemory = [];
  let artifactsWritten = false;
  try {
    for (const plan of memoryPlans) {
      const { created } = await applyMemoryPlan(plan);
      if (created) createdMemory.push(plan.target);
      installedMemory.push({ target: plan.item.target, lifetime: plan.item.lifetime, owned: created });
    }
    await writePrivateJson(artifactPath, nextArtifactManifest);
    artifactsWritten = true;

    const state = {
      version: 1,
      name,
      enabled_at: new Date().toISOString(),
      skill: manifest.skill ?? null,
      memory: installedMemory,
      artifacts: artifactValues,
      sources: sourceValues
    };
    await writePrivateJson(enabledFile, state);
    return { status: 'enabled', name, skill: manifest.skill ?? null, state: enabledFile };
  } catch (error) {
    for (const target of createdMemory.reverse()) {
      try {
        await fs.unlink(target);
      } catch {}
    }
    if (artifactsWritten) {
      try {
        if (artifactManifestExisted) await writePrivateJson(artifactPath, artifactManifest);
        else await fs.unlink(artifactPath);
      } catch {}
    }
    throw error;
  }
}

async function remove(name) {
  const root = configRoot();
  const enabledFile = stateFile(root, name);
  const state = await readJson(enabledFile, { missing: null });
  if (!state) return { status: 'already_disabled', name };
  if (state.version !== 1 || state.name !== name || !Array.isArray(state.memory) || !state.artifacts || typeof state.artifacts !== 'object') {
    fail('INVALID_EXTENSION_STATE', `invalid enabled state: ${enabledFile}`);
  }

  const artifactPath = artifactsFile(root);
  let artifactManifestExisted = true;
  try {
    await fs.access(artifactPath);
  } catch {
    artifactManifestExisted = false;
  }
  const artifactManifest = await readJson(artifactPath, { missing: {} });
  if (!artifactManifest || typeof artifactManifest !== 'object' || Array.isArray(artifactManifest)) fail('INVALID_ARTIFACT_MANIFEST', `artifact manifest must be an object: ${artifactPath}`);
  const nextArtifactManifest = { ...artifactManifest };
  const removedArtifacts = [];
  const preservedArtifacts = [];
  for (const [artifact, installedValue] of Object.entries(state.artifacts)) {
    if (nextArtifactManifest[artifact] === installedValue) {
      delete nextArtifactManifest[artifact];
      removedArtifacts.push(artifact);
    } else if (nextArtifactManifest[artifact] !== undefined) {
      preservedArtifacts.push(artifact);
    }
  }

  const memoryRoot = browserMemoryRoot(root);
  const removedMemory = [];
  const retainedSharedMemory = [];
  const retainedExistingMemory = [];
  const memoryDeletes = [];
  for (const item of state.memory) {
    if (item?.lifetime === 'shared') {
      retainedSharedMemory.push(item.target);
      continue;
    }
    if (item?.owned === false) {
      retainedExistingMemory.push(item.target);
      continue;
    }
    const target = path.resolve(memoryRoot, safeRelative(item.target, 'state.memory.target'));
    const prefix = `${path.resolve(memoryRoot)}${path.sep}`;
    if (!target.startsWith(prefix)) fail('INVALID_EXTENSION_STATE', `memory target escapes browser-memory root: ${item.target}`);
    let content = null;
    try {
      content = await fs.readFile(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    memoryDeletes.push({ item, target, content });
  }

  const deletedMemory = [];
  let artifactsWritten = false;
  try {
    for (const entry of memoryDeletes) {
      try {
        await fs.unlink(entry.target);
        removedMemory.push(entry.item.target);
        deletedMemory.push(entry);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await writePrivateJson(artifactPath, nextArtifactManifest);
    artifactsWritten = true;
    await fs.unlink(enabledFile);
  } catch (error) {
    if (artifactsWritten) {
      try {
        if (artifactManifestExisted) await writePrivateJson(artifactPath, artifactManifest);
        else await fs.unlink(artifactPath);
      } catch {}
    }
    for (const entry of deletedMemory.reverse()) {
      if (entry.content === null) continue;
      try {
        await ensurePrivateDir(path.dirname(entry.target));
        await fs.writeFile(entry.target, entry.content, { flag: 'wx', mode: 0o600 });
        await fs.chmod(entry.target, 0o600);
      } catch {}
    }
    throw error;
  }
  return {
    status: 'disabled',
    name,
    removed_memory: removedMemory,
    retained_shared_memory: retainedSharedMemory,
    retained_existing_memory: retainedExistingMemory,
    removed_artifacts: removedArtifacts,
    preserved_artifacts: preservedArtifacts,
    private_data_preserved: true,
    skill: state.skill ?? null
  };
}

async function list() {
  const root = configRoot();
  let entries = [];
  try {
    entries = await fs.readdir(EXTENSIONS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !NAME_RE.test(entry.name)) continue;
    let manifest;
    try {
      ({ manifest } = await loadManifest(entry.name));
    } catch {
      continue;
    }
    let enabled = false;
    try {
      await fs.access(stateFile(root, entry.name));
      enabled = true;
    } catch {}
    result.push({ name: entry.name, enabled, description: manifest.description ?? '', skill: manifest.skill ?? null });
  }
  return { extensions: result };
}

async function main() {
  const command = process.argv[2];
  const rawName = process.argv[3];
  let result;
  if (command === 'list' && rawName === undefined) result = await list();
  else if (command === 'install') result = await install(extensionName(rawName));
  else if (command === 'remove') result = await remove(extensionName(rawName));
  else fail('USAGE', 'usage: bin/extension list | bin/extension install <name> | bin/extension remove <name>');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  const code = typeof error?.code === 'string' ? error.code : 'EXTENSION_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
});
