# Structured Exec and Tool Batch Implementation Plan

**Goal:** Reduce model-visible nested quoting by keeping executable arguments and repeated MCP calls structured until the execution/routing boundary.

**Architecture:** Extend the two existing authoritative owners instead of adding a new orchestration layer. Local gains a bounded `tool_batch` facade that selects one existing `{server, tool}` route and applies many structured argument objects to it; Pi Dev gains a shell-free `exec` primitive that accepts `argv[]` alongside `bash`, with `bash` retained only for real shell programs. Both additions preserve existing downstream result semantics and current security domains.

**Tech Stack:** Node.js ESM, Model Context Protocol SDK, Zod/JSON Schema, existing Pi Dev shell/runtime helpers, existing Local inner-1MCP broker.

## Global Constraints

- Keep `tool_call` and `bash` backward compatible; this is additive.
- Do not introduce a new orchestration service, worker pool, or dependency.
- Keep structured data structured; do not serialize MCP arguments into shell command strings.
- `tool_batch` is for independent calls to one downstream `{server, tool}` with bounded concurrency, not sequential shell state.
- `exec` is shell-free `argv[]`; shell syntax remains the responsibility of `bash`.
- Preserve downstream MCP `CallToolResult` objects instead of inventing a second result model.
- Preserve current Local security-domain admission and Pi Dev cwd/path policy.
- No test creation, test modification, or broad test execution is part of this plan unless repository policy independently requires it.

## File map

- `providers/local-tools/server.mjs` — owner of Local discovery/schema/call routing; add batch validation, bounded dispatch, tool registration, and structured batch result.
- `providers/pi-dev/server.mjs` — owner of the Pi Dev model-visible tool surface; register the new `exec` tool and keep `bash` guidance explicit.
- `providers/pi-dev/shell.mjs` — owner of bounded process execution/output capture; add shell-free argv execution while reusing cwd, timeout, cancellation, output, and spool policies.
- `README.md` / `providers/README.md` — synchronize the public capability inventory with the additive tools.
- `docs/architecture.md` — document why Local batching and Pi Dev argv execution exist at these boundaries.
- `docs/compatibility.md` / `docs/configuration.md` / `docs/operations.md` / `docs/personal/harness.md` — update only the directly affected published tool-surface references when their current enumerations would otherwise become stale.
- `docs/security.md` — state that `exec` changes parsing rather than authority and that `tool_batch` changes orchestration rather than the Local trust domain.

### Task 1: Add Local `tool_batch`

**Files:**
- Modify: `providers/local-tools/server.mjs`
- Modify direct Local surface documentation only where the current three-tool enumeration is authoritative.

**Interfaces:**
- Consumes: existing `LocalToolBroker.call({server, tool, arguments})`, configured-server admission, downstream `CallToolResult`.
- Produces: `tool_batch({server, tool, calls, concurrency?})` where each call has an optional caller id plus structured `arguments`; the routing tuple is stated once for the whole batch.

**Steps:**
- [x] Define a bounded batch schema with a small maximum call count and concurrency cap.
- [x] Validate the shared `{server, tool}` route and every call argument object before dispatch so malformed input does not partially execute.
- [x] Dispatch independent members with a simple bounded-concurrency loop over the existing broker call path.
- [x] Preserve input order and optional caller ids in the returned entries.
- [x] Distinguish broker/transport rejection from a fulfilled downstream MCP result whose own `isError` is true.
- [x] Keep `tool_call` behavior unchanged.
- [x] Update Local instructions to prefer `tool_batch` over Bash/CLI orchestration for repeated MCP calls.

**Acceptance criteria:**
- One Local call can express multiple independent downstream tool invocations without shell, temporary files, or JSON re-encoding.
- Each member still passes through the same configured-server authority and downstream tool routing as `tool_call`.
- Returned downstream results remain intact and attributable to their input member.

### Task 2: Add shell-free Pi Dev `exec`

**Files:**
- Modify: `providers/pi-dev/shell.mjs`
- Modify: `providers/pi-dev/server.mjs`
- Modify direct Pi Dev surface documentation where tool enumerations become stale.

