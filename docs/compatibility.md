# MCP Compatibility Contract

WebHarness treats the model-facing MCP surface as a public contract. Provider implementation paths and retained service/state names may stay stable for operational compatibility without being part of that contract.

## Current provider identities

The full Personal Workstation exposes these outer provider identities:

```text
Dev       read edit write import_file file_ops review_changes wait exec bash
Local     tool_list tool_schema tool_call fallback_dispatch tool_batch
            |-- code      code_search / code_context / code_symbol
            |-- terminal  terminal_open / terminal_read / terminal_send / ...
            `-- host      pc_sleep
```

The current outer provider IDs are `dev` and `local`. `restricted` and `trusted-dev` intentionally expose smaller compositions without Local.

Local is one authorization domain. Its five broker tools address downstream MCPs by logical `{server, tool}` identity. The maintained Personal Workstation composes public Local servers for `code`, `terminal`, `host`, `browser-fast`, `browser-devtools`, and owner-added MCPs, plus one fallback-only mirror of outer Dev.

Unscoped `tool_list` excludes the fallback-only Dev mirror. Explicit read-only recovery inspection may still use `tool_list(server="dev")` and `tool_schema(server="dev", tool=...)`. Ordinary `tool_call` and `tool_batch` reject Dev. `fallback_dispatch` is reserved for an already-authorized operation whose normal writable MCP call is unavailable or unreliable; it can reach the hidden Dev mirror as well as public Local servers and forwards the downstream `CallToolResult` unchanged. Its `readOnlyHint` is intentionally retained for fallback transport compatibility and is not a promise that the selected downstream action is side-effect free. `tool_batch` applies several structured argument objects to one public `{server, tool}` route with bounded concurrency, and its member envelope adds attribution/status while each fulfilled downstream result remains intact.

## Compatibility rules

The following are compatible when existing meanings remain unchanged:

- adding an optional input;
- adding a new tool;
- adding a downstream Local catalog entry;
- adding result fields that existing consumers can ignore;
- improving implementation internals without changing authority, errors, or observable semantics.

The following are breaking model-facing changes:

- removing or renaming a tool or provider identity;
- adding a new required input;
- changing an existing input from one meaning to another;
- materially changing success/result or error semantics;
- changing whether an operation is read-only, mutating, destructive, or otherwise changes authority expectations;
- moving a capability into a different authorization domain without an explicit migration.

MCP annotations are part of the contract when they communicate authority or side-effect meaning. Changing an annotation from read-only to mutating, or changing destructive/idempotence meaning, is not treated as cosmetic metadata.

## Stable contract versus implementation identifiers

Names such as `mcp-dev-bridge.service`, `mcp-dev-bridge` state directories, `%LOCALAPPDATA%\mcp-dev-bridge`, provider package paths, and `wsl-agent-*` are retained implementation compatibility identifiers. WebHarness branding does not require migrating them.

Provider IDs are also not the whole ABI. Tool names, input schemas, result/error behavior, annotations, and authority boundaries together define the model-facing contract.

## Current Agents limitation

WebHarness controls tools and local runtimes through MCP, but it does not own ChatGPT model scheduling. It therefore cannot currently create first-class parallel ChatGPT workers from inside the MCP runtime.

Agents are the next planned additive capability, not part of the stabilized reference runtime. The intended model-facing surface is one small `agents` capability with `spawn`, `message`, `status`, and `finish` operations backed by an Agent Broker. The first backend may adapt ChatGPT worker conversations; later API or Codex runtimes should remain replaceable beneath the same broker contract.

This limitation does not require redesigning the outer Dev/Local split or the Code, Terminal, Host, and Browser logical servers behind Local. Workspace objects, worktree management, and project-authority abstractions are explicitly outside the current product direction.
