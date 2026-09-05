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
tool_list tool_schema tool_call dispatch_intent tool_batch
```

The Local provider connects over stdio to one inner 1MCP in direct mode. It exposes logical `{server, tool}` identities, bounded live discovery, exact schema lookup, raw one-shot `CallToolResult` forwarding through both `tool_call` and `dispatch_intent`, and bounded same-tool batch dispatch over structured arguments. V1 has no catalog/schema cache. The Personal Workstation inner composition contains `browser-devtools` plus the compact `browser-fast` interaction surface; the outer Local provider remains tagged only `local`.

## Browser — `providers/browser/`

The `browser-devtools` logical server is the resource-local DevTools surface behind Local. It republishes the complete pinned Chrome DevTools MCP catalog internally and adds `browser_target`, `browser_backend`, and `browser_profile`. Calls default to the dedicated persistent Windows MCP Chrome profile. On Linux, the same backend/profile policy as `browser-fast` selects Chrome or Clearcote; managed Clearcote attaches to the selected running profile's live loopback CDP endpoint, while an explicit Chrome backend can use a standalone named persistent profile. Keep this surface for network, console, performance, Lighthouse, heap, screenshots, and detailed debugging.

## Browser Fast — `providers/browser-fast/`

The `browser-fast` logical server exposes only `observe` and `execute`. Omitted `browser_profile` preserves shared browser state; an explicit stable name requests persistent isolation. On Windows, profileless calls share `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile` with `browser-devtools`, while named Browser Fast profiles use `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profiles\\<name>` with separate visible Chrome processes, Agent Browser sessions, and operation queues. Everyday Chrome is outside this MCP boundary, and Browser DevTools currently targets only the shared default Windows profile. Linux uses the current-user-owned `~/.config/mcp-dev-bridge/browser-fast.json` for its default and managed Clearcote catalog. Each Linux call can explicitly select `browser_backend=chrome` or `browser_backend=clearcote`; a supplied profile requires that explicit backend. Chrome profile names create or reuse isolated persistent bridge-state directories. Clearcote profile names must exist in the configuration catalog. Managed Chrome keeps Agent Browser 0.35.0 as observer and executor. Managed Clearcote uses pinned `clearcote@0.27.0` to own persistent profiles and ephemeral loopback CDP endpoints; one runtime is kept per named profile, and concurrent startup for the same profile is coalesced in-process. Within one Clearcote profile, `observe` claims an unclaimed tab for the first caller and a fresh tab for later independent callers, then derives a strict Agent Browser session from that target. Different Linux tabs run concurrently while operations on the same tab serialize; explicitly different profiles can remain live concurrently. Supported input routes through Clearcote's humanized Playwright context while Agent Browser keeps refs and target IDs. `execute` requires the target/backend/profile/tab tuple from `observe`, validates the pinned tab before mutation, never retries, and reports partial or unknown outcomes explicitly. Windows process launch uses ephemeral `DevToolsActivePort` endpoints and a native one-shot helper with bounded output so WSL interop cannot retain GUI-launch pipes. Firefox is not supported by the Chromium-CDP Agent Browser backend.

## Legacy shell — `providers/legacy-shell/`

Retained only for the `restricted` profile's conservative allowlisted shell policy.

See [Architecture](../docs/architecture.md) and [Security](../docs/security.md) for the current boundaries.
