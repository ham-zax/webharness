import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { currentCall, markMutation } from './call-diagnostics.mjs';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  generateDiffString,
  truncateHead
} from '@earendil-works/pi-coding-agent';
import {
  canonicalDefaultCwd,
  canonicalWorkspaceRoot,
  createParents,
  resolveExistingWorkspacePath,
  resolveNewWorkspacePath,
  resolveWorkspaceEntry,
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

const ANCHOR_MAX_CONTENT_BYTES = 512 * 1024;
const ANCHOR_MIN_SCORE = 0.35;
const ANCHOR_SNIPPET_MAX_LINES = 10;
const ANCHOR_SNIPPET_MAX_CHARS = 800;
const ANCHOR_CANDIDATE_LIMIT = 200;

function bigramSet(text) {
  const compact = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const grams = new Set();
  if (compact.length === 1) grams.add(compact);
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.add(compact.slice(index, index + 2));
  }
  return grams;
}

function bigramSimilarity(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) {
    if (right.has(gram)) shared += 1;
  }
  return (2 * shared) / (left.size + right.size);
}

function anchorWords(text) {
  return new Set(text.toLowerCase().match(/[A-Za-z0-9_$]{3,}/g) ?? []);
}

// Recovery hint for a missed anchor: the closest numbered window of the file, or null when
// no window is similar enough to be useful.
function findClosestAnchorSnippet(content, oldText) {
  if (Buffer.byteLength(content, 'utf8') > ANCHOR_MAX_CONTENT_BYTES) return null;
  const oldLines = normalizeLineEndings(oldText).split('\n');
  const needleLines = oldLines.map(line => line.trim()).filter(Boolean);
  if (needleLines.length === 0) return null;
  const anchorLine = needleLines.reduce(
    (longest, line) => (line.length > longest.length ? line : longest),
    ''
  );
  const anchorIndex = Math.max(0, oldLines.findIndex(line => line.trim() === anchorLine));
  const needleGrams = bigramSet(needleLines.join('\n').slice(0, ANCHOR_SNIPPET_MAX_CHARS * 2));
  const needleWords = anchorWords(anchorLine);
  const contentLines = content.split('\n');
  const windowSize = oldLines.length;

  const candidates = [];
  for (let index = 0; index < contentLines.length; index += 1) {
    const line = contentLines[index].trim();
    if (!line) continue;
    let related = false;
    for (const word of anchorWords(line)) {
      if (needleWords.has(word)) {
        related = true;
        break;
      }
    }
    if (!related && anchorLine.length >= 8) {
      const probe = anchorLine.slice(0, Math.min(anchorLine.length, 40));
      related = line.includes(probe) || probe.includes(line.slice(0, 40));
    }
    if (related) candidates.push(index);
    if (candidates.length >= ANCHOR_CANDIDATE_LIMIT) break;
  }
  if (candidates.length === 0) {
    const anchorGrams = bigramSet(anchorLine.slice(0, 200));
    for (let index = 0; index < contentLines.length; index += 1) {
      if (candidates.length >= ANCHOR_CANDIDATE_LIMIT) break;
      const line = contentLines[index].trim();
      if (!line) continue;
      if (bigramSimilarity(bigramSet(line.slice(0, 200)), anchorGrams) >= 0.5) candidates.push(index);
    }
  }
  if (candidates.length === 0) return null;

  let best = null;
  for (const candidate of candidates) {
    const start = Math.max(0, candidate - anchorIndex);
    const windowText = contentLines
      .slice(start, start + windowSize)
      .map(line => line.trim())
      .join('\n')
      .slice(0, ANCHOR_SNIPPET_MAX_CHARS * 2);
    const score = bigramSimilarity(bigramSet(windowText), needleGrams);
    if (best === null || score > best.score) best = { start, score };
  }
  if (best === null || best.score < ANCHOR_MIN_SCORE) return null;

  const snippetLines = [];
  let chars = 0;
  for (
    let index = best.start;
    index < contentLines.length && snippetLines.length < ANCHOR_SNIPPET_MAX_LINES;
    index += 1
  ) {
    const prefix = `  L${index + 1}: `;
    const room = ANCHOR_SNIPPET_MAX_CHARS - chars - prefix.length;
    if (room <= 0) break;
    const line = contentLines[index];
    const text = line.length > room ? line.slice(0, room) : line;
    snippetLines.push(`${prefix}${text}`);
    chars += prefix.length + text.length + 1;
  }
  if (snippetLines.length === 0) return null;
  const startLine = best.start + 1;
  const endLine = best.start + snippetLines.length;
  return `\nClosest match in file (lines ${startLine}-${endLine}):\n${snippetLines.join('\n')}`;
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
      const hint = findClosestAnchorSnippet(content, oldText);
      throw new Error(
        `edits[${editIndex}] text was not found, including tolerant normalization${hint ?? ''}`
      );
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

const OUTLINE_MAX_BYTES = 16384;
const OUTLINE_ENTRY_MAX_CHARS = 140;
const OUTLINE_FALLBACK_LINES = 30;
const READ_TARGETS_MAX = 20;
const READ_BATCH_MAX_BYTES = 32768;

// Structural landmarks. The read outline has no path, so every language rule applies to
// every file; the patterns are narrow enough that cross-language noise stays low.
const OUTLINE_LANDMARK_PATTERNS = [
  /^\s*export\s+/,
  /^\s*(async\s+)?function\s+/,
  /^\s*class\s+/,
  /^\s*(const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(async\s+)?(function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/,
  /^\s{2,4}(async\s+|static\s+|get\s+|set\s+)*[A-Za-z_$][\w$]*\s*\([^;]*\)\s*\{/,
  /^\s*(async\s+)?def\s+/,
  /^\s*[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{/,
  /^\s*function\s+[A-Za-z_]/,
  /^#{1,4}\s+/,
  /^\s*(pub\s+)?(fn|struct|enum|trait|impl|type|interface)\s+/,
];

function isOutlineLandmark(line) {
  return OUTLINE_LANDMARK_PATTERNS.some(pattern => pattern.test(line));
}

function outlineEntryText(line) {
  const trimmed = line.trim();
  return trimmed.length > OUTLINE_ENTRY_MAX_CHARS
    ? trimmed.slice(0, OUTLINE_ENTRY_MAX_CHARS)
    : trimmed;
}

function outlineEntries(text) {
  const lines = text.split('\n');
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isOutlineLandmark(lines[index])) continue;
    entries.push({ line: index + 1, text: outlineEntryText(lines[index]) });
  }
  return entries;
}

function renderOutline({ text, totalBytes, offset = 1, limit }) {
  const lines = text.split('\n');
  const allEntries = outlineEntries(text);
  let output;
  let lastLine;
  if (allEntries.length === 0) {
    const windowLimit = Math.min(limit ?? OUTLINE_FALLBACK_LINES, OUTLINE_FALLBACK_LINES);
    const first = Math.max(0, offset - 1);
    const window = lines.slice(first, first + windowLimit);
    const body = window
      .map((line, index) => `L${first + index + 1}: ${outlineEntryText(line)}`)
      .join('\n');
    output = `[outline · ${lines.length} lines · ${totalBytes} bytes · no structural symbols matched; first ${OUTLINE_FALLBACK_LINES} lines:]${body ? `\n${body}` : ''}`;
    lastLine = first + window.length;
  } else {
    const visible = allEntries.filter(entry => entry.line >= offset);
    const selected = limit === undefined ? visible : visible.slice(0, limit);
    const body = selected.map(entry => `L${entry.line}: ${entry.text}`).join('\n');
    output = `[outline · ${lines.length} lines · ${totalBytes} bytes]${body ? `\n${body}` : ''}`;
    lastLine = selected.length > 0 ? selected[selected.length - 1].line : offset - 1;
  }

  const page = truncateHead(output, { maxBytes: OUTLINE_MAX_BYTES });
  if (page.truncated) {
    return `${page.content}\n\n[outline truncated at ${OUTLINE_MAX_BYTES} bytes; request a smaller limit.]`;
  }
  const hasMore = allEntries.length === 0
    ? lastLine < lines.length
    : allEntries.some(entry => entry.line > lastLine);
  if (hasMore && limit !== undefined) {
    return `${page.content}\n\n[outline continues; use offset=${lastLine + 1} for more symbols.]`;
  }
  return page.content;
}

// Compact landmark outline: one 1-based entry per structural line, or a bounded plain
// head of the file when no landmark matches.
export function extractOutline(text, totalBytes = Buffer.byteLength(text, 'utf8')) {
  return renderOutline({ text, totalBytes });
}

async function readFilePage({ pathMode, defaultCwd, workspaceRoot, path }, signal) {
  const policy = await resolveFilePolicy({ pathMode, workspaceRoot, defaultCwd });
  const target = policy.pathMode === 'user'
    ? await resolveUserPath(policy.root, path)
    : await resolveWorkspaceEntry(policy.root, path);
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      throw new Error(`EISDIR: ${path} is a directory; use list_directory with that path`);
    }
    if (!stat.isFile()) {
      throw new Error(`EINVAL: ${path} is not a regular file; read supports regular text files only`);
    }
    const buffer = await fs.readFile(target, { signal });
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      throw new Error('dev.read supports UTF-8 text files only');
    }
    if (text.includes('\0')) throw new Error('dev.read supports text files only');
    return { text, totalBytes: buffer.length };
  } catch (error) {
    throw modelFacingPathError(error, target, path);
  }
}

async function readOne({ pathMode, defaultCwd, workspaceRoot, path, offset, limit, mode }, signal) {
  if (mode !== 'lines' && mode !== 'outline') {
    throw new Error('INVALID_ARGUMENT: read mode must be lines or outline');
  }
  const { text, totalBytes } = await readFilePage({ pathMode, defaultCwd, workspaceRoot, path }, signal);
  if (mode === 'outline') {
    return {
      content: [{ type: 'text', text: renderOutline({ text, totalBytes, offset: offset ?? 1, limit }) }]
    };
  }
  const lines = text.split('\n');
  const start = (offset ?? 1) - 1;
  if (start >= lines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
  }
  const selected = lines.slice(start, limit === undefined ? undefined : start + limit);
  const page = truncateHead(selected.join('\n'), { maxBytes: 16384 });
  let output = page.content;
  if (page.firstLineExceedsLimit) {
    output = `[Line ${start + 1} exceeds the 16384-byte read limit; ${totalBytes} bytes total. Use exec with rg or a structured extractor for this line.]`;
  } else if (page.truncated || (limit !== undefined && start + limit < lines.length)) {
    const nextOffset = start + (page.truncated ? page.outputLines : selected.length) + 1;
    output += `\n\n[truncated · ${totalBytes} bytes total; use offset=${nextOffset} to continue.]`;
  }
  return { content: [{ type: 'text', text: output }] };
}

async function readTargets({ pathMode, defaultCwd, workspaceRoot, targets, offset, limit, defaultLines, mode }, signal) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > READ_TARGETS_MAX) {
    throw new Error(`INVALID_ARGUMENT: read targets must contain from 1 to ${READ_TARGETS_MAX} entries`);
  }
  let combined = '';
  let truncated = false;
  for (let index = 0; index < targets.length; index += 1) {
    const item = targets[index];
    if (!item || typeof item.path !== 'string' || item.path.length === 0) {
      throw new Error(`INVALID_ARGUMENT: read targets[${index}].path must be a non-empty string`);
    }
    const itemMode = item.mode ?? mode;
    const itemLimit = item.limit ?? limit ?? (itemMode === 'outline' ? undefined : defaultLines);
    const result = await readOne({
      pathMode,
      defaultCwd,
      workspaceRoot,
      path: item.path,
      offset: item.offset ?? offset,
      limit: itemLimit,
      mode: itemMode,
    }, signal);
    const sectionText = result.content.map(block => block.text).join('\n');
    const section = `=== ${item.path} ===\n${sectionText}`;
    const next = combined.length === 0 ? section : `${combined}\n${section}`;
    if (Buffer.byteLength(next, 'utf8') > READ_BATCH_MAX_BYTES) {
      truncated = true;
      break;
    }
    combined = next;
  }
  if (truncated) {
    combined += `\n\n[batch read truncated at ${READ_BATCH_MAX_BYTES} bytes; request remaining targets separately]`;
  }
  return { content: [{ type: 'text', text: combined }] };
}

