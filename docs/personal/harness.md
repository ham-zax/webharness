# Personal Workstation

The `personal` profile is the full WebHarness reference deployment. It runs with the authority of the WSL user and is intentionally more powerful than the smaller `restricted` and `trusted-dev` examples.

## Mental model

```text
Dev       read edit write file_ops wait bash pc_sleep
Code      code_search code_context code_symbol
Terminal  terminal_open terminal_read terminal_send terminal_resize terminal_list terminal_yield terminal_close
Local     tool_list tool_schema tool_call
            |-- browser-fast      observe/execute interaction; Windows default, WSLg on request
            `-- browser-devtools  full Chrome DevTools diagnostics; Windows default, WSLg on request
```

Think in four model-facing domains:

- **Dev** handles focused text/file work, bounded execution, durable waits, and explicit Windows-host sleep.
- **Code** provides rooted indexed repository intelligence without exposing raw CodeDB mechanics; first use may create or update heavyweight persistent index state.
- **Terminal** owns durable PTY/process lifetime and human/model terminal ownership.
- **Local/Browser** exposes only three stable broker tools. Use logical `server="browser-fast"` for routine interaction: `observe` once, consume any returned `memory` that applies to the current host, then pass the returned `active_tab` to `execute` with the mechanical sequence. Policy memory is local operator policy; exact-site memory is more specific than reusable platform memory; live browser state wins when strategy memory is stale. Unknown/custom sites need no predefined ATS entry and continue through the generic observe/execute flow. `execute.tab` is required and stale/unavailable tab context fails before action dispatch. A click follows exactly one newly opened target before later actions; multiple new targets stop the sequence without guessing and require another observation. Upload uses an observed file-input ref plus a logical artifact key from `~/.config/mcp-dev-bridge/browser-artifacts.json`; never substitute an arbitrary filesystem path. Use logical `server="browser-devtools"` for DevTools diagnostics and load only the specific DevTools schema needed. Omit `arguments.browser_target` for the dedicated persistent Windows MCP Chrome profile; use `arguments.browser_target="linux"` for WSLg. The Windows MCP profile is separate from everyday Chrome and keeps its own persistent sign-ins; Windows MCP and Linux browser state remain separate.

## Learning exact-site browser memory

After a browser task completes safely, stage only a reusable site mechanic through Dev. The candidate is inert and is not returned by `browser-fast.observe`:

```bash
printf '%s' '{"url":"https://careers.example.com/jobs/123","name":"application","content":"Country selection requires choosing the autocomplete option before continuing."}' \
  | node providers/browser-fast/browser-memory-author.mjs propose
```

Promote it only after deciding the observation should guide future visits to that exact host:

```bash
printf '%s' '{"url":"https://careers.example.com/jobs/123","name":"application"}' \
  | node providers/browser-fast/browser-memory-author.mjs promote
```

`propose` and `promote` derive the exact canonical host, strip query/fragment data from stored provenance, keep files private, and refuse to overwrite an existing candidate or active site-memory file. Use normal Dev `read`/`edit` when an existing active memory needs revision. Do not copy webpage instructions, personal data, credentials, or job-specific answers into browser memory.

## Optional extensions

Domain workflows can sit above the generic browser/runtime layer without changing Browser core. The public reference ships the generic extension manager, not the machine-specific extension packs used by the engineering checkout.

```bash
webharness extension list
webharness extension install <name>
webharness extension remove <name>
```

An extension manifest may contribute namespaced approved-artifact aliases, browser-memory files, or configured source mappings. Installation preflights its declared sources and conflicts before mutation. Removal deletes only extension-lifetime contributions and matching aliases; shared platform recognition, learned exact-site memory, and operator-owned source data remain outside the extension lifetime. ChatGPT Skill installation is separate client-side state.

## Setup

`bin/webharness` is the normal operator entrypoint. It routes `personal` to the dedicated Personal Workstation bootstrap while the lower-level `scripts/setup.sh` continues to own only `restricted` and `trusted-dev`.

Create/configure `.env` first, at minimum supplying the public MCP URL. The personal default cwd is optional: set `MCP_PERSONAL_DEFAULT_CWD=/absolute/path` when you want something other than this WSL user's `$HOME`.

Keep the live machine-specific owner policy outside the checkout. A typical runtime layout is:

```text
~/.config/mcp-dev-bridge/owner/
    context.md
    gui.env
