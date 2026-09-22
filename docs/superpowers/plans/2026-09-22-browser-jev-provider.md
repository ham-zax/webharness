# Browser Jev Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a four-tool `browser-jev` MCP provider that runs the pinned Jev Ultrafast loop in an owned background target on WebHarness-managed Chrome and Clearcote backends.

**Architecture:** A Node MCP server owns validation, endpoint resolution, profile queues, run state, deterministic completion checks, and one persistent Python worker per run. The worker imports Jev from a uv-locked Git dependency, uses a unique Browser Harness daemon name, and closes both its owned target and namespaced daemon without closing the shared browser process.

**Tech Stack:** Node.js 24 ESM, MCP SDK 1.30.0, Python 3.12+, uv, `jev-ultrafast` pinned at Git commit `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`, Node test runner, pytest, Bash integration tests.

**Spec:** `docs/superpowers/specs/2026-09-22-browser-jev-provider-design.md`

## Global Constraints

- Expose exactly `jev_start`, `jev_tick`, `jev_state`, and `jev_stop`.
- Resolve backend endpoints on every `jev_start`; never cache an endpoint for a future run.
- Never call `ManagedClearcoteRuntime.ensure` from browser-jev.
- Reuse `resolveLinuxBrowserBackend`, `readClearcoteEndpoint`, `ensureWindowsChrome`, and the exported `AgentBrowserRunner` seams.
- Linux Chrome endpoint discovery must dispatch exactly `["get", "cdp-url"]`; never hardcode Agent Browser sessions, sockets, or PID paths.
- Use `BU_NAME=jev-<run-id>` for every worker; never use `default`.
- Stop the namespaced Browser Harness daemon with `restart_daemon(name, require_clean=True)` after `Agent.close()`.
- Accept no credentials as tool arguments; read only the allowlisted server-side environment or `MCP_BROWSER_JEV_ENV_FILE`.
- Accept only declarative success checks; never accept regex, selectors, callbacks, JavaScript, or executable code.
- Map required operations exactly as `CLICK→click`, `TYPE_TEXT→fill`, `SELECT→select`, and `WAIT→wait`.
- Treat Jev `DONE` as terminal `done` only after every success check passes; a failed check becomes terminal `blocked` with `DONE_VERIFICATION_FAILED`.
- Never replay a prediction, text request, or browser mutation after an error.
- Do not edit or revert the existing unrelated changes in `providers/browser-fast/browser-backend-config.mjs` or `skills/agent-browser/SKILL.md`.
- Do not commit or push. Replace commit steps with explicit diff/test checkpoints.

## File Structure

- Create `providers/browser-jev/contracts.mjs`: argument validation, state sanitization, operation mapping, and deterministic verification.
- Create `providers/browser-jev/backend.mjs`: call-time Windows, Linux Chrome, and live Clearcote endpoint resolution.
- Create `providers/browser-jev/credentials.mjs`: bounded owner-file validation and allowlisted worker environment construction.
- Create `providers/browser-jev/worker-client.mjs`: bounded one-request-at-a-time JSON-lines child protocol.
- Create `providers/browser-jev/run-manager.mjs`: run registry, profile queues, terminal-state rules, and cleanup.
- Create `providers/browser-jev/server.mjs`: MCP schemas, handlers, stdio startup, and shutdown.
- Create `providers/browser-jev/worker.py`: thin adapter around upstream Jev `Agent` and Browser Harness daemon cleanup.
- Create `providers/browser-jev/package.json` and `package-lock.json`: Node package and exact MCP SDK pin.
- Create `providers/browser-jev/pyproject.toml` and `uv.lock`: Python runtime with the exact Git dependency.
- Create `providers/browser-jev/test/*.test.mjs` and `providers/browser-jev/test/test_worker.py`: offline behavior tests.
- Modify `.gitignore`: ignore provider `.venv` directories without ignoring `uv.lock`.
- Modify `config/templates/mcp-local.json` and `scripts/render-config.mjs`: built-in registration and credential-file path forwarding.
- Modify `scripts/bootstrap-personal.sh`, `scripts/test-all.sh`, `scripts/smoke-local.sh`, and `scripts/doctor.sh`: install and validate the provider.
- Modify `tests/harness.sh` and `tests/publication.sh`: exact Local composition, public structure, and credential-path contracts.
- Modify current docs: `docs/architecture.md`, `docs/security.md`, `docs/configuration.md`, `docs/development.md`, `docs/acceptance.md`, `docs/reference-environment.md`, `docs/personal/harness.md`, and `providers/README.md`.

