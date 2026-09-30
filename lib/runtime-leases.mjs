import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Stateful provider work can outlive an RPC. A lease pins the runtime until
// that work is closed; process identity prevents a dead owner's PID reuse
// from keeping an abandoned lease alive.
async function processIdentity(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { state: fields[0], startTicks: fields[19] };
}

export async function acquireRuntimeLease({ directory = process.env.MCP_LIFECYCLE_LEASE_DIR, kind = 'work' } = {}) {
  if (!directory) return { async close() {} };
  if (!path.isAbsolute(directory)) throw new Error('MCP_LIFECYCLE_LEASE_DIR must be absolute');
  const identity = await processIdentity(process.pid);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, startTicks: identity.startTicks, kind }), {
    flag: 'wx', mode: 0o600
  });
  let closed = false;
  return {
    async close() {
      if (closed) return;
      await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      closed = true;
    }
  };
}

export async function hasActiveRuntimeLeases(directory = process.env.MCP_LIFECYCLE_LEASE_DIR) {
  if (!directory) return false;
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    return error.code !== 'ENOENT';
  }
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}\.json$/.test(entry)) continue;
    const file = path.join(directory, entry);
    let lease;
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > 4096 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return true;
      lease = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0 || !/^\d+$/.test(lease.startTicks ?? '')) return true;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      return true;
    }
    let active;
    try {
      const identity = await processIdentity(lease.pid);
      active = identity.startTicks === lease.startTicks && !['Z', 'X'].includes(identity.state);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) return true;
      active = false;
    }
    if (active) return true;
    // Stale leases are ignored. Leaving cleanup to their owner avoids deleting
    // a replacement file while another provider is acquiring a lease.
  }
  return false;
}
