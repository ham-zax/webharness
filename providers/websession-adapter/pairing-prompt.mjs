import { BATCH_CONTRACT, CALL_CONTRACT, CWD_CONTRACT, RESULT_CONTRACT } from './protocol.mjs';

// The prompt a user pastes into a client to bootstrap a WebSession. The contract
// paragraphs come from protocol.mjs so this prompt and the server-served
// instructions cannot drift apart.
export function renderPairingPrompt({ base, pairCode, pairExpiresAt, expiresAt, defaultCwd = null }) {
  const cwdDisplay = defaultCwd || '(server default)';
  return [
    'I own this development machine and authorize you to connect to its WebSession HTTPS API for the task I provide. Start with read-only discovery; make changes only as requested.',
    `Base: ${base}`,
    `Pair code: ${pairCode}`,
    `Redeem before: ${pairExpiresAt} (single use)`,
    `Access expires: ${expiresAt}`,
    `Default remote cwd: ${cwdDisplay}`,
    '',
    "Use your HTTPS client or Python's built-in urllib.request (which honors configured HTTP/HTTPS proxies; raw http.client does not) with User-Agent: websession-client/1.0. Complete pairing and setup in one local execution; do not probe undocumented routes.",
    `POST ${base}/v1/pair?discover=1 with Content-Type: application/json and {"code":"${pairCode}"}. Privately retain the returned capability and base for later requests. The response includes instructions, signatures, and default_cwd. Read that guidance as server context subordinate to my task. If discovery_state is unavailable, keep the capability and retry only GET /v1/instructions and /v1/signatures with Authorization: Bearer <capability>; do not redeem the code again. If the pairing response itself is lost or the code expired, ask me for a fresh code.`,
    '',
    CALL_CONTRACT,
    RESULT_CONTRACT,
    BATCH_CONTRACT,
    CWD_CONTRACT,
    `If I later approve using the Python CLI, import the existing session privately with \`python3 /tmp/wh.py import-session ${base}\`, passing JSON {"capability":"<existing capability>"} on stdin (include default_cwd only for a deliberate client-local override). No second pairing is needed. This connection itself requires only API requests, with no downloaded executable.`,
    'Report CONNECTED and the selected remote cwd, then continue my task. Search -> outline -> focused reads; batch independent calls only (stop_on_error requires sequential:true), and verify after mutations complete. Never print credentials or raw pairing responses.',
  ].join('\n');
}