export async function runRead({
  pathMode = 'workspace', defaultCwd, workspaceRoot, path, offset, limit, defaultLines,
  mode = 'lines', targets
}, signal) {
  if ((path === undefined) === (targets === undefined)) {
    throw new Error('INVALID_ARGUMENT: read requires either path or targets, not both');
  }
  if (targets !== undefined) {
    return readTargets({ pathMode, defaultCwd, workspaceRoot, targets, offset, limit, defaultLines, mode }, signal);
  }
  const singleLimit = limit ?? (mode === 'outline' ? undefined : defaultLines);
  return readOne({ pathMode, defaultCwd, workspaceRoot, path, offset, limit: singleLimit, mode }, signal);
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

function decodeWriteContent(content, encoding) {
  if (encoding === undefined || encoding === 'utf8') return content;
  if (encoding !== 'base64') throw new Error('encoding must be utf8 or base64');
  const compact = content.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('content is not valid base64');
  }
  return Buffer.from(compact, 'base64');
}

function parseWriteMode(mode) {
  if (mode === undefined) return undefined;
  if (typeof mode !== 'string' || !/^0?[0-7]{3}$/.test(mode)) {
    throw new Error('mode must be an octal permission string such as "644" or "0755"');
  }
  return Number.parseInt(mode, 8);
}

