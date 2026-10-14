# WebSession curl client and long-poll calls

Status: plan, not yet approved for implementation. Start HEAD: 3d1b168.

## Goal

An agent that has only a shell with `curl` (no MCP client) can use every tool
the live 1MCP endpoint exposes, with one short command per tool call and a
bootstrap prompt of about six lines. Tool names, schemas, permissions and
availability stay owned by 1MCP; WebSession remains transport only.

Aegis shapes this because the change adds public HTTP routes and a served
client to an authenticated transport, so the contract, compatibility and
verification boundaries need to be written down before code.

## Evidence the design rests on

Sandbox probe (2026-10-14, reported by the target agent):

- GET/POST/PUT/PATCH/DELETE and custom headers (`Authorization`,
  `Idempotency-Key`) pass the sandbox proxy unmodified.
- 1 MB uploads succeed; requests held for 10, 30 and 90 seconds complete.
- Command output is returned only when the command exits, so SSE or WebSocket
  output cannot be read incrementally. Long-poll gives the same result.
- `curl` 8.5, bash 5.2, python3 and node are present. Environment variables do
  not persist between commands; the filesystem does.
- Each command may run up to 300 seconds.

Not probed against our own host: the Cloudflare tunnel in front of the adapter.
Task 6 verifies a 90 second hold end to end before the default is relied on.

Current adapter limits (read from source at 3d1b168):

- `server.mjs:19` request body default 16 KB (validation already allows 1 MB).
- `mcp-client.mjs:58` tool call timeout fixed at 30 seconds.
- `server.mjs` `handleEnhancedCall` waits 1.9 seconds, then the client polls.
- `store.mjs:10` results are stored and served in 8 KB chunks.
- `core.mjs:11-24` when a result has any text block, non-text blocks are dropped.
- `core.mjs` `_schedule` runs operations one at a time (`_tail`).
- `mcp-client.mjs:52-56` every call opens a new MCP connection and lists tools.

## Architecture

No new owner. `providers/websession-adapter` keeps owning the HTTP transport,
`OperationCore` keeps owning submission and execution, `AdapterStore` keeps
owning persistence. All changes are additive options on the existing
`json-post-v1` profile; `universal-get-v1` is untouched.

Additions:

1. `POST /v1/calls?wait=<0..90>`: hold the response up to that many seconds.
   Without `wait` the existing 1.9 second behaviour is unchanged.
2. `Accept: text/plain` on `POST /v1/calls` and on the status route: respond
   with the existing line format from `renderOperation` and, when the
   operation is completed, the full result after `result:` regardless of chunk
   count. JSON responses with `wait` likewise carry the full `result`.
   Chunk routes stay for existing clients.
3. `GET /v1/tools` and `GET /v1/tools/<tool-name>` with
   `Authorization: Bearer <capability>`: the same data as the path-capability
   discovery routes, so a header-capable client never puts the capability in a
   URL. `text/plain` gives one tool name per line; the per-tool route returns
   the tool JSON.
4. `GET /v1/client.sh`: a static bash + curl client, no credential inside.
   Commands: `wh login <base-url>` (reads the capability from stdin into
   `~/.wh/cap`, mode 600), `wh tools`, `wh instructions`, `wh schema <tool>`,
   `wh call <tool> '<arguments-json>'`, `wh call <tool> @file`, and
   `wh status <status_url>`.
   It builds the envelope by string concatenation, sends a fresh
   `Idempotency-Key`, uses `?wait=90` with `Accept: text/plain`, re-polls the
   status URL while the state is `queued` or `running`, prints only the result
   on success, and prints the state and error to stderr with a non-zero exit
   otherwise. It never retries `unknown_outcome` and never prints the capability.
5. Limits: request body default raised to 1 MB; tool timeout read from
   `WEBSESSION_ADAPTER_TOOL_TIMEOUT_MS` (default 120000, range 1000..600000).
6. `renderToolResult`: text-only results are unchanged; a result containing
   any non-text block is returned as the JSON of the whole result, which is
   what already happens when there is no text block at all.
7. `/v1/about` advertises `long_poll_max_seconds`, `client_url` and
   `tool_timeout_ms`.

Deliberately out of scope: SSE, WebSocket, parallel execution of operations,
MCP resources and prompts, and connection reuse. Connection reuse changes the
"verify availability before dispatch" guarantee that `unknown_outcome`
depends on, so Task 6 measures per-call overhead first; it gets its own plan
only if the overhead is material.

## Tech stack

Node >= 24 ES modules, `node:http`, `node:sqlite` via the existing store,
`@modelcontextprotocol/sdk` 1.30.0, bash, curl. No new dependency.