**Interfaces:**
- Consumes: `argv: string[]` with the executable as element 0, optional `cwd`, `timeout_seconds`, and the existing Pi Dev path/output/cancellation policy.
- Produces: the same bounded execution metadata shape used by `bash` where applicable (`cwd`, exit state, output bytes, duration, timeout/cancel/truncation metadata).

**Steps:**
- [x] Factor only the minimum shared process/output policy needed to avoid duplicating Bash spool/cancellation behavior.
- [x] Spawn the executable directly with argv and no shell parser.
- [x] Reuse current cwd resolution, timeout, cancellation, output-tail/spool, and cleanup policies.
- [x] Register `exec` with a schema that makes shell-free semantics explicit.
- [x] Update `bash` guidance: use it for pipes, redirects, substitutions, variables, loops, and other genuine shell semantics; do not use it to orchestrate repeated MCP calls when `tool_batch` is available.

**Acceptance criteria:**
- Ordinary commands can be issued as structured argv without shell quoting.
- `bash` remains available and behavior-compatible for genuine shell programs.
- The new path does not silently interpret shell metacharacters.

### Task 3: Synchronize direct contract documentation

**Files:**
- Modify only documents whose explicit Local/Pi Dev tool lists or routing guidance are stale after Tasks 1-2.

**Interfaces:**
- Consumes: final tool names and semantics from Tasks 1-2.
- Produces: one consistent public/local architecture description.

**Steps:**
- [x] Replace stale `tool_list tool_schema tool_call` enumerations with the additive Local batch surface where those lists are intended to be exhaustive.
- [x] Document the `exec` versus `bash` decision boundary in the authoritative architecture/configuration guidance and keep shorter inventories elsewhere consistent.
- [x] Keep examples structural; avoid embedding long escaped shell programs.

**Acceptance criteria:**
- Published tool inventories do not contradict the implementation.
- An agent reading the docs can choose `tool_batch`, `exec`, or `bash` from semantics rather than habit.

## Delivery order

1. Implement `tool_batch` completely at the existing Local owner.
2. Inspect the resulting contract and affected direct documentation.
3. Implement shell-free `exec` at the existing Pi Dev owner.
4. Synchronize only directly affected documentation.
5. Inspect the attributable changed hunks and stop when the structured paths are present and no concrete in-scope blocker remains.

## Implementation evidence

- `node --check` and `git diff --check` pass for the changed implementation.
- `exec(argv[])` preserves spaces, quotes, `$`, and `;` literally with no shell interpretation.
- `exec` now settles from the executable's actual exit plus a bounded post-exit stdio drain, so a detached descendant holding inherited stdio does not cause a false timeout.
- `tool_batch` reaches the requested concurrency bound, preserves input order, retains downstream `isError` as a fulfilled result, represents broker/transport rejection separately, and rejects malformed envelopes before dispatch.
- Cancelling `tool_batch` stops queued members from dispatching and forwards the request signal to already-started Local inner calls.
- Existing Bash non-zero exit/output, timeout, cancellation, spool, and truncation behavior remains covered by the Pi Dev provider suite.
- Focused regression coverage now exists for literal argv, inherited-stdio exit handling, batch preflight/order/concurrency/error semantics, and batch cancellation.
- Local, Pi Dev, Terminal, Code Router, and Browser provider suites pass for this wave; Terminal tests were run with `TMPDIR` redirected because the machine's `/tmp` tmpfs was full.
- The full lifecycle gate still has a pre-existing contradiction in `HEAD`: `README.md` mentions the future `tunnel-client` path while `tests/lifecycle.sh` forbids that term. `browser-fast` also has a failing assertion with no working-tree changes in that provider. Neither blocker was broadened into this feature wave.

## Rollout boundary

This plan changes repository source and published contract documentation. It does not change ChatGPT's own tool-call rendering, install/update external ChatGPT Skills, or restart the currently running WebHarness providers. Those are separate rollout actions after this source wave.
