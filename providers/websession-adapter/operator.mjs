import { randomBytes } from 'node:crypto';
import { renderPairingPrompt } from './pairing-prompt.mjs';
import { AdapterStore } from './store.mjs';

process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0);
});

const action = process.argv[2];
const stateDir = process.env.WEBSESSION_ADAPTER_STATE_DIR;
if (!stateDir) throw new Error('WEBSESSION_ADAPTER_STATE_DIR is required');

const store = new AdapterStore(stateDir);
try {
  if (action === 'issue') {
    const ttlSeconds = process.argv[3] === undefined || process.argv[3] === '' ? 86400 : Number(process.argv[3]);
    const defaultCwd = process.argv[4] ? process.argv[4] : null;
    const issued = store.issueMainCapability(ttlSeconds, { defaultCwd });
    const lines = [
      `capability_id: ${issued.id}`,
      `capability: ${issued.token}`,
      `scope: ${issued.scope}`,
      `expires_at: ${new Date(issued.expiresMs).toISOString()}`,
    ];
    if (issued.defaultCwd !== null) lines.push(`default_cwd: ${issued.defaultCwd}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  } else if (action === 'set-master') {
    const supplied = process.argv[3];
    const token = supplied === undefined ? randomBytes(32).toString('base64url') : supplied;
    store.setMasterBearer(token);
    if (supplied === undefined) process.stdout.write(`master_bearer: ${token}\n`);
    else process.stdout.write('master_bearer: set\n');
    process.stdout.write(`service_principal: ${store.masterPrincipalId()}\n`);
    process.stdout.write('exchange_ttl_seconds: 21600\n');
  } else if (action === 'master-status') {
    const principalId = store.masterPrincipalId();
    if (!principalId) throw new Error('no master bearer is configured');
    const principal = store.activeCapabilityById(principalId);
    process.stdout.write(`service_principal: ${principalId}\n`);
    process.stdout.write(`state: ${principal ? 'active' : 'revoked'}\n`);
    if (principal?.defaultCwd) process.stdout.write(`default_cwd: ${principal.defaultCwd}\n`);
  } else if (action === 'revoke-master') {
    const principalId = store.masterPrincipalId();
    if (!principalId) throw new Error('no master bearer is configured');
    if (!store.revokeCapability(principalId)) throw new Error('service principal was not found');
    process.stdout.write(`revoked_service_principal: ${principalId}\n`);
  } else if (action === 'pair') {
    const ttlSeconds = process.argv[3] === undefined || process.argv[3] === '' ? 21600 : Number(process.argv[3]);
    const pairTtlSeconds = process.argv[4] === undefined || process.argv[4] === '' ? 300 : Number(process.argv[4]);
    const defaultCwd = process.argv[5] ? process.argv[5] : null;
    const pairing = store.issuePairingCode({ ttlSeconds, pairTtlSeconds, defaultCwd });
    const lines = [
      `pair_code: ${pairing.code}`,
      `capability_id: ${pairing.capabilityId}`,
      `pair_expires_at: ${new Date(pairing.pairExpiresMs).toISOString()}`,
      `expires_at: ${new Date(pairing.expiresMs).toISOString()}`,
    ];
    if (pairing.defaultCwd !== null) lines.push(`default_cwd: ${pairing.defaultCwd}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  } else if (action === 'prompt') {
    const [base, pairCode, pairExpiresAt, expiresAt, defaultCwd] = process.argv.slice(3);
    if (!base || !pairCode || !pairExpiresAt || !expiresAt) {
      throw new Error('prompt requires <base> <pair-code> <pair-expires-at> <expires-at> [default-cwd]');
    }
    process.stdout.write(`${renderPairingPrompt({ base, pairCode, pairExpiresAt, expiresAt, defaultCwd: defaultCwd || null })}\n`);
  } else if (action === 'revoke') {
    const capabilityId = process.argv[3];
    if (!capabilityId) throw new Error('capability ID is required');
    if (!store.revokeCapability(capabilityId)) throw new Error('capability ID was not found');
    process.stdout.write(`revoked_capability_id: ${capabilityId}\n`);
  } else {
    throw new Error('usage: node operator.mjs issue [ttl-seconds] [default-cwd] | pair [ttl-seconds] [pair-ttl-seconds] [default-cwd] | prompt <base> <pair-code> <pair-expires-at> <expires-at> [default-cwd] | set-master [bearer] | master-status | revoke-master | revoke <capability-id>');
  }
} finally {
  store.close();
}
