import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const CALL_ID_META = 'webharness/call-id';
export const MUTATION_META = 'webharness/mutation-state';
export const RPC_BUDGET_META = 'webharness/rpc-budget-ms';
export const MIN_RPC_BUDGET_MS = 5_000;
const calls = new AsyncLocalStorage();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const UUID_STEP = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:#[1-9]\d{0,3})?$/i;

export function parseRpcBudgetMs(value) {
  if (!Number.isSafeInteger(value) || value < MIN_RPC_BUDGET_MS || value > 300_000) return undefined;
  return value;
}

export function callId(value, { allowStep = false } = {}) {
  return typeof value === 'string' && (allowStep ? UUID_STEP : UUID).test(value) ? value : randomUUID();
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

export function toolResultErrorCode(result) {
  const text = result?.content?.find(item => item.type === 'text')?.text;
  return diagnosticErrorCode(result?._meta?.['webharness/error-code'] ?? result?.structuredContent?.error?.code ?? /^([A-Z][A-Z0-9_]+):/.exec(text ?? '')?.[1]);
}

export async function traceCall({ id, layer, tool, mutating = true, allowStep = false, rpcBudgetMs, log }, fn) {
  const started = performance.now();
  const parsedBudgetMs = parseRpcBudgetMs(rpcBudgetMs);
  const context = {
    id: callId(id, { allowStep }),
    mutationState: mutating ? 'not_started' : 'not_applicable',
    ...(parsedBudgetMs !== undefined ? { rpcBudgetMs: parsedBudgetMs } : {}),
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
      const { error_code: batchErrorCode, ...batch } = context.batchDiagnostics ?? {};
      const incomplete = (batch.batch_failed ?? 0) + (batch.batch_deferred ?? 0) + (batch.batch_skipped ?? 0);
      context.emit('completed', {
        ...batch,
        outcome: result?.isError ? 'error' : incomplete === 0 ? 'success'
          : incomplete === batch.batch_total ? 'error' : 'partial_error',
        ...(batchErrorCode !== undefined ? { error_code: diagnosticErrorCode(batchErrorCode) } : {}),
        ...(result?.isError ? { error_code: toolResultErrorCode(result) } : {}),
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
