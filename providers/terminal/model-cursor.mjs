import crypto from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TerminalError } from './protocol.mjs';

const FILE_NAME = 'model-cursor.json';

function validateCursor(cursor) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new TerminalError('MODEL_CURSOR_STATE_CORRUPT', 'model cursor must be a non-negative integer');
  }
  return cursor;
}

export async function readModelCursor(sessionDir) {
  const file = path.join(sessionDir, FILE_NAME);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || parsed.version !== 1) {
      throw new Error('unsupported model cursor state');
    }
    return validateCursor(parsed.cursor);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    if (error instanceof TerminalError) throw error;
    throw new TerminalError('MODEL_CURSOR_STATE_CORRUPT', `invalid model cursor state: ${error.message}`);
  }
}

export async function writeModelCursor(sessionDir, cursor) {
  validateCursor(cursor);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await chmod(sessionDir, 0o700);
  const file = path.join(sessionDir, FILE_NAME);
  const temp = path.join(sessionDir, `.${FILE_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify({ version: 1, cursor })}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
    await chmod(file, 0o600);
  } finally {
    await unlink(temp).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}