## Baseline and authority refs

`docs/websession-clients.md`, `docs/websession-master-bearer.md`,
`docs/security.md`, `docs/compatibility.md`, `docs/configuration.md`,
`providers/websession-adapter/*`, `bin/adapter`, `bin/websession-call`,
`tests/adapter-probe.sh`.

## Change necessity

Docs or configuration alone cannot close the gap: the 30 second timeout and
1.9 second wait are constants, the full-result response and header-auth
discovery do not exist, and without a served client every call costs the
agent a hand-built curl command plus polling and chunk reassembly in context.
The minimum code boundary is `server.mjs` routing, one store read helper,
two small `core.mjs`/`mcp-client.mjs` edits and one new static file.

## Compatibility boundary

- Existing routes, field names, states, status codes and the 1.9 second
  default are unchanged for clients that send no `wait` and no
  `Accept: text/plain`.
- Changed default: request body 16 KB to 1 MB. Operators who set
  `WEBSESSION_ADAPTER_MAX_JSON_BODY_BYTES` keep their value.
- Changed default: tool timeout 30 to 120 seconds.
- Changed behaviour: mixed text and non-text results become JSON instead of
  text with the non-text blocks removed.
- `bin/websession-call` is retained unchanged. It overlaps with `client.sh` in
  polling and chunk logic but has a different job (it issues and revokes a
  temporary capability locally). Retirement trigger: if `client.sh` gains a
  local-capability mode, fold `bin/websession-call` into it.

## Security notes

- `client.sh` is public and static; serving it needs no authentication and
  reveals only route shapes that `docs/websession-clients.md` already publishes.
- Header-auth discovery uses the same `resolveCapability` check as calls and
  returns 401 on failure, as `POST /v1/calls` does.
- The master bearer flow is untouched; `client.sh` accepts only an ordinary
  capability.
- A held request occupies no extra execution slot: execution is already
  serial, and waiting only awaits the existing promise.
- Request logging must keep redacting capability-bearing paths; the new
  header-auth routes carry no secret in the path.

## TDD route

Mode `off` (user-local Aegis config), decision `skipped`, authority: project
configuration. Test posture: post-change regression tests in
`providers/websession-adapter/test/` plus the integration script. Reason: no
strict request was made. Verification is listed per task.

## Tasks

### Task 1: full-result read and wait bound

Files: `store.mjs`, `core.mjs`, `test/protocol-store.test.mjs`.

- Add `AdapterStore.getOperationResult(id)` returning the concatenated chunks
  of a completed operation.
- Add `OperationCore.readOperationResult(operationId, continuationToken)`
  guarded by `continuationMatches`, like `readOperationChunk`.
- `renderToolResult`: return JSON of the whole result when any block is non-text.

Verify: `cd providers/websession-adapter && npm test`. New tests cover a
multi-chunk result reading back byte-identical, a wrong continuation token
returning nothing, and text-only, mixed and image-only results.

### Task 2: configurable tool timeout and body default

Files: `mcp-client.mjs`, `core.mjs`, `server.mjs`, `bin/adapter`,
`docs/configuration.md`.

- Pass a `timeoutMs` option into `callMcpTool`; `OperationCore` takes it from
  its constructor; `server.mjs` parses and validates
  `WEBSESSION_ADAPTER_TOOL_TIMEOUT_MS`; `bin/adapter` forwards the variable.
- Change the body default to `1024 * 1024`.

Verify: `npm test`; start the adapter with an out-of-range timeout and
confirm it refuses to start with a clear message.

### Task 3: long-poll and text responses

Files: `server.mjs`, `protocol.mjs`.

- Parse `wait` (integer 0..90) on `POST /v1/calls` and
  `GET /v1/operations/<token>/<id>`; reject other values with 400
  `invalid_wait`. Use it in place of 1900 when present.
- When `wait` is present or `Accept` is `text/plain`, a completed response
  carries the full result (`readOperationResult`); JSON sets `chunk_count: 1`
  semantics by including `result`, text uses `renderOperation` with the full
  text. Stop waiting if the client disconnects.

Verify: integration test in Task 5.

### Task 4: header-auth discovery, about fields, client script

Files: `server.mjs`, new `client.sh`, `docs/security.md`.

- Add `GET /v1/tools` and `GET /v1/tools/<name>` before the universal GET
  handler; bearer required; JSON by default, `text/plain` as described above.
  Include `instructions` in the JSON list response.
- Serve `client.sh` at `GET /v1/client.sh` as `text/x-shellscript`, read once
  at startup.
