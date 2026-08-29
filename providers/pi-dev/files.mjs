import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  createReadTool,
  createWriteTool,
  generateDiffString
} from '@earendil-works/pi-coding-agent';
import {
  canonicalDefaultCwd,
  canonicalWorkspaceRoot,
  resolveExistingWorkspacePath,
  resolveNewWorkspacePath,
  resolveUserPath
} from './boundary.mjs';
import { withMutationPath, withMutationPaths } from './mutation-coordinator.mjs';

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizedLineEndingView(text) {
  const sourceOffsets = [];
  let normalized = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\r' && text[index + 1] === '\n') {
      normalized += '\n';
      sourceOffsets.push(index);
      index += 1;
    } else if (text[index] === '\r') {
      normalized += '\n';
      sourceOffsets.push(index);
    } else {
      normalized += text[index];
      sourceOffsets.push(index);
    }
  }
  sourceOffsets.push(text.length);
  return { content: normalized, sourceOffsets };
}

function normalizeExactText(text) {
  return normalizeLineEndings(text.startsWith('\uFEFF') ? text.slice(1) : text);
}

function normalizeTolerantCharacters(text) {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

function normalizeTolerantText(text) {
  return text
    .split('\n')
    .map(line => normalizeTolerantCharacters(line.trimEnd()))
    .join('\n');
}

function tolerantMatchView(text) {
  const sourceOffsets = [];
  let sourceLineStart = 0;
  const lines = text.split('\n');
  const normalizedLines = lines.map((line, lineIndex) => {
    const trimmedLine = line.trimEnd();
    for (let index = 0; index < trimmedLine.length; index += 1) {
      sourceOffsets.push(sourceLineStart + index);
    }
    sourceLineStart += line.length;
    if (lineIndex < lines.length - 1) {
      sourceOffsets.push(sourceLineStart);
      sourceLineStart += 1;
    }
    return normalizeTolerantCharacters(trimmedLine);
  });
  return { content: normalizedLines.join('\n'), sourceOffsets };
}

function occurrenceMatch(content, needle) {
  if (!needle) return { count: 0, index: -1 };
  let count = 0;
  let firstIndex = -1;
  let from = 0;
  while (true) {
    const index = content.indexOf(needle, from);
    if (index === -1) return { count, index: firstIndex };
    if (count === 0) firstIndex = index;
    count += 1;
    from = index + 1;
  }
}

function exactOccurrenceCount(content, needle) {
  return occurrenceMatch(content, needle).count;
}

function decodeValidUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error('edit target must be valid UTF-8 text');
  }
}

function validateExactEdits(buffer, edits) {
  const content = normalizeExactText(decodeValidUtf8(buffer));
  for (let i = 0; i < edits.length; i += 1) {
    const oldText = normalizeExactText(edits[i].oldText);
    if (!oldText) throw new Error(`edits[${i}].oldText must not be empty`);
    const count = exactOccurrenceCount(content, oldText);
    if (count === 0) throw new Error(`edits[${i}] exact text was not found; fuzzy matching is disabled`);
    if (count > 1) throw new Error(`edits[${i}] exact text is not unique (${count} occurrences)`);
  }
}

function matchedLineRange(content, index, length) {
  const start = content.slice(0, index).split('\n').length - 1;
  const end = content.slice(0, index + length - 1).split('\n').length;
  return { start, end };
}

