import { randomBytes } from 'node:crypto';
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
    const ttlSeconds = process.argv[3] === undefined ? 3600 : Number(process.argv[3]);
    const issued = store.issueMainCapability(ttlSeconds);
    process.stdout.write(`capability_id: ${issued.id}\ncapability: ${issued.token}\nscope: ${issued.scope}\nexpires_at: ${new Date(issued.expiresMs).toISOString()}\n`);
  } else if (action === 'set-master') {
    const supplied = process.argv[3];
    const token = supplied === undefined ? randomBytes(32).toString('base64url') : supplied;
    store.setMasterBearer(token);
    if (supplied === undefined) process.stdout.write(`master_bearer: ${token}\n`);
    else process.stdout.write('master_bearer: set\n');
    process.stdout.write('access_ttl_seconds: 21600\n');
  } else if (action === 'revoke') {
    const capabilityId = process.argv[3];
    if (!capabilityId) throw new Error('capability ID is required');
    if (!store.revokeCapability(capabilityId)) throw new Error('capability ID was not found');
    process.stdout.write(`revoked_capability_id: ${capabilityId}\n`);
  } else {
    throw new Error('usage: node operator.mjs issue [ttl-seconds] | set-master [bearer] | revoke <capability-id>');
  }
} finally {
  store.close();
}