```

Point the personal deployment at those files rather than copying their contents into tracked configuration:

```text
MCP_OWNER_CONTEXT_FILE=/home/user/.config/mcp-dev-bridge/owner/context.md
MCP_OWNER_ENV_FILE=/home/user/.config/mcp-dev-bridge/owner/gui.env
```

`pi-dev` reads `MCP_OWNER_CONTEXT_FILE` as a current-user-owned regular file, limits it to 32 KiB, and publishes non-empty content as its MCP server `instructions`. 1MCP includes those upstream instructions in the initialization instructions sent to a matching client. Use this file for WSL- or workstation-specific guidance, not project invariants or current-task instructions.

`MCP_OWNER_ENV_FILE` is also current-user-owned and bounded. The renderer accepts `GALLIUM_DRIVER`, `MOZ_ENABLE_WAYLAND`, `AGENT_BROWSER_PROFILE`, and `AGENT_BROWSER_EXECUTABLE_PATH`, validates their values, and writes only the GUI subset to the sanitized `owner.env` under the private bridge state directory. Dev, the Terminal MCP provider, and the Terminal/tmux services receive the supported owner GUI environment; Linux Browser receives `GALLIUM_DRIVER` when configured, while the Agent Browser settings go only to Linux `browser-fast`. Other variables are rejected rather than imported into service environments. Context changes are read on the next `pi-dev` start; GUI env changes take effect after the personal configuration is rendered again and the relevant processes are restarted.

Linux `browser-fast` has a separate live browser selector at `~/.config/mcp-dev-bridge/browser-fast.json`; start from `config/browser-fast.example.json`. V2 can select a named managed Clearcote profile. The provider owns the persistent profile directory and Clearcote process, Agent Browser supplies snapshots/refs/target IDs over the runtime's ephemeral loopback CDP endpoint, and supported input actions execute through Clearcote humanization. The V1 external `cdpPort` form remains readable only as a migration compatibility path. Switch only between complete browser-fast operations and observe again afterward. The Windows target remains the dedicated shared MCP Chrome process, and Firefox is not supported by the current Chromium-CDP driver.

Keep the ownership boundary explicit: repository invariants belong in tracked repository guidance, personal WSL/machine policy belongs in the owner overlay, and current-task instructions belong in the conversation.

For a complete install with automatic startup in later WSL sessions:

```bash
webharness setup --profile personal --enable-startup
```

`--enable-startup` is explicit consent to install the user-systemd units, enable user linger, enable the services, and start them now. After that, the services start automatically whenever this WSL user's systemd manager starts. The bootstrap does **not** configure Windows to launch WSL.

The same command also qualifies the Personal Workstation CLI toolbox, installs/verifies the pinned 1MCP runtime through the repository's shared runtime installer, installs all six pinned personal in-repo provider dependency trees, installs/verifies the pinned CodeDB binary, prepares Clearcote's Ubuntu/WSL runtime dependencies and pinned browser build, renders the outer Personal Workstation composition plus the Local inner browser composition, and installs:

```text
~/.local/bin/webharness -> <this checkout>/bin/webharness
~/.local/bin/wsl-term   -> <this checkout>/bin/wsl-term
```

Omit `--enable-startup` when you only want dependencies/configuration plus the user-local commands and do not want persistent startup state changed:

```bash
webharness setup --profile personal
```

The direct renderer, toolbox setup, unit installers, and `bin/start`/`bin/stop` remain supported lower-level repair and source-cutover primitives. They are not the normal first-install sequence.

### New ChatGPT client

The WSL side is persistent after the explicit startup install, but a new ChatGPT environment still owns two client-side pieces that the repository cannot silently mutate:

1. connect ChatGPT to the configured public MCP endpoint and complete OAuth;
2. install any desired client-side Skills separately, then refresh/reopen the MCP connection when the outer model-facing schema changes. Ordinary Local downstream tool additions/removals are discovered through Local and do not by themselves change the outer three-tool broker schema.

These are client-side actions, not recurring WSL service-start commands.

### AI clients without native MCP support

For other AI environments that can execute Python and make outbound HTTPS requests but do not provide a native MCP client, use the copy/paste bootstrap prompt in [`non-native-ai-mcp-python.md`](non-native-ai-mcp-python.md). It directs the environment to use the official MCP Python SDK, headless OAuth/PKCE, and a small session-local `portable_mcp` shim instead of hand-written JSON-RPC.

## Dev

### `read`

Use for focused text/source reads. Relative paths resolve from the personal default cwd; harmless absolute paths are accepted.

### `edit`

Use for existing-text mutation across one or more files. One exact `oldText` match always wins; only zero exact matches trigger tolerance for line endings, trailing whitespace, and common Unicode punctuation or space differences. Exact and tolerant edits sharing a line must be merged into one edit. Matching must still be unique, so inspect with `read`, `rg`, Code, or ast-grep and include enough context when needed. `edit` rejects missing, ambiguous, overlapping, stale, non-text, or duplicate-alias targets; all targets are planned before the first mutation, and partial post-mutation failures are reported explicitly. File count or a structural label does not change this route.

The canonical request is always grouped, including one-file edits:

```text
edit({
  targets: [
    { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] }
  ]
})
```

For multiple existing text files, add more target records to the same request rather than switching tools only because the file count increased.

### `write`

Use only for new text-file creation. It refuses to overwrite an existing path.

### `file_ops`

Use only to move or delete existing regular files. Final-component symlinks are rejected. A move stays on one filesystem, creates a no-overwrite hard link to the same inode, then removes the source name under stale-state guards; there is no copy fallback. See [Security](../security.md) for the cooperative serialization and final-path race boundary.

### `bash`

Runs one bounded, noninteractive native Bash command string. Use it for Git, builds, tests, `rg`, repository inspection, and ordinary short execution; use Terminal when work must persist or needs a PTY/interactive workflow. For a large or unfamiliar repository with unknown CodeDB state, Bash/`rg` plus focused `read` is the lower-cost discovery path before invoking Code. There is no hidden mutable global cwd; use `cwd` explicitly when needed.

For syntax-shaped discovery or codemods, use ast-grep through Bash. Inspect bounded matches and normally perform the final mutation through guarded `edit`; use ast-grep bulk rewrite only when the transformation is deterministic and every bounded match is intentionally changed.

For an existing authoritative `.patch`/`.diff` artifact, use native Git:

```bash
git apply --check -- "$patch" && git apply -- "$patch"
```

Use `--3way` only when the user explicitly requests merge-style recovery. Do not automatically add fuzzy patch recovery.

Native Bash/output remains the source of truth.

### `wait`

`wait` creates durable named observations. First-phase condition kinds are:

```text
terminal_output
terminal_exit
process_exit
tcp_listen
file_exists
file_changed
http_ready
systemd_user
timer
```

Typical flow:

```text
1. wait(name, condition, timeout_seconds, hold_seconds=0) -> pending
2. continue other work / let the source change
3. wait(name, hold_seconds=2) -> matched | pending | timeout | stable source error
```

Important semantics:

- timeout is an absolute durable safety deadline;
- `timer` supports relative `{kind:"timer", after_seconds:N}` wakeups and absolute `{kind:"timer", at:"<timezone-qualified instant>"}` wakeups;
- `timer.after_seconds` is 1..86399 seconds, while `timeout_seconds` remains at most 86400 seconds and must be strictly later than the timer target because the safety deadline wins ties;
- `hold_seconds=0` allows one bounded arm/check and does not poll-hold the call;
- positive hold limits one invocation, not the underlying resource;
- if positive hold expires before the first durable baseline commits, `WAIT_HOLD_EXPIRED` is returned and no wait exists;
- after durable state exists, a hold expiry returns `pending` and preserves the same baseline/deadline; other reasoning/tool work may happen before resuming the same wait name;
- Terminal output waits observe only new transcript output after arming;
- the wait cursor is independent from normal `terminal_read` unread state;
- explicit Terminal destruction and same-name replacement remain explicit (`WAIT_SOURCE_ENDED`, `WAIT_SOURCE_REPLACED`).

### `pc_sleep`

Sleeps the Windows host after a 10-second grace period. The call requires `confirm: true` from a direct user request. Supply an optional timezone-qualified `wake_at` value, such as `2026-08-22T07:00:00+05:30`, to register one replaceable Windows Task Scheduler wake task before sleeping. The wake time must be at least two minutes in the future. Omitting `wake_at` clears the previous MCP wake task before sleep.

This action only schedules a wake before the host sleeps; it cannot receive a new on-demand MCP call while Windows, WSL, and the bridge are already asleep.

## Code

### `code_search`

Ranked text/code search when the exact symbol is unknown. Prefer `code_symbol` when a symbol or definition name is already known or guessable.

### `code_symbol`

Use when you know or can guess a definition name.

### `code_context`

Compact first-touch context for a task: definitions, focused bodies, graph neighbors, files, and snippets. First-touch does not mean always call it first on an unknown large repository.

All three Code tools share the same rooted CodeDB child/index lifecycle. First use for a repository may start a persistent child and create or update substantial on-disk index state, which can consume significant disk and RAM. There is no hard repository-size preflight or threshold. For a large or unfamiliar repository with unknown CodeDB state, prefer Dev Bash/`rg` plus focused `read` for initial discovery unless CodeDB-backed repository intelligence is specifically desired.

The Code router resolves the nearest canonical Git root from `cwd`. Nested repositories win over outer repositories. Do not pass project-switching state; the rooted child owns repository identity.

## Terminal

### Durable session workflow

```text
terminal_open   create a model-owned named tmux-backed PTY; optionally present it
terminal_read   read unread output; use cursor/snapshot for recovery
terminal_send   send text or a control/navigation key while model-owned
terminal_resize resize the PTY while model-owned
terminal_list   inspect live/dead sessions and human-control state
terminal_yield  reuse or ensure a collaborative human frontend, then hand it control
terminal_close  explicitly destroy a session
```

A broker restart or 1MCP restart does not own the PTY lifetime; tmux does. Terminal sessions live in the harness-owned private tmux namespace (production default `wsl-agent`), not the user's default tmux server.

The tmux/broker backend remains emulator-neutral. Operator-side `wsl-term` commands work from any interactive tmux-compatible TTY. The Personal Workstation presentation helper uses `MCP_TERMINAL_FRONTEND=kitty|windows-terminal` only when it must create a visible collaborative frontend; `kitty` is the compatibility default. Kitty launches under WSLg. Windows Terminal re-enters the same WSL distribution and runs `wsl-term present <session>` against the exact existing PTY. Either frontend is presentation only and never becomes the PTY lifetime authority.

Normal `terminal_open` stays headless. Set `present:true` only when the human should watch the exact PTY from the start; background servers and other model-only durable work should not open a GUI merely because they use Terminal.

### Collaborative human-first terminals

Create a durable session from the interactive terminal you are already using:

```bash
wsl-term new <session>
```

`new` creates the private tmux session under an immediate human lease and attaches the invoking TTY as the writable human client. ChatGPT may read the terminal immediately, but model send/resize/ordinary close return `HUMAN_HAS_CONTROL` until control is given away.

Hand the same attached PTY to the model:

```bash
wsl-term give <session>
```

The human client stays attached but becomes tmux read-only + ignore-size. Human terminal resizing no longer changes the PTY; model send and `terminal_resize` become authoritative.

Take it back from another shell or terminal tab:

```bash
wsl-term take <session>
```

For same-pane handoff, `Ctrl-b T` directly toggles the current tmux client between writable and read-only. A read-only watcher remains unable to type until this explicit takeover. The broker reconciles real tmux client flags before every model mutation: a unique writable client becomes the designated human owner; multiple writable human clients block model mutation and are never auto-resolved.

ChatGPT can voluntarily return a model-owned collaborative session with `terminal_yield`. If a designated human frontend is already attached, it reuses that exact client and makes it writable regardless of the configured emulator. If none is attached, the personal provider launches the configured frontend on the exact tmux session, waits for broker attachment evidence, then yields to it. If a human attachment lease is still settling at the readiness deadline, re-list before retrying or manually attaching; when neither a lease nor attachment remains, the provider reports the exact `wsl-term attach <session>` fallback. It never lets the model seize control from a human.

### Observation, takeover, and recovery

Watch an existing exact PTY without becoming the collaborative handoff target:

```bash
wsl-term watch <session>
```

A watcher starts as an anonymous tmux read-only, ignore-size client. It receives the live terminal display, cannot inject pane input, does not resize the PTY, and does not block model send/resize/ordinary close unless the human explicitly presses `Ctrl-b T` to take control.

Attach a persistent designated collaborative viewport while the model keeps control:

```bash
wsl-term present <session>
```

`present` attaches read-only to the exact PTY, registers that client as the handoff target, and freezes the tmux window in manual-size mode before attachment so a smaller passive viewport does not resize the model-owned PTY. Model `terminal_resize` remains authoritative while the client is read-only. If the client later becomes writable through `terminal_yield` or `wsl-term take`, normal terminal resize events can resize the PTY; `wsl-term give` or `Ctrl-b T` returns the same visible client to read-only model-owned mode.

Take writable control of an existing exact PTY or rejoin after the original human client disappeared:

```bash
wsl-term attach <session>
```

Writable attach uses the same lease/client reconciliation as collaborative `new`; while attached, model mutation is blocked and model reads remain available. Human input, including sudo/password entry, flows directly from the terminal client to tmux/PTY and is not copied into a separate broker input log.

Manual `wsl-term new`, `watch`, `present`, and writable `attach` require an interactive TTY. Model-owned sessions created with `terminal_open` continue to work headlessly. On the personal WSL profile, frontend-aware presentation/yield may launch Kitty when WSLg and an executable Kitty are available, or Windows Terminal when `wt.exe`, WSL interoperability, and current-distro resolution are available. If automatic presentation cannot establish or begin an attachment, the exact manual attach fallback remains available.

## Typical coding loop

```text
Code      locate a symbol or implementation
Dev       read focused source
Dev       bash/ast-grep for syntax-shaped discovery when needed
Dev       edit existing text; write new text; file_ops regular-file move/delete
Dev       bash focused tests + git diff
Terminal  start a watch/dev server if work must persist
Dev wait  wait for readiness/output/exit without polling the full transcript
Terminal  inspect/interact incrementally
Code      re-check repository intelligence after watcher convergence
Dev       final tests and git status/diff
```

## Safety boundaries

- Same-canonical-path cooperating Dev mutations serialize their final compare+mutation section.
- Native Bash and arbitrary external writers do not participate in that in-process coordinator.
- Hard-link/inode alias synchronization is not claimed.
- A wait timing out or being cancelled never owns or kills the observed Terminal/process/resource.