function writeError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

async function verifyWrittenBytes(handle, expectedBytes, expectedHash) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size !== expectedBytes) {
    throw writeError('WRITE_VERIFICATION_FAILED', 'staged file size differs from the received content');
  }
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < expectedBytes) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, expectedBytes - offset), offset);
    if (bytesRead === 0) throw writeError('WRITE_VERIFICATION_FAILED', 'staged file ended early');
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (hash.digest('hex') !== expectedHash) {
    throw writeError('WRITE_VERIFICATION_FAILED', 'staged file hash differs from the received content');
  }
}

export async function runWrite({
  pathMode = 'workspace', defaultCwd, workspaceRoot, path, content, overwrite = false,
  encoding, mode, mkdir_parents: mkdirParents = false, expected_bytes: expectedBytes,
  expected_sha256: expectedHash, operation_id: operationId = currentCall()?.id ?? randomUUID()
}, signal) {
  const data = Buffer.from(decodeWriteContent(content, encoding));
  const fileMode = parseWriteMode(mode);
  const digest = createHash('sha256').update(data).digest('hex');
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes !== data.length)) {
    throw writeError('WRITE_EXPECTATION_MISMATCH', 'expected_bytes does not match decoded content');
  }
  if (expectedHash !== undefined && (typeof expectedHash !== 'string'
    || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(expectedHash)
    || expectedHash.toLowerCase().replace(/^sha256:/, '') !== digest)) {
    throw writeError('WRITE_EXPECTATION_MISMATCH', 'expected_sha256 does not match decoded content');
  }
  throwIfAborted(signal);
  const policy = await resolveFilePolicy({ pathMode, workspaceRoot, defaultCwd });
  if (mkdirParents) {
    markMutation('started');
    await createParents({ pathMode: policy.pathMode, root: policy.root, value: path });
  }
  const target = policy.pathMode === 'user'
    ? await resolveUserPath(policy.root, path, { mustExist: false })
    : await resolveNewWorkspacePath(policy.root, path);
  return withMutationPath(target, async () => {
    throwIfAborted(signal);
    let existing = null;
    try {
      existing = await fs.lstat(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw modelFacingPathError(error, target, path);
    }
    if (existing && !overwrite) {
      throw new Error('file already exists; use edit for existing files, or pass overwrite: true to replace it');
    }
    if (existing && !existing.isFile()) {
      throw new Error('overwrite target must be a regular file, not a symlink or directory');
    }
    const temp = join(dirname(target), `.webharness-write-${randomUUID()}.tmp`);
    let handle;
    try {
      markMutation('started');
      handle = await fs.open(temp, 'wx+', existing ? 0o600 : 0o666);
      await handle.writeFile(data);
      await verifyWrittenBytes(handle, data.length, digest);
      if (fileMode !== undefined) await handle.chmod(fileMode);
      else if (existing) await handle.chmod(existing.mode & 0o7777);
      await handle.sync();
      throwIfAborted(signal);
      // The open handle verifies the bytes we publish. A hard link preserves
      // create-only semantics even against writers outside our mutation lease.
      if (overwrite) await fs.rename(temp, target);
      else await fs.link(temp, target);
      markMutation('published');
      return {
        path, replaced: existing !== null, outcome: existing ? 'replaced' : 'created',
        bytes_written: data.length, sha256: `sha256:${digest}`, operation_id: operationId,
      };
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('file already exists; use edit for existing files, or pass overwrite: true to replace it');
      }
      throw modelFacingPathError(error, target, path);
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }, { signal });
}
