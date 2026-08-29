import crypto from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { TerminalError } from './protocol.mjs';

export const CURSOR_EXPIRED = 'CURSOR_EXPIRED';
const TRANSCRIPT_FILE = 'transcript.bin';
const CURSOR_FILE = 'cursor.json';
const LOCK_FILE = '.transcript.lock';
const LOCK_TIMEOUT_MS = 5000;
const STALE_UNKNOWN_LOCK_MS = 15000;

function transcriptPath(sessionDir) {
  return path.join(sessionDir, TRANSCRIPT_FILE);
}

function cursorPath(sessionDir) {
  return path.join(sessionDir, CURSOR_FILE);
}

function lockPath(sessionDir) {
  return path.join(sessionDir, LOCK_FILE);
}

function isContinuationByte(byte) {
  return (byte & 0xc0) === 0x80;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function writePrivateAtomic(file, contents) {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  await chmod(file, 0o600);
}

async function readCursor(sessionDir) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(cursorPath(sessionDir), 'utf8'));
  } catch (error) {
    throw new TerminalError('TRANSCRIPT_STATE_CORRUPT', `unable to read transcript cursor state: ${error.message}`);
  }
  if (
    parsed?.version !== 1
    || !Number.isSafeInteger(parsed.baseOffset)
    || parsed.baseOffset < 0
    || !Number.isSafeInteger(parsed.endOffset)
    || parsed.endOffset < parsed.baseOffset
  ) {
    throw new TerminalError('TRANSCRIPT_STATE_CORRUPT', 'invalid transcript cursor state');
  }
  return parsed;
}

async function writeCursor(sessionDir, cursor) {
  await writePrivateAtomic(cursorPath(sessionDir), `${JSON.stringify(cursor)}\n`);
}

