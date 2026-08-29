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
Agents    agents {spawn|message|status|finish}
```

The current outer provider IDs are `dev`, `code`, `terminal`, `local`, and `agents`. `restricted` and `trusted-dev` intentionally expose smaller compositions. `agents` exists only in the Personal Workstation profile and is authorized separately under `tag:agents`.

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

## Agents compatibility boundary

Agents is additive and does not change Dev, Code, Terminal, Local, Browser, or Browser DevTools. Its model-facing contract is one `agents` tool with the `spawn`, `message`, `status`, and `finish` actions. Caller identity is not an argument: the provider accepts only ChatGPT's native `openai/session` metadata and the Agent Broker maps that session to an exact browser conversation through the paired WebHarness Agents extension.

The extension protocol is independently versioned. A broker/extension protocol or extension-version mismatch fails visibly rather than silently accepting incompatible browser evidence. The unpacked extension's source is `webharness-agents-extension/`; upstream provenance is retained inside that directory.

WebHarness still does not own ChatGPT model scheduling. It can open worker conversations and deliver worker turns, but it cannot synthesize a new prime model turn while the prime is idle. Workspace objects, automatic worktree management, and project authority remain outside the contract.
