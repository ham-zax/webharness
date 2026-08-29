import { z } from 'zod';

const WAIT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

const terminalOutput = z.object({
  kind: z.literal('terminal_output'),
  session: z.string().min(1),
  literal: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 1024, {
    message: 'literal must be at most 1024 UTF-8 bytes',
  }).describe('Literal in new transcript output after the wait is armed'),
}).strict();

const terminalExit = z.object({
  kind: z.literal('terminal_exit'),
  session: z.string().min(1),
}).strict();

const processExit = z.object({
  kind: z.literal('process_exit'),
  pid: z.number().int().positive(),
}).strict();

const tcpListen = z.object({
  kind: z.literal('tcp_listen'),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535),
}).strict();

const fileExists = z.object({
  kind: z.literal('file_exists'),
  path: z.string().min(1),
}).strict();

const fileChanged = z.object({
  kind: z.literal('file_changed'),
  path: z.string().min(1),
}).strict();

const httpReady = z.object({
  kind: z.literal('http_ready'),
  url: z.string().min(1),
  status: z.number().int().min(100).max(599).optional(),
}).strict();

const systemdUser = z.object({
  kind: z.literal('systemd_user'),
  unit: z.string().min(1).max(256),
  state: z.enum(['active', 'inactive', 'failed']).optional(),
}).strict();

const timerAt = z.string().min(1).refine((value) => {
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}, {
  message: 'at must be a timezone-qualified RFC3339/ISO-8601 instant',
});

const timer = z.object({
  kind: z.literal('timer'),
  after_seconds: z.number().int().min(1).max(86399).optional(),
  at: timerAt.optional(),
}).strict().superRefine((value, ctx) => {
  const fields = [value.after_seconds !== undefined, value.at !== undefined].filter(Boolean).length;
  if (fields !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['after_seconds'],
      message: 'timer requires exactly one of after_seconds or at',
    });
  }
});

export const waitConditionSchema = z.discriminatedUnion('kind', [
  terminalOutput,
  terminalExit,
  processExit,
  tcpListen,
  fileExists,
  fileChanged,
  httpReady,
  systemdUser,
  timer,
]);

export const waitInputSchema = z.object({
  name: z.string().regex(WAIT_NAME_RE, 'name must match ^[A-Za-z0-9._-]{1,64}$'),
  condition: waitConditionSchema.optional(),
  timeout_seconds: z.number().int().min(1).max(86400).optional(),
  hold_seconds: z.number().int().min(0).max(15).optional(),
  cancel: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.cancel === true) {
    if (value.condition !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['condition'], message: 'cancel cannot include condition' });
    }
    if (value.timeout_seconds !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['timeout_seconds'], message: 'cancel cannot include timeout_seconds' });
    }
    if (value.hold_seconds !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['hold_seconds'], message: 'cancel cannot include hold_seconds' });
    }
    return;
  }
  if (value.condition === undefined && value.timeout_seconds !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['timeout_seconds'], message: 'resume cannot include timeout_seconds' });
  }
});
