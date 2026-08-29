import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { resolveUserCwd } from './boundary.mjs';
import { withMutationPaths } from './mutation-coordinator.mjs';

function fileOpsError(message, code = 'FILE_OPS_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  throw error;
}

function requirePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw fileOpsError(`${label} must be a non-empty path`);
  }
  if (value.includes('\0')) throw fileOpsError(`${label} contains a NUL byte`);
  return value;
}

async function resolveTopologyEntry(baseCwd, value, label) {
  requirePath(value, label);
  const unresolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseCwd, value);
  const unresolvedParent = path.dirname(unresolved);
  let parent;
  try {
    parent = await fs.realpath(unresolvedParent);
  } catch (error) {
    if (error?.code === 'ENOENT') throw fileOpsError(`${label} parent must already exist`);
    throw error;
  }
  const parentStat = await fs.stat(parent, { bigint: true });
  if (!parentStat.isDirectory()) throw fileOpsError(`${label} parent must be a directory`);
  return {
    entry: path.join(parent, path.basename(unresolved)),
    parent,
    parentDev: parentStat.dev,
  };
}

function snapshot(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameFileObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameFileObject(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

const defaultOperations = {
  openFile: (target, flags) => fs.open(target, flags),
  lstat: target => fs.lstat(target),
  stat: target => fs.stat(target, { bigint: true }),
  link: (source, destination) => fs.link(source, destination),
  unlink: target => fs.unlink(target),
};

async function inspectRegularEntry(operations, target, label) {
  let handle;
  try {
    handle = await operations.openFile(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      throw fileOpsError(`${label} must be an existing regular file`, 'FILE_OPS_CONFLICT');
    }
    return snapshot(stat);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw fileOpsError(`${label} must not be a symbolic link`, 'FILE_OPS_CONFLICT');
    }
    if (error?.code === 'ENOENT') {
      throw fileOpsError(`${label} must be an existing regular file`, 'FILE_OPS_CONFLICT');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function requireDestinationAbsent(operations, target, label) {
  try {
    await operations.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw fileOpsError(`${label} already exists`, 'FILE_OPS_CONFLICT');
}

function exdevError(item) {
  return fileOpsError(
    `move ${item.path} -> ${item.to} is unsupported across filesystems (EXDEV)`,
    'EXDEV'
  );
}

async function requireDestinationFilesystem(operations, item) {
  const parentStat = await operations.stat(item.destinationParent);
  if (!parentStat.isDirectory()) {
    throw fileOpsError(`move destination ${item.to} parent must be a directory`, 'FILE_OPS_CONFLICT');
  }
  if (parentStat.dev !== item.identity.dev) throw exdevError(item);
}

function operationRecord(item) {
  return item.kind === 'move'
    ? { kind: 'move', path: item.path, to: item.to }
    : { kind: 'delete', path: item.path };
}

function failedRecord(item, error) {
  return { ...operationRecord(item), message: error instanceof Error ? error.message : String(error) };
}

function fileOpsPartialError(details) {
  const error = new Error('FILE_OPS_PARTIAL');
  error.code = 'FILE_OPS_PARTIAL';
  error.fileOpsPartial = details;
  return error;
}

function claimEntry(claimed, target, label) {
  const existing = claimed.get(target);
  if (existing) {
    throw fileOpsError(`${label} conflicts with ${existing}`, 'FILE_OPS_CONFLICT');
  }
  claimed.set(target, label);
}

function validateOperation(operation, index) {
  if (!operation || typeof operation !== 'object') {
    throw fileOpsError(`operations[${index}] must be an object`);
  }
  if (!['move', 'delete'].includes(operation.kind)) {
    throw fileOpsError(`operations[${index}].kind must be move or delete`);
  }
  requirePath(operation.path, `operations[${index}].path`);
  if (operation.kind === 'move') requirePath(operation.to, `operations[${index}].to`);
}

export async function preflightFileOps({ pathMode = 'user', defaultCwd, operations, cwd, signal }) {
  if (pathMode !== 'user') {
    throw fileOpsError('file_ops is available only in personal user path mode');
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    throw fileOpsError('file_ops operations must contain at least one operation');
  }

  const baseCwd = await resolveUserCwd(defaultCwd, cwd);
  const claimed = new Map();
  const plan = [];
  const mutationPaths = [];

  for (let index = 0; index < operations.length; index += 1) {
    throwIfAborted(signal);
    const operation = operations[index];
    validateOperation(operation, index);

    const sourcePath = await resolveTopologyEntry(baseCwd, operation.path, `source ${operation.path}`);
    claimEntry(claimed, sourcePath.entry, `source ${operation.path}`);
    const identity = await inspectRegularEntry(defaultOperations, sourcePath.entry, `source ${operation.path}`);
    mutationPaths.push(sourcePath.entry);

    if (operation.kind === 'delete') {
      plan.push({
        kind: 'delete',
        path: operation.path,
        source: sourcePath.entry,
        identity,
      });
      continue;
    }

    const destinationPath = await resolveTopologyEntry(baseCwd, operation.to, `move destination ${operation.to}`);
    claimEntry(claimed, destinationPath.entry, `move destination ${operation.to}`);
    await requireDestinationAbsent(defaultOperations, destinationPath.entry, `move destination ${operation.to}`);
    const item = {
      kind: 'move',
      path: operation.path,
      to: operation.to,
      source: sourcePath.entry,
      destination: destinationPath.entry,
      destinationParent: destinationPath.parent,
      identity,
    };
    if (destinationPath.parentDev !== identity.dev) throw exdevError(item);
    plan.push(item);
    mutationPaths.push(destinationPath.entry);
  }

  throwIfAborted(signal);
  return { operations: plan, mutationPaths, signal };
}

async function assertSourceSnapshot(operations, item) {
  const current = await inspectRegularEntry(operations, item.source, `source ${item.path}`);
  if (!sameSnapshot(current, item.identity)) {
    throw fileOpsError(
      `${item.kind} ${item.path} changed since preflight; reread and reconcile`,
      'FILE_OPS_CONFLICT'
    );
  }
  return current;
}

async function expectedSourceEntryRetained(operations, item) {
  try {
    const current = await inspectRegularEntry(operations, item.source, `source ${item.path}`);
    return sameFileObject(current, item.identity);
  } catch (error) {
    if (error?.code === 'FILE_OPS_CONFLICT' || error?.code === 'ENOENT' || error?.code === 'ELOOP') return false;
    return undefined;
  }
}

function mapLinkError(error, item) {
  if (error?.code === 'EEXIST') {
    return fileOpsError(`move destination ${item.to} already exists`, 'FILE_OPS_CONFLICT');
  }
  if (error?.code === 'EXDEV') return exdevError(item);
  return error;
}

export async function applyFileOpsPlan(plan, operationOverrides = {}) {
  const operations = { ...defaultOperations, ...operationOverrides };
  const completed = [];

  return withMutationPaths(plan.mutationPaths, async () => {
    throwIfAborted(plan.signal);

    // Revalidate the complete batch after the lease is granted so queued races
    // are rejected before this batch performs its first mutation.
    for (const item of plan.operations) {
      await assertSourceSnapshot(operations, item);
      if (item.kind === 'move') {
        await requireDestinationFilesystem(operations, item);
        await requireDestinationAbsent(operations, item.destination, `move destination ${item.to}`);
      }
    }

    for (let index = 0; index < plan.operations.length; index += 1) {
      const item = plan.operations[index];
      if (plan.signal?.aborted) {
        if (completed.length === 0) throwIfAborted(plan.signal);
        throw fileOpsPartialError({
          completed,
          failed: [],
          uncertain: [],
          unattempted: plan.operations.slice(index).map(operationRecord),
          reason: 'cancelled',
        });
      }

      let destinationLinked = false;
      try {
        if (item.kind === 'delete') {
          await assertSourceSnapshot(operations, item);
          throwIfAborted(plan.signal);
          await operations.unlink(item.source);
        } else {
          await requireDestinationFilesystem(operations, item);
          await requireDestinationAbsent(operations, item.destination, `move destination ${item.to}`);
          await assertSourceSnapshot(operations, item);
          throwIfAborted(plan.signal);
          try {
            await operations.link(item.source, item.destination);
          } catch (error) {
            throw mapLinkError(error, item);
          }
          destinationLinked = true;

          // From link creation through guarded source unlink, deliberately ignore
          // cancellation so a cancellation cannot manufacture a half-move.
          const destinationIdentity = await inspectRegularEntry(
            operations,
            item.destination,
            `move destination ${item.to}`
          );
          if (!sameFileObject(destinationIdentity, item.identity)) {
            throw fileOpsError(
              `move ${item.path} -> ${item.to} destination identity does not match the preflight source`,
              'FILE_OPS_CONFLICT'
            );
          }
          const sourceIdentity = await inspectRegularEntry(operations, item.source, `source ${item.path}`);
          if (!sameSnapshot(sourceIdentity, destinationIdentity)) {
            throw fileOpsError(
              `move ${item.path} source changed after destination link creation; inspect both paths before retrying`,
              'FILE_OPS_CONFLICT'
            );
          }
          await operations.unlink(item.source);
        }

        completed.push(operationRecord(item));
      } catch (error) {
        const unattempted = plan.operations.slice(index + 1).map(operationRecord);
        if (destinationLinked) {
          const retained = await expectedSourceEntryRetained(operations, item);
          const sideEffects = { destination_link_created: true };
          if (retained !== undefined) sideEffects.expected_source_entry_retained = retained;
          throw fileOpsPartialError({
            completed,
            failed: [],
            uncertain: [{
              ...operationRecord(item),
              message: `${error instanceof Error ? error.message : String(error)}; destination link was created; inspect both paths before retrying`,
              sideEffects,
            }],
            unattempted,
          });
        }
        if (completed.length === 0) throw error;
        throw fileOpsPartialError({
          completed,
          failed: [failedRecord(item, error)],
          uncertain: [],
          unattempted,
        });
      }
    }

    return { operations: completed };
  }, { signal: plan.signal });
}

export async function runFileOps(args, signal) {
  const plan = await preflightFileOps({ ...args, signal });
  return applyFileOpsPlan(plan);
}