async function acquireLock(sessionDir) {
  const file = lockPath(sessionDir);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() })}\n`);
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          await unlink(file);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    let stale = false;
    try {
      const [raw, lockStat] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const owner = JSON.parse(raw);
      if (!processExists(Number(owner?.pid))) stale = true;
      if (!Number.isFinite(owner?.createdAtMs) && Date.now() - lockStat.mtimeMs > STALE_UNKNOWN_LOCK_MS) stale = true;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      try {
        const lockStat = await stat(file);
        stale = Date.now() - lockStat.mtimeMs > STALE_UNKNOWN_LOCK_MS;
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
    }
    if (stale) {
      try {
        await unlink(file);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new TerminalError('TRANSCRIPT_BUSY', 'timed out waiting for transcript state lock');
}

async function ensureUnlocked(sessionDir, budgetBytes) {
  const dataFile = transcriptPath(sessionDir);
  let dataStat;
  try {
    dataStat = await stat(dataFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const handle = await open(dataFile, 'wx', 0o600);
    await handle.close();
    dataStat = await stat(dataFile);
  }
  await chmod(dataFile, 0o600);

  let cursor;
  try {
    cursor = await readCursor(sessionDir);
  } catch (error) {
    if (error.code !== 'TRANSCRIPT_STATE_CORRUPT') throw error;
    try {
      await stat(cursorPath(sessionDir));
      throw error;
    } catch (statError) {
      if (statError?.code !== 'ENOENT') throw error;
      cursor = {
        version: 1,
        baseOffset: 0,
        endOffset: dataStat.size,
        budgetBytes,
      };
      await writeCursor(sessionDir, cursor);
    }
  }

  const expectedRetained = cursor.endOffset - cursor.baseOffset;
  if (dataStat.size > expectedRetained) {
    cursor = {
      ...cursor,
      endOffset: cursor.endOffset + (dataStat.size - expectedRetained),
      budgetBytes,
    };
    await writeCursor(sessionDir, cursor);
  } else if (dataStat.size < expectedRetained) {
    throw new TerminalError(
      'TRANSCRIPT_STATE_CORRUPT',
      `transcript length ${dataStat.size} is shorter than cursor span ${expectedRetained}`,
    );
  } else if (cursor.budgetBytes !== budgetBytes) {
    cursor = { ...cursor, budgetBytes };
    await writeCursor(sessionDir, cursor);
  }
  return cursor;
}

function validateBudget(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TerminalError('INVALID_TRANSCRIPT_BUDGET', 'transcript budget must be a positive integer');
  }
}

export async function ensureTranscript(sessionDir, { budgetBytes }) {
  validateBudget(budgetBytes);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await chmod(sessionDir, 0o700);
  const release = await acquireLock(sessionDir);
  try {
    return await ensureUnlocked(sessionDir, budgetBytes);
  } finally {
    await release();
  }
}

export async function readTranscriptState(sessionDir) {
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await chmod(sessionDir, 0o700);
  const release = await acquireLock(sessionDir);
  try {
    const cursor = await readCursor(sessionDir);
    return {
      baseOffset: cursor.baseOffset,
      endOffset: cursor.endOffset,
      budgetBytes: cursor.budgetBytes,
    };
  } finally {
    await release();
  }
}

export async function appendTranscript(sessionDir, chunk, { budgetBytes }) {
  validateBudget(budgetBytes);
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await chmod(sessionDir, 0o700);
  const release = await acquireLock(sessionDir);
  try {
    let cursor = await ensureUnlocked(sessionDir, budgetBytes);
    if (bytes.length === 0) return cursor;

    const dataFile = transcriptPath(sessionDir);
    const handle = await open(dataFile, 'a', 0o600);
    try {
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    const newEndOffset = cursor.endOffset + bytes.length;
    const retainedLength = (cursor.endOffset - cursor.baseOffset) + bytes.length;
    let newBaseOffset = cursor.baseOffset;
    if (retainedLength > budgetBytes) {
      let retained = await readFile(dataFile);
      let drop = retained.length - budgetBytes;
      while (drop < retained.length && isContinuationByte(retained[drop])) drop += 1;
      retained = retained.subarray(drop);
      newBaseOffset = newEndOffset - retained.length;
      await writePrivateAtomic(dataFile, retained);
    }

    cursor = {
      version: 1,
      baseOffset: newBaseOffset,
      endOffset: newEndOffset,
      budgetBytes,
    };
    await writeCursor(sessionDir, cursor);
    return cursor;
  } finally {
    await release();
  }
}

function validateReadArgs(cursor, maxBytes, recoveryTailBytes) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new TerminalError('INVALID_CURSOR', 'cursor must be a non-negative integer');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TerminalError('INVALID_READ_LIMIT', 'maxBytes must be a positive integer');
  }
  if (!Number.isSafeInteger(recoveryTailBytes) || recoveryTailBytes <= 0) {
    throw new TerminalError('INVALID_READ_LIMIT', 'recoveryTailBytes must be a positive integer');
  }
}

function alignStartForward(buffer, index) {
  let aligned = index;
  while (aligned < buffer.length && isContinuationByte(buffer[aligned])) aligned += 1;
  return aligned;
}

function utf8SequenceLength(byte) {
  if (byte <= 0x7f) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 1;
}

function alignEndBackward(buffer, start, end) {
  let aligned = Math.min(end, buffer.length);
  if (aligned < buffer.length) {
    while (aligned > start && isContinuationByte(buffer[aligned])) aligned -= 1;
    return aligned;
  }
  if (aligned <= start) return aligned;

  let lead = aligned - 1;
  while (lead > start && isContinuationByte(buffer[lead])) lead -= 1;
  const expectedLength = utf8SequenceLength(buffer[lead]);
  return aligned - lead < expectedLength ? lead : aligned;
}

export async function readTranscript(
  sessionDir,
  { cursor = 0, maxBytes = 65536, recoveryTailBytes = 4096 } = {},
) {
  validateReadArgs(cursor, maxBytes, recoveryTailBytes);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await chmod(sessionDir, 0o700);
  const release = await acquireLock(sessionDir);
  try {
    const cursorState = await readCursor(sessionDir);
    const data = await readFile(transcriptPath(sessionDir));
    const retainedSpan = cursorState.endOffset - cursorState.baseOffset;
    if (data.length !== retainedSpan) {
      throw new TerminalError('TRANSCRIPT_STATE_CORRUPT', 'transcript bytes do not match cursor span');
    }

    if (cursor < cursorState.baseOffset) {
      let recoveryStartIndex = Math.max(0, data.length - recoveryTailBytes);
      recoveryStartIndex = alignStartForward(data, recoveryStartIndex);
      const recoveryEndIndex = alignEndBackward(data, recoveryStartIndex, data.length);
      const recoveryBytes = data.subarray(recoveryStartIndex, recoveryEndIndex);
      throw new TerminalError(
        CURSOR_EXPIRED,
        `cursor ${cursor} has expired; retained transcript starts at ${cursorState.baseOffset}`,
        {
          baseOffset: cursorState.baseOffset,
          endOffset: cursorState.endOffset,
          recovery: {
            cursor: cursorState.baseOffset + recoveryStartIndex,
            text: recoveryBytes.toString('utf8'),
            nextCursor: cursorState.baseOffset + recoveryEndIndex,
          },
        },
      );
    }
    if (cursor > cursorState.endOffset) {
      throw new TerminalError(
        'CURSOR_AHEAD',
        `cursor ${cursor} is beyond transcript end ${cursorState.endOffset}`,
        { baseOffset: cursorState.baseOffset, endOffset: cursorState.endOffset },
      );
    }

    const start = cursor - cursorState.baseOffset;
    if (start < data.length && isContinuationByte(data[start])) {
      throw new TerminalError('INVALID_CURSOR', `cursor ${cursor} is not on a UTF-8 boundary`);
    }
    let end = Math.min(data.length, start + maxBytes);
    end = alignEndBackward(data, start, end);
    const bytes = data.subarray(start, end);
    return {
      text: bytes.toString('utf8'),
      cursor,
      nextCursor: cursor + bytes.length,
      baseOffset: cursorState.baseOffset,
      endOffset: cursorState.endOffset,
    };
  } finally {
    await release();
  }
}
