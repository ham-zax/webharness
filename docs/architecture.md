# Architecture

## Runtime path

```text
ChatGPT
  -> authenticated MCP route
  -> Cloudflare tunnel
  -> 1MCP on 127.0.0.1:3050
  -> dev provider
  -> configured Linux / WSL workspace
```

1MCP is the single MCP gateway. The `dev` provider is a local stdio child that exposes the small model-facing tool surface.

## Provider boundary

The provider owns coding semantics:

- `read`: bounded text reads below the workspace root;
- `edit`: exact guarded replacements with one diff result;
- `write`: atomic create-only text files;
- `bash`: registered only in `trusted-dev`, with native Bash command-string semantics.

Bridge lifecycle code does not implement editor or shell semantics itself.

## State ownership

Source code stays read-only from the lifecycle's perspective. Mutable deployment state lives outside the checkout:

```text
runtime: ${XDG_RUNTIME_DIR:-/run/user/$UID}/mcp-dev-bridge
state:   ${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge
1MCP:    <state>/1mcp
```

The 1MCP config, OAuth/session data, PID state, and Bash overflow artifacts therefore do not belong in Git.

## Process model

The bridge owns one config-scoped 1MCP process, one `cloudflared` process, and one watchdog while enabled. Start/stop/watchdog operations share an exclusive lifecycle lock and use validated PID/process-group ownership.

Startup is transactional: local 1MCP readiness is required before public tunnel readiness, and failures roll managed processes back instead of leaving a partial stack.
