#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { appendTranscript, ensureTranscript } from './transcript.mjs';

const execFileAsync = promisify(execFile);
const [sessionDir, rawBudget, tmuxBin, socketPath, socketName, paneId, finalizerPath, panePid] = process.argv.slice(2);
const budgetBytes = Number(rawBudget);
if (!sessionDir || !Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
  process.stderr.write('usage: transcript-writer.mjs <session-dir> <budget-bytes> [tmux-bin] [socket-path] [socket-name] [pane-id] [finalizer-path] [pane-pid]\n');
  process.exit(64);
}

// tmux 3.4 keeps a dead pane's child unreaped and withholds pane-died while
// this pipe job still runs, so the pane would never finalize. Watch the pane,
// run the finalizer after queued writes settle, then drain the closed pipe
// through EOF so tmux can reap the child without losing transcript bytes.
const POLL_MS = 500;
const DRAIN_GRACE_MS = 200;

let lastDataAt = Date.now();
let probing = false;
let writing = false;
let timer;

async function paneDead() {
  // The pane PID stays fixed until finalization. Avoid spawning a tmux client
  // every poll while the Linux child is still running.
  if (process.platform === 'linux' && /^[1-9][0-9]*$/.test(panePid ?? '')) {
    try {
      const raw = await readFile(`/proc/${panePid}/stat`, 'utf8');
      const state = raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0];
      if (state !== 'Z' && state !== 'X') return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const socketArgs = socketPath ? ['-S', socketPath] : (socketName ? ['-L', socketName] : []);
  return execFileAsync(tmuxBin || 'tmux', [
    '-N', ...socketArgs, 'display-message', '-p', '-t', paneId, '#{pane_dead}',
  ], { encoding: 'utf8', timeout: 2000 }).then(
    ({ stdout }) => stdout.trim() === '1',
    () => false,
  );
}

await ensureTranscript(sessionDir, { budgetBytes });

if (paneId && finalizerPath) {
  timer = setInterval(async () => {
    if (probing || writing || process.stdin.readableLength > 0 || Date.now() - lastDataAt < DRAIN_GRACE_MS) return;
    probing = true;
    try {
      if (!(await paneDead())) return;
      if (writing || process.stdin.readableLength > 0 || Date.now() - lastDataAt < DRAIN_GRACE_MS) return;
      // The finalizer closes the tmux end of the pipe. Keep reading through EOF
      // and await every append, including bytes already buffered in the pipe.
      await execFileAsync('/bin/sh', [finalizerPath, paneId], { timeout: 5000 });
      clearInterval(timer);
    } catch (error) {
      process.stderr.write(`terminal transcript finalizer failed: ${error.message}\n`);
    } finally {
      probing = false;
    }
  }, POLL_MS);
  timer.unref();
}

try {
  for await (const chunk of process.stdin) {
    writing = true;
    try {
      await appendTranscript(sessionDir, chunk, { budgetBytes });
    } finally {
      writing = false;
      lastDataAt = Date.now();
    }
  }
} catch (error) {
  process.stderr.write(`terminal transcript writer failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
}
