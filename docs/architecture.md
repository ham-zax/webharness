# Architecture

## Runtime path

```text
ChatGPT
  -> HTTPS + OAuth
Cloudflare Tunnel
  -> loopback origin
1MCP :3050
  -> Dev
  -> Code       (Personal Workstation)
  -> Terminal   (Personal Workstation)
  -> Local      (Personal Workstation, tag:local)
       -> inner 1MCP
            |-- browser-fast
            `-- browser-devtools
Linux / WSL host
```

1MCP is the single public MCP gateway in the maintained reference deployment. Cloudflare supplies HTTPS transport; providers remain local stdio processes. The model-facing compatibility contract is documented in [MCP Compatibility](compatibility.md).

## Capability boundaries

### Dev

Dev owns Files, native Bash, regular-file topology operations, durable waits, and the personal Windows-host sleep boundary.

Personal surface:

```text
read edit write file_ops wait bash pc_sleep
```

`edit` owns guarded mutation of existing text across one or more files. One exact `oldText` match always wins; only zero exact matches trigger tolerance for line endings, trailing whitespace, and common Unicode punctuation or space differences, and the fallback must still be unique. Exact and tolerant edits sharing a line must be merged. Callers inspect with `read`, `rg`, Code, or ast-grep and include enough context when needed. `write` owns new text-file creation, and `file_ops` owns move/delete for existing regular files. Syntax-shaped discovery/codemods use ast-grep through Bash and normally feed guarded `edit`; an existing authoritative `.patch`/`.diff` artifact uses native `git apply --check -- "$patch" && git apply -- "$patch"`.

`wait` owns durable named wait state and generic local readiness checks. Terminal-specific waits use private broker transcript/session observations, but `wait` is not a Terminal MCP action.

`pc_sleep` is personal-only. It requires explicit confirmation, optionally registers one replaceable Windows Task Scheduler `WakeToRun` task, returns an acknowledgement, and then asks Windows to enter sleep after a short grace period. It does not provide on-demand wake while the host is already asleep.

### Code

Code owns:

```text
code_search code_context code_symbol
```

The router resolves the nearest canonical Git root for the requested cwd and keeps one correctly rooted CodeDB child per active repository. Per-call project switching and the raw CodeDB catalog are hidden from the model-facing surface. First use may start a persistent CodeDB child and create or update substantial on-disk index state, so Code is not a cost-free read abstraction; on large or unfamiliar repositories with unknown CodeDB state, start with Dev Bash/`rg` plus focused `read` unless indexing-backed repository intelligence is specifically needed. This is model-routing guidance, not an enforced size threshold.

### Terminal

Terminal owns exactly seven actions:

```text
terminal_open terminal_read terminal_send terminal_resize terminal_list terminal_yield terminal_close
```

tmux is the PTY/process lifetime authority. A separate broker owns session metadata, transcripts, model cursors, generation identity, and human/model control leases. Each live pane streams transcript bytes through `pipe-pane`; when a retained pane dies, a pane-local finalizer closes that pipe with real EOF and restores the same dead pane state so the transcript writer exits instead of remaining attached for the lifetime of the retained session. A personal frontend helper owns presentation only: it may launch Kitty under WSLg or Windows Terminal through WSL re-entry, and either path attaches to the exact existing tmux session through `wsl-term present`. MCP owns the agent interface, broker owns authority, tmux owns lifetime, and the frontend never becomes a process-lifetime owner.

## Durable Terminal data flow

```text
Terminal MCP -> Unix socket -> broker -> tmux pane / transcript
      |                  |
      |                  +-> generation + model cursor + human lease
      |
      +-> frontend.mjs
            |-> Kitty / WSLg -> wsl-term present -> exact tmux PTY
            `-> Windows Terminal / wsl.exe
                     `-> wsl-term present -> same tmux PTY

