# Providers

WebHarness is organized around capability boundaries, not one tool per package.

## Dev — `providers/pi-dev/`

Files, ChatGPT-native file ingress, aggregate Git change review, short-RPC shell-free structured argv execution, short-RPC native Bash, regular-file topology operations, and durable local waits. Long or duration-uncertain commands belong in the Local Terminal server and are observed through Dev `wait`.

Personal Workstation surface:

```text
read list_directory search edit write import_file file_ops review_changes wait exec bash run_script
```

`import_file` and `review_changes` are Personal Workstation tools: the former streams one trusted ChatGPT-native file to a create-only WSL destination, while the latter returns a bounded aggregate view of the current Git working tree (or commit/range history via optional `rev`) without creating checkpoints or refs. `restricted` and `trusted-dev` expose smaller subsets according to their trust policy. Set `MCP_DEV_PREWARM_WORKER=1` to pre-fork the outer Dev execution worker on startup while retaining idle eviction (`MCP_DEV_WORKER_IDLE_MS`, default 30 minutes).

`run_script` runs one bounded JavaScript program whose only capability is calling the Dev tools this process registered, minus `run_script`, `wait`, and `import_file`. It runs in a QuickJS VM inside a worker thread of the execution worker, with no filesystem, network, timers, imports, or process access. Read-only calls may overlap; a mutating call runs alone. Nested calls are real and are not rolled back if the script later fails, and the result lists every call with its status. A script's authority is exactly the profile's own Dev surface, so it adds no Local, Terminal, Browser, Host, or owner-MCP reach.


`search` provides structured ripgrep queries with bounded output and vendor exclusions. `read` supports structural outlines and up to 20 targets, with a default of 160 lines for line mode. User-mode paths expand `~` against the service user's home. Failed edit anchors can include a bounded nearest-match snippet; long command output preserves its start and end with a retained-output path on the remote host.

## WebSession adapter — `providers/websession-adapter/`

Optional HTTPS access to the live 1MCP catalog for clients without native MCP. `bin/adapter connect --here` issues a reusable pair code, valid for one hour by default, and prints an HTTP pairing prompt. Retries recover the same token. Its default 24-hour session starts at first redemption. The Python client stores a private session and supports search, outlines, edits, writes, and up to 20 calls per HTTP batch. Batch admission is transactional; execution is per operation, with concurrent reads and serialized mutations. The adapter has its own manual lifecycle. See [WebSession clients](../docs/websession-clients.md).

## Terminal logical server — `providers/terminal/`

Persistent PTY control published through Local as `server="terminal"`:

```text
terminal_open terminal_read terminal_send terminal_resize terminal_list terminal_yield terminal_close
```

The MCP provider talks to a local broker over a Unix socket. tmux owns PTY/process lifetime; the broker owns metadata, transcript/cursor state, and human/model control leases.

## Host logical server — `providers/pi-dev/host-server.mjs`

Personal Windows-host actions are published through Local as `server="host"`. The current surface is `pc_sleep`; its implementation reuses the Pi Dev package dependencies but is not part of the direct Dev tool catalog.

## Local — `providers/local-tools/`

Stable downstream tool-broker surface:

```text
tool_list tool_schema tool_call fallback_dispatch tool_batch
```

The Local provider supervises downstream stdio servers directly through `DirectLocalServerPool` (without a second inner 1MCP process), waking each addressed server lazily on demand and evicting idle servers after `MCP_LOCAL_INNER_IDLE_MS` (default 30 minutes). It exposes logical `{server, tool}` identities, bounded live discovery, exact schema lookup, ordinary one-shot `tool_call`, `fallback_dispatch` (supporting single calls and heterogeneous `calls[]` batches with `sequential: true` or bounded concurrency), and bounded same-tool `tool_batch` dispatch. The Personal Workstation inner composition contains public `terminal`, `host`, `skill-library`, `browser-devtools`, `browser-fast`, and `browser-daily` servers plus owner-added MCPs, alongside one fallback-only mirror of outer Dev. Unscoped `tool_list` hides the Dev mirror, while explicit read-only `tool_list(server="dev")` and `tool_schema(server="dev", tool=...)` may inspect it for recovery. Ordinary `tool_call` and `tool_batch` still reject Dev; only `fallback_dispatch` can execute through that mirror. The broker declares honest mutating annotations on `fallback_dispatch` (`readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: true`); operators can enable `compat_annotations: true` per matched client in `connector-policy.yaml` so `wake-proxy` applies the read-only transport shim only to that client. The outer Local provider remains tagged only `local`.

