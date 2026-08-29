import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 3000;

function brokerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class AgentBrokerClient {
  constructor({ socketPath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof socketPath !== 'string' || socketPath.length === 0) throw new TypeError('socketPath is required');
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
  }

  request(op, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffered = '';
      let settled = false;
      const timer = setTimeout(() => finishReject(brokerError('AGENT_BROKER_TIMEOUT', `broker request timed out: ${op}`)), this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
      };
      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(`${JSON.stringify({ id, op, params })}\n`));
      socket.on('data', (chunk) => {
        buffered += chunk;
        const newline = buffered.indexOf('\n');
        if (newline === -1) return;
        let response;
        try {
          response = JSON.parse(buffered.slice(0, newline));
        } catch {
          finishReject(brokerError('AGENT_BROKER_INVALID_RESPONSE', 'broker returned invalid JSON'));
          return;
        }
        if (response?.id !== id) {
          finishReject(brokerError('AGENT_BROKER_INVALID_RESPONSE', 'broker response id does not match request id'));
          return;
        }
        if (response.ok === true) {
          finishResolve(response.result);
          return;
        }
        finishReject(brokerError(
          typeof response?.error?.code === 'string' ? response.error.code : 'AGENT_BROKER_ERROR',
          typeof response?.error?.message === 'string' ? response.error.message : 'broker request failed',
        ));
      });
      socket.once('error', (error) => {
        if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error?.code)) {
          finishReject(brokerError('AGENT_BROKER_UNAVAILABLE', 'Agent Broker is unavailable'));
          return;
        }
        finishReject(error);
      });
      socket.once('close', () => {
        if (!settled) finishReject(brokerError('AGENT_BROKER_UNAVAILABLE', 'Agent Broker closed the connection before replying'));
      });
    });
  }
}
