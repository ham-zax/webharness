# Architecture

## Runtime path

```text
ChatGPT
  -> HTTPS + OAuth
Cloudflare Tunnel
  -> loopback origin
1MCP :3050
  -> Dev
  -> Local      (Personal Workstation, tag:local)
       -> inner 1MCP
            |-- dev (fallback_dispatch only)
            |-- code
            |-- terminal
            |-- host
            |-- browser-fast
            `-- browser-devtools
Linux / WSL host
```

1MCP is the single public MCP gateway in the maintained reference deployment. Cloudflare supplies HTTPS transport; providers remain local stdio processes. The model-facing compatibility contract is documented in [MCP Compatibility](compatibility.md).

## Capability boundaries

### Dev

Dev owns Files, ChatGPT-native file ingress, aggregate Git working-tree review, shell-free structured argv execution, native Bash, regular-file topology operations, and durable waits.

Personal surface:

```text
read edit write import_file file_ops review_changes wait exec bash
```

`edit` owns guarded mutation of existing text across one or more files. One exact `oldText` match always wins; only zero exact matches trigger tolerance for line endings, trailing whitespace, and common Unicode punctuation or space differences, and the fallback must still be unique. Exact and tolerant edits sharing a line must be merged. Callers inspect with `read`, `rg`, Code, or ast-grep and include enough context when needed. `write` owns new text-file creation, `import_file` owns create-only ingress of one ChatGPT-native file into a WSL-user path, and `file_ops` owns move/delete for existing regular files. `review_changes` owns one bounded read-only aggregate view of a Git working tree, including untracked file content when it fits the patch budget; it creates no refs, commits, or temporary Git index state. `exec` passes one `argv[]` directly to an executable without a shell parser and Bash remains the explicit path for pipes, redirects, substitutions, loops, compound commands, and other shell semantics. Both are short-RPC execution paths: agents route only work expected comfortably inside the connector request window through direct Dev, using 45 seconds as the routing target. Runtime that is uncertain, may approach a minute, or must survive the call belongs in Local Terminal; Dev `wait` observes Terminal output/exit/readiness across short RPCs and `terminal_read` retrieves output. The provider's larger internal timeout does not extend the connector lifetime. Syntax-shaped discovery/codemods can therefore run ast-grep through `exec` when no shell composition is needed and normally feed guarded `edit`; an existing authoritative `.patch`/`.diff` artifact may still use Bash for the guarded `git apply --check -- "$patch" && git apply -- "$patch"` compound command.

`wait` owns durable named wait state and generic local readiness checks. Terminal-specific waits use private broker transcript/session observations, but `wait` is not a Terminal MCP action.

### Code logical server

Code owns:

```text
code_search code_context code_symbol
```

The router resolves the nearest canonical Git root for the requested cwd and keeps one correctly rooted CodeDB child per active repository. Per-call project switching and the raw CodeDB catalog are hidden from the model-facing surface. First use may start a persistent CodeDB child and create or update substantial on-disk index state, so Code is not a cost-free read abstraction; on large or unfamiliar repositories with unknown CodeDB state, start with Dev `exec` + `rg` plus focused `read` unless indexing-backed repository intelligence is specifically needed. Use Bash there only when the search itself requires shell composition. This is model-routing guidance, not an enforced size threshold.

### Terminal logical server

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

### Host logical server

The Personal Workstation Local catalog exposes `server="host"` with `pc_sleep`. It requires explicit confirmation, optionally registers one replaceable Windows Task Scheduler `WakeToRun` task, returns an acknowledgement, and then asks Windows to enter sleep after a short grace period. It does not provide on-demand wake while the host is already asleep.

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

Personal Workstation domain capabilities are model-facing through one `local` provider under `tag:local`. Code, Terminal, Host, Browser, and owner-added capabilities are logical servers behind it. The provider exposes exactly:

```text
tool_list tool_schema tool_call fallback_dispatch tool_batch
```

The Local broker owns stable logical `{server, tool}` routing and connects over stdio to an inner 1MCP running in normal direct mode. It keeps no broker catalog/schema cache. Unscoped `tool_list` is server-oriented and excludes fallback-only mirrors. Explicit read-only inspection may still target a known fallback-only server: `tool_list(server="dev")` lists its tools and `tool_schema(server="dev", tool=...)` loads the exact schema. Ordinary `tool_call` and `tool_batch` remain limited to the public Local server set, including `code`, `terminal`, `host`, Browser, and owner-added MCPs. `fallback_dispatch` is the deliberate execution exception: it can route one already-authorized operation to the hidden Dev mirror when the normal writable MCP call is unavailable or unreliable. Its `readOnlyHint` is intentionally a transport-compatibility annotation and does not describe the selected downstream side effects. `tool_batch` states one public route once then dispatches a bounded set of structured argument objects with bounded concurrency. Batch routing fields and argument-object shapes are preflighted before dispatch; downstream MCPs retain ownership of their own tool-schema validation. Member results preserve input order and distinguish broker/transport rejection from a fulfilled downstream result whose own `isError` may be true. Discovery remains bounded with an opaque self-contained cursor; downstream catalog churn does not change the outer five-tool surface.

The private inner 1MCP contains the built-in `code`, `terminal`, `host`, `browser-fast`, and `browser-devtools` servers, owner-configured Local servers, and one fallback-only mirror of outer Dev. It enables only its internal reload management action for broker-owned recovery; the reserved `1mcp` namespace remains rejected and filtered from model routes. If a public configured server is absent during scoped discovery/schema/batch preflight, Local performs one coalesced targeted reload and verifies that tools reappear. A failed direct `tool_call` or `fallback_dispatch` is never automatically replayed: if Local proves the selected server disappeared, it may recover the backend but returns a retry-required error because the original action's side-effect outcome could be ambiguous. Owner-configured stdio MCPs are rendered with 1MCP `restartOnExit: true` by default, with an explicit `false` opt-out, so ordinary post-start crashes are handled by the native supervisor before broker recovery is needed.

### Browser

The Local inner 1MCP publishes two browser surfaces in the same `tag:local` trust domain:

```text
Local
  +-- server="browser-devtools" -> Chrome DevTools MCP facade
  |    +-- windows (default) -> dedicated persistent MCP Chrome profile
  |    `-- linux             -> same backend/profile selector as browser-fast
  `-- server="browser-fast" -> compact observe/execute facade
       +-- windows (default) -> pinned native Agent Browser 0.35.0 -> same MCP Chrome profile
       `-- linux             -> per-call backend: managed Chrome or managed Clearcote
```

