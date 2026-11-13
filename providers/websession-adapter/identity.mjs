#!/usr/bin/env node
/**
 * Provisions, inspects, and revokes the WebSession adapter's dedicated 1MCP
 * service identity.
 *
 * The identity is a deliberate local owner grant. It is created through the
 * localhost-only 1MCP route, carries every published tag, has no time-based
 * expiry, and is independent of any Gemini/Claude connector grant. It is never a
 * substitute for remote OAuth approval of an arbitrary tool, and it never reuses
 * another connector's token.
 *
 * Ownership is decided from the 1MCP session record, not from the local file:
 * a stored token is only reported as this service identity when its session
 * belongs to `websession-adapter`. A token borrowed from a connector is reported
 * as borrowed and is never deleted here.
 *
 * Usage: node identity.mjs ensure|provision|status|revoke
 *
 * Environment:
 *   WEBSESSION_ADAPTER_STATE_DIR          private adapter state directory (required)
 *   WEBSESSION_ADAPTER_1MCP_BASE         loopback 1MCP base URL (default http://127.0.0.1:3050)
 *   WEBSESSION_ADAPTER_1MCP_SESSIONS_DIR 1MCP inbound session directory (required to judge ownership)
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const SERVICE_CLIENT_ID = 'websession-adapter';
export const STATE_VERSION = 1;
/** The pinned runtime's explicit non-expiring session sentinel. */
export const NON_EXPIRING_MS = Number.MAX_SAFE_INTEGER;

const SESSION_FILE_RE = /^session_sess-[0-9a-f-]{36}\.json$/i;

function oauthPath(stateDir) {
  return join(stateDir, 'oauth.json');
}

export function readState(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(oauthPath(stateDir), 'utf8'));
    if (parsed?.version !== STATE_VERSION) throw new Error(`unsupported OAuth state version: ${parsed?.version}`);
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: STATE_VERSION };
    throw error;
  }
}

export function writeState(stateDir, state) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const target = oauthPath(stateDir);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}

export function sessionPathFor(sessionsDir, token) {
  if (!sessionsDir || typeof token !== 'string' || !token.startsWith('tk-')) return null;
  const tokenId = token.slice('tk-'.length);
  if (!/^[0-9a-f-]{36}$/i.test(tokenId)) return null;
  return join(sessionsDir, `session_sess-${tokenId}.json`);
}