- Extend `/v1/about`.
- `shellcheck providers/websession-adapter/client.sh` must pass.

Verify: `shellcheck`; integration test in Task 5.

### Task 5: integration regression

Files: `tests/adapter-probe.sh`, new `tests/fixtures/` stub only if needed.

`tests/adapter-probe.sh` starts a private adapter but has no MCP backend, so
tool calls are not covered today. Add a minimal stub MCP server (the SDK is
already a dependency) with three tools: echo, a sleep of N seconds, and one
returning 100 KB. Point `WEBSESSION_ADAPTER_MCP_URL` at it. If the adapter's
OAuth provider prevents an unauthenticated stub, stop and report; do not
weaken OAuth to make the test pass.

Cases, all through the downloaded `client.sh`:

- `wh tools` lists the three names; `wh schema echo` returns its schema.
- `wh call echo` prints exactly the echoed text.
- A 5 second sleep returns in one request with `wait=90`.
- The 100 KB result arrives intact in one response (compare sha256).
- A 200 KB argument is accepted; a 2 MB argument is rejected with 413.
- A call without `wait` still returns within about 2 seconds with `running`
  and a `status_url` (compatibility).
- A revoked capability gets 401 on `/v1/tools` and on a call.

Verify: `tests/adapter-probe.sh` and `npm test` both pass.

### Task 6: live check and measurement

No source files.

- `bin/adapter start`, issue a one hour capability, and from this machine run
  `client.sh` against the public URL: `tools`, a `pwd` call, and a call that
  sleeps 80 seconds to confirm the tunnel holds a 90 second request.
- If the 80 second hold fails, lower the advertised `long_poll_max_seconds`
  to the largest value that passes and record it.
- Time ten trivial calls and record the median. If it exceeds about one
  second, open a follow-up for connection reuse; otherwise close that question.
- Revoke the capability and stop the adapter.

Result (2026-10-14, through the public hostname): login, `tools` (14),
`instructions`, `schema` and a `pwd` call passed; the served client matched the
repository file. Ten trivial calls: median 1234 ms (1174..1495); the same call
against loopback took about 1000 ms and a public `/v1/about` about 430 ms, so
the cost is the per-call MCP connection, not the tunnel. This is above the one
second threshold: connection reuse gets a follow-up plan. A 50 second call
succeeded. An 80 second call ended as `unknown_outcome` after 62 seconds
because 1MCP stops a downstream tool request at 60 seconds (`-32001`); the
tunnel held the request for those 62 seconds. The effective ceiling for one
call is therefore 60 seconds, below the adapter's 120 second default, and
longer work uses the terminal tools as the tool descriptions say. A hold
beyond 62 seconds through the tunnel was not exercised. The revoked
capability was rejected with 401.

### Task 7: docs and bootstrap prompt

Files: `docs/websession-clients.md`, `docs/compatibility.md`.

- Add a "curl-only agent" section with the short prompt below, and a row in
  the compatibility table.
- Record the three changed defaults and behaviours from the compatibility
  boundary.

```text
You can reach my machine's tools over HTTPS with curl. Setup, once:
  mkdir -p ~/.wh && curl -fsS https://<HOST>/v1/client.sh -o ~/.wh/wh && chmod +x ~/.wh/wh
  printf '%s' '<CAPABILITY>' | ~/.wh/wh login https://<HOST>
Then: `~/.wh/wh tools` lists tool names, `~/.wh/wh schema <tool>` shows one
tool's arguments (read it before first use of that tool), and
`~/.wh/wh call <tool> '<json-arguments>'` runs it and prints only the result.
Never print the capability. If a call ends with `unknown_outcome`, do not
retry it; check the effect first.
```

Final delivery evidence: the target sandbox agent runs that prompt and
reports the output of `wh tools` and one `pwd` call.

## Verification summary

`npm test` in `providers/websession-adapter`, `tests/adapter-probe.sh`,
`shellcheck` on the client, the live check in Task 6, and the sandbox agent's
report in Task 7.

## Risks

- The tunnel may cut held requests below 90 seconds. Task 6 measures it; the
  client re-polls, so a lower limit costs round trips, not correctness.
- A 120 second tool timeout lets one slow call block the serial queue for
  longer. The value is configurable.
- A stub MCP server may not be reachable through the adapter's OAuth client;
  Task 5 stops and reports in that case.
- Parity is for tools only. Resources and prompts are not exposed.

## Execution route

Inline, one task at a time: the tasks share `server.mjs` and are sequential.
User confirmation required: yes. This plan changes public behaviour and
defaults that have not been approved yet.