`browser-devtools` keeps the complete Chrome DevTools MCP catalog for network, console, performance, Lighthouse, heap, screenshots, and detailed debugging. It adds `browser_target`, `browser_backend`, and `browser_profile`, strips those routing fields before forwarding, and returns downstream `CallToolResult` objects unchanged. On Linux, omitted backend/profile values resolve through `browser-fast.json`. Managed Clearcote attaches to the already running profile's loopback CDP endpoint instead of launching a second browser process.

`browser-fast` is an experimental routine-interaction surface with only `observe` and `execute`. `observe` returns compact interactive refs plus stable Agent Browser/CDP target IDs. It also resolves bounded read-only browser memory from `~/.config/mcp-dev-bridge/browser-memory/`: exact-host policy, exact-host site knowledge, then reusable platform knowledge whose `match.json` matches the current host/URL. Exact site lookup scales without scanning every learned company; platform scans stay limited to the reusable platform catalog. The resolver strips only leading `www.` and does not collapse arbitrary subdomains into one key. Up to six Markdown files are returned, capped at 16 KiB per file and 48 KiB total; malformed/missing local memory becomes a warning rather than a browser failure. `execute` requires the tab ID returned by `observe`. Linux operations are serialized by resolved backend/profile/tab, so independent tabs can proceed concurrently while the same tab remains fail-closed and ordered. Windows operations serialize by profile because each profile has one native Agent Browser session; different named Windows profiles have independent queues. Each Linux tab is driven through a deterministic Agent Browser session derived from its CDP target ID. After each click, `execute` compares the target set: exactly one new target is bound before later actions and final observation, zero continues on the current target, and multiple new targets stop the sequence without guessing. Other tab switching remains an Agent Browser operation through `observe(tab=...)` or an explicit `tab_switch` action.