function classifyEdits(content, edits, path, sourceOffsets = null) {
  const tolerantView = tolerantMatchView(content);
  const tolerantContent = tolerantView.content;
  const mapSourceOffset = index => sourceOffsets ? sourceOffsets[index] : index;
  const matches = edits.map((edit, editIndex) => {
    const oldText = normalizeLineEndings(edit.oldText);
    const newText = normalizeLineEndings(edit.newText);
    if (!oldText) throw new Error(`edits[${editIndex}].oldText must not be empty`);

    const exactMatch = occurrenceMatch(content, oldText);
    if (exactMatch.count > 1) {
      throw new Error(`edits[${editIndex}] exact text is not unique (${exactMatch.count} occurrences)`);
    }
    if (exactMatch.count === 1) {
      const normalizedIndex = exactMatch.index;
      const normalizedEnd = normalizedIndex + oldText.length;
      const index = mapSourceOffset(normalizedIndex);
      const end = mapSourceOffset(normalizedEnd);
      return {
        kind: 'exact', editIndex, index, length: end - index, newText,
        lines: matchedLineRange(content, normalizedIndex, oldText.length)
      };
    }

    const tolerantOldText = normalizeTolerantText(oldText);
    const tolerantMatch = occurrenceMatch(tolerantContent, tolerantOldText);
    if (tolerantMatch.count === 0) {
      throw new Error(`edits[${editIndex}] text was not found, including tolerant normalization`);
    }
    if (tolerantMatch.count > 1) {
      throw new Error(`edits[${editIndex}] tolerant text is not unique (${tolerantMatch.count} occurrences)`);
    }
    const normalizedIndex = tolerantMatch.index;
    const normalizedEnd = normalizedIndex + tolerantOldText.length;
    const contentIndex = tolerantView.sourceOffsets[normalizedIndex];
    const contentEnd = tolerantView.sourceOffsets[normalizedEnd - 1] + 1;
    const index = mapSourceOffset(contentIndex);
    const end = mapSourceOffset(contentEnd);
    return {
      kind: 'tolerant', editIndex, index, length: end - index, newText,
      lines: matchedLineRange(tolerantContent, normalizedIndex, tolerantOldText.length)
    };
  });

  const exact = matches.filter(match => match.kind === 'exact').sort((a, b) => a.index - b.index);
  for (let index = 1; index < exact.length; index += 1) {
    const previous = exact[index - 1];
    const current = exact[index];
    if (previous.index + previous.length > current.index) {
      throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}`);
    }
  }

  const tolerant = matches.filter(match => match.kind === 'tolerant').sort((a, b) => a.index - b.index);
  for (let index = 1; index < tolerant.length; index += 1) {
    const previous = tolerant[index - 1];
    const current = tolerant[index];
    if (previous.index + previous.length > current.index) {
      throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}`);
    }
  }
  for (const exactMatch of exact) {
    for (const tolerantMatch of tolerant) {
      if (exactMatch.lines.start < tolerantMatch.lines.end && tolerantMatch.lines.start < exactMatch.lines.end) {
        throw new Error(
          `edits[${exactMatch.editIndex}] and edits[${tolerantMatch.editIndex}] share lines across exact and tolerant matching; merge them into one edit`
        );
      }
    }
  }
  return { exact, tolerant };
}

function applyMatchedEdits(content, matches) {
  const replacements = [...matches.exact, ...matches.tolerant].map(match => {
    const end = match.index + match.length;
    return {
      start: match.index,
      end,
      newText: restoreReplacementLineEndings(match.newText, content.slice(match.index, end))
    };
  });
  replacements.sort((a, b) => a.start - b.start);
  let result = content;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    result = result.slice(0, replacement.start) + replacement.newText + result.slice(replacement.end);
  }
  return result;
}

function restoreReplacementLineEndings(text, source) {
  const sourceLineEndings = source.match(/\r\n|\r|\n/g) ?? [];
  let index = 0;
  return text.replace(/\n/g, () => sourceLineEndings[index++] ?? sourceLineEndings.at(-1) ?? '\n');
}

function modelFacingPathMessage(error, absolutePath, relativePath) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(absolutePath).join(relativePath);
}

function modelFacingPathError(error, absolutePath, relativePath) {
  const sanitized = modelFacingPathMessage(error, absolutePath, relativePath);
  const wrapped = new Error(sanitized);
  if (error && typeof error === 'object' && 'code' in error) wrapped.code = error.code;
  return wrapped;
}

export function createStrictEditOperations(edits, signal) {
  let snapshot = null;
  let snapshotPath = null;
  return {
    access: absolutePath => fs.access(absolutePath, constants.R_OK | constants.W_OK),
    readFile: async absolutePath => {
      const buffer = await fs.readFile(absolutePath);
      validateExactEdits(buffer, edits);
      snapshot = Buffer.from(buffer);
      snapshotPath = absolutePath;
      return buffer;
    },
    writeFile: async (absolutePath, content) => {
      if (!snapshot || snapshotPath !== absolutePath) throw new Error('edit snapshot is missing');
      await withMutationPath(absolutePath, async () => {
        const current = await fs.readFile(absolutePath);
        if (!current.equals(snapshot)) throw new Error('file changed during edit; reread and reconcile');
        await fs.writeFile(absolutePath, content, 'utf8');
      }, { signal });
    }
  };
}

