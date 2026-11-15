# Universal GET profile parity

Status: investigation complete, implementation pending.
Date: 2026-11-12.
Scope authority: the user requests a plan only and will execute it.

## Outcome and boundaries

Bring `universal-get-v1` to the current adapter standard through additive routes and options.
Keep the existing call envelope, canonical unpadded base64url encoding, confirmation flow, and chunk format.
Keep the `json-post-v1` contract, defaults, authentication, response formats, and execution policy unchanged.
Do not deploy or restart the running adapter during planning.

Aegis visibility: this plan defines public GET additions and their confirmation, persistence, and compatibility checks.
TDD Route: off / skipped, from `~/.config/aegis/config.toml`.
Add regression tests with implementation. Strict test-first sequencing is not required.

## Baseline evidence

Read-set:
- `providers/websession-adapter/server.mjs`: universal handlers, JSON handlers, discovery, raw download, routing, logging.
- `providers/websession-adapter/core.mjs`: submission, cwd selection, confirmation, batching, scheduling, dispatch guards.
- `providers/websession-adapter/protocol.mjs`: canonical decoding, request normalization, wait parser, text and JSON renderers.
- `providers/websession-adapter/store.mjs`: capabilities, turn fences, operation state, confirmation, chunks, recovery.
- `providers/websession-adapter/test/{protocol-store,enhanced-responses,discovery-client,capability-queues,real-1mcp-gateway}.test.mjs`.
- `docs/websession-clients.md`, `docs/compatibility.md`, and `docs/aegis/plans/2026-10-14-websession-curl-client.md`.
- `bin/adapter`: capability issue and revocation commands.

`git log -S"universal-get-v1" -- providers/websession-adapter/server.mjs` finds only `1f698cf`.
The October plan deliberately leaves universal GET unchanged.
The compatibility note describes that earlier change accurately, but needs a new current-behavior entry.

Live checks use `https://mcp.hamza.my.id` and a fresh `bin/adapter issue-cap --here` capability.
The probe revokes that capability after use. No bearer belongs in this document.

| Check | Observed result |
| --- | --- |
| GET `/v1/about` | HTTP 200. Advertises POST calls, headers, POST batch, header cwd, and header raw download. |
| Authenticated GET tools | HTTP 200, 16 tools, compact upstream guidance. The JSON HTTP instruction block is absent. |
| GET call with a 126-character request | HTTP 200, `confirmation_required`, separate confirmation and continuation capabilities. |
| Confirm harmless `dev_bash` sleep/printf | HTTP 200, `running`, about 2.423 seconds including transport. |
| Status `?wait=invalid` | HTTP 200, `running`, about 0.471 seconds. No validation. |
| Status `?wait=8` | HTTP 200, `running`, about 0.435 seconds. No hold. |
| Status `?wait=0` | HTTP 200, `running`, about 0.603 seconds. |
| 371-character encoded request | HTTP 200, `invalid_request`, `invalid encoded request`. No length diagnostic. |

The delayed live call proves ignored waits while execution remains active.
The probe does not check its final result or chunks before revocation.
Live cwd switching, batch, artifact download, and turn fencing remain untested during planning.
Their missing GET surfaces follow from source inspection.

Baseline command, from the repository root:

```bash
node --test providers/websession-adapter/test/*.test.mjs
```

Result: 89 tests pass, zero fail, zero skip, about 12.385 seconds.
The suite includes real pinned 1MCP qualification on this host.
Baseline output: `/tmp/websession-plan-baseline-tests.log`.
Existing tests cover universal decoding and store confirmation, but no complete universal HTTP lifecycle.

## Design decisions

Code changes are necessary. Documentation cannot add missing routes or make status honor waits.
Retain the existing owners: HTTP handling in server, execution in core, persistence in store, encoding in protocol.
Keep JSON behavior as the compatibility reference. Share primitives where their semantics match.
Do not forward universal requests to automatic JSON submission handlers.

Use these additive GET interfaces. Every authenticated route uses a finite capability in its path.
`request_b64` always means canonical, unpadded base64url of UTF-8 JSON.

| Route or option | Contract |
| --- | --- |
| Existing `/v1/s/{cap}/call/{nonce}/{request_b64}` | Existing exact `{version:1,tool,arguments}` envelope. Optional `turn_id` and `wait` query parameters. |
| Existing `/v1/s/{confirmation}/confirm/{id}/{challenge}` | Existing confirmation. Add optional `wait`. Use the persisted turn, never a query override. |
| Existing `/v1/s/{continuation}/op/{id}` | Add `wait=0..90`. Preserve immediate reads when absent. Keep chunked rendering even with wait. |
| `/v1/s/{cap}/cwd` | Read `default_cwd` as text, with JSON value encoding for nullable fields. |
| `/v1/s/{cap}/cwd/{nonce}/{request_b64}` | Exact `{cwd:string|null}` envelope. Prepare a confirmed cwd operation. Optional `turn_id` and `wait`. |
| `/v1/s/{cap}/batch/{nonce}/{request_b64}` | Same batch envelope and validation as JSON. All items require confirmation. Optional `turn_id`. |
| `/v1/s/{cap}/raw?path=...` | Binary download with the existing `/tmp` rules and 10 MiB limit. No header needed. |