The Linux browser-process seam uses `~/.config/mcp-dev-bridge/browser-fast.json` as default/profile policy rather than as a required runtime switch. A Browser Fast call can explicitly select `browser_backend=chrome` or `browser_backend=clearcote`. Omitted `browser_profile` keeps the existing shared default. With Chrome, an explicit profile name creates or reuses a persistent directory under bridge state and a profile-specific Agent Browser session. With Clearcote, the name selects a profile defined in the V2 configuration catalog. Clearcote owns persistent profiles beneath bridge state and launches one headed or headless Chromium context per active profile with an ephemeral loopback CDP endpoint. Concurrent callers for the same not-yet-started profile share one in-process launch promise, while different profiles may start independently; no filesystem lock is used for routine browser concurrency. For managed Clearcote, the first no-tab observation may claim an existing page and later independent no-tab observations allocate fresh pages in that same authenticated profile. Agent Browser attaches with a per-target pinned session for snapshots, refs, and target IDs. Chrome remains a separate backend, so a Chrome call does not close Clearcote or require editing shared configuration. Supported Clearcote input actions execute through its humanized Playwright context, while navigation, tab bookkeeping, waits, and approved uploads keep the existing Agent Browser path. Owner-managed V1 `cdpPort` Clearcote configuration remains readable, but Personal bootstrap converges the known maintained `clearcote:9222` selector to V2 `clearcote/x-main`. Firefox is outside this seam because Agent Browser 0.35.0 is Chromium-CDP-only.

File upload reuses Agent Browser 0.35.0's native `upload` command rather than adding Browser Harness's Python/CDP runtime. The model supplies an observed input ref plus a logical `artifact` name. `browser-fast` resolves that name through `~/.config/mcp-dev-bridge/browser-artifacts.json`, requires the configured target to resolve to a regular file, and passes only the resolved approved path to Agent Browser. Windows uploads translate the WSL path with `wslpath -w`; Linux uploads keep the WSL path. Arbitrary model-supplied filesystem paths are not part of the action schema.

The memory design ports Browser Harness's MIT-licensed disk-backed domain-skill discovery idea without adding Browser Harness as a runtime/browser owner. `browser-fast` reads Markdown and platform `match.json` only; it does not execute Browser Harness-style `agent_helpers.py`, write learned memory, change Chrome lifecycle, or add another MCP tool. Provenance is recorded under `providers/browser-fast/vendor/browser-harness/`.

Learning stays outside Local browser authority. The Dev-only `providers/browser-fast/browser-memory-author.mjs` stages one exact-host observation with `propose` under `candidates/<host>/`, which `observe` never loads. A separate `promote` call creates `sites/<host>/<name>.md` with create-only semantics and removes the candidate after success. Both operations derive the exact host from the URL; provenance drops query strings and fragments. No page, successful form submission, or Browser call promotes memory automatically.

Optional domain workflows are extensions above this generic browser layer. `bin/extension` installs or removes manifest-declared browser-memory contributions, namespaced approved-artifact aliases, and configured source mappings; Browser core imports no extension. Required sources, artifacts, memory targets, and alias conflicts are preflighted before mutation. Removal deletes only extension-lifetime contributions while shared platform recognition, learned exact-site memory, and operator-owned source data remain outside the extension lifetime. ChatGPT Skill installation is separate client-side state. Enabling or disabling an extension therefore does not require modifying `browser-fast`, `browser-devtools`, Local, or Chrome lifecycle.

Windows browser ownership defaults to one runtime shared below both logical surfaces. It keeps persistent state under `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile`; `browser-devtools` and profileless `browser-fast` calls connect to that same instance. Browser Fast may instead select a named persistent profile under `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profiles\\<name>`. Each named profile gets a separate visible Chrome process, DevTools endpoint, Agent Browser session, and operation queue; Browser DevTools does not currently select those named profiles. Every runtime launches Chrome with `--user-data-dir` plus `--remote-debugging-port=0`, waits for that directory's `DevToolsActivePort`, and returns loopback endpoints. The everyday Chrome data directory is never an MCP execution target. Profile state persists cookies, local storage, extensions, and sign-ins across restarts. Agent Browser's one-shot Windows Node helper owns bounded stdout/stderr capture so cold daemon startup cannot keep the WSL interop lifetime open. On Linux, Agent Browser remains the pinned observation/ref layer for both backends; managed Chrome also uses it for execution, while managed Clearcote uses its own Playwright context for humanized input. Linux tab operations use independent pinned sessions and tab-scoped queues, normalized tab IDs prefer the CDP `targetId`, and each `observe` explicitly rebinds the chosen/current target before snapshotting so a strict pin can recover after its prior target is closed.

## Trust/profile separation

`restricted` and `trusted-dev` remain smaller explicit compositions; they do not inherit Local or its Code/Terminal/Host/Browser logical servers, `wait`, or the Personal Workstation Terminal socket. `personal` is the full reference composition and remains an explicit authority choice.
