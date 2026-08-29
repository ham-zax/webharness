#!/usr/bin/env node
import { appendTranscript, ensureTranscript } from './transcript.mjs';

const [sessionDir, rawBudget] = process.argv.slice(2);
const budgetBytes = Number(rawBudget);
if (!sessionDir || !Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
  process.stderr.write('usage: transcript-writer.mjs <session-dir> <budget-bytes>\n');
  process.exit(64);
}

await ensureTranscript(sessionDir, { budgetBytes });

try {
  for await (const chunk of process.stdin) {
    await appendTranscript(sessionDir, chunk, { budgetBytes });
  }
} catch (error) {
  process.stderr.write(`terminal transcript writer failed: ${error.message}\n`);
  process.exitCode = 1;
}
