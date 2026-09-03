import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const CHUNK_BYTES = 8192;
const MASTER_BEARER_FILE = 'master-bearer.sha256';

function validMasterBearer(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{32,128}$/.test(value);
}

function splitUtf8(text, maxBytes = CHUNK_BYTES) {
  const chunks = [];
  let current = '';
  let currentBytes = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function loadOrCreateKey(stateDir) {
  const path = join(stateDir, 'continuation.key');
  try {
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error('invalid continuation key length');
    chmodSync(path, 0o600);
    return key;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const key = randomBytes(32);
    writeFileSync(path, key, { mode: 0o600 });
    chmodSync(path, 0o600);
    return key;
  }
}

export class AdapterStore {
  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    this.stateDir = stateDir;
    this._continuationKey = loadOrCreateKey(stateDir);
    this._dbPath = join(stateDir, 'operations.sqlite');
    this.db = new DatabaseSync(this._dbPath);
    chmodSync(this._dbPath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS capabilities (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        expires_ms INTEGER NOT NULL,
        revoked_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        client_nonce TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        tool TEXT NOT NULL DEFAULT 'read',
        policy_class TEXT NOT NULL DEFAULT 'automatic',
        source_profile TEXT NOT NULL DEFAULT 'unknown',
        state TEXT NOT NULL,
        confirmation_hash TEXT,
        confirmation_expires_ms INTEGER,
        confirmation_used_ms INTEGER,
        dispatch_started_ms INTEGER,
        result_text TEXT,
        error_text TEXT,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        UNIQUE(principal_id, client_nonce),
        FOREIGN KEY(principal_id) REFERENCES capabilities(id)
      );
      CREATE TABLE IF NOT EXISTS operation_chunks (
        operation_id TEXT NOT NULL,
        chunk_number INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        PRIMARY KEY(operation_id, chunk_number),
        FOREIGN KEY(operation_id) REFERENCES operations(id) ON DELETE CASCADE
      );
    `);
    const capabilityColumns = this.db.prepare('PRAGMA table_info(capabilities)').all();
    if (!capabilityColumns.some(column => column.name === 'revoked_ms')) {
      this.db.exec('ALTER TABLE capabilities ADD COLUMN revoked_ms INTEGER');
    }
    const operationColumns = this.db.prepare('PRAGMA table_info(operations)').all().map(column => column.name);
    const migrations = [
      ['tool', "TEXT NOT NULL DEFAULT 'read'"],
      ['policy_class', "TEXT NOT NULL DEFAULT 'automatic'"],
      ['source_profile', "TEXT NOT NULL DEFAULT 'unknown'"],
      ['confirmation_hash', 'TEXT'],
      ['confirmation_expires_ms', 'INTEGER'],
      ['confirmation_used_ms', 'INTEGER'],
      ['dispatch_started_ms', 'INTEGER'],
    ];
    for (const [name, definition] of migrations) {
      if (!operationColumns.includes(name)) this.db.exec(`ALTER TABLE operations ADD COLUMN ${name} ${definition}`);
    }
  }

  close() {
    this.db.close();
  }

  issueCapability(scope, ttlSeconds, maxTtlSeconds) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > maxTtlSeconds) {
      throw new Error(`capability TTL must be an integer from 60 to ${maxTtlSeconds} seconds`);
    }
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare('INSERT INTO capabilities (id, token_hash, scope, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?)')
      .run(id, sha256(token), scope, now, now + ttlSeconds * 1000);
    return { id, token, scope, expiresMs: now + ttlSeconds * 1000 };
  }

  issueMainCapability(ttlSeconds = 3600) {
    return this.issueCapability('main', ttlSeconds, 86400);
  }

  setMasterBearer(token) {
    if (!validMasterBearer(token)) {
      throw new Error('master bearer must be 32 to 128 characters using letters, digits, dot, underscore, or hyphen');
    }
    const path = join(this.stateDir, MASTER_BEARER_FILE);
    writeFileSync(path, `${sha256(token)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  masterBearerMatches(token) {
    if (!validMasterBearer(token)) return false;
    let expected;
    try {
      expected = readFileSync(join(this.stateDir, MASTER_BEARER_FILE), 'utf8').trim();
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    const actualBuffer = Buffer.from(sha256(token));
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  }

  revokeCapability(id) {
    const result = this.db.prepare('UPDATE capabilities SET revoked_ms = COALESCE(revoked_ms, ?) WHERE id = ?').run(Date.now(), id);
    return result.changes === 1;
  }

  resolveCapability(token) {
    const row = this.db.prepare('SELECT id, scope, expires_ms, revoked_ms FROM capabilities WHERE token_hash = ?').get(sha256(token));
    if (!row || row.scope !== 'main' || row.expires_ms <= Date.now() || row.revoked_ms !== null) return undefined;
    return { id: row.id, scope: row.scope, expiresMs: row.expires_ms };
  }

  activeCapabilityById(id) {
    const row = this.db.prepare('SELECT id, scope, expires_ms, revoked_ms FROM capabilities WHERE id = ?').get(id);
    if (!row || row.scope !== 'main' || row.expires_ms <= Date.now() || row.revoked_ms !== null) return undefined;
    return { id: row.id, scope: row.scope, expiresMs: row.expires_ms };
  }

  continuationToken(operationId) {
    return createHmac('sha256', this._continuationKey).update(`operation:${operationId}`).digest('base64url');
  }

  continuationMatches(operationId, token) {
    const expected = Buffer.from(this.continuationToken(operationId));
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  confirmationCapability(operationId) {
    return createHmac('sha256', this._continuationKey).update(`confirmation:${operationId}`).digest('base64url');
  }

  confirmationCapabilityMatches(operationId, token) {
    const expected = Buffer.from(this.confirmationCapability(operationId));
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  confirmationChallenge(operationId) {
    return createHmac('sha256', this._continuationKey).update(`challenge:${operationId}`).digest('base64url').slice(0, 16);
  }

  submitOperation(principalId, clientNonce, requestJson, requestHash, options = {}) {
    const id = randomUUID();
    const now = Date.now();
    const state = options.state || 'queued';
    const confirmationChallenge = state === 'confirmation_required' ? this.confirmationChallenge(id) : undefined;
    const confirmationHash = confirmationChallenge ? sha256(confirmationChallenge) : null;
    const confirmationExpiresMs = confirmationChallenge ? now + 10 * 60 * 1000 : null;
    const inserted = this.db.prepare(`
      INSERT INTO operations (
        id, principal_id, client_nonce, request_hash, request_json, tool, policy_class, source_profile,
        state, confirmation_hash, confirmation_expires_ms, created_ms, updated_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(principal_id, client_nonce) DO NOTHING
    `).run(
      id, principalId, clientNonce, requestHash, requestJson,
      options.tool || 'read', options.policyClass || 'automatic', options.sourceProfile || 'unknown',
      state, confirmationHash, confirmationExpiresMs, now, now,
    );

    let row;
    if (inserted.changes === 1) {
      row = this.getOperation(id);
    } else {
      const existing = this.db.prepare('SELECT id FROM operations WHERE principal_id = ? AND client_nonce = ?').get(principalId, clientNonce);
      row = existing ? this.getOperation(existing.id) : undefined;
    }
    return {
      operation: row,
      created: inserted.changes === 1,
      challenge: row?.state === 'confirmation_required' ? this.confirmationChallenge(row.id) : undefined,
      confirmationCapability: row?.state === 'confirmation_required' ? this.confirmationCapability(row.id) : undefined,
    };
  }

  confirmOperation(id, challenge) {
    const now = Date.now();
    const operation = this.getOperation(id);
    if (!operation || !operation.confirmation_hash) return { invalid: true };
    const expectedHash = Buffer.from(operation.confirmation_hash);
    const actualHash = Buffer.from(sha256(challenge));
    if (expectedHash.length !== actualHash.length || !timingSafeEqual(expectedHash, actualHash)) return { invalid: true };
    if (operation.state === 'confirmation_required' && operation.confirmation_expires_ms <= now) {
      this.db.prepare("UPDATE operations SET state = 'expired', error_text = 'confirmation expired', updated_ms = ? WHERE id = ? AND state = 'confirmation_required'")
        .run(now, id);
      return { operation: this.getOperation(id), expired: true };
    }
    if (operation.state === 'confirmation_required') {
      const principal = this.activeCapabilityById(operation.principal_id);
      if (!principal) return { operation, authorizationInvalid: true };
      this.db.prepare(`
        UPDATE operations
        SET state = 'queued', confirmation_used_ms = ?, updated_ms = ?
        WHERE id = ? AND state = 'confirmation_required'
          AND EXISTS (
            SELECT 1 FROM capabilities c
            WHERE c.id = operations.principal_id AND c.revoked_ms IS NULL AND c.expires_ms > ?
          )
      `).run(now, now, id, now);
    }
    return { operation: this.getOperation(id) };
  }

  getOperation(id) {
    return this.db.prepare(`
      SELECT o.*,
        (SELECT COUNT(*) FROM operation_chunks c WHERE c.operation_id = o.id) AS chunk_count
      FROM operations o
      WHERE o.id = ?
    `).get(id);
  }

  getOperationChunk(id, chunkNumber) {
    return this.db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM operation_chunks all_chunks WHERE all_chunks.operation_id = c.operation_id) AS chunk_count
      FROM operation_chunks c
      WHERE c.operation_id = ? AND c.chunk_number = ?
    `).get(id, chunkNumber);
  }

  claimQueued(id) {
    const now = Date.now();
    const result = this.db.prepare("UPDATE operations SET state = 'running', updated_ms = ? WHERE id = ? AND state = 'queued'").run(now, id);
    return result.changes === 1;
  }

  completeOperation(id, resultText) {
    const now = Date.now();
    const chunks = splitUtf8(resultText);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const operation = this.db.prepare('SELECT state FROM operations WHERE id = ?').get(id);
      if (!operation || operation.state !== 'running') throw new Error('operation is not running');
      const insertChunk = this.db.prepare(`
        INSERT INTO operation_chunks (operation_id, chunk_number, content, content_sha256)
        VALUES (?, ?, ?, ?)
      `);
      chunks.forEach((content, index) => insertChunk.run(id, index + 1, content, sha256(content)));
      this.db.prepare("UPDATE operations SET state = 'completed', result_text = ?, error_text = NULL, updated_ms = ? WHERE id = ? AND state = 'running'")
        .run(chunks.length === 1 ? resultText : null, now, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  failOperation(id, errorText) {
    const now = Date.now();
    this.db.prepare("UPDATE operations SET state = 'tool_failed', error_text = ?, updated_ms = ? WHERE id = ? AND state = 'running'")
      .run(errorText, now, id);
  }

  rejectOperation(id, errorText) {
    const now = Date.now();
    this.db.prepare("UPDATE operations SET state = 'rejected', error_text = ?, updated_ms = ? WHERE id = ? AND state IN ('queued', 'running')")
      .run(errorText, now, id);
  }

  markDispatchStarted(id) {
    const now = Date.now();
    const result = this.db.prepare("UPDATE operations SET dispatch_started_ms = ?, updated_ms = ? WHERE id = ? AND state = 'running' AND dispatch_started_ms IS NULL")
      .run(now, now, id);
    return result.changes === 1;
  }

  markUnknownOutcome(id) {
    const now = Date.now();
    this.db.prepare("UPDATE operations SET state = 'unknown_outcome', error_text = 'tool outcome is ambiguous; do not retry automatically', updated_ms = ? WHERE id = ? AND state = 'running'")
      .run(now, id);
  }

  recoverOperations() {
    const now = Date.now();
    const running = this.db.prepare("SELECT id, dispatch_started_ms FROM operations WHERE state = 'running'").all();
    for (const operation of running) {
      if (operation.dispatch_started_ms === null) {
        this.db.prepare("UPDATE operations SET state = 'queued', updated_ms = ? WHERE id = ? AND state = 'running'").run(now, operation.id);
      } else {
        this.db.prepare("UPDATE operations SET state = 'unknown_outcome', error_text = 'tool outcome is ambiguous after worker interruption', updated_ms = ? WHERE id = ? AND state = 'running'")
          .run(now, operation.id);
      }
    }
  }

  queuedOperationIds() {
    return this.db.prepare("SELECT id FROM operations WHERE state = 'queued' ORDER BY created_ms").all().map(row => row.id);
  }
}

export function requestHash(requestJson) {
  return sha256(requestJson);
}
