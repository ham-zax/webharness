import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classifyIdentity,
  ensureIdentity,
  NON_EXPIRING_MS,
  provisionIdentity,
  revokeIdentity,
  SERVICE_CLIENT_ID,
  sessionLifetime,
  statusIdentity,
} from '../identity.mjs';

const RESOURCE = 'https://mcp-arm.example.com/';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'websession-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, 'adapter');
  const sessionsDir = join(root, 'sessions');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  return { root, stateDir, sessionsDir };
}

function writeSession(sessionsDir, { clientId, expires = NON_EXPIRING_MS, tokenId = randomUUID() }) {
  const path = join(sessionsDir, `session_sess-${tokenId}.json`);
  writeFileSync(path, JSON.stringify({
    clientId,
    resource: RESOURCE,
    scopes: ['tag:dev', 'tag:local'],
    expires,
    createdAt: Date.now(),
  }));
  return { tokenId, token: `tk-${tokenId}`, path };
}

function writeState(stateDir, state) {
  writeFileSync(join(stateDir, 'oauth.json'), `${JSON.stringify({ version: 1, ...state })}\n`);
}

function readState(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, 'oauth.json'), 'utf8'));
}

/** Fake 1MCP service route that also writes the session record it would create. */
function fakeService({ sessionsDir, clientId = SERVICE_CLIENT_ID, expires = NON_EXPIRING_MS, status = 200 }) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (status !== 200) return { status, ok: false, json: async () => ({}) };
    const session = writeSession(sessionsDir, { clientId, expires });
    return {
      status: 200,
      ok: true,
      json: async () => ({
        authRequired: true,
        token: session.token,
        expiresIn: null,
        tokenId: session.tokenId,
        service: true,
        clientId: SERVICE_CLIENT_ID,
      }),
    };
  };
  return { fetchImpl, calls };
}

function lines(log) {
  return log.join('\n');
}

/** Collects module output while keeping the module's function-shaped log contract. */
function sink() {
  const log = [];
  return { log, sink: line => log.push(line) };
}

test('status reports absent when no identity has been provisioned', t => {
  const { stateDir, sessionsDir } = fixture(t);
  const { log, sink: write } = sink();
  const result = statusIdentity({ stateDir, sessionsDir, log: write });
  assert.equal(result.state, 'absent');
  assert.match(lines(log), /service_identity: absent/);
});

test('status reports a borrowed connector token as borrowed with its real lifetime', t => {
  const { stateDir, sessionsDir } = fixture(t);
  const expires = Date.now() + 86_400_000;
  const borrowed = writeSession(sessionsDir, { clientId: 'gemini-connector', expires });
  writeState(stateDir, { tokens: { access_token: borrowed.token, token_type: 'Bearer' } });

  const { log, sink: write } = sink();
  const result = statusIdentity({ stateDir, sessionsDir, log: write });
  assert.equal(result.state, 'borrowed');
  assert.equal(result.clientId, 'gemini-connector');
  const output = lines(log);
  assert.match(output, /service_identity: borrowed/);
  assert.match(output, /client_id: gemini-connector/);
  assert.match(output, new RegExp(`expires: ${new Date(expires).toISOString()}`));
  assert.doesNotMatch(output, /expires: never/, 'an arbitrary token must never be labelled never-expiring');
  assert.doesNotMatch(output, new RegExp(`client_id: ${SERVICE_CLIENT_ID}`));
});

test('status makes no ownership or lifetime claim when the session directory is not configured', t => {
  const { stateDir, sessionsDir } = fixture(t);
  const borrowed = writeSession(sessionsDir, { clientId: 'gemini-connector' });
  writeState(stateDir, { tokens: { access_token: borrowed.token, token_type: 'Bearer' } });

  const { log, sink: write } = sink();
  const result = statusIdentity({ stateDir, sessionsDir: '', log: write });
  assert.equal(result.state, 'unverified');
  assert.match(lines(log), /service_identity: unverified/);
  assert.doesNotMatch(lines(log), /expires: never/);
});