Mutation preparation must not change cwd or dispatch tools.
Cwd selection requires confirmation because later tool calls inherit its result.
Artifact reads do not require confirmation, matching JSON download authority.

Increase the universal encoded segment ceiling from 256 to 4096 characters for calls, batch, and cwd payloads.
Keep a single named constant in protocol and publish the actual value in discovery.
The ceiling remains bounded by URL transport, independent of the 1 MiB JSON body limit.
Reject larger segments before decoding or storing them.
Use text `code: request_too_large`, plus `request_chars` and `max_request_chars` numeric lines.
Keep HTTP 200 for universal validation errors. Keep malformed requests as `invalid_request`.
Do not echo payloads or capabilities in diagnostics.
A proxy can reject a URL before the adapter sees it. Document that separate limit without claiming a measured proxy maximum.

Parse `turn_id` once. Match JSON unsigned safe-integer semantics and reject duplicate, negative, fractional, or unsafe values.
Return text `invalid_turn_id` or `superseded_by_newer_turn` through the established universal error envelope.
Omitted turns remain valid until the capability has a fence.
Never advance a fence from polling, confirmation, discovery, or download.

Batch admission remains atomic. Execution remains non-transactional.
Return text `state: ready` with `results_json`, an ordered array of universal operation snapshots.
Each item contains its own status URL, confirmation base, challenge, expiry, and summary when pending.
Do not give any item the JSON automatic execution policy.
Sequential batches require a scheduler that waits for pending confirmations instead of treating them as failures.
An out-of-order confirmation must never dispatch a later step early.

## Implementation tasks

### 1. Add GET protocol primitives and regression coverage

Files: `protocol.mjs`, `test/protocol-store.test.mjs`, and `test/enhanced-responses.test.mjs`.

- Introduce the shared encoded-length constant and typed oversized-request diagnostic.
- Preserve exact call-envelope validation and existing canonical base64url checks.
- Add separate cwd and batch parsers. Reuse JSON batch rules without changing accepted JSON fields or defaults.
- Add strict query parsing for GET turns. Reuse `parseWait` for waits.
- Add GET instruction and batch rendering helpers. Preserve existing operation and chunk output.
- Test 256, 257, 4096, and 4097 characters, malformed encoding, extra fields, invalid turns, and duplicate queries.
- Use valid JSON fixtures for accepted-length checks. Include UTF-8 data and measure encoded characters separately from decoded bytes.

Check: `node --test providers/websession-adapter/test/{protocol-store,enhanced-responses}.test.mjs`.

### 2. Support confirmed cwd actions through the existing operation lifecycle

Files: `core.mjs`, `store.mjs`, and `test/protocol-store.test.mjs`.

- Add an operation-kind column with default `tool`, using the existing additive migration pattern.
- Existing operations and JSON submissions retain kind `tool`. Add kind `cwd` for universal cwd operations only.
- Bind kind, payload, and persisted turn to nonce identity. Reject cross-kind or cross-profile nonce reuse on the GET path.
- Reuse confirmation hashes, expiry, capability revocation, continuation tokens, and state transitions.
- Dispatch confirmed cwd actions through `setDefaultCwd`, after the same capability and turn guards as tool actions.
- Recheck authority and turn immediately before persisting cwd after asynchronous directory validation.
- Preserve the existing JSON cwd response and behavior. Keep any extra guard opt-in for the confirmed GET action.
- Store the completed cwd result as text JSON containing `default_cwd` and optional `listing`.
- Serialize cwd actions with capability mutations. Document dispatch-time cwd inheritance for other operations.
- Test no change before confirmation, canonicalization, clearing, bad directories, stale turns, revocation, replay, and restart recovery.
- Do not expose an internal cwd action as an invented MCP tool.

Check: `node --test providers/websession-adapter/test/protocol-store.test.mjs`.

### 3. Add confirmed universal batches without changing JSON batches

Files: `core.mjs`, `store.mjs` if needed, and `test/protocol-store.test.mjs`.

- Extend batch submission with a source-profile option whose default remains `json-post-v1`.
- Supply `universal-get-v1` only from the new GET handler.
- Bind the complete universal batch manifest to each derived item identity, including count, order, flags, and turn.
- Preserve atomic rollback of all admission changes and turn advancement on any conflict.
- Return a confirmation for every item. Default batches schedule each item only after its confirmation.
- For sequential GET batches, make confirmation resume the batch scheduler instead of the single-operation scheduler.
- Stop at an unconfirmed predecessor. Do not count a pending predecessor as a failed step.
- Resume only confirmed steps in index order. Preserve stop-on-error, command-footer checks, and restart ordering.
- Treat expired or otherwise failed predecessors as failures under stop-on-error. Handle confirmation expiry lazily without indefinite blocking.
- Preserve JSON scheduling paths and defaults. Test cross-capability concurrency and out-of-order confirmations.

