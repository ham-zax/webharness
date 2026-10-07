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
MCP_DEV_MAX_OUTPUT_BYTES=65536
MCP_DEV_READ_DEFAULT_LINES=500
MCP_DEV_IMPORT_MAX_BYTES=104857600
MCP_DEV_MAX_SPOOL_BYTES=67108864
MCP_DEV_SPOOL_TTL_SECONDS=604800
MCP_DEV_SPOOL_MAX_TOTAL_BYTES=536870912
MCP_ONE_MCP_PORT=3050
MCP_ONE_MCP_LOG_MAX_SIZE_BYTES=10485760
MCP_ONE_MCP_LOG_MAX_FILES=5
MCP_PERSONAL_DEFAULT_CWD=
MCP_TERMINAL_FRONTEND=kitty
MCP_OWNER_CONTEXT_FILE=
MCP_OWNER_ENV_FILE=
MCP_BROWSER_JEV_ENV_FILE=
MCP_LOCAL_SERVERS_FILE=
```

`MCP_PUBLIC_URL` is the externally reachable HTTPS MCP origin. `MCP_ONE_MCP_PORT` selects the loopback 1MCP listener port and defaults to `3050`. Set Cloudflare's origin service to the same port. This is useful when WSL mirrored networking reserves the default port on the Windows host.

`MCP_TUNNEL_NAME` controls only the locally-managed Cloudflare startup command. Empty/unset, as on the maintained workstation, runs `cloudflared tunnel run` and relies on the operator-owned default `~/.cloudflared/config.yml` for tunnel identity. A non-empty value runs `cloudflared tunnel run <name>`. That named selector is implemented but is not the maintained workstation path.

OpenAI Secure MCP Tunnel is a separate possible transport for a ChatGPT developer-mode app: an OpenAI-hosted tunnel endpoint talks to `tunnel-client` inside the private network, which can forward to the loopback MCP server without public ingress. WebHarness does not currently own that client, its tunnel identity/runtime credential, its service lifecycle, or the required OpenAI organization/workspace association. See [Getting Started](getting-started.md#provision-the-cloudflare-transport-used-by-the-reference-deployment).

`MCP_PERSONAL_DEFAULT_CWD` is optional and applies to the `personal` and `server` profiles. Leave it empty/unset to use the Linux account's `$HOME`. `MCP_TERMINAL_FRONTEND` is also personal-only: unset/empty defaults to `kitty`, and the accepted values are `kitty` and `windows-terminal`. The renderer validates this selector only for `personal`, so a stray value does not break `restricted` or `trusted-dev`.

`MCP_OWNER_CONTEXT_FILE` and `MCP_OWNER_ENV_FILE` are optional personal-profile references to owner-controlled files outside the repository. Both paths must be absolute when set. `pi-dev` requires the context file to be a readable, current-user-owned regular file no larger than 32 KiB and publishes non-empty content as MCP initialization instructions. The renderer requires the env file to be a readable, current-user-owned regular file no larger than 64 KiB and permits only `GALLIUM_DRIVER`, `MOZ_ENABLE_WAYLAND`, `AGENT_BROWSER_PROFILE`, `AGENT_BROWSER_EXECUTABLE_PATH`, and `MCP_BROWSER_DEFAULT_TARGET`. The Agent Browser settings are Linux `browser-fast`-only; the executable path must be absolute and executable. `MCP_BROWSER_DEFAULT_TARGET` must be `windows` or `linux` and is rendered into all three browser servers. Generated `owner.env` still contains only the validated Dev/Terminal GUI variables, so Agent Browser settings are not imported into systemd service environments. Do not put trust policy or secrets in `.env` or the owner GUI env.

`MCP_BROWSER_JEV_ENV_FILE` is an optional personal-profile path to browser-jev's server-side model environment. It must be an absolute, readable, current-user-owned regular file no larger than 64 KiB. Only `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, `TEXT_MODEL_API_KEY`, `TEXT_MODEL_BASE_URL`, `TEXT_MODEL`, and `TEXT_MODEL_REASONING` are accepted, and `TYPESAFE_API_KEY` must be non-empty. The private mode-`0600` generated Local config contains only this path, never the file's values; browser-jev validates the file again when each worker starts. Keep the source file outside Git with owner-only permissions. `TEXT_MODEL_API_KEY` is needed only if the run selects `TYPE_TEXT`.