function readSession(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Classifies the stored token against the 1MCP session record.
 *
 * `dedicated` means the session belongs to this service identity. `borrowed`
 * means it belongs to another client and must not be deleted or relabelled.
 * `unverified` means ownership cannot be judged because the session directory is
 * not configured, so no lifetime claim is made.
 */
export function classifyIdentity({ stateDir, sessionsDir }) {
  const state = readState(stateDir);
  const token = state?.tokens?.access_token;
  const revokedAt = state?.identity?.revokedAt;
  if (typeof token !== 'string' || !token) return { state: revokedAt ? 'revoked' : 'absent', revokedAt, record: state };
  const path = sessionPathFor(sessionsDir, token);
  if (!path) return { state: 'unverified', token, record: state };
  if (!existsSync(path)) return { state: 'missing', token, path, record: state };
  const session = readSession(path);
  if (!session) return { state: 'unverified', token, path, record: state };
  if (session.clientId !== SERVICE_CLIENT_ID) {
    return { state: 'borrowed', token, path, session, clientId: session.clientId, record: state };
  }
  return { state: 'dedicated', token, path, session, record: state };
}

/** Renders the lifetime from the session record, never from an assumption. */
export function sessionLifetime(session) {
  if (!session || typeof session.expires !== 'number') return 'unknown';
  return session.expires === NON_EXPIRING_MS ? 'never' : new Date(session.expires).toISOString();
}

/** Deletes every 1MCP session that belongs to this service identity. */
export function revokeDedicatedSessions(sessionsDir) {
  if (!sessionsDir || !existsSync(sessionsDir)) return [];
  const removed = [];
  for (const name of readdirSync(sessionsDir)) {
    if (!SESSION_FILE_RE.test(name)) continue;
    const path = join(sessionsDir, name);
    const session = readSession(path);
    if (session?.clientId !== SERVICE_CLIENT_ID) continue;
    rmSync(path);
    removed.push(name);
  }
  return removed;
}

async function requestServiceToken(base, fetchImpl) {
  const response = await fetchImpl(`${base}/api/auth/cli-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 403) {
    throw new Error('this deployment does not enable local service identities; set WEBHARNESS_OAUTH_SERVICE_IDENTITY=1 in the bridge environment');
  }
  if (!response.ok) {
    throw new Error(`1MCP service identity provisioning failed with HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body?.authRequired !== true || typeof body.token !== 'string' || !body.token.startsWith('tk-')) {
    throw new Error('1MCP did not return a service access token');
  }
  if (body.service !== true || body.clientId !== SERVICE_CLIENT_ID) {
    throw new Error('1MCP returned an ordinary CLI token instead of the adapter service identity');
  }
  return body.token;
}

/**
 * Provisions a fresh dedicated identity.
 *
 * Idempotent: an already-active dedicated identity is left alone. Any other
 * dedicated session left behind by an earlier provision is revoked first, so a
 * repeated provision never leaves an orphan permanent session. A borrowed
 * connector session is reported and left intact.
 */
export async function provisionIdentity({ stateDir, base, sessionsDir, fetchImpl = fetch, log = () => {} }) {
  const current = classifyIdentity({ stateDir, sessionsDir });
  if (current.state === 'dedicated') {
    log('service_identity: present');
    log('note: a dedicated identity is already provisioned; run identity-revoke first to rotate it');
    return { provisioned: false, state: current.state };
  }
  if (current.state === 'borrowed') {
    log(`note: the stored token belongs to connector ${current.clientId}; it is left intact and will no longer be used`);
  }
  if (current.state === 'unverified') {
    log('note: the 1MCP session directory is not configured, so the stored token cannot be judged; replacing it');
  }
  const removed = revokeDedicatedSessions(sessionsDir);
  if (removed.length > 0) log(`revoked_stale_sessions: ${removed.length}`);

  const token = await requestServiceToken(base, fetchImpl);
  const state = readState(stateDir);
  state.tokens = { access_token: token, token_type: 'Bearer' };
  state.identity = { clientId: SERVICE_CLIENT_ID, provisionedAt: new Date().toISOString() };
  delete state.codeVerifier;
  delete state.oauthState;
  writeState(stateDir, state);
  log('service_identity: provisioned');
  log(`client_id: ${SERVICE_CLIENT_ID}`);
  log('expires: never');
  return { provisioned: true, state: 'dedicated' };
}

/**
 * Startup path: provisions only when there is no usable dedicated identity.
 *
 * An intentional revoke is never undone here; the operator must run
 * `identity-provision` explicitly.
 */
export async function ensureIdentity(options) {
  const current = classifyIdentity(options);
  if (current.state === 'dedicated') {
    options.log?.('service_identity: present');
    return { provisioned: false, state: current.state };
  }
  if (current.state === 'revoked') {
    options.log?.('service_identity: revoked');
    options.log?.('note: the adapter identity was revoked deliberately; run bin/adapter identity-provision to create a new one');
    return { provisioned: false, state: current.state };
  }
  return provisionIdentity(options);
}

export function statusIdentity({ stateDir, sessionsDir, log = () => {} }) {
  const current = classifyIdentity({ stateDir, sessionsDir });
  if (current.state === 'absent') {
    log('service_identity: absent');
    return current;
  }
  if (current.state === 'revoked') {
    log('service_identity: revoked');
    log(`revoked_at: ${current.revokedAt}`);
    log('note: run bin/adapter identity-provision to create a new identity');
    return current;
  }
  if (current.state === 'unverified') {
    log('service_identity: unverified');
    log('note: the 1MCP session directory is not configured, so ownership and lifetime cannot be confirmed');
    return current;
  }
  if (current.state === 'missing') {
    log('service_identity: missing');
    log('note: the stored token no longer resolves to a 1MCP session; run bin/adapter identity-provision');
    return current;
  }
  if (current.state === 'borrowed') {
    log('service_identity: borrowed');
    log(`client_id: ${current.clientId}`);
    log(`expires: ${sessionLifetime(current.session)}`);
    log('note: this token belongs to another connector; run bin/adapter identity-provision to replace it');
    return current;
  }
  log('service_identity: present');
  log(`client_id: ${SERVICE_CLIENT_ID}`);
  log(`expires: ${sessionLifetime(current.session)}`);
  return current;
}

/**
 * Revokes the stored identity.
 *
 * Only a session that belongs to this service identity is deleted. A borrowed
 * connector session is left intact; the local reference is cleared and the
 * revoke is recorded so startup does not recreate the identity.
 */
export function revokeIdentity({ stateDir, sessionsDir, log = () => {} }) {
  const current = classifyIdentity({ stateDir, sessionsDir });
  const state = readState(stateDir);
  if (current.state === 'dedicated') {
    rmSync(current.path);
    log('service_identity: revoked');
  } else if (current.state === 'borrowed') {
    log('service_identity: not revoked');
    log(`note: the stored token belongs to connector ${current.clientId}; its session was left intact`);
  } else if (current.state === 'missing') {
    log('service_identity: already absent');
  } else if (current.state === 'unverified') {
    log('service_identity: not revoked');
    log('note: the 1MCP session directory is not configured, so the stored token was not deleted');
  } else {
    log('service_identity: already absent');
  }
  if (current.state === 'dedicated' || current.state === 'borrowed' || current.state === 'missing') {
    delete state.tokens;
    state.identity = { clientId: SERVICE_CLIENT_ID, revokedAt: new Date().toISOString() };
    writeState(stateDir, state);
  }
  return current;
}

async function main() {
  const action = process.argv[2] || 'status';
  const stateDir = process.env.WEBSESSION_ADAPTER_STATE_DIR;
  const base = (process.env.WEBSESSION_ADAPTER_1MCP_BASE || 'http://127.0.0.1:3050').replace(/\/$/, '');
  const sessionsDir = process.env.WEBSESSION_ADAPTER_1MCP_SESSIONS_DIR || '';
  if (!stateDir) throw new Error('WEBSESSION_ADAPTER_STATE_DIR is required');
  const log = line => process.stdout.write(`${line}\n`);
  if (action === 'ensure') await ensureIdentity({ stateDir, base, sessionsDir, log });
  else if (action === 'provision') await provisionIdentity({ stateDir, base, sessionsDir, log });
  else if (action === 'status') statusIdentity({ stateDir, sessionsDir, log });
  else if (action === 'revoke') revokeIdentity({ stateDir, sessionsDir, log });
  else throw new Error('usage: node identity.mjs ensure|provision|status|revoke');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