## Review Focus

- Agent Browser returns a syntactically valid but non-loopback CDP URL: reject it before spawning a worker (Task 2 test).
- A worker exits after a mutation but before its response: mark the run failed and never replay the tick (Task 4 test).
- Stop races with an in-flight tick for the same profile: queue stop behind the tick and perform cleanup exactly once (Task 4 test).
- A credential file changes between render and start: revalidate ownership, size, keys, and readability at worker startup (Task 1 test).
- A `DONE` snapshot satisfies visible text but lacks a required `TYPE_TEXT` history entry: return terminal blocked with per-check evidence (Task 1 test).

---

### Task 1: Contracts and credential boundary

**Files:**
- Create: `providers/browser-jev/contracts.mjs`
- Create: `providers/browser-jev/credentials.mjs`
- Create: `providers/browser-jev/test/contracts.test.mjs`
- Create: `providers/browser-jev/test/credentials.test.mjs`

**Interfaces:**
- Produces `validateStartArguments(args) -> {url, goal, scenario}`.
- Produces `validateRunId(args) -> string`.
- Produces `sanitizeSnapshot(snapshot) -> object`.
- Produces `verifySuccess(snapshot, success) -> {passed, checks}`.
- Produces `loadWorkerEnvironment({file, baseEnv, readFile, lstat}) -> Promise<object>`.
- Later tasks consume these exact exports without duplicating validation.

- [ ] **Step 1: Write failing contract tests**

Cover strict URL/routing/profile validation, required non-empty success checks,
unknown-key rejection, the fixed operation enum, sanitization, all-checks-must-pass,
and the `TYPE_TEXT→fill` history mapping. Include this representative assertion:

```js
test('DONE verification requires visible checks and requested operation history', () => {
  const result = verifySuccess({
    page: { url: 'https://en.wikipedia.org/wiki/G%C3%B6del%27s_incompleteness_theorems', title: 'Gödel', text: 'Incompleteness theorem' },
    history: [{ kind: 'click' }]
  }, {
    url_contains: ['/wiki/'],
    text_contains: ['Incompleteness theorem'],
    required_operations: ['TYPE_TEXT']
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.checks.required_operations.TYPE_TEXT, { expected_kind: 'fill', passed: false });
});
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `node --test providers/browser-jev/test/contracts.test.mjs`

Expected: FAIL because `contracts.mjs` does not exist.

- [ ] **Step 3: Implement the contract functions**

Use exact constants and reject extra keys at every schema layer:

```js
export const OPERATION_KINDS = Object.freeze({
  CLICK: 'click',
  TYPE_TEXT: 'fill',
  SELECT: 'select',
  WAIT: 'wait'
});

