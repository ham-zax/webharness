import { WaitStore } from '../wait-state.mjs';

const [stateDir, name, holdMsRaw = '0', maxWaitMsRaw = '1000', abortAfterMsRaw = '0'] = process.argv.slice(2);
const holdMs = Number(holdMsRaw);
const maxWaitMs = Number(maxWaitMsRaw);
const abortAfterMs = Number(abortAfterMsRaw);

const store = new WaitStore({ stateDir });
const controller = new AbortController();
let releaseManual;
const manualGate = new Promise((resolve) => { releaseManual = resolve; });

process.on('message', (message) => {
  if (message?.type === 'release') releaseManual();
  if (message?.type === 'abort') controller.abort();
});

let abortTimer;
if (abortAfterMs > 0) abortTimer = setTimeout(() => controller.abort(), abortAfterMs);

try {
  await store.withLock(name, async () => {
    process.send?.({ type: 'entered', name, pid: process.pid, at: Date.now() });
    if (holdMs < 0) await manualGate;
    else if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
    process.send?.({ type: 'leaving', name, pid: process.pid, at: Date.now() });
  }, { signal: controller.signal, maxWaitMs });
  process.send?.({ type: 'result', status: 'ok', name, pid: process.pid });
} catch (error) {
  process.send?.({
    type: 'error',
    name,
    pid: process.pid,
    code: error?.code,
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  if (abortTimer) clearTimeout(abortTimer);
  process.disconnect?.();
}