`MCP_LOCAL_SERVERS_FILE` is an optional Personal or Server profile reference to a current-user-owned JSON file outside the repository. It accepts a standard `{"version":"1.0.0","mcpServers":{...}}` object and merges those servers into the private Local inner 1MCP beside the built-in Terminal, Host, and Browser surfaces plus the fallback-only Dev mirror. Extra servers are explicit owner grants: names cannot replace built-ins or use the retired `code`/`codedb` routes, each server is limited to optional `type: "stdio"`, `command`, optional string `args`, optional absolute `cwd`, optional string-valued `env`, and optional boolean `restartOnExit`; `command` must be an existing absolute executable path and `cwd`, when set, must be an existing directory. Owner stdio servers render with explicit `type: "stdio"` and `restartOnExit: true` by default so 1MCP supervises unexpected backend exits; set `restartOnExit: false` only when an intentionally non-restarting MCP lifecycle is required. The source file is capped at 128 KiB; the rendered Local inner config remains private mode `0600`. Values under `env` are copied into that private rendered config, so keep credentials there only when a downstream MCP actually requires them.

Linux `browser-fast` reads the current-user-owned `~/.config/mcp-dev-bridge/browser-fast.json` as its default/backend-profile policy. Outside the Personal Workstation bootstrap, missing configuration preserves managed Chrome. The Personal bootstrap installs the maintained V2 `clearcote` / `x-main` policy when the file is missing and migrates only known maintained predecessors: the legacy V1 `clearcote` selector on fixed port `9222` and the prior tracked V2 Chrome+x-main template. Other owner-managed files are preserved, including V1 external Clearcote configurations on other ports. Migration uses unique temporary files plus atomic replacement rather than a persistent lock, so concurrent bootstrap/configuration agents converge without stale-lock ownership. V2 can define named managed Clearcote profiles; the maintained workstation uses `x-main` as its normal Linux default. Individual calls may select `browser_backend="chrome"` or `browser_backend="clearcote"` without rewriting the shared selector. An explicit `browser_profile` with the Chrome backend creates or reuses a persistent isolated bridge-state profile; with Clearcote it selects a profile already defined in the catalog. Linux requires an explicit backend whenever a profile is supplied. Managed Clearcote runtimes are owned per profile, and concurrent startup of the same profile is coalesced in-process. Managed Clearcote no-tab observations allocate independent tab workspaces after the first claim. The returned target/backend/profile/tab tuple should be reused for continuation. Firefox is not supported by the current Chromium-CDP driver and fails explicitly rather than falling through to Chrome.

## Profiles

### `restricted`

- Dev Files: workspace-bounded `read`, `edit`, `write`.
- Shell: separate allowlisted legacy shell.
- No Local provider, so Terminal, Host, and Browser logical servers are absent.

### `trusted-dev`

- Dev Files: workspace-bounded `read`, `edit`, `write`.
- Dev execution: unrestricted shell-free `exec(argv[])` and native Bash as the Linux service user.
- No Local provider, so Terminal, Host, and Browser logical servers are absent.

### `personal` — Personal Workstation

The maintained full reference composition is:

```text
Dev       read edit write import_file file_ops review_changes wait exec bash
Local     tool_list tool_schema tool_call fallback_dispatch tool_batch
            |-- terminal          durable PTY/session control
            |-- host              pc_sleep
            |-- browser-fast      routine observe/execute interaction
            |-- browser-jev       stateful TypeSafe browser-agent loop
            `-- browser-devtools  Chrome DevTools diagnostics
