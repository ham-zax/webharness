import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CURSOR_EXPIRED,
  appendTranscript,
  ensureTranscript,
  readTranscript,
  readTranscriptState,
} from '../transcript.mjs';

async function withSessionDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'terminal-transcript-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('readTranscriptState exposes logical offsets without transcript payload', async (t) => {
  const dir = await withSessionDir(t);
  await ensureTranscript(dir, { budgetBytes: 1024 });
  await appendTranscript(dir, Buffer.from('abc'), { budgetBytes: 1024 });
  assert.deepEqual(await readTranscriptState(dir), {
    baseOffset: 0,
    endOffset: 3,
    budgetBytes: 1024,
  });
});

test('incremental reads use monotonically increasing logical byte cursors', async (t) => {
  const dir = await withSessionDir(t);
  await ensureTranscript(dir, { budgetBytes: 1024 });

  await appendTranscript(dir, Buffer.from('alpha\n'), { budgetBytes: 1024 });
  const first = await readTranscript(dir, { cursor: 0, maxBytes: 1024 });
  assert.equal(first.text, 'alpha\n');
  assert.equal(first.cursor, 0);
  assert.equal(first.nextCursor, 6);
  assert.equal(first.baseOffset, 0);
  assert.equal(first.endOffset, 6);

  await appendTranscript(dir, Buffer.from('beta\n'), { budgetBytes: 1024 });
  const second = await readTranscript(dir, { cursor: first.nextCursor, maxBytes: 1024 });
  assert.equal(second.text, 'beta\n');
  assert.equal(second.cursor, 6);
  assert.equal(second.nextCursor, 11);
  assert.equal(second.baseOffset, 0);
  assert.equal(second.endOffset, 11);
});

test('UTF-8 reads never return a partial code point', async (t) => {
  const dir = await withSessionDir(t);
  await ensureTranscript(dir, { budgetBytes: 1024 });
  await appendTranscript(dir, Buffer.from('A😀BC', 'utf8'), { budgetBytes: 1024 });

  const first = await readTranscript(dir, { cursor: 0, maxBytes: 5 });
  assert.equal(first.text, 'A😀');
  assert.equal(first.nextCursor, Buffer.byteLength('A😀'));

  const second = await readTranscript(dir, { cursor: first.nextCursor, maxBytes: 4 });
  assert.equal(second.text, 'BC');
  assert.equal(second.nextCursor, Buffer.byteLength('A😀BC'));
});

test('UTF-8 reads wait for a split multibyte code point to become complete', async (t) => {
  const dir = await withSessionDir(t);
  await ensureTranscript(dir, { budgetBytes: 1024 });
  const emoji = Buffer.from('😀', 'utf8');

  await appendTranscript(dir, Buffer.concat([Buffer.from('A'), emoji.subarray(0, 2)]), { budgetBytes: 1024 });
  const partial = await readTranscript(dir, { cursor: 0, maxBytes: 1024 });
  assert.equal(partial.text, 'A');
  assert.equal(partial.nextCursor, 1);
  assert.equal(partial.endOffset, 3);

  await appendTranscript(dir, emoji.subarray(2), { budgetBytes: 1024 });
  const completed = await readTranscript(dir, { cursor: partial.nextCursor, maxBytes: 1024 });
  assert.equal(completed.text, '😀');
  assert.equal(completed.nextCursor, 5);
  assert.equal(completed.endOffset, 5);
});

test('rotation preserves logical cursors and rejects stale cursors explicitly', async (t) => {
  const dir = await withSessionDir(t);
  const budgetBytes = 8;
  await ensureTranscript(dir, { budgetBytes });
  await appendTranscript(dir, Buffer.from('abcdef'), { budgetBytes });
  const meta = await appendTranscript(dir, Buffer.from('ghijkl'), { budgetBytes });

  assert.equal(meta.baseOffset, 4);
  assert.equal(meta.endOffset, 12);

  const retained = await readTranscript(dir, { cursor: 4, maxBytes: 32 });
  assert.equal(retained.text, 'efghijkl');
  assert.equal(retained.nextCursor, 12);

  await assert.rejects(
    () => readTranscript(dir, { cursor: 0, maxBytes: 32, recoveryTailBytes: 5 }),
    (error) => {
      assert.equal(error.code, CURSOR_EXPIRED);
      assert.equal(error.details.baseOffset, 4);
      assert.equal(error.details.endOffset, 12);
      assert.ok(Buffer.byteLength(error.details.recovery.text) <= 5);
      assert.equal(error.details.recovery.nextCursor, 12);
      return true;
    },
  );
});

test('state and transcript files are private', async (t) => {
  const dir = await withSessionDir(t);
  await ensureTranscript(dir, { budgetBytes: 1024 });
  await appendTranscript(dir, Buffer.from('secret-ish terminal bytes'), { budgetBytes: 1024 });

  const dirMode = (await stat(dir)).mode & 0o777;
  const transcriptMode = (await stat(path.join(dir, 'transcript.bin'))).mode & 0o777;
  const cursorMode = (await stat(path.join(dir, 'cursor.json'))).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(transcriptMode, 0o600);
  assert.equal(cursorMode, 0o600);
});