## Skill Library — `providers/skill-library/`

Self-contained read-only specialist skill catalog (`find_skills` and `read_skill`) backed by `skill-library/policy.json` and local BM25 search, with no external service or model API key required by default.

## Browser Daily (optional) — `providers/browser-daily/`

Optional transparent stdio proxy to `browse mcp` (`https://opencode.ai/browse`), exposing the user's own already-open everyday browser (tabs, logins, extensions) when paired with the `browse` relay. It owns no browser process of its own and can be ignored completely if you do not install `browse` or prefer isolated automation profiles only.

## Browser — `providers/browser/`

The `browser-devtools` logical server is the resource-local DevTools surface behind Local. It republishes the complete pinned Chrome DevTools MCP catalog internally and adds `browser_target`, `browser_backend`, and `browser_profile`. Calls that omit `browser_target` default to the dedicated persistent Windows MCP Chrome profile on WSL hosts and to the configured Linux browser elsewhere. On Linux, the same backend/profile policy as `browser-fast` selects Chrome or CloakBrowser; managed CloakBrowser attaches to the selected running profile's live loopback CDP endpoint, while an explicit Chrome backend can use a standalone named persistent profile. Keep this surface for network, console, performance, Lighthouse, heap, screenshots, and detailed debugging.

## Browser Fast — `providers/browser-fast/`

The `browser-fast` logical server exposes `observe`, `execute`, and `inspect`. Omitted `browser_profile` preserves shared browser state; an explicit stable name requests persistent isolation. On Windows, profileless Chrome calls share `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile` with `browser-devtools`, while named Browser Fast profiles use `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profiles\\<name>` with separate visible Chrome processes, Agent Browser sessions, and operation queues; `browser_backend=cloakbrowser` is also available on Windows for native `win32-x64` CloakBrowser profiles. Everyday Chrome is outside this MCP boundary. Linux uses the current-user-owned `~/.config/mcp-dev-bridge/browser-fast.json` for its default and managed CloakBrowser catalog. Each Linux call can explicitly select `browser_backend=chrome` or `browser_backend=cloakbrowser`; a supplied profile requires that explicit backend. Managed CloakBrowser is recommended on Linux whenever stealth, humanized input, or per-profile proxies are required. CloakBrowser profile names must exist in the configuration catalog. Managed Chrome keeps Agent Browser 0.43.0 as observer and executor. Managed CloakBrowser uses pinned `cloakbrowser@0.7.2` to own persistent profiles and ephemeral loopback CDP endpoints; one runtime is kept per named profile, and concurrent startup for the same profile is coalesced in-process. Within one CloakBrowser profile, `observe` claims the blank launch tab for the first caller, reuses a blank tab that has sat untouched for 10 minutes instead of opening another, and otherwise opens a tab for later callers, then derives a strict Agent Browser session from that target. Different Linux tabs run concurrently while operations on the same tab serialize; explicitly different profiles can remain live concurrently. Supported input routes through CloakBrowser's humanized Playwright context while Agent Browser keeps refs and target IDs. `execute` requires the target/backend/profile/tab tuple from `observe`, validates the pinned tab before mutation, never retries, and reports partial or unknown outcomes explicitly. A click follows a single new tab only after a bounded read-only CDP lookup verifies that its opener is the clicked tab; multiple new tabs, missing opener metadata, or lookup failure leave remaining actions unrun. Windows process launch uses ephemeral `DevToolsActivePort` endpoints and a native one-shot helper with bounded output so WSL interop cannot retain GUI-launch pipes. Firefox is not supported by the Chromium-CDP Agent Browser backend.

See [Architecture](../docs/architecture.md) and [Security](../docs/security.md) for the current boundaries.
