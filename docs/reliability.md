# Write verification and invocation diagnostics

A healthy endpoint does not prove that an individual connector invocation works.
Check the operation result as well as `webharness status`.

## Verified writes

Dev `write` returns the first-line Created/Replaced acknowledgment, followed by
`bytes_written`, `sha256`, and `operation_id`. The same receipt appears in
`structuredContent`, with `path`, `outcome` (`created` or `replaced`), and
`replaced`. SHA-256 strings use the `sha256:` prefix. Counts describe decoded
bytes, not JavaScript string length or base64 input length.

Optional `expected_bytes` and `expected_sha256` describe the new decoded
content. The hash accepts 64 hexadecimal digits with an optional `sha256:`
prefix. A mismatch returns `WRITE_EXPECTATION_MISMATCH` before directory
creation or file mutation. Empty files remain valid when the caller intends
zero bytes. These expectations do not compare the previous file version.

The provider writes a temporary file in the destination directory, reads it
through the open handle, and checks its size and SHA-256. A mismatch returns
`WRITE_VERIFICATION_FAILED` before publication. Create-only writes publish with
an exclusive hard link. Explicit overwrite publishes with atomic rename.
Symlink refusal, permission preservation, and the shared mutation lease remain.
Hard-link publication requires filesystem support and returns an error rather
than falling back to a partial destination write. A process crash can leave an
unpublished temporary file. Verification is not a power-loss durability promise.

Keep the intended size/hash outside the serialized content when possible. A
receipt verifies received content, but cannot reconstruct content that a client
omitted before transmission. Inspect state after any uncertain mutation result.
Operation IDs identify invocation traces. They are not replay or idempotency keys.

## Invocation diagnostics

Dev facade, Dev worker, and Local dispatch emit bounded `call_started`,
`call_mutation`, and `call_completed` records. Records include a timestamp,
call ID, layer, tool, elapsed milliseconds, outcome, safe error code, and
mutation state where applicable. New records exclude arguments, file paths,
file contents, and exception messages. Existing provider stderr and legacy
error diagnostics retain their existing policies.

Callers can provide a UUID in MCP `_meta["webharness/call-id"]`. Invalid or
missing IDs receive a generated UUID. Local direct downstream dispatch carries
the ID to Dev, and Dev carries it across execution-worker IPC. Results return
the ID and mutation state in `_meta`. Successful write receipts use that ID as
`operation_id`. The metadata additions preserve native image and structured
result blocks. Batch subcalls can share the parent invocation ID.

Write mutation states are `not_started`, `started`, and `published`.
`started` can mean staged-file or parent-directory work, not destination
publication. Read-only Dev tools use `not_applicable`. Worker loss and other
operations without exact mutation instrumentation use `unknown`.
Schema rejection before handler entry has no handler trace. A missing handler
trace alone does not prove that a request never reached the process.

The wake proxy returns and forwards `x-webharness-request-id`, accepting a UUID
or generating one. HTTP diagnostics record forwarding attempts and completion,
without bodies, URLs, query strings, credentials, or raw errors. A forwarding
attempt does not prove that a provider received the invocation. HTTP 200 can
still contain an MCP error.

HTTP records use `logs/wake-proxy-calls.log` under the bridge state directory.
Retention is three files of at most 10 MiB each. The writer queues at most 128
records and reports dropped-record counts when capacity returns. Diagnostic
storage failures do not fail requests.

HTTP request IDs and MCP call IDs are separate. External 1MCP and connector
layers must preserve metadata or supply the bridge between them. This change
does not claim complete tracing through those external layers, or through the
legacy inner-1MCP path. Local recovery still never automatically replays a failed
mutation and retains the inspect-before-retry error.

## Controlled reliability check

Run from the repository root:

```bash
node scripts/check-write-reliability.mjs /tmp/webharness-reliability-results.json
```

The check runs 100 sequential operations through SDK stdio into five fresh Dev
provider processes. It creates and removes its own temporary workspace. Each
write checks actual bytes, hash, and receipt. The command exits nonzero on a
failure. The optional argument stores raw measurements. The check does not
exercise the authenticated public connector, Local browser tools, live service
restarts, or the public idle-wake path. It does not modify running services.