Check: `node --test providers/websession-adapter/test/{protocol-store,capability-queues}.test.mjs`.

### 4. Connect routes, waits, downloads, and discovery

Files: `server.mjs`, `protocol.mjs`, and new `test/universal-get.test.mjs`.

- Pass the parsed URL to `handleUniversalGet` and add the routes above.
- Validate wait queries before submission or confirmation side effects.
- Apply waits only to queued/running operations. Confirmation-required and terminal responses return promptly.
- Reuse the disconnect-aware wait helper. Disconnect must stop the response hold without cancelling execution.
- Keep absent call/confirm waits at 1900 ms, absent status waits immediate, and GET rendering chunked.
- Extract raw file reading behind shared validation. Preserve JSON route authentication and responses exactly.
- Keep O_NOFOLLOW, O_NONBLOCK, descriptor-based `/tmp` validation, regular-file checks, size checks, and descriptor cleanup.
- Return GET text errors for the path-authenticated raw route. Success returns the exact binary bytes.
- Add GET route templates, encoding, limits, confirmation, polling, chunks, cwd, batch, and turn guidance to universal discovery.
- Preserve existing about metadata for compatibility. Clearly label existing POST/header fields as JSON-profile-only.
- Universal instructions must direct GET clients only to supported GET interfaces. Preserve upstream guidance.
- Redact secrets and payloads in logs for every new route. Keep no-store and no-referrer on text and binary responses.

The new HTTP test must start the real adapter process against a deterministic local MCP fixture.
Reuse the fixture style in `protocol-store.test.mjs`. Do not substitute direct core calls for HTTP acceptance tests.

Required end-to-end cases:
- Discover, submit, receive confirmation, confirm, observe running status, long-poll completion, and reconstruct multiple chunks.
- Use output above 8192 bytes with multibyte UTF-8. Check every chunk SHA-256 and the exact joined content.
- Count backend invocations. Submission, duplicate confirmation, and replay must produce exactly one execution.
- Reject incorrect confirmation and continuation capabilities, cross-operation tokens, and invalid chunk numbers.
- Check expiry, revocation before dispatch, nonce conflicts, stale and missing turns after fencing, and newer-turn races.
- Check wait absence, zero, valid hold, invalid value, duplicates, terminal completion, and disconnected callers.
- Use fixture barriers for hold assertions. Avoid relying only on wall-clock timing.
- Exercise cwd read/prepare/confirm/status, batch confirmations and sequential order, and binary raw download.
- Exercise raw traversal, symlinks, non-regular files, oversized files, missing files, and invalid capabilities.
- Assert discovery profile labels and usable GET instructions without removing JSON metadata.

Check: `node --test providers/websession-adapter/test/universal-get.test.mjs`.

### 5. Update documentation and perform final qualification

Files: `docs/websession-clients.md` and `docs/compatibility.md`.

- Add a complete GET-only walkthrough with placeholders, exact encoding, confirmation, polling, and chunk reconstruction.
- Document cwd, batch item confirmation, sequential semantics, artifact download, turns, and request-length diagnostics.
- Correct the discovery description to distinguish `/v1/about` from authenticated tool guidance.
- Preserve the historical compatibility entry. Add the new behavior and defaults in a current entry.
- State that GET URL capacity remains smaller than JSON body capacity. Do not prescribe POST as the only recovery for GET-only clients.
- Run the full adapter suite once after the focused checks pass. Record failures and skips separately.
- If a shell script changes, run `shellcheck` on that script. No script changes are currently planned.
- Review the complete diff for JSON contract drift, secret exposure, duplicated execution owners, and unrelated edits.

Final suite: `node --test providers/websession-adapter/test/*.test.mjs`.

After implementation, test a temporary local instance before any deployment.
Public live qualification requires the changed adapter to run at the public URL.
Determine restart requirements and coordinate that operational step before claiming live deployment.
Issue a fresh private capability with `bin/adapter issue-cap --here`.
Use that capability for a harmless public GET lifecycle with a multi-chunk result.
Repeat public wait, size-boundary, discovery, cwd, batch, turn, and artifact checks against the new process.
Use a private `/tmp` artifact and the probe capability only. Revoke the capability and remove the artifact afterward.
If no public deployment occurs, report local qualification and mark new public behavior unverified.

## Completion and risks

Completion requires all listed GET surfaces, an HTTP lifecycle test, passing adapter tests, and matching client documentation.
No legacy profile or encoding is retired. No new service, transport, capability authority, or fallback is required.
The main risks are accidental automatic GET dispatch, out-of-order confirmed batch execution, and stale cwd updates after asynchronous validation.
Test those risks at their owning core/store boundaries and through HTTP.
URL limits imposed by the public proxy require live checks after deployment. Local tests cannot prove that boundary.
A passing baseline suite proves the current checkout only. It does not prove the planned change or deployment.
