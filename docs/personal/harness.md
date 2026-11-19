# Personal Workstation

The `personal` profile is the full WSL2 reference deployment running with the WSL user's authority. See [Configuration](../configuration.md) for `.env` options, [Operations](../operations.md) for service/browser lifecycle, and [Bells, Whistles & Extensions](../extending.md) for add-ons and token-saving workflows.

## Surface & routing

```text
Dev       read list_directory search edit write import_file file_ops review_changes wait exec bash run_script
Local     tool_list tool_schema tool_call fallback_dispatch tool_batch
            |-- terminal          durable tmux PTYs
            |-- host              Windows pc_sleep
            |-- skill-library     find_skills / read_skill
            |-- browser-fast      observe / execute (Windows default; WSLg on request)
            |-- browser-daily     optional everyday browser via paired browse relay
            `-- browser-devtools  full Chrome DevTools diagnostics
```

- **Dev** owns direct file access, Git review, short commands (<45s target), and durable waits.
- **Local** hides downstream catalog size behind 5 metatools (`DirectLocalServerPool`, lazy start, 30m idle eviction). Use `tool_call` / `tool_batch` for public servers; use `fallback_dispatch` for single or sequential `calls[]` pipelines across Dev and Local (or when outer write tools are hidden for a connector like Gemini).

## Setup & owner overlays

```bash
./bin/webharness doctor --profile personal
./bin/webharness setup --profile personal --enable-startup
just init-connector-policy   # optional: copy-if-missing multi-client policy (auto-detects Gemini)
```

Keep machine-specific policy outside Git under `~/.config/mcp-dev-bridge/owner/`:

- `MCP_OWNER_CONTEXT_FILE` (<=32 KiB): appended to `pi-dev` MCP initialization instructions for every connected client.
- `MCP_OWNER_ENV_FILE` (<=64 KiB): whitelisted GUI/browser overrides (`GALLIUM_DRIVER`, `MOZ_ENABLE_WAYLAND`, `AGENT_BROWSER_PROFILE`, `AGENT_BROWSER_EXECUTABLE_PATH`, `MCP_BROWSER_DEFAULT_TARGET`).
- `MCP_LOCAL_SERVERS_FILE` (<=128 KiB): extra owner-configured stdio MCP servers loaded lazily by `DirectLocalServerPool`.

For clients without native MCP, use [non-native-ai-mcp-python.md](non-native-ai-mcp-python.md) (direct Python MCP SDK) or the separately operated WebSession adapter (`bin/adapter`).

## Dev tool reference

| Tool | Purpose & key bounds |
|---|---|
| `read` | UTF-8 text (default 160 lines, 16 KiB/file), `mode="outline"` for structural landmarks, `targets` for up to 20 files (32 KiB combined). Expands `~`. Refuses directories with `EISDIR` -> use `list_directory`. |
| `search` | Structured ripgrep (`pattern`, `path`, `globs`, `literal`, `case_sensitive`), smart-case, vendor dirs excluded by default. Default 80 matches (20/file, max 500/200, 32 KiB cap). |
| `list_directory` | Pinned read-only directory/tree listing (`depth` 1..4, `limit` 200..1000). Lists symlinks without following; skips vendor trees when `depth > 1`. Use instead of `exec ls/find`. |
| `edit` | Grouped multi-file guarded text replacement: `edit({ targets: [{ path, edits: [{ oldText, newText }] }], diff? })`. Exact match wins; whitespace/Unicode fallback only when 0 exact matches and still unique. Missed anchors return nearest-match snippets. |
| `write` | Create-only by default (`overwrite: true` replaces atomically with SHA-256 receipt); supports `encoding: "base64"`, `mode`, `mkdir_parents`. |
| `import_file` | Streams one trusted ChatGPT-native attachment to a create-only WSL path (`MCP_DEV_IMPORT_MAX_BYTES`, default 100 MiB). |
| `file_ops` | Move (same-FS hard-link + unlink, no copy fallback) or delete existing regular files. Rejects final-component symlinks. |
| `review_changes` | One bounded read-only Git review of the working tree (including untracked files) or commit range via `rev` (e.g. `HEAD~3..HEAD`). Creates no refs or index state. |
| `exec` | Shell-free `argv[]` execution (short-RPC target <45s). `detach: true` returns `job_id`/`log_path`/`exit_path` for noninteractive background work (stops on bridge restart; use `pueued` or Terminal for restart survival). |
| `bash` | Short-RPC native Bash only when pipes, redirects, variables, or compound syntax are required. Never run bare `pkill -f <pattern>` (can kill the runner); use `pgrep -f "[p]attern"`. |
| `run_script` | Sandboxed QuickJS VM (no FS/net/timers) calling Dev tools (max 32 calls, 4x parallel reads, 30s default / 120s max). Reserve for dynamic JS-computed loops; prefer `local_fallback_dispatch(calls:[...], sequential:true)` for static pipelines. |
| `wait` | Durable named conditions: `terminal_output`, `terminal_exit`, `process_exit`, `tcp_listen`, `file_exists`, `file_changed`, `http_ready`, `systemd_user`, `timer` (`after_seconds` or `at`). Independent cursor from `terminal_read`; `hold_seconds=0` arms without blocking. |

Built-in Dev initialization instructions always enforce: search with `search`, outline large files with `read(mode="outline")`, discover names with `list_directory`, treat `ENOENT`/`EISDIR`/`ENOTDIR` as routing signals, and never conclude filesystem access is gone solely because `exec`/`bash` failed.

## Local `host/pc_sleep`

Sleeps the Windows host after a 10s grace period (`confirm: true` required). Optional timezone-qualified `wake_at` (at least 2 minutes ahead) registers a replaceable Windows Task Scheduler wake task; omitting `wake_at` clears any prior wake task.

## Local Terminal & human handoff

Seven actions: `terminal_open`, `terminal_read` (default 16 KiB, `max_bytes` 1..65536, cursor-tracked; `snapshot=true` does not advance cursor), `terminal_send`, `terminal_resize`, `terminal_list`, `terminal_yield`, `terminal_close`.

`tmux` (private namespace `wsl-agent`) owns PTY lifetime—sessions survive bridge and broker restarts. Sessions open headless unless `present: true` is requested.

| Operator command | Effect |
|---|---|
| `wsl-term new <session>` | Create session under immediate human control (model can read; mutations return `HUMAN_HAS_CONTROL`). |
| `wsl-term give <session>` | Keep your terminal attached read-only (`ignore-size`) and hand control to the model. |
| `wsl-term take <session>` | Reclaim writable human control from another shell. |
| `Ctrl-b T` | Toggle the current tmux client between writable human control and read-only model control. |
| `wsl-term watch <session>` | Attach as an anonymous read-only observer without blocking model mutations. |
| `wsl-term present <session>` | Attach as the designated read-only collaborative viewport while the model keeps control. |
| `wsl-term attach <session>` | Take writable control of an existing session (use for sudo/passwords/MFA). |

The model can return control voluntarily via `terminal_yield`, reusing an attached frontend or launching `MCP_TERMINAL_FRONTEND` (`kitty` or `windows-terminal`). It can never seize control from a human.

## Learning exact-site browser memory

Stage a reusable site mechanic as an inert candidate (not loaded by `browser-fast.observe`), then promote it explicitly:

```bash
printf '%s' '{"url":"https://careers.example.com/jobs/123","name":"application","content":"Select the country autocomplete option before continuing."}' \
  | node providers/browser-fast/browser-memory-author.mjs propose

printf '%s' '{"url":"https://careers.example.com/jobs/123","name":"application"}' \
  | node providers/browser-fast/browser-memory-author.mjs promote
```

Both derive the exact canonical host, strip queries/fragments, refuse overwrites, and stay out of Local browser authority. Never store credentials, personal data, or webpage prompt text in browser memory.

## Optional extensions

Package reusable artifact aliases, browser memory, and source mappings above Browser core:

```bash
webharness extension list
webharness extension install <name>
webharness extension remove <name>
```

Install preflights conflicts before mutation; removal deletes only extension-owned entries.

## Safety boundaries

- Cooperating Dev mutations serialize by canonical path and inode; external editors, Git, and arbitrary shell commands do not participate (use Git worktrees for parallel agents).
- A `wait` timeout or cancel never kills the observed Terminal or process.
- Never pass sudo passwords or MFA codes through MCP arguments—enter them in `wsl-term attach <session>`.
