# Temporary Gemini connection tracing

The user requests request/response evidence before further permission fixes.
Baseline: `d660324`, clean working tree. No tool effects or approval policy change.

The existing wake proxy owns outer HTTP forwarding. Its diagnostic logger
already provides bounded queues, rotation, private files, and request IDs.
Extend that owner with opt-in tracing, rather than patching the installed SDK.

Capture method, sanitized path/headers, protocol/session fingerprints, JSON-RPC
request/response bodies, statuses, disconnects, and timing. Omit authentication
bodies. Redact authorization, cookies, tokens, OAuth codes, and secret fields.
Tool arguments and results can still contain private content. Keep captures local.

Use a private control file and CLI start/stop/status. Default off, default
30-minute window, maximum one hour. Limit each body to 64 KiB, log storage to
three 10 MiB files, and the asynchronous writer queue. Large or incomplete
JSON bodies report an omission instead of unsafe partial redaction.

Passive listeners must preserve streaming, backpressure, response bytes,
headers, and tool dispatch. Trace failures must not fail requests. Record a
first-byte event and completion, including disconnects. A client permission
card may appear before any request, so server traces cannot reveal that decision.

Implement the trace module, proxy hook, CLI, focused tests, and operating notes.
Check redaction, rotation, expiry, forwarding, and SSE. Run bridge tests and
shell checks only if a shell source changes. Deploy, arm a window, and check
public forwarding without logging credentials. The user then reproduces Gemini.

TDD Route: off / skipped, from local configuration. Add regression tests with
implementation. No migration, connector workaround, or permission fix is in scope.
