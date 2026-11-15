import fs from 'node:fs/promises';
import path from 'node:path';

// A bounded queue prevents slow storage from holding up requests or growing
// memory without limit. Dropped records are counted in the next accepted line.
export function createHttpDiagnosticLog(file, { maxBytes = 10 * 1024 * 1024, maxFiles = 3, maxQueued = 128 } = {}) {
  let tail = Promise.resolve();
  let pending = 0;
  let dropped = 0;
  let bytes;
  return {
    log(record) {
      if (pending >= maxQueued) { dropped++; return; }
      const priorDropped = dropped;
      const line = `${JSON.stringify({ ...record, ...(dropped ? { dropped_records: dropped } : {}) })}\n`;
      const size = Buffer.byteLength(line);
      if (size > Math.min(4096, maxBytes)) { dropped++; return; }
      dropped = 0;
      pending++;
      tail = tail.then(async () => {
        if (bytes === undefined) {
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          try { bytes = (await fs.stat(file)).size; }
          catch (error) { if (error.code !== 'ENOENT') throw error; bytes = 0; }
        }
        if (bytes + size > maxBytes) {
          if (maxFiles === 1) await fs.rm(file, { force: true });
          for (let index = maxFiles - 1; index >= 1; index--) {
            try { await fs.rename(index === 1 ? file : `${file}.${index - 1}`, `${file}.${index}`); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          bytes = 0;
        }
        await fs.appendFile(file, line, { mode: 0o600 });
        bytes += size;
      }).catch(() => { bytes = undefined; dropped += priorDropped + 1; }).finally(() => { pending--; });
    },
    flush: () => tail,
  };
}