test('status reports a token whose session is gone as missing', t => {
  const { stateDir, sessionsDir } = fixture(t);
  const borrowed = writeSession(sessionsDir, { clientId: SERVICE_CLIENT_ID });
  writeState(stateDir, { tokens: { access_token: borrowed.token, token_type: 'Bearer' } });
  rmSync(borrowed.path);

  const { log, sink: write } = sink();
  const result = statusIdentity({ stateDir, sessionsDir, log: write });
  assert.equal(result.state, 'missing');
  assert.match(lines(log), /service_identity: missing/);
});

test('status reports never only for the explicit non-expiring session sentinel', t => {
  const { stateDir, sessionsDir } = fixture(t);
  const dedicated = writeSession(sessionsDir, { clientId: SERVICE_CLIENT_ID, expires: NON_EXPIRING_MS });
  writeState(stateDir, { tokens: { access_token: dedicated.token, token_type: 'Bearer' } });

  const { log, sink: write } = sink();
  statusIdentity({ stateDir, sessionsDir, log: write });
  assert.match(lines(log), /service_identity: present/);
  assert.match(lines(log), /expires: never/);

  const timed = writeSession(sessionsDir, { clientId: SERVICE_CLIENT_ID, expires: Date.now() + 3_600_000 });
  writeState(stateDir, { tokens: { access_token: timed.token, token_type: 'Bearer' } });
  const { log: timedLog, sink: writeTimed } = sink();
  statusIdentity({ stateDir, sessionsDir, log: writeTimed });
  assert.doesNotMatch(lines(timedLog), /expires: never/);
  assert.match(lines(timedLog), /expires: \d{4}-\d{2}-\d{2}T/);
});

test('ensure migrates a pre-existing borrowed token and leaves the connector session intact', async t => {
  const { stateDir, sessionsDir } = fixture(t);
  const borrowed = writeSession(sessionsDir, { clientId: 'gemini-connector', expires: Date.now() + 86_400_000 });
  writeState(stateDir, { tokens: { access_token: borrowed.token, token_type: 'Bearer' } });
  const service = fakeService({ sessionsDir });

  const { log, sink: write } = sink();
  const result = await ensureIdentity({ stateDir, base: 'http://127.0.0.1:3050', sessionsDir, fetchImpl: service.fetchImpl, log: write });

  assert.equal(result.provisioned, true);
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].url, 'http://127.0.0.1:3050/api/auth/cli-token');
  assert.deepEqual(JSON.parse(service.calls[0].options.body), { service: true });
  assert.equal(existsSync(borrowed.path), true, 'a borrowed connector session must never be deleted');
  const state = readState(stateDir);
  assert.notEqual(state.tokens.access_token, borrowed.token);
  assert.equal(state.identity.clientId, SERVICE_CLIENT_ID);
  assert.equal(classifyIdentity({ stateDir, sessionsDir }).state, 'dedicated');
});

test('provision is idempotent and does not create a second permanent session', async t => {
  const { stateDir, sessionsDir } = fixture(t);
  const service = fakeService({ sessionsDir });
  const first = await provisionIdentity({ stateDir, base: 'http://127.0.0.1:3050', sessionsDir, fetchImpl: service.fetchImpl });
  assert.equal(first.provisioned, true);
  const token = readState(stateDir).tokens.access_token;

  const second = await provisionIdentity({ stateDir, base: 'http://127.0.0.1:3050', sessionsDir, fetchImpl: service.fetchImpl });
  assert.equal(second.provisioned, false);
  assert.equal(service.calls.length, 1, 'a second provision must not call the service route again');
  assert.equal(readState(stateDir).tokens.access_token, token);
});

test('provision revokes stale dedicated sessions instead of leaving orphan permanent sessions', async t => {
  const { stateDir, sessionsDir } = fixture(t);
  const stale = writeSession(sessionsDir, { clientId: SERVICE_CLIENT_ID });
  const other = writeSession(sessionsDir, { clientId: 'claude-connector' });
  // The local state was lost, so the stale dedicated session is not referenced.
  const service = fakeService({ sessionsDir });

  const { log, sink: write } = sink();
  const result = await provisionIdentity({ stateDir, base: 'http://127.0.0.1:3050', sessionsDir, fetchImpl: service.fetchImpl, log: write });
  assert.equal(result.provisioned, true);
  assert.equal(existsSync(stale.path), false, 'a stale dedicated session must be revoked');
  assert.equal(existsSync(other.path), true, 'another connector session must be preserved');
  assert.match(lines(log), /revoked_stale_sessions: 1/);
});

