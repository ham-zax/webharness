# Configuration

Configuration is built from three inputs:

```text
tracked template + explicit trust profile + local deployment identity
                              -> generated external state
```

## Deployment identity

Local machine-specific values come from `.env` (or another file passed with `--env-file`):

```text
MCP_WORKSPACE_ROOT=/absolute/path/to/code
MCP_PUBLIC_URL=https://mcp.example.com
MCP_TUNNEL_NAME=
MCP_DEV_MAX_OUTPUT_BYTES=1048576
MCP_DEV_MAX_SPOOL_BYTES=67108864
MCP_DEV_SPOOL_TTL_SECONDS=604800
MCP_DEV_SPOOL_MAX_TOTAL_BYTES=536870912
MCP_ONE_MCP_LOG_MAX_SIZE_BYTES=10485760
MCP_ONE_MCP_LOG_MAX_FILES=5
MCP_PERSONAL_DEFAULT_CWD=
MCP_TERMINAL_FRONTEND=kitty
MCP_OWNER_CONTEXT_FILE=
MCP_OWNER_ENV_FILE=
```

`MCP_PERSONAL_DEFAULT_CWD` is optional and applies only to the Personal Workstation (`personal`) profile. Leave it empty/unset to use the actual WSL user's `$HOME`. `MCP_TERMINAL_FRONTEND` is also personal-only: unset/empty defaults to `kitty`, and the accepted values are `kitty` and `windows-terminal`. The renderer validates this selector only for `personal`, so a stray value does not break `restricted` or `trusted-dev`.

`MCP_OWNER_CONTEXT_FILE` and `MCP_OWNER_ENV_FILE` are optional personal-profile references to owner-controlled files outside the repository. Both paths must be absolute when set. `pi-dev` requires the context file to be a readable, current-user-owned regular file no larger than 32 KiB and publishes non-empty content as MCP initialization instructions. The renderer requires the env file to be a readable, current-user-owned regular file no larger than 64 KiB and permits only `GALLIUM_DRIVER`, `MOZ_ENABLE_WAYLAND`, `AGENT_BROWSER_PROFILE`, and `AGENT_BROWSER_EXECUTABLE_PATH`. The Agent Browser settings are Linux `browser-fast`-only; the executable path must be absolute and executable. Generated `owner.env` still contains only the validated Dev/Terminal GUI variables, so Agent Browser settings are not imported into systemd service environments. Do not put trust policy or secrets in `.env` or the owner GUI env.

Linux `browser-fast` also reads the current-user-owned `~/.config/mcp-dev-bridge/browser-fast.json` before each backend call. Missing configuration preserves managed Chrome. The current V2 configuration can select a named managed Clearcote profile; WebHarness owns that profile and its ephemeral loopback CDP endpoint while Agent Browser remains the observation/ref layer. The older V1 `cdpPort` form is retained only as a migration compatibility path. Save backend changes only between complete `observe`/`execute` operations and observe again after switching because refs and tab IDs belong to the previous browser. Firefox is not supported by the current Chromium-CDP driver and fails explicitly rather than falling through to Chrome.

## Profiles

### `restricted`

- Dev Files: workspace-bounded `read`, `edit`, `write`.
- Shell: separate allowlisted legacy shell.
- No Code provider.
- No Terminal provider.

### `trusted-dev`

- Dev Files: workspace-bounded `read`, `edit`, `write`.
- Dev Bash: unrestricted native Bash as the Linux service user.
- No Code provider.
- No Terminal provider.

### `personal` — Personal Workstation

The maintained full reference composition is:

```text
Dev       read edit write file_ops wait bash pc_sleep
Code      code_search code_context code_symbol
Terminal  terminal_open terminal_read terminal_send terminal_resize terminal_list terminal_yield terminal_close
Local     tool_list tool_schema tool_call
            |-- browser-fast      routine observe/execute interaction
            `-- browser-devtools  Chrome DevTools diagnostics
