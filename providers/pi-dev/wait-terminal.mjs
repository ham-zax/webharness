const DEFAULT_MAX_READ_BYTES = 64 * 1024;
const MAX_LITERAL_BYTES = 1024;
const BROKER_TRANSPORT_CODES = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'BROKER_CONNECTION_CLOSED',
  'BROKER_REQUEST_TIMEOUT',
]);

function waitError(code, message, details) {
  const error = new Error(message);
  error.name = 'WaitSourceError';
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw waitError('WAIT_ABORTED', 'wait request was aborted');
}

async function brokerRequest(client, op, params, signal) {
  throwIfAborted(signal);
  try {
    return await client.request(op, params, { signal });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw waitError('WAIT_ABORTED', 'wait request was aborted');
    }
    if (BROKER_TRANSPORT_CODES.has(error?.code)) {
      throw waitError(
        'WAIT_SOURCE_UNAVAILABLE',
        `Terminal broker unavailable during ${op}`,
        { causeCode: error.code },
      );
    }
    throw error;
  }
}

function requireCondition(condition) {
  if (!condition || typeof condition !== 'object') {
    throw waitError('INVALID_WAIT_CONDITION', 'terminal wait condition is required');
  }
  if (!['terminal_output', 'terminal_exit'].includes(condition.kind)) {
    throw waitError('INVALID_WAIT_CONDITION', `unsupported Terminal wait condition: ${String(condition.kind)}`);
  }
  if (typeof condition.session !== 'string' || condition.session.length === 0) {
    throw waitError('INVALID_WAIT_CONDITION', 'terminal wait session is required');
  }
  if (condition.kind === 'terminal_output') {
    if (typeof condition.literal !== 'string' || condition.literal.length === 0) {
      throw waitError('INVALID_WAIT_CONDITION', 'terminal output literal must be non-empty');
    }
    const literalBytes = Buffer.from(condition.literal, 'utf8');
    if (literalBytes.length === 0 || literalBytes.length > MAX_LITERAL_BYTES) {
      throw waitError('INVALID_WAIT_CONDITION', `terminal output literal must be at most ${MAX_LITERAL_BYTES} UTF-8 bytes`);
    }
    return { condition, literalBytes };
  }
  return { condition, literalBytes: null };
}

function requireBaseline(record) {
  const baseline = record?.baseline;
  if (!baseline || typeof baseline !== 'object') {
    throw waitError('WAIT_STATE_CORRUPT', 'terminal wait baseline is missing');
  }
  if (typeof baseline.generation !== 'string' || baseline.generation.length === 0) {
    throw waitError('WAIT_STATE_CORRUPT', 'terminal wait generation is missing');
  }
  return baseline;
}

function replaced(baseline, actualGeneration, details) {
  return {
    status: 'failed',
    baseline,
    code: 'WAIT_SOURCE_REPLACED',
    details: {
      expectedGeneration: baseline.generation,
      actualGeneration,
      ...details,
    },
  };
}

function sourceEnded(baseline, observed = {}) {
  const exitStatus = observed.paneDeadStatus ?? null;
  return {
    status: 'failed',
    baseline,
    code: 'WAIT_SOURCE_ENDED',
    details: { exitStatus },
    evidence: `exit=${exitStatus ?? 'unknown'}`,
  };
}

function cursorFailure(code, baseline, details) {
  return { status: 'failed', baseline, code, details };
}

function nextOverlap(combined, literalLength) {
  const keep = Math.max(0, literalLength - 1);
  if (keep === 0 || combined.length === 0) return Buffer.alloc(0);
  return combined.subarray(Math.max(0, combined.length - keep));
}