export const TERMINAL_STATUSES = new Set(['done', 'blocked', 'failed', 'stopped']);
```

Normalize neither page content nor URLs beyond ordinary string comparison.
Each supplied substring must be present. Return a separate result for every
string and required operation. `sanitizeSnapshot` must retain goal, status,
elapsed time, page URL/title/text/scroll, indexed elements, decision fields
needed to explain the choice, and history fields needed to explain execution;
it must drop `request`, `raw_answers`, `screenshot`, browser objects, and any
unknown fields.

- [ ] **Step 4: Run the contract tests and verify GREEN**

Run: `node --test providers/browser-jev/test/contracts.test.mjs`

Expected: all contract tests pass.

- [ ] **Step 5: Write failing credential tests**

Create temporary files and assert:

```js
await assert.rejects(
  loadWorkerEnvironment({ file, baseEnv: {}, lstat: async () => ({ isFile: () => true, uid: process.getuid(), size: 20 }), readFile: async () => 'TYPESAFE_API_KEY=x\nPATH=/tmp\n' }),
  /permits only/
);
```

Also cover missing `TYPESAFE_API_KEY`, a non-file, wrong owner, a file over
64 KiB, malformed lines, direct server environment without a file, file values
overriding only allowlisted direct values, and a file that changes to an
invalid owner/file between render and start.

- [ ] **Step 6: Run credential tests and verify RED**

Run: `node --test providers/browser-jev/test/credentials.test.mjs`

Expected: FAIL because `credentials.mjs` does not exist.

- [ ] **Step 7: Implement bounded credential loading**

Export the exact allowlist:

```js
export const JEV_ENV_KEYS = Object.freeze([
  'TYPESAFE_API_KEY', 'TYPESAFE_MODEL', 'TEXT_MODEL_API_KEY',
  'TEXT_MODEL_BASE_URL', 'TEXT_MODEL', 'TEXT_MODEL_REASONING'
]);
```

When `file` is non-empty, require an absolute path, current-user-owned regular
file, maximum size `64 * 1024`, and only allowlisted keys. Merge only allowlisted
keys into a fresh environment object. Require a non-empty `TYPESAFE_API_KEY`.
Never include a value in an error message.

- [ ] **Step 8: Run both suites and inspect the diff checkpoint**

Run:

```bash
node --test providers/browser-jev/test/contracts.test.mjs providers/browser-jev/test/credentials.test.mjs
git diff --check
```

Expected: tests pass; no whitespace errors; no commit is created.

### Task 2: Call-time managed backend endpoint resolution

**Files:**
- Create: `providers/browser-jev/backend.mjs`
- Create: `providers/browser-jev/test/backend.test.mjs`

**Interfaces:**
- Consumes `resolveLinuxBrowserBackend`, `readClearcoteEndpoint`, `DEFAULT_CLEARCOTE_STATE_ROOT`, `ensureWindowsChrome`, and `AgentBrowserRunner`.
- Produces `BrowserJevBackendResolver.resolve(selection) -> Promise<{browserTarget, browserBackend, browserProfile, browserUrl, queueKey}>`.
- Produces `extractAgentBrowserCdpUrl(item) -> string` and `toLoopbackBrowserUrl(value) -> string`.

- [ ] **Step 1: Write failing backend tests**

Use injected fakes to prove:

- Windows calls `ensureWindowsChrome(profile)` and returns its `browserUrl`.
- Linux Clearcote reads `profiles/<profile>/DevToolsActivePort` on every resolve.
- Missing Clearcote returns `LINUX_BROWSER_NOT_RUNNING` and never constructs or
  calls `ManagedClearcoteRuntime`.
- Linux Chrome dispatches exactly `[['get', 'cdp-url']]` through
  `AgentBrowserRunner.linuxBatch` with the requested backend/profile.
- The returned WebSocket URL is converted to its HTTP(S) origin for
  `BU_CDP_URL`.
- Non-loopback hosts, embedded credentials, unsupported schemes, absent result
  fields, and invalid ports are rejected before worker startup.

Representative assertion:

```js
assert.deepEqual(calls, [{
  commands: [['get', 'cdp-url']],
  options: { bail: true, browserBackend: 'chrome', browserProfile: 'work' }
}]);
```

- [ ] **Step 2: Run backend tests and verify RED**

Run: `node --test providers/browser-jev/test/backend.test.mjs`

Expected: FAIL because `backend.mjs` does not exist.

- [ ] **Step 3: Implement the resolver**

Construct dependencies in the class constructor so tests never launch a
browser. For Chrome, accept the Agent Browser result only when the batch has
one successful item and the result is a string or contains one of the
documented compatibility fields `url`, `cdpUrl`, `cdp_url`, or `wsEndpoint`.
Convert `ws:` to `http:` and `wss:` to `https:`, strip path/query/fragment,
and require hostname `127.0.0.1`, `localhost`, or `::1`.

For Clearcote, derive the profile directory with `path.resolve`, verify that
its immediate parent is the resolved profiles root, and use only
`readClearcoteEndpoint(..., {allowMissing: true})`. Do not instantiate the
managed runtime. Build queue keys only from resolved target/backend/profile.

- [ ] **Step 4: Run backend and browser-fast regression tests**

Run:

```bash
node --test providers/browser-jev/test/backend.test.mjs
(cd providers/browser-fast && npm test)
```

Expected: browser-jev backend tests pass; existing browser-fast tests pass
without modifying browser-fast sources.

- [ ] **Step 5: Inspect the focused diff checkpoint**

Run: `git diff --check && git diff -- providers/browser-jev/backend.mjs providers/browser-jev/test/backend.test.mjs`

Expected: only the new resolver/test are shown; no commit is created.

### Task 3: Locked upstream Jev worker and daemon cleanup

**Files:**
- Create: `providers/browser-jev/pyproject.toml`
- Create: `providers/browser-jev/uv.lock`
- Create: `providers/browser-jev/worker.py`
- Create: `providers/browser-jev/test/test_worker.py`
- Modify: `.gitignore`

**Interfaces:**
- Worker stdin accepts one JSON object per line: `{"id":string,"command":"start"|"tick"|"state"|"stop","arguments":object}`.
- Worker stdout emits exactly one JSON object per request: `{"id":string,"ok":true,"result":object}` or `{"id":string,"ok":false,"error":{"code":string,"message":string}}`.
- `WorkerRuntime` accepts injectable `agent_factory` and `daemon_stopper` for offline tests.

- [ ] **Step 1: Add the Python project declaration**

Use this exact dependency and Python floor:

```toml
[project]
name = "mcp-dev-bridge-browser-jev-worker"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "jev-ultrafast @ git+https://github.com/browser-use/jev-ultrafast.git@1231850a0bf1a0c0341fe408ef1668dbbfdfac46",
]

