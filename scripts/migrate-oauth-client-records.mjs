#!/usr/bin/env node
/**
 * Removes the 30-day expiry from existing inbound OAuth client registrations.
 *
 * The pinned runtime stores each dynamic client registration as
 * sessions/sessions/server/session_cli_<clientId>.json with an `expires` field and
 * a `client_secret_expires_at` value. Both are enforced: the storage layer deletes
 * an expired record on read, and the SDK's client authentication rejects an
 * expired secret. This migration clears both without changing any client id,
 * secret, redirect URI, or grant.
 *
 * Records the runtime already deleted cannot be reconstructed here; they are
 * reported so the owner can reconnect that connector.
 *
 * Usage:
 *   node scripts/migrate-oauth-client-records.mjs --state-dir <bridge-state-dir> [--apply] [--revive-expired]
 *
 * Default is a dry run. Nothing is written without --apply.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CLIENT_PREFIX = 'session_cli_';
const FILE_EXTENSION = '.json';

function parseArgs(argv) {
  const options = { stateDir: '', apply: false, reviveExpired: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--revive-expired') options.reviveExpired = true;
    else if (arg === '--state-dir') {
      options.stateDir = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--state-dir=')) options.stateDir = arg.slice('--state-dir='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.stateDir) throw new Error('--state-dir is required');
  return options;
}

function clientRecordsDir(stateDir) {
  return path.join(stateDir, '1mcp', 'sessions', 'sessions', 'server');
}

function assertOwnerOnly(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error(`refusing a non-regular client record: ${path.basename(filePath)}`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`refusing a group/other-accessible client record: ${path.basename(filePath)}`);
  }
}

function writeAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const directory = clientRecordsDir(options.stateDir);
  if (!fs.existsSync(directory)) {
    console.log(`no inbound OAuth client records at ${directory}`);
    return;
  }

  const now = Date.now();
  const report = { migrated: [], already: [], expired: [], skipped: [] };

  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.startsWith(CLIENT_PREFIX) || !name.endsWith(FILE_EXTENSION)) continue;
    const filePath = path.join(directory, name);
    const clientId = name.slice(CLIENT_PREFIX.length, -FILE_EXTENSION.length);
    let record;
    try {
      assertOwnerOnly(filePath);
      record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      report.skipped.push({ clientId, reason: error.message });
      continue;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      report.skipped.push({ clientId, reason: 'record is not an object' });
      continue;
    }

    const hasExpiry = Object.hasOwn(record, 'expires');
    const secretExpiry = record.client_secret_expires_at;
    const secretExpired = typeof secretExpiry === 'number' && secretExpiry > 0 && secretExpiry * 1000 <= now;
    const recordExpired = typeof record.expires === 'number' && record.expires <= now;

    if (!hasExpiry && (secretExpiry === 0 || secretExpiry === undefined)) {
      report.already.push({ clientId, clientName: record.client_name ?? null });
      continue;
    }
    if ((recordExpired || secretExpired) && !options.reviveExpired) {
      report.expired.push({ clientId, clientName: record.client_name ?? null });
      continue;
    }

    const migrated = { ...record, client_secret_expires_at: 0 };
    delete migrated.expires;
    if (options.apply) writeAtomic(filePath, migrated);
    report.migrated.push({ clientId, clientName: record.client_name ?? null, revived: recordExpired || secretExpired });
  }

  const mode = options.apply ? 'applied' : 'dry run (pass --apply to write)';
  console.log(`inbound OAuth client records: ${mode}`);
  console.log(`  directory: ${directory}`);
  console.log(`  migrated:  ${report.migrated.length}`);
  console.log(`  current:   ${report.already.length}`);
  console.log(`  expired:   ${report.expired.length}`);
  console.log(`  skipped:   ${report.skipped.length}`);
  for (const entry of report.migrated) {
    console.log(`  migrated ${entry.clientId}${entry.clientName ? ` (${entry.clientName})` : ''}${entry.revived ? ' [revived expired record]' : ''}`);
  }
  for (const entry of report.expired) {
    console.log(`  expired  ${entry.clientId}${entry.clientName ? ` (${entry.clientName})` : ''} - reconnect this connector, or re-run with --revive-expired`);
  }
  for (const entry of report.skipped) {
    console.log(`  skipped  ${entry.clientId} - ${entry.reason}`);
  }
  if (report.expired.length > 0) {
    console.log('  note: an expired record cannot be repaired by a lifetime change alone; the connector must be reconnected.');
  }
}

try {
  main();
} catch (error) {
  console.error(`migrate-oauth-client-records: ${error.message}`);
  process.exitCode = 1;
}
