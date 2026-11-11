import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const CALL_ID_META = 'webharness/call-id';
export const MUTATION_META = 'webharness/mutation-state';
const calls = new AsyncLocalStorage();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function callId(value) {
  return typeof value === 'string' && UUID.test(value) ? value : randomUUID();
}

export function currentCall() {
  return calls.getStore();
}

export function markMutation(state) {
  const context = currentCall();
  if (!context) return;
  context.mutationState = state;
  context.emit('mutation', { mutation_state: state });
}

export function diagnosticErrorCode(value) {
  if (Number.isSafeInteger(value)) return value;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : 'TOOL_FAILED';
}

function resultCode(result) {
  const text = result?.content?.find(item => item.type === 'text')?.text;
  return diagnosticErrorCode(result?._meta?.['webharness/error-code'] ?? result?.structuredContent?.error?.code ?? /^([A-Z][A-Z0-9_]+):/.exec(text ?? '')?.[1]);
}

export async function traceCall({ id, layer, tool, mutating = true, log }, fn) {
  const started = performance.now();
  const context = {
    id: callId(id), mutationState: mutating ? 'not_started' : 'not_applicable',
    emit(event, fields = {}) {
      const record = {
        timestamp: new Date().toISOString(), event: `call_${event}`, call_id: context.id, layer,
        tool: /^[A-Za-z0-9_.-]{1,96}$/.test(tool ?? '') ? tool : 'unknown',
        ...fields,
      };
      try {
        if (log) log(record);
        else process.stderr.write(`${JSON.stringify(record)}\n`);
      } catch { /* Diagnostics must never change the operation outcome. */ }
    },
  };
  return calls.run(context, async () => {
    context.emit('started');
    try {
      const result = await fn(context);
      const downstreamState = result?._meta?.[MUTATION_META];
      if (['not_started', 'started', 'published', 'unknown', 'not_applicable'].includes(downstreamState)) {
        context.mutationState = downstreamState;
      }
      context.emit('completed', {
        outcome: result?.isError ? 'error' : 'success',
        ...(result?.isError ? { error_code: resultCode(result) } : {}),
        duration_ms: Math.round(performance.now() - started), mutation_state: context.mutationState,
      });
      return { ...result, _meta: { ...result?._meta, [CALL_ID_META]: context.id, [MUTATION_META]: context.mutationState } };
    } catch (error) {
      context.emit('completed', {
        outcome: 'error', error_code: diagnosticErrorCode(error?.code),
        duration_ms: Math.round(performance.now() - started), mutation_state: context.mutationState,
      });
      throw error;
    }
  });
}
