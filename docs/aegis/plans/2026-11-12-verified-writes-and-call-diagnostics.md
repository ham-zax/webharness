# Verified writes and call diagnostics

The user authorizes fixes after the reliability investigation. Baseline: clean
main at 7f45c0d. The original connector incidents remain unattributed.

Decision: code-change. Existing write acknowledgments cannot prove file content.
Code owners are pi-dev files/server/render, its idle execution worker, Local's
dispatch boundary, and the wake proxy. Additive receipts preserve the first
Created/Replaced line. Keep create-only behavior, symlink refusal, permissions,
atomic overwrite, image envelopes, and recovery without mutation replay.

TDD mode: off. Add focused regression and fault-injection checks after changes.
No deployment restart, external framework, or tunnel lifecycle change is needed.
Internal write implementations consolidate into one verified publication owner.
No stored user data or public tool names are retired.

1. Stage creates and replacements in the destination directory. Verify staged
   bytes against decoded input with a handle read and SHA-256. Publish creates
   with exclusive hard linking and replacements with atomic rename. Preserve
   permission behavior. Validate expected_bytes and expected_sha256 before
   creating parents. Return bytes_written, sha256, outcome, replaced, operation_id.
2. Return the receipt in text and structuredContent. Add schema fields and tests
   for UTF-8, binary, empty content, mismatch without mutation, write corruption,
   interrupted publication, exclusive creation, permission retention, and MCP.
3. Add bounded invocation diagnostics with safe IDs and explicit stage/outcome.
   Carry correlation metadata across Local downstream calls and Dev worker IPC.
   Do not log arguments, file paths, contents, credentials, or raw exception text.
   Log starts and completions, including successes. Preserve native result blocks.
   Add HTTP request IDs at the wake proxy without buffering request bodies.
   HTTP IDs and MCP invocation IDs are separate unless the caller propagates both.
   The external 1MCP/client connector cannot be modified by this repository.
4. Run affected suites sequentially. Repeat the isolated 100-operation check,
   including receipt validation. Update usage/deferred docs and record limits.
   Commit verified work. Report connector evidence still needed from the user.

Acceptance: no incorrect successful write under controlled fault injection.
Every successful write includes a verified receipt. Expected-content mismatch
leaves destination and missing parents unchanged. Traces identify provider entry,
worker dispatch, completion, and conservative mutation state. Logs exclude test
secrets. Recovery never replays a failed mutation automatically.

## Execution checkpoint

Verified publication, receipts, correlation across Local/Dev worker IPC, and
HTTP request diagnostics pass focused tests. The smaller-profile test exposed
a standalone packaging boundary. The shared built-in-only diagnostic helper
lives in pi-dev so that copying that provider remains self-contained. Local and
the wake proxy import the same implementation. No duplicate helper exists.

The full gate passed all provider suites, shell integration suites, documentation,
snapshot, and syntax checks. Its runtime group stalled once in stream shutdown
and the coordinator terminated that test child. The unchanged baseline passed
15 proxy tests. The changed proxy passed 16 isolated tests, and a bounded rerun
of all runtime tests passed 30 tests. No shutdown cause was established or patched.
Later focused tests cover the bounded HTTP log writer and final metadata changes.
The 100-operation check passes with independent bytes/hash/receipt validation.

The user supplied a retained gateway incident. Inspection of the installed
1MCP implementation shows that upstream_error denotes a returned isError result.
The original result text is absent, so the read failure remains unattributed.
The user explicitly authorizes commit, push, and workstation restart/deployment.

Brief retrospective: the standalone-provider contract caught a new shared import
that was unsuitable for exported profiles. Run that existing smoke check at the
first cross-directory import change. Repeated mixed-cwd commands also cost time.
Use explicit repository paths when edits and package-local checks share a batch.
No new global rule or guardrail is installed.
