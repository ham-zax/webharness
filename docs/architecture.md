# Architecture

## Runtime path

```text
MCP client (ChatGPT / Claude / Gemini)
  -> HTTPS + OAuth -> Cloudflare Tunnel
  -> loopback wake-proxy (MCP_ONE_MCP_PORT, default 3050; connector-policy.yaml)
  -> on-demand 1MCP (BRIDGE_BACKEND_PORT, default 3060)
       |-- Dev    (lightweight facade + expendable execution worker)
       `-- Local  (tag:local; 5 broker tools -> DirectLocalServerPool)
                    |-- dev              hidden fallback-only mirror
                    |-- terminal         Unix socket -> broker -> tmux PTYs
                    |-- host             Windows host actions (pc_sleep)
                    |-- skill-library    local BM25 + policy-checked Markdown
                    |-- browser-fast     Agent Browser 0.43.0 (+ CloakBrowser 0.7.2)
                    |-- browser-daily    optional stdio proxy to paired browse relay
                    `-- browser-devtools Chrome DevTools MCP facade
```

1MCP is the single public MCP gateway; Cloudflare supplies HTTPS ingress; all providers run as local stdio processes. See [MCP Compatibility](compatibility.md) for the model-facing contract.

## Capability boundaries

### Dev (`providers/pi-dev/`)

Dev splits into a lightweight schema/instruction/`wait` facade and an on-demand Pi execution worker (evicted after `MCP_DEV_WORKER_IDLE_MS`, never interrupting active calls).

- **Files & Git:** `read` (16 KiB/file, default 160 lines, `mode="outline"`, up to 20 `targets`), `search` (structured ripgrep, vendor exclusions), `list_directory` (pinned `/proc/self/fd` tree, no symlink following), `edit` (multi-file grouped replacement with exact-first + unique tolerant fallback and nearest-match hints), `write` (staged + SHA-256 verified receipts, see [Reliability](reliability.md)), `import_file` (create-only ChatGPT attachment stream), `file_ops` (same-FS move/delete for regular files), and `review_changes` (bounded read-only Git diff for working tree or `rev`).
- **Execution & Waits:** Shell-free `exec(argv[])` and native `bash` are short-RPC execution paths (~45s connector target; `detach: true` handles background jobs within the service cgroup). `wait` persists durable readiness checks (`terminal_output`, `terminal_exit`, `process_exit`, `tcp_listen`, `file_exists`, `file_changed`, `http_ready`, `systemd_user`, `timer`) independently of `terminal_read` cursors.
- **`run_script`:** Sandboxed QuickJS VM in a worker thread (256 MiB cap, max 4 concurrent scripts, no FS/net/timers). Exposes only the profile's Dev tools minus `run_script`, `wait`, and `import_file` (max 32 calls, up to 4x parallel reads, serialized mutations per script, 30s default / 120s max). Nested calls are real and never rolled back on later failure.

### Local broker (`providers/local-tools/`)

Exposes exactly five outer tools under `tag:local`: `tool_list`, `tool_schema`, `tool_call`, `fallback_dispatch`, and `tool_batch`.

- **`DirectLocalServerPool`:** Supervises each downstream stdio server directly (no second 1MCP process). Wakes only the addressed server on first scoped request and evicts idle servers independently after `MCP_LOCAL_INNER_IDLE_MS` (default 30m). Unscoped `tool_list` reads config without waking any provider.
- **Hidden Dev mirror:** `MCP_LOCAL_FALLBACK_ONLY_SERVERS=dev` keeps Dev out of unscoped `tool_list`, `tool_call`, and `tool_batch`. Explicit `tool_list(server="dev")` / `tool_schema(server="dev", ...)` allow inspection, and `fallback_dispatch` executes single calls or heterogeneous `calls[]` batches (`sequential: true` or bounded concurrency) across Dev and Local.
- **Honest annotations & per-client shim:** The broker advertises mutating annotations on `fallback_dispatch`. When `connector-policy.yaml` matches a client with `compat_annotations: true`, `wake-proxy` rewrites `tools/list` annotations to read-only for that client only without changing authority.
- **Failure semantics:** Owner stdio servers default to `restartOnExit: true`. A failed call is never auto-replayed because downstream side effects may be ambiguous.

### Terminal (`providers/terminal/`)

```text
Terminal MCP -> Unix socket -> broker (metadata, transcripts, cursors, human leases) -> tmux PTY
                                  `-> optional frontend (Kitty/WSLg or Windows Terminal via wsl-term present)
Dev wait -> private broker observation -> independent wait cursor
```

`tmux` owns PTY/process lifetime; the broker owns transcripts and human/model control leases; GUI frontends are pure presentation adapters. Retained dead panes finalize `pipe-pane` cleanly so writers exit on EOF.

### Browser (`browser-fast`, `browser-devtools`, `browser-daily`)

- **`browser-devtools`:** Full Chrome DevTools MCP catalog plus `browser_target`, `browser_backend`, `browser_profile` routing.
- **`browser-fast`:** Compact `observe`/`execute`/`inspect` over Agent Browser `0.43.0` (Windows and Linux) and managed CloakBrowser `0.7.2` (Linux humanized input, coalesced per-profile startup, concurrent tabs, serialized same-tab execution). Loads bounded read-only exact-host/platform browser memory (`~/.config/mcp-dev-bridge/browser-memory/`) and allowlisted file uploads (`browser-artifacts.json`). Learning (`propose`/`promote`) stays Dev-only.
- **`browser-daily`:** Optional transparent stdio proxy to `browse mcp` (`opencode.ai/browse`), driving the user's already-open browser without owning any browser process.
- **Windows vs. Linux isolation:** Windows automation uses `%LOCALAPPDATA%\mcp-dev-bridge\chrome-profile` (or `chrome-profiles\<name>`) on ephemeral loopback `DevToolsActivePort` via a one-shot Node helper so daemon startup cannot hold WSL interop pipes open. Everyday Chrome is never copied or launched.

### Skill library (`providers/skill-library/`) & Host (`providers/pi-dev/host-server.mjs`)

- **`skill-library`:** Read-only BM25 discovery (`find_skills`) and revision-verified UTF-8 reads (`read_skill`) over `skill-library/policy.json` with zero external model dependency by default.
- **`host`:** Personal-only Windows `pc_sleep` with explicit `confirm: true` and optional Windows Task Scheduler `WakeToRun`.

## Optional WebSession HTTP transport

`providers/websession-adapter/` runs separately in front of 1MCP for non-MCP HTTP sandboxes. `POST /v1/pair` redeems reusable codes for finite bearer tokens with optional default cwd; `POST /v1/batch` admits up to 20 calls atomically in SQLite (concurrent reads, serialized mutations; atomic admission, not filesystem rollback). See [WebSession clients](websession-clients.md).

## State, lifecycle & profile boundaries

- **State roots:** Bridge persistent state in `${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge`, runtime in `${XDG_RUNTIME_DIR:-/run/user/$UID}/mcp-dev-bridge`; Terminal state in `wsl-agent-terminal` and socket at `wsl-agent-terminal.sock`.
- **Supervision:** `mcp-dev-bridge.service` runs the foreground watchdog supervising `wake-proxy` and `cloudflared`; 1MCP holds a kernel `flock` lease. Terminal runs as two separate units (`wsl-agent-tmux.service` + `wsl-agent-terminal-broker.service`).
- **Profile separation:** `restricted` and `trusted-dev` never inherit Local, Terminal, Host, or Browser. `server` deploys independently on headless Linux/ARM with its own tunnel and OAuth state (see [Headless Server](headless-server.md)).
