# MCP Compatibility Contract

WebHarness treats the model-facing MCP surface as a public contract. Provider implementation paths and retained service/state names may stay stable for operational compatibility without being part of that contract.

## Current provider identities

The full Personal Workstation exposes these outer provider identities:

```text
Dev       read edit write import_file file_ops review_changes wait exec bash
Local     tool_list tool_schema tool_call fallback_dispatch tool_batch
            |-- terminal  terminal_open / terminal_read / terminal_send / ...
            `-- host      pc_sleep
```

The current outer provider IDs are `dev` and `local`. `restricted` and `trusted-dev` intentionally expose smaller compositions without Local.

Local is one authorization domain. Its five broker tools address downstream MCPs by logical `{server, tool}` identity. The maintained Personal Workstation composes public Local servers for `terminal`, `host`, `browser-fast`, `browser-devtools`, and owner-added MCPs, plus one fallback-only mirror of outer Dev.

Unscoped `tool_list` excludes the fallback-only Dev mirror. Explicit read-only recovery inspection may still use `tool_list(server="dev")` and `tool_schema(server="dev", tool=...)`. Ordinary `tool_call` and `tool_batch` reject Dev. `fallback_dispatch` is reserved for an already-authorized operation whose normal writable MCP call is unavailable or unreliable; it can reach the hidden Dev mirror as well as public Local servers and forwards the downstream `CallToolResult` unchanged. Its `readOnlyHint` is intentionally retained for fallback transport compatibility and is not a promise that the selected downstream action is side-effect free. `tool_batch` applies several structured argument objects to one public `{server, tool}` route with bounded concurrency, and its member envelope adds attribution/status while each fulfilled downstream result remains intact.

The additive `skill-library` logical server exposes `find_skills` and `read_skill`
in Personal and Server profiles. This changes neither the five outer Local tools
nor smaller-profile authority. Read responses distinguish complete/incomplete
pages and package completeness/runtime compatibility; stale dependency revisions
require rediscovery. See [Skill library](skill-library.md).

`find_skills` optionally accepts `mode="jev"` and `context`; omission preserves
offline lexical behavior. Its annotations acknowledge that opt-in calls contact
an external model and may consume quota. The operator CLI validates directly;
the obsolete generated catalog and compile command have been removed.

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

### Browser agent and Satori removal

The `browser-jev` logical server and its `jev_run`, `jev_start`, `jev_tick`, `jev_state`, and `jev_stop` tools, `MCP_BROWSER_JEV_ENV_FILE`, and the bundled Satori skill and router guidance have been removed. Skill-library Jev discovery remains available.

### WebSession adapter defaults changed

For enhanced JSON requests, the default request body limit is 1 MB, up from 16 KB, and is configurable with `WEBSESSION_ADAPTER_MAX_JSON_BODY_BYTES`. The MCP tool-call timeout is 120 seconds, up from 30 seconds, and can be configured with `WEBSESSION_ADAPTER_TOOL_TIMEOUT_MS` from 1000 to 600000 milliseconds. Results containing both text and non-text content are returned as JSON for the whole result instead of text only. The `universal-get-v1` call routes and request format are unchanged, and the `bin/websession-call` script is unchanged. The shared timeout and result handling changes also apply to calls through those paths.

The served curl client changed what it prints. `wh tools` now prints one signature line per tool (from the new header-authenticated `GET /v1/signatures`) instead of bare names; `GET /v1/tools` is unchanged. A result over `WH_MAX_OUTPUT` bytes (default 8192) is printed as its start and end with the full text saved to `$WH_HOME/last`; set `WH_MAX_OUTPUT=0` for the previous behaviour. Failed calls and rejected requests now print the server's reason on stderr.

The served Python client's `call` and `sh` commands also limit displayed payloads to 8192 UTF-8 bytes. They save larger results in a private temporary file and print its path. A save failure preserves the bounded display with a warning. Set `WS_MAX_OUTPUT=0` for complete output. The Python client requests an immediate submission response, then uses existing status long-poll routes. Submission transport failures and `unknown_outcome` now exit with code 2 and a warning against automatic retries. Results with `structuredContent` retain the complete MCP result as JSON, including text content, instead of losing the structured fields.

## Stable contract versus implementation identifiers

Names such as `mcp-dev-bridge.service`, `mcp-dev-bridge` state directories, `%LOCALAPPDATA%\mcp-dev-bridge`, provider package paths, and `wsl-agent-*` are retained implementation compatibility identifiers. WebHarness branding does not require migrating them.

Provider IDs are also not the whole ABI. Tool names, input schemas, result/error behavior, annotations, and authority boundaries together define the model-facing contract.

## Current Agents limitation

WebHarness controls tools and local runtimes through MCP, but it does not own ChatGPT model scheduling. It therefore cannot currently create first-class parallel ChatGPT workers from inside the MCP runtime.

Agents are the next planned additive capability, not part of the stabilized reference runtime. The intended model-facing surface is one small `agents` capability with `spawn`, `message`, `status`, and `finish` operations backed by an Agent Broker. The first backend may adapt ChatGPT worker conversations; later API or Codex runtimes should remain replaceable beneath the same broker contract.

This limitation does not require redesigning the outer Dev/Local split or the Terminal, Host, and Browser logical servers behind Local. Workspace objects, worktree management, and project-authority abstractions are explicitly outside the current product direction.