[dependency-groups]
dev = ["pytest>=8.4,<9"]
```

Add `.venv/` to the root `.gitignore`; do not ignore `uv.lock`.

- [ ] **Step 2: Generate and inspect the lockfile**

Run:

```bash
uv lock --project providers/browser-jev
rg -n '1231850a0bf1a0c0341fe408ef1668dbbfdfac46|jev-ultrafast' providers/browser-jev/uv.lock
```

Expected: uv resolves the Git commit and records it in `uv.lock`.

- [ ] **Step 3: Write failing worker tests**

Test that start constructs one Agent, tick calls exactly one
`agent.command('tick')`, state only snapshots, stop calls `Agent.close()` before
`restart_daemon(name, require_clean=True)`, EOF cleanup is idempotent, and
errors never contain environment values. Assert `BU_NAME` starts with `jev-`
and is not `default`.

```python
runtime.stop()
assert calls == ["agent.close", ("restart_daemon", "jev-test123", True)]
```

- [ ] **Step 4: Run worker tests and verify RED**

Run: `uv run --frozen --project providers/browser-jev pytest providers/browser-jev/test/test_worker.py -q`

Expected: FAIL because `worker.py` does not exist.

- [ ] **Step 5: Implement the thin worker**

Import `Agent` from `jev_ultrafast` and `restart_daemon` from
`browser_harness.admin`. Keep all protocol writes on stdout and all optional
diagnostics on stderr without environment dumps. Validate request shape and
allow only one start. Use `screenshots=False`. Stop in this exact order:

```python
try:
    if self.agent is not None:
        self.agent.close()
finally:
    self.daemon_stopper(self.daemon_name, require_clean=True)