Dev wait -> private broker observation -> independent wait cursor
```

Normal Terminal reads and output waits therefore do not consume each other's cursor. The GUI path is presentation only: normal Terminal sessions remain headless by default, and a designated read-only frontend keeps model mutation/resize authority until control is explicitly yielded to the human.

## State boundaries

By default:

```text
bridge persistent state  ${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge
bridge runtime state     ${XDG_RUNTIME_DIR:-/run/user/$UID}/mcp-dev-bridge
Terminal state           ${XDG_STATE_HOME:-$HOME/.local/state}/wsl-agent-terminal
Terminal broker socket   ${XDG_RUNTIME_DIR:-/run/user/$UID}/wsl-agent-terminal.sock
```

1MCP receives one external writable application root because its config, PID, and OAuth/session data live together beneath that root.

## Lifecycle boundaries

The bridge supervises one config-scoped 1MCP process, one cloudflared process, and one watchdog. Lifecycle operations use an exclusive lock and validated process ownership.

Personal Workstation Terminal lifetime is split into two user services:

```text
wsl-agent-tmux.service             PTY/process lifetime
wsl-agent-terminal-broker.service  broker/transcript/control state
```

Restart the broker without restarting tmux when only broker/provider code changes.

### Local tool broker

Personal Workstation local capabilities are model-facing through one `local` provider under `tag:local`. Browser capabilities are logical servers behind it. The provider exposes exactly:

```text
tool_list tool_schema tool_call
```

The Local broker owns stable logical `{server, tool}` routing and connects over stdio to an inner 1MCP running in normal direct mode. V1 keeps no broker catalog/schema cache: discovery and schema lookup consult current inner `tools/list`, while `tool_call` dispatches the qualified inner tool directly and returns the downstream `CallToolResult` unchanged. Discovery is bounded with an opaque self-contained cursor; downstream catalog churn does not change the outer three-tool surface.

### Browser

The Local inner 1MCP publishes two browser surfaces in the same `tag:local` trust domain:

```text
Local
  +-- server="browser-devtools" -> Chrome DevTools MCP facade
  |    +-- windows (default) -> dedicated persistent MCP Chrome profile
  |    `-- linux             -> managed visible Chrome through WSLg
  `-- server="browser-fast" -> compact observe/execute facade
       +-- windows (default) -> pinned native Agent Browser 0.35.0 -> same MCP Chrome profile
       `-- linux             -> selected backend: managed Chrome or managed Clearcote
```

`browser-devtools` keeps the complete Chrome DevTools MCP catalog for network, console, performance, Lighthouse, heap, screenshots, and detailed debugging. It adds `browser_target`, strips that field before forwarding, and returns downstream `CallToolResult` objects unchanged.

`browser-fast` is an experimental routine-interaction surface with only `observe` and `execute`. `observe` returns compact interactive refs plus stable Agent Browser/CDP target IDs. It also resolves bounded read-only browser memory from `~/.config/mcp-dev-bridge/browser-memory/`: exact-host policy, exact-host site knowledge, then reusable platform knowledge whose `match.json` matches the current host/URL. Exact site lookup scales without scanning every learned company; platform scans stay limited to the reusable platform catalog. The resolver strips only leading `www.` and does not collapse arbitrary subdomains into one key. Up to six Markdown files are returned, capped at 16 KiB per file and 48 KiB total; malformed/missing local memory becomes a warning rather than a browser failure. `execute` requires the tab ID returned by `observe`, serializes the complete operation per browser target, validates that the pinned Agent Browser session is still on that exact target without switching tabs, runs mechanical actions locally, stops on the first error by default, never retries, and reports completed/failed/unknown/not-run steps plus a final observation. After each click, it compares the target set: exactly one new target is bound before later actions and final observation, zero continues on the current target, and multiple new targets stop the sequence without guessing. Other tab switching remains an Agent Browser operation through `observe(tab=...)` or an explicit `tab_switch` action.

The Linux browser-process seam is a small owner-controlled selector at `~/.config/mcp-dev-bridge/browser-fast.json`. V2 may select a named managed Clearcote profile. Clearcote owns a persistent profile beneath bridge state and launches a headed or headless Chromium context with an ephemeral loopback CDP endpoint; Agent Browser attaches to that same process for snapshots, refs, and target IDs. Supported input actions are then executed through the Clearcote-owned humanized Playwright context, while navigation, tab bookkeeping, waits, and approved uploads keep the existing Agent Browser path. V1 `cdpPort` Clearcote configuration remains a compatibility path during migration. The file is reread for backend calls; operators switch only between complete operations and discard prior refs. Windows remains on the shared dedicated Chrome runtime because the full DevTools `browser-devtools` facade and `browser-fast` intentionally share that process. Firefox is outside this seam because Agent Browser 0.35.0 is Chromium-CDP-only.

File upload reuses Agent Browser 0.35.0's native `upload` command rather than adding Browser Harness's Python/CDP runtime. The model supplies an observed input ref plus a logical `artifact` name. `browser-fast` resolves that name through `~/.config/mcp-dev-bridge/browser-artifacts.json`, requires the configured target to resolve to a regular file, and passes only the resolved approved path to Agent Browser. Windows uploads translate the WSL path with `wslpath -w`; Linux uploads keep the WSL path. Arbitrary model-supplied filesystem paths are not part of the action schema.

The memory design ports Browser Harness's MIT-licensed disk-backed domain-skill discovery idea without adding Browser Harness as a runtime/browser owner. `browser-fast` reads Markdown and platform `match.json` only; it does not execute Browser Harness-style `agent_helpers.py`, write learned memory, change Chrome lifecycle, or add another MCP tool. Provenance is recorded under `providers/browser-fast/vendor/browser-harness/`.

Learning stays outside Local browser authority. The Dev-only `providers/browser-fast/browser-memory-author.mjs` stages one exact-host observation with `propose` under `candidates/<host>/`, which `observe` never loads. A separate `promote` call creates `sites/<host>/<name>.md` with create-only semantics and removes the candidate after success. Both operations derive the exact host from the URL; provenance drops query strings and fragments. No page, successful form submission, or Browser call promotes memory automatically.

Optional domain workflows are extensions above this generic browser layer. `bin/extension` installs or removes manifest-declared browser-memory contributions, namespaced approved-artifact aliases, and configured source mappings; Browser core imports no extension. Required sources, artifacts, memory targets, and alias conflicts are preflighted before mutation. Removal deletes only extension-lifetime contributions while shared platform recognition, learned exact-site memory, and operator-owned source data remain outside the extension lifetime. ChatGPT Skill installation is separate client-side state. Enabling or disabling an extension therefore does not require modifying `browser-fast`, `browser-devtools`, Local, or Chrome lifecycle.

Windows browser ownership is shared below both logical surfaces by one runtime. It keeps persistent browser state under `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile`, launches visible Google Chrome with `--user-data-dir` plus `--remote-debugging-port=0` when that profile is not already healthy, waits for that profile's `DevToolsActivePort`, and returns the resulting loopback HTTP/WebSocket endpoints. `browser-devtools` connects Chrome DevTools MCP to the HTTP endpoint with `--browserUrl`; `browser-fast` connects pinned native Agent Browser 0.35.0 to the WebSocket with `--cdp` and `--pin-tab`. The everyday Chrome data directory is never an MCP execution target. The MCP profile persists cookies, local storage, extensions, and sign-ins across Chrome restarts, so the user can sign into this visible profile once and reuse it. Agent Browser's separate one-shot Windows Node helper still owns bounded stdout/stderr capture so cold daemon startup cannot keep the WSL interop lifetime open. On Linux, Agent Browser remains the pinned observation/ref layer for both backends; managed Chrome also uses it for execution, while managed Clearcote uses its own Playwright context for humanized input. Complete operations are serialized per target, normalized tab IDs prefer the CDP `targetId`, and each `observe` explicitly rebinds the chosen/current target before snapshotting so a strict pin can recover after its prior target is closed.

## Trust/profile separation

`restricted` and `trusted-dev` remain smaller explicit compositions; they do not inherit Code, Terminal, Local/Browser, `wait`, or the Personal Workstation Terminal socket. `personal` is the full reference composition and remains an explicit authority choice.