const exclusiveWriteOperations = {
  mkdir: async dir => {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) throw new Error('write parent must be a directory');
  },
  writeFile: (absolutePath, content) => fs.writeFile(
    absolutePath,
    content,
    { encoding: 'utf8', flag: 'wx' }
  )
};

async function resolveFilePolicy({ pathMode = 'workspace', workspaceRoot, defaultCwd }) {
  if (pathMode === 'workspace') {
    const root = await canonicalWorkspaceRoot(workspaceRoot);
    return { root, pathMode };
  }
  if (pathMode === 'user') {
    const root = await canonicalDefaultCwd(defaultCwd);
    return { root, pathMode };
  }
  throw new Error('MCP_DEV_PATH_MODE must be workspace or user');
}

export async function runRead({ pathMode = 'workspace', defaultCwd, workspaceRoot, path, offset, limit }, signal) {
  const policy = await resolveFilePolicy({ pathMode, workspaceRoot, defaultCwd });
  const target = policy.pathMode === 'user'
    ? await resolveUserPath(policy.root, path)
    : await resolveExistingWorkspacePath(policy.root, path);
  const tool = createReadTool(policy.root);
  try {
    return await tool.execute(randomUUID(), { path: target, offset, limit }, signal);
  } catch (error) {
    throw modelFacingPathError(error, target, path);
  }
}


function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  throw error;
}

async function readHandleBytes(handle) {
  const chunks = [];
  let position = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
    if (bytesRead < buffer.length) break;
  }
  return Buffer.concat(chunks);
}

async function writeHandleBytes(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error('edit write made no progress');
    }
    offset += bytesWritten;
  }
}

function editPartialError(details) {
  const error = new Error('EDIT_PARTIAL');
  error.code = 'EDIT_PARTIAL';
  error.editPartial = details;
  return error;
}

async function mutatePlannedTarget(plan, signal, operations) {
  await operations.beforeGuard?.(plan);
  throwIfAborted(signal);
  let handle;
  let mutationStarted = false;
  let mutationCompleted = false;
  let primaryError = null;
  try {
    handle = await operations.openFile(
      plan.canonicalPath,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)
    );
    const stat = await handle.stat();
    if (stat.dev !== plan.identity.dev || stat.ino !== plan.identity.ino) {
      const error = new Error('file identity changed since preflight; reread and reconcile');
      error.mutationStarted = false;
      throw error;
    }
    const current = await readHandleBytes(handle);
    if (!current.equals(plan.snapshot)) {
      const error = new Error('file changed since preflight; reread and reconcile');
      error.mutationStarted = false;
      throw error;
    }
    throwIfAborted(signal);
    const proposed = Buffer.from(plan.proposed, 'utf8');
    if (proposed.length === 0) {
      mutationStarted = true;
      await handle.truncate(0);
    } else {
      mutationStarted = true;
      await writeHandleBytes(handle, proposed);
      await handle.truncate(proposed.length);
    }
    mutationCompleted = true;
    return { state: 'APPLIED' };
  } catch (error) {
    primaryError = error;
    if (error && typeof error === 'object' && !('mutationStarted' in error)) {
      error.mutationStarted = mutationStarted;
    }
    throw error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        if (!primaryError && !mutationCompleted) throw closeError;
        // A close failure must not overwrite the real mutation error, and once the
        // complete write/truncate sequence succeeded the target is already APPLIED.
      }
    }
  }
}