```

Make cleanup idempotent so explicit stop followed by process-finally does not
signal a successor daemon.

- [ ] **Step 6: Run worker tests and verify GREEN**

Run: `uv run --frozen --project providers/browser-jev pytest providers/browser-jev/test/test_worker.py -q`

Expected: all worker tests pass without network/model calls.

- [ ] **Step 7: Verify a clean frozen install**

Run:

```bash
clean_env="$(mktemp -d)/venv"
UV_PROJECT_ENVIRONMENT="$clean_env" uv sync --frozen --project providers/browser-jev
"$clean_env/bin/python" -c 'import jev_ultrafast, browser_harness; print("locked worker imports ok")'
```

Expected: frozen sync exits zero and prints `locked worker imports ok`.

- [ ] **Step 8: Inspect the dependency/worker checkpoint**

Run: `git diff --check && git status --short`

Expected: `pyproject.toml`, `uv.lock`, worker, tests, and `.gitignore` are visible;
no `.venv`, credential file, or commit appears.

### Task 4: Worker client, run registry, profile queues, and terminal rules

**Files:**
- Create: `providers/browser-jev/worker-client.mjs`
- Create: `providers/browser-jev/run-manager.mjs`
- Create: `providers/browser-jev/test/run-manager.test.mjs`

**Interfaces:**
- Consumes Tasks 1–3 interfaces.
- Produces `JevWorkerClient.start({python, script, env})`, `.request(command, arguments)`, and `.close()`.
- Produces `BrowserJevRunManager.start(args)`, `.tick(runId)`, `.state(runId)`, `.stop(runId)`, and `.close()`.

- [ ] **Step 1: Write failing worker-client and manager tests**

Use fake child processes/workers and resolvers. Cover bounded output, request ID
matching, one outstanding request, malformed JSON, process exit, timeout,
per-profile serialization, different-profile concurrency, stop racing a tick,
cleanup exactly once, unknown run IDs, and terminal tick rejection.

Prove no replay after ambiguous failure:

```js
worker.request.mockRejectedValueOnce(Object.assign(new Error('lost response'), { code: 'JEV_WORKER_EXITED' }));
await assert.rejects(manager.tick(runId), /lost response/);
assert.equal(worker.requests.filter(item => item.command === 'tick').length, 1);
assert.equal(manager.state(runId).status, 'failed');
```

- [ ] **Step 2: Run manager tests and verify RED**

Run: `node --test providers/browser-jev/test/run-manager.test.mjs`

Expected: FAIL because the client and manager do not exist.

- [ ] **Step 3: Implement the bounded worker client**

Spawn the provider `.venv/bin/python` with `worker.py`, `stdio: ['pipe','pipe','pipe']`,
`windowsHide: true`, and the explicitly constructed environment. Bound each
stdout/stderr buffer to 4 MiB and each request to 120 seconds. Parse complete
newline-delimited responses, match the pending request ID, and reject on any
extra/malformed response. Never include environment values in errors.

- [ ] **Step 4: Implement the manager and queue**

Use `randomUUID().replaceAll('-', '')` for run IDs and
`jev-${runId.slice(0, 32)}` for `BU_NAME`. Resolve the backend before spawning,
load credentials at every start, and create worker env with exactly one of the
fresh `BU_CDP_URL` and no inherited `BU_NAME`.

Keep `operationTails: Map<string, Promise>` using the same release-in-finally
pattern as browser-fast. On each tick, sanitize the returned snapshot. If Jev
status is `done`, evaluate success and publish `done` only on full pass;
otherwise publish terminal `blocked` with `DONE_VERIFICATION_FAILED`. Preserve
Jev `blocked`. On transport failure publish terminal `failed` and never issue a
second worker request. Queue stop on the run's queue key and call cleanup once.

- [ ] **Step 5: Run manager tests and verify GREEN**

Run: `node --test providers/browser-jev/test/run-manager.test.mjs`

Expected: all client, registry, queue, verification, failure, and cleanup tests
pass.

- [ ] **Step 6: Run all provider-local offline tests**

Run:

```bash
node --test providers/browser-jev/test/*.test.mjs
uv run --frozen --project providers/browser-jev pytest providers/browser-jev/test/test_worker.py -q
```

Expected: all tests pass and make no paid API calls.

### Task 5: Four-tool MCP server and provider package

**Files:**
- Create: `providers/browser-jev/package.json`
- Create: `providers/browser-jev/package-lock.json`
- Create: `providers/browser-jev/server.mjs`
- Create: `providers/browser-jev/test/server.test.mjs`

**Interfaces:**
- Consumes `BrowserJevRunManager`.
- Produces `createBrowserJevServer({manager})` and `runBrowserJevStdio()`.
- Advertises exactly the four approved schemas.

- [ ] **Step 1: Create the Node package manifest and lockfile**

Use Node `>=24.0.0`, ESM, and exact dependency:

```json
{
  "name": "mcp-dev-bridge-browser-jev",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "test": "node --test test/*.test.mjs && uv run --frozen pytest test/test_worker.py -q"
  },
  "dependencies": { "@modelcontextprotocol/sdk": "1.30.0" }
}
```

Run: `npm --prefix providers/browser-jev install --package-lock-only --ignore-scripts`

- [ ] **Step 2: Write the failing in-memory MCP test**

Follow `providers/browser-fast/test/server.test.mjs`: connect an MCP client via
paired in-memory transports, assert the exact sorted tool names, inspect schema
annotations, call each tool against a fake manager, and confirm errors are
structured without stack traces or secrets.

```js
assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
  'jev_start', 'jev_state', 'jev_stop', 'jev_tick'
]);
```

- [ ] **Step 3: Run the server test and verify RED**

Run: `node --test providers/browser-jev/test/server.test.mjs`

Expected: FAIL because `server.mjs` does not exist.

- [ ] **Step 4: Implement the MCP server**

Use `Server`, `StdioServerTransport`, `ListToolsRequestSchema`, and
`CallToolRequestSchema`. Mark start/tick/stop as mutating and non-idempotent;
mark state read-only and idempotent. Schemas must set
`additionalProperties:false` at every object layer and contain no credential,
selector, code, or endpoint field. Return both JSON text and
`structuredContent`, matching browser-fast's result convention.

Wire stdin end, SIGTERM, and SIGINT to one idempotent manager/server shutdown.

- [ ] **Step 5: Run provider tests and syntax checks**

Run:

```bash
npm --prefix providers/browser-jev ci
npm --prefix providers/browser-jev test
node --check providers/browser-jev/*.mjs
```

Expected: dependency install, all Node/Python tests, and syntax checks pass.

### Task 6: Secure rendering and built-in Local discovery

**Files:**
- Modify: `config/templates/mcp-local.json`
- Modify: `scripts/render-config.mjs`
- Modify: `tests/harness.sh`
- Modify: `tests/publication.sh`

**Interfaces:**
- Consumes `MCP_BROWSER_JEV_ENV_FILE` as an optional personal deployment value.
- Produces a built-in `browser-jev` Local server whose generated environment
  contains the path and GUI/Agent Browser settings but no credential values.

- [ ] **Step 1: Extend rendering/publication tests first**

Add `browser-jev` to the exact sorted Local server assertions in both shell
suites and require `providers/browser-jev/server.mjs` in public structure.
Create a mode-0600 temporary Jev env file containing both API keys and model
options, set `MCP_BROWSER_JEV_ENV_FILE` in the deployment fixture, and assert:

```js
const jev = personalLocal.mcpServers['browser-jev'];
if (jev.env.MCP_BROWSER_JEV_ENV_FILE !== jevEnvFile) process.exit(1);
for (const secret of ['TYPESAFE_API_KEY', 'TEXT_MODEL_API_KEY']) {
  if (JSON.stringify(personalLocal).includes(secret + '=')) process.exit(1);
  if (jev.env[secret] !== undefined) process.exit(1);
}
```

Also reject relative paths, non-files, wrong-owner fakes where supported, files
over 64 KiB, malformed lines, and unknown credential keys during render.

- [ ] **Step 2: Run focused shell tests and verify RED**

Run:

```bash
bash tests/harness.sh
bash tests/publication.sh
```

Expected: fail because the template and renderer do not yet know browser-jev.

- [ ] **Step 3: Register browser-jev in the template**

Place it immediately after `browser-fast`, invoking
`__REPO_ROOT__/providers/browser-jev/server.mjs`. Supply the WSLg environment
and `MCP_BROWSER_JEV_ENV_FILE: "__BROWSER_JEV_ENV_FILE__"`. Do not place keys or
values in the template.

- [ ] **Step 4: Implement renderer validation and path forwarding**

Add `MCP_BROWSER_JEV_ENV_FILE` to deployment override keys. During personal
rendering, validate the referenced absolute current-user-owned regular file,
64 KiB limit, parseable env lines, exact six-key allowlist, and non-empty
`TYPESAFE_API_KEY`. Put only its path into replacement
`__BROWSER_JEV_ENV_FILE__`. Copy `GALLIUM_DRIVER`,
`AGENT_BROWSER_PROFILE`, and `AGENT_BROWSER_EXECUTABLE_PATH` to browser-jev in
the same bounded loops used for the existing browser providers.

- [ ] **Step 5: Run focused rendering tests and verify GREEN**

Run:

```bash
bash tests/harness.sh
bash tests/publication.sh
```

Expected: both suites pass, generated Local JSON is mode 0600, and it contains
only the credential-file path.

### Task 7: Installation, smoke, doctor, and portable gate wiring

**Files:**
- Modify: `scripts/bootstrap-personal.sh`
- Modify: `scripts/test-all.sh`
- Modify: `scripts/smoke-local.sh`
- Modify: `scripts/doctor.sh`

**Interfaces:**
- Makes the provider installable and discoverable in the maintained Personal
  Workstation path.

- [ ] **Step 1: Add failing wiring assertions**

Extend `tests/publication.sh` or the nearest existing bootstrap assertion to
require:

```bash
npm --prefix "$ROOT/providers/browser-jev" ci --omit=dev
uv sync --frozen --project "$ROOT/providers/browser-jev"
```

Extend Local smoke and doctor required-server arrays with `browser-jev`; smoke
must verify the server path, MCP SDK pin, installed SDK version, and exact
four-tool discovery by starting the provider with a fake manager test path or
using its offline server test.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bash tests/publication.sh
bash scripts/smoke-local.sh
```

Expected: fail on missing install/smoke wiring.

- [ ] **Step 3: Add bootstrap and gate commands**

Install browser-jev after browser-fast so the shared Node browser dependency is
already qualified. Add browser-jev to the JavaScript syntax glob in
`scripts/test-all.sh`; the existing provider loop will run its package test.
Add browser-jev to outer-browser-hidden checks, inner required lists, path and
dependency checks, and doctor composition checks.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
bash tests/publication.sh
bash scripts/smoke-local.sh
node --check scripts/render-config.mjs providers/browser-jev/*.mjs
bash -n scripts/bootstrap-personal.sh scripts/test-all.sh scripts/smoke-local.sh scripts/doctor.sh
```

Expected: all commands exit zero.

### Task 8: Current documentation

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/security.md`
- Modify: `docs/configuration.md`
- Modify: `docs/development.md`
- Modify: `docs/acceptance.md`
- Modify: `docs/reference-environment.md`
- Modify: `docs/personal/harness.md`
- Modify: `providers/README.md`

**Interfaces:**
- Documents the shipped behavior without chronology or speculative claims.

- [ ] **Step 1: Update the authoritative browser architecture**

Add browser-jev as the third Local browser surface. Document its four tools,
owned background target, call-time backend resolution, live-only Clearcote
attachment, Agent Browser `get cdp-url` Chrome reuse, profile queue, per-run
daemon, deterministic DONE verification, and explicit stop lifecycle.

- [ ] **Step 2: Update security and configuration**

Document that browser-jev shares the Local trust domain, can mutate websites,
never accepts selectors/code/keys, and reads only the allowlisted owner file.
Document `MCP_BROWSER_JEV_ENV_FILE`, ownership/size/key validation, mode-0600
generated config, and the fact that only the path is rendered.

- [ ] **Step 3: Update development, provider, environment, and acceptance docs**

Add Node/uv install and test commands, Local discovery names, current browser
ownership, and the two live acceptance scenarios. Keep credentials and raw
traces out of docs.

- [ ] **Step 4: Verify docs**

Run:

```bash
node scripts/check-doc-links.mjs
rg -n 'browser-devtools.*browser-fast|browser-fast.*browser-devtools' docs providers/README.md
git diff --check
```

Expected: link checker and whitespace check pass; every old two-browser list is
either updated to include browser-jev or intentionally describes only those
two implementations.

### Task 9: Generated configuration, full verification, and live acceptance

**Files:**
- Generated outside Git: `${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge/local-1mcp/mcp.json`
- No tracked source files should be newly edited in this task except fixes
  directly required by failed verification.

**Interfaces:**
- Proves the complete request against offline gates and the maintained live
  Clearcote environment.

- [ ] **Step 1: Run the complete portable gate**

Run: `bash scripts/test-all.sh`

Expected: harness, publication, lifecycle, every provider suite, doc links,
Skill snapshot, syntax checks, and diff checks all pass. Report every failure
by name; do not omit pre-existing failures.

- [ ] **Step 2: Run explicit browser regressions and clean dependency install**

Run:

```bash
npm --prefix providers/browser-fast test
npm --prefix providers/browser test
npm --prefix providers/browser-jev test
clean_env="$(mktemp -d)/venv"
UV_PROJECT_ENVIRONMENT="$clean_env" uv sync --frozen --project providers/browser-jev
"$clean_env/bin/python" -c 'import jev_ultrafast, browser_harness; print("locked worker imports ok")'
```

Expected: all provider tests pass and clean imports succeed.

- [ ] **Step 3: Rerender the maintained Personal configuration**

Use the existing ignored Jev environment file only by path:

```bash
MCP_BROWSER_JEV_ENV_FILE=/home/hamza/repo/jev-ultrafast/.env \
  node scripts/render-config.mjs --profile personal
```

Inspect the generated mode-0600 Local config with a script that prints only
server names, browser-jev path equality, and credential-key absence. Never
print the file contents or credential values.

- [ ] **Step 4: Ensure `x-main` is live through browser-fast**

Use the browser-fast provider's normal observe path once if the call-time
endpoint is inactive. Do not invoke Clearcote runtime code from browser-jev and
do not launch another process against the profile.

- [ ] **Step 5: Run the example.com live scenario**

Start `https://example.com` with a narrow goal such as “Confirm the Example
Domain page is visible, then stop” and success checks for the URL/title/text.
Call `jev_tick` until terminal. Expected: verified `done`. Record run ID,
statuses, elapsed times, and check booleans only—never raw model bodies or
credentials. Call `jev_stop` afterward.

- [ ] **Step 6: Run the Wikipedia TYPE_TEXT scenario**

Start Wikipedia's main page with the goal “Find and open the Wikipedia article
about Gödel's incompleteness theorems.” Require the destination URL/text and
`required_operations:["TYPE_TEXT"]`. Tick until terminal. Expected: verified
`done`, destination article visible, and the deterministic history scan reports
`TYPE_TEXT` present. Call `jev_stop` afterward.

- [ ] **Step 7: Verify daemon hygiene and browser-fast non-regression**

For both stopped run IDs, call Browser Harness `daemon_alive(name)` from the
provider environment and assert false. Then call browser-fast observe against
the original profile and confirm its active mediated tab/state remains usable.

- [ ] **Step 8: Final evidence review**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Confirm no `.env`, `.venv`, generated state, credential file, log, trace, commit,
or unrelated browser-fast/Skill edit was added. Prepare the final report with
changed files and exact fresh verification output.