export class TerminalWaitSource {
  constructor({ client, maxReadBytes = DEFAULT_MAX_READ_BYTES } = {}) {
    if (!client || typeof client.request !== 'function') throw new TypeError('client is required');
    if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) {
      throw new TypeError('maxReadBytes must be a positive integer');
    }
    this.client = client;
    this.maxReadBytes = maxReadBytes;
    this.pollIntervalMs = 250;
  }

  async arm(condition, signal) {
    const { condition: validated } = requireCondition(condition);
    throwIfAborted(signal);
    const observed = await brokerRequest(this.client, 'session.observe', { name: validated.session }, signal);
    throwIfAborted(signal);
    if (validated.kind === 'terminal_exit') {
      return {
        status: 'pending',
        baseline: { generation: observed.generation },
      };
    }
    return {
      status: 'pending',
      baseline: {
        generation: observed.generation,
        cursor: observed.transcript.endOffset,
        overlapBase64: '',
        paneDead: observed.paneDead,
        paneDeadStatus: observed.paneDeadStatus,
      },
    };
  }

  async check(record, signal) {
    const { condition, literalBytes } = requireCondition(record?.condition);
    let baseline = requireBaseline(record);
    throwIfAborted(signal);
    let observed;
    try {
      observed = await brokerRequest(this.client, 'session.observe', { name: condition.session }, signal);
    } catch (error) {
      if (error?.code === 'SESSION_NOT_FOUND') return sourceEnded(baseline);
      throw error;
    }
    throwIfAborted(signal);

    if (observed.generation !== baseline.generation) {
      return replaced(baseline, observed.generation);
    }

    if (condition.kind === 'terminal_exit') {
      if (!observed.paneDead) return { status: 'pending', baseline };
      return {
        status: 'matched',
        baseline,
        evidence: `exit=${observed.paneDeadStatus ?? 'unknown'}`,
        details: { exitStatus: observed.paneDeadStatus },
      };
    }

    if (!Number.isSafeInteger(baseline.cursor) || baseline.cursor < 0) {
      throw waitError('WAIT_STATE_CORRUPT', 'terminal wait cursor is invalid');
    }
    if (typeof baseline.overlapBase64 !== 'string') {
      throw waitError('WAIT_STATE_CORRUPT', 'terminal wait overlap is invalid');
    }

    while (true) {
      if (observed.generation !== baseline.generation) {
        return replaced(baseline, observed.generation);
      }
      if (baseline.cursor > observed.transcript.endOffset) {
        return cursorFailure('CURSOR_AHEAD', baseline, {
          baseOffset: observed.transcript.baseOffset,
          endOffset: observed.transcript.endOffset,
        });
      }

      while (baseline.cursor < observed.transcript.endOffset) {
        throwIfAborted(signal);
        let read;
        try {
          read = await brokerRequest(this.client, 'session.read', {
            name: condition.session,
            cursor: baseline.cursor,
            maxBytes: this.maxReadBytes,
            expectedGeneration: baseline.generation,
          }, signal);
        } catch (error) {
          if (error?.code === 'SESSION_GENERATION_MISMATCH') {
            return replaced(baseline, error?.details?.actualGeneration, error.details);
          }
          if (error?.code === 'SESSION_NOT_FOUND') return sourceEnded(baseline);
          if (error?.code === 'CURSOR_EXPIRED' || error?.code === 'CURSOR_AHEAD') {
            return cursorFailure(error.code, baseline, error.details);
          }
          throw error;
        }
        throwIfAborted(signal);

        const priorOverlap = Buffer.from(baseline.overlapBase64, 'base64');
        const bytes = Buffer.from(read.text, 'utf8');
        const combined = Buffer.concat([priorOverlap, bytes]);
        const combinedStart = read.cursor - priorOverlap.length;
        const matchIndex = combined.indexOf(literalBytes);
        const updatedBaseline = {
          ...baseline,
          cursor: read.nextCursor,
          overlapBase64: nextOverlap(combined, literalBytes.length).toString('base64'),
          paneDead: observed.paneDead,
          paneDeadStatus: observed.paneDeadStatus,
        };

        if (matchIndex !== -1) {
          const matchStart = combinedStart + matchIndex;
          return {
            status: 'matched',
            baseline: updatedBaseline,
            evidence: `output ${condition.session} ${condition.literal} offsets=${matchStart}-${matchStart + literalBytes.length}`,
            details: {
              matchStart,
              matchEnd: matchStart + literalBytes.length,
            },
          };
        }
        if (!Number.isSafeInteger(read.nextCursor) || read.nextCursor <= baseline.cursor) {
          throw waitError('WAIT_SOURCE_ERROR', 'terminal transcript read made no cursor progress');
        }
        baseline = updatedBaseline;
      }

      throwIfAborted(signal);
      let refreshed;
      try {
        refreshed = await brokerRequest(this.client, 'session.observe', { name: condition.session }, signal);
      } catch (error) {
        if (error?.code === 'SESSION_NOT_FOUND') return sourceEnded(baseline);
        throw error;
      }
      throwIfAborted(signal);
      if (refreshed.generation !== baseline.generation) {
        return replaced(baseline, refreshed.generation);
      }
      if (refreshed.transcript.endOffset > baseline.cursor) {
        observed = refreshed;
        continue;
      }
      if (baseline.cursor > refreshed.transcript.endOffset) {
        return cursorFailure('CURSOR_AHEAD', baseline, {
          baseOffset: refreshed.transcript.baseOffset,
          endOffset: refreshed.transcript.endOffset,
        });
      }
      baseline = {
        ...baseline,
        paneDead: refreshed.paneDead,
        paneDeadStatus: refreshed.paneDeadStatus,
      };
      if (refreshed.paneDead) return sourceEnded(baseline, refreshed);
      return { status: 'pending', baseline };
    }
  }
}
