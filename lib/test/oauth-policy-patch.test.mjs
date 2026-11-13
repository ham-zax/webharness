import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { applyOAuthPolicyPatches, CREATED_FILES, PATCHES, preflightOAuthPolicyPatches } from '../../scripts/patch-1mcp-oauth-policy.mjs';

/**
 * The patch module is qualified against one pinned runtime. These checks run the
 * real patched modules from a throwaway copy of that runtime, so a changed
 * upstream shape or a broken patch fails here instead of on a live server.
 *
 * The copy is private in every direction: the runtime's own code comes from the
 * pristine package when one is supplied, and every dependency is a real copy.
 * The installed package is only ever read, and its hashes are asserted unchanged
 * after the whole file runs.
 */
const PINNED_VERSION = '0.39.8';
const CANONICAL_URL = 'https://mcp-arm.example.com/';
const PLATFORM_CALLBACK = 'https://chatgpt.com/connector/oauth/abc123';
const SDK_ROUTER_PATCH = 'protected-resource-metadata-mcp-alias';

function installedAgentRoot() {
  const candidates = [
    process.env.WEBHARNESS_1MCP_AGENT_ROOT,
    path.join(os.homedir(), '.local/lib/node_modules/@1mcp/agent'),
    path.join(path.dirname(process.execPath), '..', 'lib/node_modules/@1mcp/agent'),
    '/usr/local/lib/node_modules/@1mcp/agent',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const manifest = path.join(candidate, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    try {
      if (JSON.parse(fs.readFileSync(manifest, 'utf8')).version === PINNED_VERSION) return candidate;
    } catch {
      // An unreadable manifest is not the pinned runtime.
    }
  }
  return null;
}

/**
 * Optional pristine npm package (unpacked tarball). It has no dependencies, so it
 * only supplies the runtime's own code; dependencies still come from the install.
 */
function pristinePackageRoot() {
  const candidate = process.env.WEBHARNESS_1MCP_PRISTINE_ROOT;
  if (!candidate) return null;
  const manifest = path.join(candidate, 'package.json');
  if (!fs.existsSync(manifest)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version === PINNED_VERSION ? candidate : null;
  } catch {
    return null;
  }
}

const agentRoot = installedAgentRoot();
const pristineRoot = pristinePackageRoot();
const sourceRoot = pristineRoot || agentRoot;
const skip = agentRoot ? false : `pinned @1mcp/agent@${PINNED_VERSION} is not installed`;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Hashes of every installed file this module may target, keyed by relative path. */
function installedTargetHashes() {
  const hashes = {};
  for (const entry of [...PATCHES, ...CREATED_FILES]) {
    const target = path.join(agentRoot, entry.file);
    hashes[entry.file] = fs.existsSync(target) ? sha256(fs.readFileSync(target)) : null;
  }
  return hashes;
}

const installedBefore = agentRoot ? installedTargetHashes() : null;

after(() => {
  if (!agentRoot) return;
  assert.deepEqual(
    installedTargetHashes(),
    installedBefore,
    'these tests must never modify the installed runtime or its dependencies',
  );
});

/**
 * Restores the private SDK copy to the pristine upstream shape.
 *
 * The installed dependency may already carry this module's patch from an earlier
 * run. Reversing the exact replacement in the private copy is what lets the test
 * qualify the patch against the pristine shape instead of reporting "already".
 */
function normalizePrivateSdk(root) {
  const entry = PATCHES.find(candidate => candidate.id === SDK_ROUTER_PATCH);
  const target = path.join(root, entry.file);
  const source = fs.readFileSync(target, 'utf8');
  if (source.includes(entry.upstream)) return;
  if (!source.includes(entry.patched)) {
    throw new Error('the private SDK copy matches neither the pristine nor the patched shape');
  }
  fs.writeFileSync(target, source.replace(entry.patched, entry.upstream));
}

/** Apply the existing installer prerequisite before qualifying the new policy. */
function applyInstallerCallbackPrerequisite(root) {
  const installer = fs.readFileSync(new URL('../../scripts/install-bridge-runtime.sh', import.meta.url), 'utf8');
  const start = installer.indexOf('SDK_PROVIDER=');
  const block = installer.slice(start).match(/<<'NODE'\n([\s\S]*?)\nNODE/);
  assert.ok(start >= 0 && block, 'the installer callback prerequisite must be present');
  const run = spawnSync(process.execPath, [
    '--input-type=module', '-', path.join(root, 'build/sdk/legacy/auth/sdkOAuthServerProvider.js'),
  ], { input: block[1], encoding: 'utf8' });
  assert.equal(run.status, 0, `installer callback prerequisite failed: ${run.stderr}`);
}

/** Copies the runtime and every dependency into a scratch root so the install is never touched. */
function patchedRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(sourceRoot, 'build'), path.join(root, 'build'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(root, 'package.json'));
  // Real copies, never symlinks: a symlinked dependency tree would let the patch
  // module write into the installed package.
  fs.cpSync(path.join(agentRoot, 'node_modules'), path.join(root, 'node_modules'), { recursive: true });
  normalizePrivateSdk(root);
  applyInstallerCallbackPrerequisite(root);
  applyOAuthPolicyPatches(root);
  return root;
}