```

The renderer resolves one absolute personal default cwd from `MCP_PERSONAL_DEFAULT_CWD` when supplied, otherwise from the actual WSL user's `$HOME`, and uses it for direct Dev. No tracked personal profile/template carries a machine-specific home path. Personal Dev also exposes create-only `import_file` for ChatGPT-native files and read-only `review_changes` for bounded aggregate Git review. `MCP_DEV_IMPORT_MAX_BYTES` controls the per-file import ceiling, defaults to 104857600 bytes (100 MiB), and is capped at 1073741824 bytes (1 GiB). Dev `exec` passes `argv[]` directly to an executable without shell parsing; Dev `bash` remains the explicit shell-program path when pipes, redirects, substitutions, variables, loops, or compound shell syntax are required. Terminal communicates through the WebHarness broker socket and receives one normalized `MCP_TERMINAL_FRONTEND` presentation preference; tracked source keeps `kitty` as the compatibility default while a local deployment may select `windows-terminal`.

For personal rendering, the outer config contains only `dev` and `local`. The outer `local` provider is tagged only `local` and points at the repository Local broker. The renderer atomically materializes a Local inner config at the bridge state root containing built-in `terminal`, `host`, `browser-devtools`, `browser-fast`, and `browser-jev` servers, any explicitly configured `MCP_LOCAL_SERVERS_FILE` entries, and one fallback-only mirror of the fully rendered outer Dev provider. Terminal receives the same socket/frontend and validated owner runtime environment that its former outer provider received. `MCP_LOCAL_FALLBACK_ONLY_SERVERS=dev` keeps the Dev mirror out of unscoped Local discovery and ordinary `tool_call`/`tool_batch`. Explicit read-only recovery inspection may still use `tool_list(server="dev")` and `tool_schema(server="dev", tool=...)`; `fallback_dispatch` is the only Local execution path that can target Dev. The inner config is written before publishing the outer config so config reload cannot start Local against a missing file, and the outer Local provider receives a deterministic revision of the rendered inner config so a real downstream configuration change restarts only Local through 1MCP hot reload rather than requiring a full WebHarness restart. The broker keeps 1MCP's reload management action private for targeted recovery and never exposes the reserved `1mcp` namespace through Local.

The Local broker starts its inner 1MCP (and therefore every inner provider process) on demand at the first scoped `tool_list`, `tool_schema`, `tool_call`, `fallback_dispatch`, or `tool_batch` request, and stops it after `MCP_LOCAL_INNER_IDLE_MS` milliseconds with no in-flight request (default 1800000, 30 minutes; `0` disables idle stop while keeping lazy start; a negative or non-integer value fails broker startup). The next request transparently starts a fresh inner. The renderer validates this variable and explicitly passes it into the outer Local provider environment. Unscoped discovery reads configured server names without waking the backend; unscoped `available` and `toolCount` are `null` because readiness and counts are not queried, and `backendState` reports the shared inner lifecycle rather than individual provider health. Active Jev run leases prevent idle eviction until the run is closed. Other inner provider state may be lost when evicted; Terminal PTY sessions survive because the Terminal broker is a separate systemd process.

`browser-devtools` is the full Chrome DevTools MCP facade for diagnostics and rich results; `browser-fast` exposes only `observe` and `execute` for routine interaction; `browser-jev` exposes the four-step stateful Jev run lifecycle. All three resolve the maintained managed-browser identities. Browser-jev creates an independent background target, resolves the endpoint at each start, and never launches an inactive Clearcote profile; initialize that profile once through browser-fast. It accepts only declarative non-empty success checks, requires all of them before accepting Jev `DONE`, and never accepts selectors, code, or model keys as tool arguments. On Windows, profileless calls share the dedicated MCP Chrome process. On Linux, `browser-fast.json` defines the default and Clearcote profile catalog, and each call can select Chrome or Clearcote without mutating that file. The everyday Chrome data directory is not attached or copied. The tracked templates carry generic WSLg plumbing; `GALLIUM_DRIVER`, `AGENT_BROWSER_PROFILE`, `AGENT_BROWSER_EXECUTABLE_PATH`, and `MCP_BROWSER_DEFAULT_TARGET` are mirrored to browser-fast and browser-jev where configured; `GALLIUM_DRIVER` and `MCP_BROWSER_DEFAULT_TARGET` also reach browser-devtools. All three browser surfaces remain behind the same `tag:local` authorization boundary.

Local `server="host"` registers `pc_sleep` only for the Personal Workstation composition and uses Windows Task Scheduler for an optional wake time. Repository discovery uses Dev `exec` with `rg` and focused `read`.

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

`MCP_DEV_READ_DEFAULT_LINES` controls how many lines Dev `read` returns when no `limit` is supplied (default 500, range 0..100000). Set it in the deployment environment or `.env`; the renderer carries it into every Dev provider, including the Personal fallback mirror. `0` disables this default line limit; the reader's 2000-line ceiling and 16 KiB text-content budget still apply. An explicit `limit` overrides the default line count. Truncated reads report total file bytes and the next line offset; complete lines are preserved. An individual line larger than the byte budget returns a diagnostic recommending a focused command extract. Binary and invalid UTF-8 files are rejected.

`MCP_DEV_MAX_OUTPUT_BYTES` is deployment policy, not a model-facing tool argument. It defaults to 65536 bytes: a command result shows the output tail within that budget and, when it truncates, reports the total observed byte count and a retained-output path. Retained output has its own storage ceiling described below. Commands append a compact status/timing footer such as `[exit 0 · 0.3s]`; timeout, cancellation and termination are distinguished from normal exits. Increase the output budget only when the operator deliberately wants larger model-visible results.

Local `terminal_read` has a separate model-facing `max_bytes` argument (default 16384, range 1..65536), subject to the broker's configured ceiling. A transcript read advances the persisted model cursor only past the returned bytes; if more remain, the result reports continuation cursors. Repeat the same read to retrieve the next page. A budget too small for the next UTF-8 character reports no progress and asks for a larger budget. `snapshot=true` bounds the screen locally, marks truncation, and never advances the transcript cursor.

`MCP_DEV_IMPORT_MAX_BYTES` controls Personal `import_file`; it defaults to 104857600 bytes (100 MiB), is capped at 1073741824 bytes (1 GiB), and is enforced while the native file stream is read.

Pi Dev also bounds retained Bash diagnostics independently of the model-visible tail. `MCP_DEV_MAX_SPOOL_BYTES` is an internal deployment/provider limit with a 64 MiB default and a 256 MiB maximum; the renderer propagates it into the Dev provider environment but it never appears as a model-facing MCP tool argument. `MCP_DEV_SPOOL_TTL_SECONDS` defaults to 604800 seconds (7 days), and `MCP_DEV_SPOOL_MAX_TOTAL_BYTES` defaults to 536870912 bytes (512 MiB) and must be at least the per-spool cap. Finalized spools are pruned on provider startup and opportunistically after every Bash command: expired files are removed, legacy oversized files are capped, and the oldest finalized files are evicted until the aggregate budget is satisfied. Active `.log.active` spools are excluded from GC. When command output exceeds the per-spool cap, `output_bytes` still counts the full observed stream, the model still receives the configured bounded tail, and any retained-output file is explicitly labeled as capped rather than complete.


## 1MCP log policy

1MCP application logging uses the pinned runtime's native Winston file transport rather than an unbounded shell `>>` capture. The renderer writes a structured `[logging]` block to `1mcp/config.toml` and keeps the log under the private bridge state directory. `MCP_ONE_MCP_LOG_MAX_SIZE_BYTES` defaults to 10485760 bytes (10 MiB) and is constrained to 1..64 MiB; `MCP_ONE_MCP_LOG_MAX_FILES` defaults to 5 and is constrained to 1..10. The pinned runtime installer forces restart-stable tailable Winston rotation when more than one file is retained, and bridge startup removes numeric siblings left by the older incrementing mode beyond the configured file count. The parent `logs/` directory is mode 0700, and bridge startup uses `umask 077`.

A fresh 1MCP launch suppresses the duplicate console stream after native file logging is configured and removes the legacy runtime `one-mcp.log` append file. `scripts/smoke-local.sh` requires the generated `config.toml`, so after upgrading an existing installation re-render/bootstrap the deployment before the first restart. If startup health fails, the lifecycle helper prints a bounded tail from the native log when available.

## On-demand runtimes

`BRIDGE_COLD_START` defaults to `1`. The loopback wake proxy listens on `MCP_ONE_MCP_PORT` (3050 by default); 1MCP uses `BRIDGE_BACKEND_PORT`, which defaults to the public port +10. The two ports must be different, available, and in 1..65535. Existing Cloudflare ingress keeps using the public port. Set `BRIDGE_COLD_START=0` to run 1MCP continuously on the public port.

`BRIDGE_WAKE_IDLE_MS` defaults to 600000 (10 minutes) and must be positive. Real requests wake 1MCP; `/health/ready` and `/health/live` do not. Active requests, streams, and stateful run leases prevent eviction. Failed startup returns an error and is not reported as readiness; the next request may retry startup, but the proxy never replays a dispatched operation.

`MCP_DEV_WORKER_IDLE_MS` defaults to 600000 (10 minutes); `0` disables worker eviction. Dev publishes its schemas and owner instructions without loading Pi execution code. Actual execution starts an expendable worker; durable `wait` remains in the lightweight facade so its hold budget does not include worker startup. In-flight calls keep the worker alive. Both idle settings are deployment policy, not tool arguments.

`MCP_LIFECYCLE_LEASE_DIR` is rendered beneath the bridge runtime root. Jev runs hold private PID/start-identity leases across RPCs and release them after worker cleanup. Both Local and the outer proxy consult the leases before idle shutdown. Terminal broker and tmux lifetime remain separate. CodeDB is no longer installed or exposed by WebHarness; existing operator installations and indexes are left untouched.

## Independent headless server

The `server` profile keeps Dev, the Local broker, and Terminal while excluding desktop providers and WSL GUI environment. It uses separate deployment environment and OAuth/runtime state on the server. See [Headless Server](headless-server.md) for tunnel and private approval setup.