test('revoke deletes only the dedicated session and ensure never resurrects it', async t => {
  const { stateDir, sessionsDir } = fixture(t);
  const service = fakeService({ sessionsDir });
  await provisionIdentity({ stateDir, base: 'http://127.0.0.1:3050', sessionsDir, fetchImpl: service.fetchImpl });
  const dedicated = classifyIdentity({ stateDir, sessionsDir });
  assert.equal(dedicated.state, 'dedicated');

  const { log, sink: write } = sink();
  revokeIdentity({ stateDir, sessionsDir, log: write });
  assert.match(lines(log), /service_identity: revoked/);
  assert.equal(existsSync(dedicated.path), false);
  assert.equal(readState(stateDir).tokens, undefined);
  assert.equal(typeof readState(stateDir).identity.revokedAt, 'string');

  const { log: ensureLog, sink: writeEnsure } = sink();
  const ensured = await ensureIdentity({ stateDir, base: 'http://127.0.0.1:3050', sessionsDir, fetchImpl: service.fetchImpl, log: writeEnsure });
  assert.equal(ensured.provisioned, false);
  assert.equal(service.calls.length, 1, 'startup must not recreate an intentionally revoked identity');
  assert.match(lines(ensureLog), /service_identity: revoked/);
});

test('revoke leaves a borrowed connector session intact and clears the local reference', t => {
  const { stateDir, sessionsDir } = fixture(t);
  const borrowed = writeSession(sessionsDir, { clientId: 'gemini-connector' });
  writeState(stateDir, { tokens: { access_token: borrowed.token, token_type: 'Bearer' } });

  const { log, sink: write } = sink();
  revokeIdentity({ stateDir, sessionsDir, log: write });
  assert.match(lines(log), /service_identity: not revoked/);
  assert.match(lines(log), /left intact/);
  assert.equal(existsSync(borrowed.path), true);
  assert.equal(readState(stateDir).tokens, undefined);
  assert.equal(classifyIdentity({ stateDir, sessionsDir }).state, 'revoked');
});

test('sessionLifetime never invents an expiry', () => {
  assert.equal(sessionLifetime(undefined), 'unknown');
  assert.equal(sessionLifetime({}), 'unknown');
  assert.equal(sessionLifetime({ expires: NON_EXPIRING_MS }), 'never');
  const expires = Date.now() + 1000;
  assert.equal(sessionLifetime({ expires }), new Date(expires).toISOString());
});

test('supervised startup exits on provisioning failure so systemd can retry', t => {
  const root = mkdtempSync(join(tmpdir(), 'wh-adapter-boot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'lib/bridge', 'providers/websession-adapter', 'shim']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'bin/adapter'), readFileSync(new URL('../../../bin/adapter', import.meta.url)));
  writeFileSync(join(root, 'lib/bridge/common.sh'), 'BRIDGE_STATE_DIR="$FIXTURE/state"\nBRIDGE_RUN_DIR="$FIXTURE/run"\nBRIDGE_ONE_MCP_PORT=3050\n');
  writeFileSync(join(root, 'providers/websession-adapter/server.mjs'), '');
  writeFileSync(join(root, 'providers/websession-adapter/identity.mjs'), '');
  const node = join(root, 'shim/node');
  writeFileSync(node, '#!/usr/bin/env bash\ncase "$1" in */identity.mjs) exit 1;; */server.mjs) touch "$FIXTURE/server-started"; exit 0;; esac\n');
  chmodSync(node, 0o700);
  const run = spawnSync('bash', [join(root, 'bin/adapter'), 'run'], {
    env: { ...process.env, FIXTURE: root, PATH: `${join(root, 'shim')}:${process.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /identity is unavailable/);
  assert.equal(existsSync(join(root, 'server-started')), false);
});
