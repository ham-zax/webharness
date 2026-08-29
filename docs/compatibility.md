# MCP Compatibility Contract

WebHarness treats the model-facing MCP surface as a public contract. Provider implementation paths and retained service/state names may stay stable for operational compatibility without being part of that contract.

## Current provider identities

The full Personal Workstation exposes these outer provider identities:

```text
Dev       read edit write file_ops wait bash pc_sleep
Code      code_search code_context code_symbol
Terminal  terminal_open terminal_read terminal_send terminal_resize
          terminal_list terminal_yield terminal_close
Local     tool_list tool_schema tool_call
```

The current outer provider IDs are `dev`, `code`, `terminal`, and `local`. `restricted` and `trusted-dev` intentionally expose smaller compositions.

Local is one authorization domain. Its three broker tools address downstream MCPs by logical `{server, tool}` identity. The maintained Personal Workstation composes:

- `browser-fast` for routine observe/execute interaction;
- `browser-devtools` for Chrome DevTools diagnostics.

`tool_list` returns bounded live catalog results, `tool_schema` returns the exact downstream tool definition, and `tool_call` forwards the downstream `CallToolResult` rather than translating it into a second result model.

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

This limitation does not require redesigning Dev, Code, Terminal, Local, Browser, or Browser DevTools. Workspace objects, worktree management, and project-authority abstractions are explicitly outside the current product direction.
