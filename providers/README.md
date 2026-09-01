# Providers

WebHarness is organized around capability boundaries, not one tool per package.

## Dev — `providers/pi-dev/`

Files, ChatGPT-native file ingress, aggregate Git change review, shell-free structured argv execution, native Bash, regular-file topology operations, durable local waits, and personal Windows-host sleep.

Personal Workstation surface:

```text
read edit write import_file file_ops review_changes wait exec bash pc_sleep
```

`import_file` and `review_changes` are Personal Workstation tools: the former streams one trusted ChatGPT-native file to a create-only WSL destination, while the latter returns a bounded aggregate view of the current Git working tree without creating checkpoints or refs. `restricted` and `trusted-dev` expose smaller subsets according to their trust policy.

## Code — `providers/code-router/`

Repository intelligence:

```text
code_search code_context code_symbol
```

Each call resolves the nearest canonical Git root and routes to a correctly rooted CodeDB child. The raw CodeDB MCP catalog is not model-facing.

## Terminal — `providers/terminal/`

Persistent PTY control:

```text
terminal_open terminal_read terminal_send terminal_resize terminal_list terminal_yield terminal_close
```

The MCP provider talks to a local broker over a Unix socket. tmux owns PTY/process lifetime; the broker owns metadata, transcript/cursor state, and human/model control leases.

## Local — `providers/local-tools/`

Stable downstream tool-broker surface:

```text
tool_list tool_schema tool_call tool_batch
```

The Local provider connects over stdio to one inner 1MCP in direct mode. It exposes logical `{server, tool}` identities, bounded live discovery, exact schema lookup, raw single-call `CallToolResult` forwarding, and bounded same-tool batch dispatch over structured arguments. V1 has no catalog/schema cache. The Personal Workstation inner composition contains `browser-devtools` plus the compact `browser-fast` interaction surface; the outer Local provider remains tagged only `local`.

## Browser — `providers/browser/`

The `browser-devtools` logical server is the resource-local DevTools surface behind Local. It republishes the complete pinned Chrome DevTools MCP catalog internally, adds `browser_target`, defaults to the dedicated persistent Windows MCP Chrome profile, and routes `browser_target=linux` to WSLg Chrome. Keep it for network, console, performance, Lighthouse, heap, screenshots, and detailed debugging.

## Browser Fast — `providers/browser-fast/`

The `browser-fast` logical server exposes only `observe` and `execute`. On Windows, a shared runtime owns `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile`, launches visible Chrome with an ephemeral remote-debugging port when needed, and gives Agent Browser the resulting `DevToolsActivePort` WebSocket; the full `browser-devtools` diagnostics facade connects to the same Chrome instance. Everyday Chrome is outside this MCP boundary. Linux uses the current-user-owned `~/.config/mcp-dev-bridge/browser-fast.json` for its default and managed Clearcote profile catalog. Each call can select `browser_backend=chrome` or `browser_backend=clearcote` without rewriting that file; `browser_profile` selects a named managed Clearcote profile when needed. Managed Chrome keeps Agent Browser 0.35.0 as both observer and executor. Managed Clearcote uses pinned `clearcote@0.27.0` to own persistent bridge-state profiles and ephemeral loopback CDP endpoints; one runtime is kept per named profile, and concurrent startup for the same profile is coalesced in-process rather than serialized with a filesystem lock. Within a managed Clearcote profile, `observe` allocates an unclaimed tab for the first caller and a fresh tab for later independent callers, then derives a strict Agent Browser session from that CDP target. Different Linux tabs therefore run concurrently while operations on the same tab serialize; explicitly different Clearcote profiles can also remain live concurrently. Agent Browser keeps accessibility snapshots, refs, and target IDs, while click/fill/type/check/uncheck/select/press/hover/wheel/drag input routes through Clearcote's humanized Playwright context. With `humanize: true`, geometry-only fallbacks choose an interior target point instead of the exact center, standalone `type` performs a Clearcote-owned pointer approach before typing, drag uses Clearcote's held-button settling path and persona dwell windows, and wheel input retains Clearcote's scroll anchoring/easing. Automatic ambient motion remains opt-in because it can interfere with caller-controlled actions. The V1 external Clearcote `cdpPort` form remains readable for owner-managed compatibility, while the Personal bootstrap migrates the known maintained V1 `clearcote:9222` selector to managed V2 `x-main`. `execute` requires a tab ID from `observe`. Before mutation, the facade reads Agent Browser's tab list and requires the pinned session's current CDP `targetId` to equal the caller's observed tab; it does not switch tabs during validation, so observation refs remain valid. `observe` explicitly binds its chosen/current target before taking a fresh snapshot, which recovers strict pinning after an externally closed target. After a click, `execute` compares the target set: exactly one new target is bound before later actions and final observation, while multiple new targets stop the remaining actions without guessing. Windows Agent Browser CLI output uses a native one-shot Node helper with bounded file capture so cold daemon startup cannot strand WSL waiting for inherited pipe EOF. `execute` never retries and returns final compact state when available. Firefox is not supported by the Chromium-CDP Agent Browser backend.

## Legacy shell — `providers/legacy-shell/`

Retained only for the `restricted` profile's conservative allowlisted shell policy.

See [Architecture](../docs/architecture.md) and [Security](../docs/security.md) for the current boundaries.
