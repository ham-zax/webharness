import fs from 'node:fs/promises';

function poolError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export class RepoChildPool {
  constructor({ childFactory, maxActive = 4 } = {}) {
    if (typeof childFactory !== 'function') throw new TypeError('childFactory is required');
    if (!Number.isInteger(maxActive) || maxActive < 1) throw new TypeError('maxActive must be a positive integer');
    this.childFactory = childFactory;
    this.maxActive = maxActive;
    this.children = new Map();
    this.pending = new Map();
    this.closed = false;
  }

  get activeCount() {
    return this.children.size;
  }

  get pendingCount() {
    return this.pending.size;
  }

  inspect() {
    return [...this.children.entries()]
      .map(([root, child]) => ({ root, pid: child.pid ?? null, alive: Boolean(child.alive) }))
      .sort((a, b) => a.root.localeCompare(b.root));
  }

  async canonicalRoot(repoRoot) {
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
      throw poolError('INVALID_REPOSITORY', 'repository root must be a non-empty path');
    }
    try {
      const root = await fs.realpath(repoRoot);
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) throw new Error('not a directory');
      return root;
    } catch (error) {
      const existing = this.children.get(repoRoot);
      if (existing) await this.removeChild(repoRoot, existing);
      throw poolError('REPOSITORY_DISAPPEARED', `repository root is unavailable: ${repoRoot}`, error);
    }
  }

  async removeChild(root, child) {
    if (this.children.get(root) === child) this.children.delete(root);
    try {
      await child.close();
    } catch {
      // The child may already be gone; its slot is still released.
    }
  }

  async getChild(repoRoot) {
    if (this.closed) throw poolError('ROUTER_CLOSED', 'router child pool is shut down');
    const root = await this.canonicalRoot(repoRoot);

    const existing = this.children.get(root);
    if (existing?.alive) return existing;
    if (existing) await this.removeChild(root, existing);

    const pending = this.pending.get(root);
    if (pending) return pending;

    if (this.children.size + this.pending.size >= this.maxActive) {
      throw poolError(
        'ROUTER_CAPACITY',
        `maximum active CodeDB children is ${this.maxActive}; close work or retry an existing repository`
      );
    }

    const spawnPromise = (async () => {
      const child = await this.childFactory(root);
      if (this.closed) {
        try { await child.close(); } catch { /* already gone */ }
        throw poolError('ROUTER_CLOSED', 'router child pool shut down during child startup');
      }
      this.children.set(root, child);
      return child;
    })();

    this.pending.set(root, spawnPromise);
    try {
      return await spawnPromise;
    } finally {
      if (this.pending.get(root) === spawnPromise) this.pending.delete(root);
    }
  }

  async call(repoRoot, name, args = {}) {
    if (typeof name !== 'string' || name.length === 0) throw new TypeError('tool name is required');
    const root = await this.canonicalRoot(repoRoot);
    let child = await this.getChild(root);
    try {
      return await child.callTool(name, args);
    } catch (error) {
      if (child.alive) throw error;
      await this.removeChild(root, child);
      child = await this.getChild(root);
      return child.callTool(name, args);
    }
  }

  async release(root) {
    const child = this.children.get(root);
    if (!child) return false;
    await this.removeChild(root, child);
    return true;
  }

  async pruneMissing() {
    const removed = [];
    for (const [root, child] of [...this.children.entries()]) {
      try {
        const stat = await fs.stat(root);
        if (stat.isDirectory()) continue;
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      }
      await this.removeChild(root, child);
      removed.push(root);
    }
    return removed.sort();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;

    const pending = [...this.pending.values()];
    if (pending.length > 0) await Promise.allSettled(pending);

    const children = [...this.children.entries()];
    this.children.clear();
    await Promise.allSettled(children.map(([, child]) => child.close()));
  }
}