```

The renderer resolves one absolute personal default cwd from `MCP_PERSONAL_DEFAULT_CWD` when supplied, otherwise from the actual WSL user's `$HOME`, and uses it for both Dev and Code. No tracked personal profile/template carries a machine-specific home path. Terminal communicates through the WebHarness broker socket and receives one normalized `MCP_TERMINAL_FRONTEND` presentation preference; tracked source keeps `kitty` as the compatibility default while a local deployment may select `windows-terminal`.

For personal rendering, the outer config contains `local`, `code`, `dev`, and `terminal`. The outer `local` provider is tagged only `local` and points at the repository Local broker. The renderer also atomically materializes a Local inner config at the bridge state root containing `browser-devtools` and `browser-fast`, and writes that inner config before publishing the outer config so config reload cannot start Local against a missing file. The Local broker starts pinned 1MCP over stdio in direct mode and exposes only bounded discovery/schema/call metatools.

`browser-devtools` is the full Chrome DevTools MCP facade for diagnostics and rich results; its tools default to the dedicated persistent Windows MCP Chrome profile and use `browser_target=linux` for WSLg. `browser-fast` exposes only `observe` and `execute` for routine interaction and uses pinned Agent Browser 0.35.0 on both targets. The Windows target remains the dedicated shared MCP Chrome runtime. The Linux target normally uses a managed browser selected through `~/.config/mcp-dev-bridge/browser-fast.json`; the maintained V2 Clearcote path owns a named persistent profile and ephemeral loopback CDP endpoint, while the legacy V1 external `cdpPort` form remains readable during migration. Each observation also checks the WSL-user browser-memory root at `~/.config/mcp-dev-bridge/browser-memory/`. `policies/<host>/` and `sites/<host>/` are exact canonical-host lookups; `platforms/<name>/match.json` can declare `hosts`, `host_suffixes`, or `url_prefixes` for reusable platform memory. Missing memory is valid and unknown/custom company sites continue through the generic browser flow. Upload actions use logical names from `~/.config/mcp-dev-bridge/browser-artifacts.json`, whose values are absolute WSL paths to intentionally browser-shareable files. The action schema never accepts a raw file path. Windows uploads translate the approved WSL path to its `\\wsl.localhost` form before calling Agent Browser; Linux uses the path directly. Windows keeps the MCP Chrome data directory at `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile`; a shared runtime launches that visible profile with an ephemeral debugging port and supplies its `DevToolsActivePort` endpoint to both logical servers. The everyday Chrome user-data directory is not attached or copied. The tracked templates carry only generic WSLg plumbing. Personal runtime/browser policy comes from the optional owner env: Dev, the Terminal MCP provider, and the Terminal/tmux services receive the validated GUI values; both Linux browser surfaces may receive `GALLIUM_DRIVER`; and Linux `browser-fast` alone may receive `AGENT_BROWSER_PROFILE` plus `AGENT_BROWSER_EXECUTABLE_PATH`. A named profile lets Agent Browser snapshot the source Chrome profile into its controlled session instead of making the harness own or mutate that Chrome user-data directory. This keeps workstation-specific browser and GUI choices out of active tracked configuration. Both browser surfaces stay behind the same `tag:local` authorization boundary.

`pc_sleep` is registered only in this personal user-path mode and uses Windows Task Scheduler for an optional wake time. Code has no repository-size preflight or threshold: first use may start a persistent CodeDB child and create or update substantial on-disk index state, potentially consuming significant disk and RAM. Tool descriptions steer large or unfamiliar repository discovery toward Dev Bash/`rg` and focused `read` first; that guidance is not runtime enforcement.

## Rendering

`webharness setup` calls the renderer for you. Direct rendering is also supported:

```bash
node scripts/render-config.mjs \
  --profile trusted-dev \
  --env-file .env
```

The renderer accepts `restricted`, `trusted-dev`, and `personal`.

Useful options:

```text
--check           validate without writing generated state
--env-file PATH
--state-dir PATH
--repo-root PATH
```

## Generated state

Default persistent root:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge
```

Important files:

```text
bridge.env        selected profile, public URL, workspace/default cwd, source root
owner.env         sanitized personal GUI environment when the personal profile is rendered
1mcp/mcp.json     rendered provider composition
1mcp/config.toml  rendered 1MCP application policy, including bounded native logging
1mcp/             1MCP writable application/OAuth/session state
logs/one-mcp.log  current native 1MCP application log; rotated siblings stay in logs/
dev/              Dev durable retained-output state when enabled
```

Transient process state is kept under `${XDG_RUNTIME_DIR:-/run/user/$UID}/mcp-dev-bridge`.

## Source root matters

Generated provider commands contain the repository root used during rendering. If you move or delete that checkout/worktree, render again from the new source root before removing the old one. See [Operations: safe source cutover](operations.md#safe-source-cutover).

## Output policy

`MCP_DEV_MAX_OUTPUT_BYTES` is deployment policy, not a model-facing tool argument. Increase it only when the operator deliberately wants a larger model-visible Bash result budget.

Pi Dev also bounds retained Bash diagnostics independently of the model-visible tail. `MCP_DEV_MAX_SPOOL_BYTES` is an internal deployment/provider limit with a 64 MiB default and a 256 MiB maximum; the renderer propagates it into the Dev provider environment but it never appears as a model-facing MCP tool argument. `MCP_DEV_SPOOL_TTL_SECONDS` defaults to 604800 seconds (7 days), and `MCP_DEV_SPOOL_MAX_TOTAL_BYTES` defaults to 536870912 bytes (512 MiB) and must be at least the per-spool cap. Finalized spools are pruned on provider startup and opportunistically after every Bash command: expired files are removed, legacy oversized files are capped, and the oldest finalized files are evicted until the aggregate budget is satisfied. Active `.log.active` spools are excluded from GC. When command output exceeds the per-spool cap, `output_bytes` still counts the full observed stream, the model still receives the configured bounded tail, and any retained-output file is explicitly labeled as capped rather than complete.


## 1MCP log policy

1MCP application logging uses the pinned runtime's native Winston file transport rather than an unbounded shell `>>` capture. The renderer writes a structured `[logging]` block to `1mcp/config.toml` and keeps the log under the private bridge state directory. `MCP_ONE_MCP_LOG_MAX_SIZE_BYTES` defaults to 10485760 bytes (10 MiB) and is constrained to 1..64 MiB; `MCP_ONE_MCP_LOG_MAX_FILES` defaults to 5 and is constrained to 1..10. The pinned runtime installer forces restart-stable tailable Winston rotation when more than one file is retained, and bridge startup removes numeric siblings left by the older incrementing mode beyond the configured file count. The parent `logs/` directory is mode 0700, and bridge startup uses `umask 077`.

A fresh 1MCP launch suppresses the duplicate console stream after native file logging is configured and removes the legacy runtime `one-mcp.log` append file. `scripts/smoke-local.sh` requires the generated `config.toml`, so after upgrading an existing installation re-render/bootstrap the deployment before the first restart. If startup health fails, the lifecycle helper prints a bounded tail from the native log when available.