export async function runEdit({ pathMode = 'workspace', defaultCwd, workspaceRoot, targets }, signal, operationOverrides = {}) {
  const policy = await resolveFilePolicy({ pathMode, workspaceRoot, defaultCwd });
  const operations = {
    openFile: (target, flags) => fs.open(target, flags),
    beforeGuard: null,
    ...operationOverrides
  };
  const requestedTargets = Array.isArray(targets) ? targets : [];
  if (requestedTargets.length === 0) throw new Error('edit targets must contain at least one file');

  const resolved = [];
  for (const request of requestedTargets) {
    const canonicalPath = policy.pathMode === 'user'
      ? await resolveUserPath(policy.root, request.path)
      : await resolveExistingWorkspacePath(policy.root, request.path);
    resolved.push({ requestedPath: request.path, canonicalPath, edits: request.edits });
  }

  const seen = new Set();
  for (const target of resolved) {
    if (seen.has(target.canonicalPath)) {
      throw new Error(`duplicate edit target resolves to the same file: ${target.requestedPath}`);
    }
    seen.add(target.canonicalPath);
  }

  return withMutationPaths(resolved.map(target => target.canonicalPath), async () => {
    const plans = [];
    for (const target of resolved) {
      const stat = await fs.stat(target.canonicalPath);
      if (!stat.isFile()) throw new Error(`${target.requestedPath} must resolve to a regular file`);
      const snapshot = await fs.readFile(target.canonicalPath);
      const rawContent = decodeValidUtf8(snapshot);
      try {
        await fs.access(target.canonicalPath, constants.R_OK | constants.W_OK);
      } catch (error) {
        throw modelFacingPathError(error, target.canonicalPath, target.requestedPath);
      }
      throwIfAborted(signal);

      const bom = rawContent.startsWith('\uFEFF') ? '\uFEFF' : '';
      const content = bom ? rawContent.slice(1) : rawContent;
      const lineEndingView = normalizedLineEndingView(content);
      const baseContent = lineEndingView.content;
      let matches;
      try {
        matches = classifyEdits(baseContent, target.edits, target.canonicalPath, lineEndingView.sourceOffsets);
      } catch (error) {
        throw modelFacingPathError(error, target.canonicalPath, target.requestedPath);
      }

      const newContent = applyMatchedEdits(content, matches);

      if (newContent === content) throw new Error(`edit produced no changes for ${target.requestedPath}`);
      const proposed = bom + newContent;
      const diff = generateDiffString(baseContent, normalizeLineEndings(newContent)).diff;
      plans.push({ ...target, identity: { dev: stat.dev, ino: stat.ino }, snapshot, proposed, diff });
    }

    const applied = [];
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      if (applied.length > 0 && signal?.aborted) {
        throw editPartialError({
          applied,
          failed: [],
          uncertain: [],
          unattempted: plans.slice(index).map(item => item.requestedPath),
          reason: 'cancelled'
        });
      }
      try {
        await mutatePlannedTarget(plan, signal, operations);
        applied.push(plan.requestedPath);
      } catch (error) {
        const message = modelFacingPathMessage(error, plan.canonicalPath, plan.requestedPath);
        const unattempted = plans.slice(index + 1).map(item => item.requestedPath);
        if (applied.length === 0 && !error?.mutationStarted) {
          throw modelFacingPathError(error, plan.canonicalPath, plan.requestedPath);
        }
        if (error?.mutationStarted) {
          throw editPartialError({
            applied,
            failed: [],
            uncertain: [{ path: plan.requestedPath, message: `${message}; write state unknown; reread target before retrying` }],
            unattempted
          });
        }
        throw editPartialError({
          applied,
          failed: [{ path: plan.requestedPath, message }],
          uncertain: [],
          unattempted
        });
      }
    }

    const results = plans.map(plan => ({ path: plan.requestedPath, diff: plan.diff }));
    return {
      targets: results,
      details: results.length === 1 ? { diff: results[0].diff } : undefined
    };
  }, { signal });
}

export async function runWrite({ pathMode = 'workspace', defaultCwd, workspaceRoot, path, content }, signal) {
  const policy = await resolveFilePolicy({ pathMode, workspaceRoot, defaultCwd });
  const target = policy.pathMode === 'user'
    ? await resolveUserPath(policy.root, path, { mustExist: false })
    : await resolveNewWorkspacePath(policy.root, path);
  const tool = createWriteTool(policy.root, { operations: exclusiveWriteOperations });
  try {
    return await tool.execute(randomUUID(), { path: target, content }, signal);
  } catch (error) {
    if (error?.code === 'EEXIST' || /EEXIST/.test(error?.message ?? '')) {
      throw new Error('file already exists; use edit for existing files');
    }
    throw modelFacingPathError(error, target, path);
  }
}