async function load(root, relative) {
  return import(pathToFileURL(path.join(root, relative)).href);
}

function withSingleOwner(t, enabled) {
  const previous = process.env.WEBHARNESS_OAUTH_SINGLE_OWNER;
  if (enabled) process.env.WEBHARNESS_OAUTH_SINGLE_OWNER = '1';
  else delete process.env.WEBHARNESS_OAUTH_SINGLE_OWNER;
  t.after(() => {
    if (previous === undefined) delete process.env.WEBHARNESS_OAUTH_SINGLE_OWNER;
    else process.env.WEBHARNESS_OAUTH_SINGLE_OWNER = previous;
  });
}

/** Minimal in-memory stand-in for the runtime's file storage service. */
function memoryStorage() {
  const files = new Map();
  const fileKey = (prefix, id) => `${prefix}${id}.json`;
  return {
    files,
    withExclusiveLock(_name, run) {
      return run();
    },
    writeData(prefix, id, data) {
      files.set(fileKey(prefix, id), structuredClone(data));
    },
    writeDataDurable(prefix, id, data) {
      files.set(fileKey(prefix, id), structuredClone(data));
    },
    readData(prefix, id, schema) {
      const value = files.get(fileKey(prefix, id));
      if (value === undefined) return null;
      if (!schema) return structuredClone(value);
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
    deleteData(prefix, id) {
      return files.delete(fileKey(prefix, id));
    },
    listFiles(prefix) {
      return [...files.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

function sessionRecord(tokenId, { clientId = 'client-1', resource = CANONICAL_URL, scopes = ['tag:dev'], expires = Date.now() + 3_600_000 } = {}) {
  return { clientId, resource, scopes, expires, createdAt: Date.now() };
}

function fakeResponse() {
  return {
    headers: {},
    code: undefined,
    body: undefined,
    sent: undefined,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.sent = body;
      return this;
    },
  };
}

test('every patch applies to the pristine runtime and re-running is a no-op', { skip }, async (t) => {
  const root = patchedRuntime(t);
  const second = applyOAuthPolicyPatches(root);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.created, []);
  assert.equal(second.already.length, PATCHES.length + CREATED_FILES.length);
});

test('the SDK metadata patch is qualified against the pristine dependency shape', { skip }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-sdk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(sourceRoot, 'build'), path.join(root, 'build'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(root, 'package.json'));
  fs.cpSync(path.join(agentRoot, 'node_modules'), path.join(root, 'node_modules'), { recursive: true });
  normalizePrivateSdk(root);

  const result = applyOAuthPolicyPatches(root);
  assert.ok(result.applied.includes(SDK_ROUTER_PATCH), 'the SDK patch must apply to the pristine shape, not report "already"');
  const entry = PATCHES.find(candidate => candidate.id === SDK_ROUTER_PATCH);
  const patched = fs.readFileSync(path.join(root, entry.file), 'utf8');
  assert.ok(patched.includes(entry.patched));
  assert.ok(!patched.includes(entry.upstream));
});

test('a changed upstream shape aborts before writing anything', { skip }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-shape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'build/constants'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/constants/auth.js'), 'export const AUTH_CONFIG = {};\n');
  assert.throws(() => applyOAuthPolicyPatches(root), /source shape changed/);
  assert.equal(fs.existsSync(path.join(root, 'build/auth/resourceIdentity.js')), false, 'a failed preflight must not create files');
  assert.equal(fs.readFileSync(path.join(root, 'build/constants/auth.js'), 'utf8'), 'export const AUTH_CONFIG = {};\n');
});

test('an unknown existing resourceIdentity.js is rejected instead of overwritten', { skip }, (t) => {
  const root = patchedRuntime(t);
  const target = path.join(root, 'build/auth/resourceIdentity.js');
  fs.writeFileSync(target, 'export const unexpected = true;\n');
  assert.throws(() => applyOAuthPolicyPatches(root), /differs from the reviewed module/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'export const unexpected = true;\n');
});

test('a symlinked dependency tree is refused so the installed package is never written', { skip }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(sourceRoot, 'build'), path.join(root, 'build'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(root, 'package.json'));
  fs.symlinkSync(path.join(agentRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  assert.throws(() => preflightOAuthPolicyPatches(root), /refusing to write outside the agent root/);
  assert.throws(() => applyOAuthPolicyPatches(root), /refusing to write outside the agent root/);
});

test('an individual patch target cannot symlink outside the private runtime', { skip }, (t) => {
  const root = patchedRuntime(t);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-external-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  const target = path.join(root, PATCHES[0].file);
  const outside = path.join(external, 'auth.js');
  const original = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(outside, original);
  fs.rmSync(target);
  fs.symlinkSync(outside, target);
  assert.throws(() => applyOAuthPolicyPatches(root), /refusing to write outside the agent root/);
  assert.equal(fs.readFileSync(outside, 'utf8'), original);
});

test('the service provisioning route issues an independently revocable full-access identity', { skip }, async (t) => {
  const root = patchedRuntime(t);
  const { AgentConfigManager } = await load(root, 'build/core/server/agentConfig.js');
  AgentConfigManager.getInstance().updateConfig({ externalUrl: CANONICAL_URL, features: { auth: true } });
  const { McpConfigManager } = await load(root, 'build/config/mcpConfigManager.js');
  McpConfigManager.getInstance().transportConfig = { dev: { tags: ['dev'] }, local: { tags: ['local'] } };
  const { SDKOAuthServerProvider } = await load(root, 'build/sdk/legacy/auth/sdkOAuthServerProvider.js');
  const { createCliTokenRoute } = await load(root, 'build/transport/http/routes/cliTokenRoute.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-service-route-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = new SDKOAuthServerProvider(stateDir, 'service-route-test');
  await provider.oauthStorage.ready();
  const route = createCliTokenRoute(provider);
  const previous = process.env.WEBHARNESS_OAUTH_SERVICE_IDENTITY;
  t.after(() => {
    if (previous === undefined) delete process.env.WEBHARNESS_OAUTH_SERVICE_IDENTITY;
    else process.env.WEBHARNESS_OAUTH_SERVICE_IDENTITY = previous;
  });
  const request = { socket: { remoteAddress: '127.0.0.1' }, body: { service: true } };
  delete process.env.WEBHARNESS_OAUTH_SERVICE_IDENTITY;
  const disabled = fakeResponse();
  await route(request, disabled);
  assert.equal(disabled.code, 403);
  process.env.WEBHARNESS_OAUTH_SERVICE_IDENTITY = '1';
  const remote = fakeResponse();
  await route({ ...request, socket: { remoteAddress: '203.0.113.7' } }, remote);
  assert.equal(remote.code, 403);
  const response = fakeResponse();
  await route(request, response);
  assert.equal(response.body.service, true);
  assert.equal(response.body.clientId, 'websession-adapter');
  const verified = await provider.verifyAccessToken(response.body.token);
  assert.equal(verified.clientId, 'websession-adapter');
  assert.deepEqual([...verified.scopes].sort(), ['tag:dev', 'tag:local']);
  assert.equal(verified.expiresAt, Number.MAX_SAFE_INTEGER);
  const tokenId = response.body.token.slice('tk-'.length);
  provider.oauthStorage.sessionRepository.delete(`sess-${tokenId}`);
  await assert.rejects(provider.verifyAccessToken(response.body.token), /Invalid or expired/);
});

test('a durable client registration carries the protected-store sentinel under the single-owner flag', { skip }, async (t) => {
  const root = patchedRuntime(t);
  withSingleOwner(t, true);
  const { ClientDataRepository } = await load(root, 'build/auth/storage/clientDataRepository.js');
  const storage = memoryStorage();
  const repository = new ClientDataRepository(storage);

  repository.save('durable', { client_id: 'durable', client_secret: 's' }, null);
  const durable = storage.files.get('session_durable.json');
  assert.equal(durable.expires, Number.MAX_SAFE_INTEGER, 'a durable record must remain readable by ProtectedRecordStorage');
  assert.equal(durable.client_id, 'durable');

  repository.save('timed', { client_id: 'timed' }, 30 * 24 * 60 * 60 * 1000);
  const timed = storage.files.get('session_timed.json');
  assert.equal(typeof timed.expires, 'number');
  assert.ok(timed.expires > Date.now());
});

test('durable clients and repaired missing-expiry records reach consent through protected storage', { skip }, async (t) => {
  const root = patchedRuntime(t);
  withSingleOwner(t, true);
  const { AgentConfigManager } = await load(root, 'build/core/server/agentConfig.js');
  AgentConfigManager.getInstance().updateConfig({ externalUrl: CANONICAL_URL, features: { auth: true } });
  const { McpConfigManager } = await load(root, 'build/config/mcpConfigManager.js');
  McpConfigManager.getInstance().transportConfig = { dev: { tags: ['dev'] }, local: { tags: ['local'] } };
  const { SDKOAuthServerProvider } = await load(root, 'build/sdk/legacy/auth/sdkOAuthServerProvider.js');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-client-repair-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const provider = new SDKOAuthServerProvider(path.join(state, '1mcp/sessions'), 'client-repair-test');
  await provider.oauthStorage.ready();
  const client = { client_id: 'durable-test', client_secret: 'fixture-secret', redirect_uris: [PLATFORM_CALLBACK] };
  provider.clientsStore.registerClient(client);
  assert.equal(provider.clientsStore.getClient(client.client_id).client_secret, client.client_secret);
  const recordPath = path.join(state, '1mcp/sessions/sessions/server/session_cli_durable-test.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  delete record.expires;
  fs.writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
  assert.throws(() => provider.clientsStore.getClient(client.client_id), /credential migration or access is incomplete/);
  const migrate = spawnSync(process.execPath, [
    new URL('../../scripts/migrate-oauth-client-records.mjs', import.meta.url).pathname,
    '--state-dir', state, '--apply',
  ], { encoding: 'utf8' });
  assert.equal(migrate.status, 0, migrate.stderr);
  const recovered = provider.clientsStore.getClient(client.client_id);
  assert.equal(recovered.client_secret, client.client_secret);
  assert.deepEqual(recovered.redirect_uris, client.redirect_uris);
  assert.equal(recovered.expires, Number.MAX_SAFE_INTEGER);
  const response = fakeResponse();
  await provider.authorize(recovered, {
    redirectUri: PLATFORM_CALLBACK, codeChallenge: 'fixture-challenge', state: 'fixture-state',
    scopes: ['tag:dev', 'tag:local'], resource: new URL(CANONICAL_URL),
  }, response);
  assert.match(response.sent, /action="\/oauth\/consent"/);
  const again = spawnSync(process.execPath, [
    new URL('../../scripts/migrate-oauth-client-records.mjs', import.meta.url).pathname,
    '--state-dir', state, '--apply',
  ], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /migrated:\s+0/);
});

test('the previous durable-registration patch upgrades once and stays idempotent', { skip }, t => {
  const root = patchedRuntime(t);
  const entry = PATCHES.find(patch => patch.id === 'client-records-non-expiring');
  const target = path.join(root, entry.file);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(entry.patched, entry.previous[0]));
  assert.deepEqual(applyOAuthPolicyPatches(root).applied, [entry.id]);
  assert.deepEqual(applyOAuthPolicyPatches(root).applied, []);
});

test('a deployment without the flag keeps the 30-day registration lifetime', { skip }, async (t) => {
  const root = patchedRuntime(t);
  withSingleOwner(t, false);
  const { AUTH_CONFIG } = await load(root, 'build/constants.js');
  assert.equal(AUTH_CONFIG.CLIENT.OAUTH.TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(AUTH_CONFIG.SERVER.REFRESH_FAMILY.TTL_MS, 30 * 24 * 60 * 60 * 1000);

  const { SDKOAuthServerProvider } = await load(root, 'build/sdk/legacy/auth/sdkOAuthServerProvider.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = new SDKOAuthServerProvider(stateDir, 'scope-test');
  const registered = provider.clientsStore.registerClient({ client_id: 'ordinary-client', redirect_uris: [PLATFORM_CALLBACK] });
  assert.equal(registered.client_secret_expires_at, undefined, 'a non-single-owner deployment must not claim a non-expiring secret');
  const stored = provider.oauthStorage.clientDataRepository.get('cli_ordinary-client');
  assert.equal(typeof stored.expires, 'number', 'the previous 30-day registration lifetime must be preserved');
});

test('refresh authority is 365 days under the flag, renews on rotation, and retries inside a bounded window', { skip }, async (t) => {
  const root = patchedRuntime(t);
  withSingleOwner(t, true);
  const { AUTH_CONFIG } = await load(root, 'build/constants.js');
  assert.equal(AUTH_CONFIG.SERVER.REFRESH_FAMILY.TTL_MS, 365 * 24 * 60 * 60 * 1000);
  assert.equal(AUTH_CONFIG.SERVER.REFRESH_FAMILY.RETRY_WINDOW_MS, 10 * 60 * 1000);
  assert.equal(AUTH_CONFIG.SERVER.SESSION.NON_EXPIRING_MS, Number.MAX_SAFE_INTEGER);

  const { RefreshTokenFamilyRepository } = await load(root, 'build/auth/storage/refreshTokenFamilyRepository.js');
  const storage = memoryStorage();
  const repository = new RefreshTokenFamilyRepository(storage, 'scope-test');
  const firstTokenId = randomUUID();
  const secondTokenId = randomUUID();
  const before = Date.now();
  const created = await repository.create('client-1', ['tag:dev', 'tag:local'], CANONICAL_URL, firstTokenId, () => {});
  assert.ok(created.family.expires >= before + 365 * 24 * 60 * 60 * 1000 - 1000);
  // Give the old family an earlier deadline so stale lookup expiries cannot
  // accidentally pass when create and rotate happen in the same millisecond.
  repository.save({ ...created.family, expires: before + 60_000 });

  const rotated = await repository.consume(created.refreshToken, 'client-1', secondTokenId, () => {}, {
    scopes: ['tag:dev', 'tag:local'],
    resource: CANONICAL_URL,
    ttlMs: 365 * 24 * 60 * 60 * 1000,
  });
  assert.equal(rotated.status, 'rotated');
  assert.ok(rotated.family.expires >= created.family.expires, 'rotation must renew the authority window');
  assert.equal(rotated.family.retry.accessToken, `tk-${secondTokenId}`);
  assert.equal(rotated.family.retry.accessTokenId, secondTokenId);
  assert.equal(rotated.family.retry.refreshToken, rotated.refreshToken);
  const lookupPrefix = AUTH_CONFIG.SERVER.REFRESH_FAMILY.LOOKUP_FILE_PREFIX;
  const lookups = [...storage.files.entries()].filter(([name]) => name.startsWith(lookupPrefix));
  assert.equal(lookups.length, 2);
  for (const [, lookup] of lookups) {
    assert.equal(lookup.expires, rotated.family.expires, 'lookup expiry follows renewed authority');
  }

  storage.writeData('session_', `sess-${secondTokenId}`, sessionRecord(secondTokenId));
  const retried = repository.retryResult(rotated.family, created.refreshToken, ['tag:dev', 'tag:local'], CANONICAL_URL);
  assert.deepEqual(retried, {
    access_token: `tk-${secondTokenId}`,
    token_type: 'Bearer',
    expires_in: 31536000,
    scope: 'tag:dev tag:local',
    refresh_token: rotated.refreshToken,
  });
  assert.equal(
    repository.retryResult(rotated.family, created.refreshToken, ['tag:dev'], CANONICAL_URL),
    null,
    'a changed scope request is not the same retry',
  );
  assert.equal(
    repository.retryResult(rotated.family, created.refreshToken, ['tag:dev', 'tag:local'], 'https://elsewhere.test/'),
    null,
    'a changed resource request is not the same retry',
  );

  // A second rotation moves the retry record forward, so the oldest token is now a
  // genuine replay rather than a duplicate of the latest rotation.
  const thirdTokenId = randomUUID();
  const second = await repository.consume(rotated.refreshToken, 'client-1', thirdTokenId, () => {}, {
    scopes: ['tag:dev', 'tag:local'],
    resource: CANONICAL_URL,
    ttlMs: 365 * 24 * 60 * 60 * 1000,
  });
  assert.equal(second.status, 'rotated');
  const replay = await repository.consume(created.refreshToken, 'client-1', randomUUID(), () => {});
  assert.equal(replay.status, 'replay');
  assert.equal(replay.family.status, 'active', 'a replay must not revoke an active connector');
  assert.equal(repository.findById(created.family.familyId).status, 'active');

  const expiredRetry = { ...rotated.family, retry: { ...rotated.family.retry, expires: Date.now() - 1 } };
  assert.equal(repository.retryResult(expiredRetry, created.refreshToken, ['tag:dev', 'tag:local'], CANONICAL_URL), null);
});

test('a revoked family, an expired family, or a deleted access session returns no retry credentials', { skip }, async (t) => {
  const root = patchedRuntime(t);
  withSingleOwner(t, true);
  const { RefreshTokenFamilyRepository } = await load(root, 'build/auth/storage/refreshTokenFamilyRepository.js');
  const storage = memoryStorage();
  const repository = new RefreshTokenFamilyRepository(storage, 'scope-test');
  const firstTokenId = randomUUID();
  const secondTokenId = randomUUID();
  const created = await repository.create('client-1', ['tag:dev'], CANONICAL_URL, firstTokenId, () => {});
  const rotated = await repository.consume(created.refreshToken, 'client-1', secondTokenId, () => {}, {
    scopes: ['tag:dev'],
    resource: CANONICAL_URL,
    ttlMs: 3_600_000,
  });
  assert.equal(rotated.status, 'rotated');
  storage.writeData('session_', `sess-${secondTokenId}`, sessionRecord(secondTokenId));
  assert.ok(repository.retryResult(rotated.family, created.refreshToken, ['tag:dev'], CANONICAL_URL));

  assert.equal(
    repository.retryResult({ ...rotated.family, status: 'revoked' }, created.refreshToken, ['tag:dev'], CANONICAL_URL),
    null,
    'a revoked family must not return retry credentials',
  );
  assert.equal(
    repository.retryResult({ ...rotated.family, expires: Date.now() - 1 }, created.refreshToken, ['tag:dev'], CANONICAL_URL),
    null,
    'an expired family must not return retry credentials',
  );
  storage.deleteData('session_', `sess-${secondTokenId}`);
  assert.equal(
    repository.retryResult(rotated.family, created.refreshToken, ['tag:dev'], CANONICAL_URL),
    null,
    'a deleted access session must not return retry credentials',
  );
});

test('concurrent duplicate refresh requests return one rotation result under real storage locking', { skip }, async (t) => {
  const root = patchedRuntime(t);
  withSingleOwner(t, true);
  const { AUTH_CONFIG } = await load(root, 'build/constants.js');
  const { FileStorageService } = await load(root, 'build/auth/storage/fileStorageService.js');
  const { RefreshTokenFamilyRepository } = await load(root, 'build/auth/storage/refreshTokenFamilyRepository.js');
  const { SessionRepository } = await load(root, 'build/auth/storage/sessionRepository.js');

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-lock-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const storage = new FileStorageService(baseDir, 'server', { manageLifecycle: false });
  const sessions = new SessionRepository(storage);
  const repository = new RefreshTokenFamilyRepository(storage, 'scope-lock');
  const ttlMs = AUTH_CONFIG.SERVER.TOKEN.TTL_MS;
  const persist = tokenId => familyId => sessions.createRefreshFamilyAccessSession({
    tokenId,
    clientId: 'client-1',
    resource: CANONICAL_URL,
    scopes: ['tag:dev'],
    ttlMs,
    familyId,
  });

  const created = await repository.create('client-1', ['tag:dev'], CANONICAL_URL, randomUUID(), () => {});
  const firstId = randomUUID();
  const secondId = randomUUID();
  const [left, right] = await Promise.all([
    repository.consume(created.refreshToken, 'client-1', firstId, persist(firstId), { scopes: ['tag:dev'], resource: CANONICAL_URL, ttlMs }),
    repository.consume(created.refreshToken, 'client-1', secondId, persist(secondId), { scopes: ['tag:dev'], resource: CANONICAL_URL, ttlMs }),
  ]);

  assert.deepEqual([left.status, right.status].sort(), ['retried', 'rotated']);
  const rotated = left.status === 'rotated' ? left : right;
  const retried = left.status === 'retried' ? left : right;
  assert.equal(retried.result.access_token, rotated.family.retry.accessToken);
  assert.equal(retried.result.refresh_token, rotated.refreshToken);
  assert.equal(retried.result.access_token, `tk-${rotated.family.retry.accessTokenId}`);
});

test('a provider-level revoke stops a retried refresh from returning credentials', { skip }, async (t) => {
  const root = patchedRuntime(t);
  withSingleOwner(t, true);
  const { AgentConfigManager } = await load(root, 'build/core/server/agentConfig.js');
  AgentConfigManager.getInstance().updateConfig({ externalUrl: CANONICAL_URL });
  const { SDKOAuthServerProvider } = await load(root, 'build/sdk/legacy/auth/sdkOAuthServerProvider.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-provider-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = new SDKOAuthServerProvider(stateDir, 'scope-provider');
  await provider.oauthStorage.ready();

  const repository = provider.oauthStorage.refreshTokenFamilyRepository;
  const client = { client_id: 'platform-connector', redirect_uris: [PLATFORM_CALLBACK] };
  const ttlMs = provider.configManager.get('auth').oauthTokenTtlMs;
  const created = await repository.create(client.client_id, ['tag:dev'], CANONICAL_URL, randomUUID(), familyId => (
    provider.oauthStorage.sessionRepository.createRefreshFamilyAccessSession({
      tokenId: randomUUID(),
      clientId: client.client_id,
      resource: CANONICAL_URL,
      scopes: ['tag:dev'],
      ttlMs,
      familyId,
    })
  ));

  const rotated = await provider.exchangeRefreshToken(client, created.refreshToken, ['tag:dev'], new URL(CANONICAL_URL));
  assert.equal(typeof rotated.access_token, 'string');
  const retried = await provider.exchangeRefreshToken(client, created.refreshToken, ['tag:dev'], new URL(CANONICAL_URL));
  assert.equal(retried.access_token, rotated.access_token, 'a duplicate inside the window returns the original result');
  assert.equal(retried.refresh_token, rotated.refresh_token);

  const family = repository.findById(created.family.familyId);
  const revoked = await repository.revokeForClient(family, client.client_id);
  assert.equal(revoked.status, 'revoked');
  await assert.rejects(
    provider.exchangeRefreshToken(client, created.refreshToken, ['tag:dev'], new URL(CANONICAL_URL)),
    /Invalid refresh token|already used/,
    'a revoked family must not hand back retry credentials',
  );
});

test('without the flag a replay still revokes the family and authority stays 30 days', { skip }, async (t) => {
  const root = patchedRuntime(t);
  withSingleOwner(t, false);
  const { AUTH_CONFIG } = await load(root, 'build/constants.js');
  assert.equal(AUTH_CONFIG.SERVER.REFRESH_FAMILY.TTL_MS, 30 * 24 * 60 * 60 * 1000);
  const { RefreshTokenFamilyRepository } = await load(root, 'build/auth/storage/refreshTokenFamilyRepository.js');
  const storage = memoryStorage();
  const repository = new RefreshTokenFamilyRepository(storage, 'scope-test');
  const created = await repository.create('client-1', ['tag:dev'], CANONICAL_URL, randomUUID(), () => {});
  const rotated = await repository.consume(created.refreshToken, 'client-1', randomUUID(), () => {}, {
    scopes: ['tag:dev'],
    resource: CANONICAL_URL,
    ttlMs: 3_600_000,
  });
  assert.equal(rotated.status, 'rotated');
  assert.ok(rotated.family.expires <= Date.now() + 30 * 24 * 60 * 60 * 1000 + 1000, 'a non-single-owner deployment keeps the 30-day window');
});

test('resource identity accepts this machine root and /mcp and rejects anything else', { skip }, async (t) => {
  const root = patchedRuntime(t);
  const { AgentConfigManager } = await load(root, 'build/core/server/agentConfig.js');
  AgentConfigManager.getInstance().updateConfig({ externalUrl: CANONICAL_URL });
  const identity = await load(root, 'build/auth/resourceIdentity.js');

  assert.deepEqual(identity.equivalentResources(), [CANONICAL_URL, `${CANONICAL_URL}mcp`]);
  assert.equal(identity.sameResource(CANONICAL_URL, `${CANONICAL_URL}mcp`), true);
  assert.equal(identity.sameResource(`${CANONICAL_URL}mcp`, CANONICAL_URL), true);
  assert.equal(identity.sameResource(CANONICAL_URL, 'https://elsewhere.test/'), false);
  assert.equal(identity.sameResource(CANONICAL_URL, `${CANONICAL_URL}mcp/extra`), false);
  assert.equal(identity.sameResource(undefined, CANONICAL_URL), false);
  assert.equal(identity.bindResource(undefined), CANONICAL_URL);
  assert.equal(identity.bindResource(''), CANONICAL_URL);
  assert.equal(identity.bindResource(`${CANONICAL_URL}mcp`), CANONICAL_URL);
  assert.equal(identity.bindResource('https://elsewhere.test/'), null);
});

test('platform connector approval keeps the exact HTTPS callback, state, and PKCE challenge', { skip }, async (t) => {
  const root = patchedRuntime(t);
  withSingleOwner(t, true);
  const { AgentConfigManager } = await load(root, 'build/core/server/agentConfig.js');
  AgentConfigManager.getInstance().updateConfig({ externalUrl: CANONICAL_URL });
  const { McpConfigManager } = await load(root, 'build/config/mcpConfigManager.js');
  McpConfigManager.getInstance().transportConfig = { dev: { tags: ['dev'] }, local: { tags: ['local'] } };
  const { SDKOAuthServerProvider } = await load(root, 'build/sdk/legacy/auth/sdkOAuthServerProvider.js');

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = new SDKOAuthServerProvider(stateDir, 'scope-test');
  const client = {
    client_id: 'platform-connector',
    redirect_uris: [PLATFORM_CALLBACK],
    grant_types: ['authorization_code', 'refresh_token'],
  };
  const params = {
    redirectUri: PLATFORM_CALLBACK,
    codeChallenge: 'pkce-challenge-value',
    state: 'opaque-state-value',
    scopes: [],
    resource: new URL(`${CANONICAL_URL}mcp`),
  };

  const response = fakeResponse();
  await provider.authorize(client, params, response);

  // The consent form must be allowed to post and then redirect to the platform's
  // registered HTTPS callback. A loopback-only policy would break every hosted
  // connector, which is the cross-device path this deployment relies on.
  const csp = response.headers['Content-Security-Policy'];
  assert.match(csp, /form-action 'self' https:\/\/chatgpt\.com;/);
  assert.match(response.sent, /action="\/oauth\/consent"/);
  assert.doesNotMatch(response.sent, /type="checkbox"/, 'a single-owner deployment shows one full-access decision');
  assert.match(response.sent, /as long as you leave it approved/, 'the single-owner notice states the durable lifetime');
  assert.doesNotMatch(response.sent, /up to 30 days/, 'the single-owner notice drops the 30-day claim');

  const authRequestId = response.sent.match(/name="auth_request_id" value="([^"]+)"/)[1];
  const stored = provider.oauthStorage.getAuthorizationRequest(authRequestId);
  assert.equal(stored.redirectUri, PLATFORM_CALLBACK, 'the registered callback must not be rewritten');
  assert.equal(stored.state, 'opaque-state-value');
  assert.equal(stored.codeChallenge, 'pkce-challenge-value');
  assert.equal(stored.resource, CANONICAL_URL);
  assert.deepEqual([...stored.scopes].sort(), ['tag:dev', 'tag:local']);
});

test('an unrelated resource is rejected before any consent page is shown', { skip }, async (t) => {
  const root = patchedRuntime(t);
  const { AgentConfigManager } = await load(root, 'build/core/server/agentConfig.js');
  AgentConfigManager.getInstance().updateConfig({ externalUrl: CANONICAL_URL });
  const { SDKOAuthServerProvider } = await load(root, 'build/sdk/legacy/auth/sdkOAuthServerProvider.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = new SDKOAuthServerProvider(stateDir, 'scope-test');

  const response = fakeResponse();
  await provider.authorize(
    { client_id: 'platform-connector', redirect_uris: [PLATFORM_CALLBACK] },
    { redirectUri: PLATFORM_CALLBACK, codeChallenge: 'c', state: 's', scopes: [], resource: new URL('https://elsewhere.test/mcp') },
    response,
  );
  assert.equal(response.code, 400);
  assert.equal(response.body.error, 'invalid_target');
  assert.equal(response.sent, undefined, 'no consent page for an unrelated resource');
});

test('a deployment without the single-owner flag keeps per-tag consent choices', { skip }, async (t) => {
  const root = patchedRuntime(t);
  withSingleOwner(t, false);
  const { AgentConfigManager } = await load(root, 'build/core/server/agentConfig.js');
  AgentConfigManager.getInstance().updateConfig({ externalUrl: CANONICAL_URL });
  const { McpConfigManager } = await load(root, 'build/config/mcpConfigManager.js');
  McpConfigManager.getInstance().transportConfig = { dev: { tags: ['dev'] }, local: { tags: ['local'] } };
  const { SDKOAuthServerProvider } = await load(root, 'build/sdk/legacy/auth/sdkOAuthServerProvider.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webharness-1mcp-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const provider = new SDKOAuthServerProvider(stateDir, 'scope-test');

  const response = fakeResponse();
  await provider.authorize(
    {
      client_id: 'platform-connector',
      redirect_uris: [PLATFORM_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
    },
    { redirectUri: PLATFORM_CALLBACK, codeChallenge: 'c', state: 's', scopes: ['tag:dev'], resource: new URL(CANONICAL_URL) },
    response,
  );
  assert.match(response.sent, /type="checkbox"/);
  assert.match(response.sent, /renew this access for up to 30 days/, 'a non-single-owner deployment keeps the previous renewal notice');
  assert.doesNotMatch(response.sent, /as long as you leave it approved/, 'the durable lifetime claim stays scoped to the single-owner profile');
  const authRequestId = response.sent.match(/name="auth_request_id" value="([^"]+)"/)[1];
  assert.deepEqual(provider.oauthStorage.getAuthorizationRequest(authRequestId).scopes, ['tag:dev']);
});
