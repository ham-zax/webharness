# Security and Trust Profiles

The effective security boundary is the selected profile plus the Linux account running the bridge.

## `restricted`

Use when conservative workspace-bounded authority is required.

- Files are confined to the configured workspace.
- Dev does not expose unrestricted Bash.
- A separate legacy shell provider enforces an allowlist policy.
- Code and Terminal are not present in this profile.

## `trusted-dev`

Use only on a dedicated development host where unrestricted shell authority is intentional.

- Files remain workspace-bounded.
- Dev exposes native Bash with the permissions of the Linux service user.
- Bash may reach files, processes, network resources, developer tools, and credentials accessible to that account even when the Files tools are workspace-bounded.
- Code and Terminal are not present in this profile.

## `personal` — Personal Workstation

Full reference-workstation authority.

- Files use user-mode paths and may accept absolute paths.
- Bash has the authority of the WSL user.
- Code can inspect Git repositories reachable by that user.
- Terminal can create and control persistent tmux-backed PTYs.
- Durable waits can observe local process/port/file/HTTP/systemd and WebHarness Terminal state.
- Local Browser access can control the dedicated persistent Windows MCP Chrome profile or the separate managed WSLg Chrome profile after explicit `tag:local` authorization; everyday Windows Chrome remains outside MCP control.

This profile is intentionally powerful. Treat it like giving a coding agent an interactive shell as your WSL user plus, when `tag:local` is granted, access to the local capability domain, which currently includes authenticated browser control.

The outer `local` provider is the `tag:local` authorization boundary. Its generic `tool_call(server, tool, arguments)` means every downstream MCP admitted to that broker instance shares that authority. The `browser-devtools` and `browser-fast` logical servers intentionally share this local browser trust domain. A genuinely different trust domain needs a separate broker/scope or direct exposure.

The DevTools `browser-devtools` facade intentionally does not advertise MCP filesystem roots to its internal Chrome DevTools MCP clients. Upstream path-bearing browser tools therefore remain restricted to the relevant OS temp directory. `browser-fast` has two narrow filesystem reads owned by the facade. Observation may read Markdown plus platform `match.json` beneath `~/.config/mcp-dev-bridge/browser-memory/` and return bounded content as strategy/policy metadata. Upload may read `~/.config/mcp-dev-bridge/browser-artifacts.json`, resolve one explicitly named approved file, and hand that file path to Agent Browser. The model never supplies a raw path, and an unlisted artifact is rejected before browser action dispatch. The artifact manifest is an upload allowlist, so it should contain only files the operator is willing to send to websites; it is not a destination allowlist and does not remove the need to verify the current form/site before uploading.

Browser memory is not executable. `browser-fast` never writes learned content or automatically persists webpage text, and it does not execute Browser Harness-style `agent_helpers.py`. Treat active memory as trusted local agent/operator configuration because its contents can influence browser strategy. The Dev-only `browser-memory-author.mjs` stages proposed exact-site knowledge under `candidates/`, which the resolver ignores, and requires a separate explicit `promote` operation before that content becomes active under `sites/`. Promotion never overwrites an existing site-memory file. Summarize reusable mechanics in candidates; do not persist webpage instructions, secrets, personal/candidate data, or one-off form answers as browser memory. Editing memory or the artifact manifest through Dev remains a separate WSL-user-authority action; Local browser access alone does not gain arbitrary filesystem write or Python execution.

Extensions do not receive additional Browser authority. `bin/extension` is an operator/Dev-side installer that preflights declared sources, approved artifacts, memory targets, and alias conflicts before activation. It may copy declared read-only memory contributions, merge explicitly namespaced artifact aliases, and record configured source mappings for an extension. Conflicts fail instead of overwriting another extension. Removal deletes only extension-lifetime contributions and matching aliases; shared platform recognition, learned exact-site memory, and operator-owned source data remain outside the extension lifetime. The extension manager cannot install or remove ChatGPT Skills; that remains client-side state.

`execute` requires an observed tab ID and serializes the complete operation per browser target. Agent Browser 0.35.0 remains the strict `--pin-tab` observation/ref layer; normalized tab IDs prefer the CDP `targetId`, which Agent Browser accepts as a tab reference and keeps stable across daemon restarts. Immediately before mutation, `browser-fast` reads Agent Browser's tab list and requires the current target to equal `execute.tab`; it deliberately does not switch tabs in this precondition because switching invalidates snapshot refs. `observe` may explicitly bind a chosen/current target before taking its fresh snapshot, which is the recovery boundary after a strict pinned target is externally closed. Managed Clearcote input is bound back to the same target ID before dispatch through its Playwright context; ref-targeted input does not invent CSS/XPath selectors. A click may bind exactly one newly created target before later actions; multiple new targets stop the sequence without selecting one, preserving truthful completed/not-run states. On Windows, both logical browser surfaces share only `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile`, launched with an ephemeral loopback debugging port; the default everyday Chrome user-data directory is not attached, copied, or exposed to `tag:local`. Managed Linux Clearcote profiles live under bridge state and expose only an ephemeral loopback debugging endpoint. The fast executor never automatically retries a failed, partial, or unknown action batch, and no debugging endpoint is intentionally published beyond loopback.

## CodeDB resource guidance

The Personal Workstation Code tools are description-guided, not resource-enforced. A first Code call for a repository may start a persistent rooted CodeDB child and create or update substantial on-disk index state. On large repositories this can consume significant disk and RAM. The model-facing descriptions therefore direct large or unfamiliar repository discovery toward bounded Dev Bash/`rg` and focused `read` before CodeDB-backed intelligence when CodeDB state/cost is unknown.

There is no repository-size preflight, threshold, cgroup, or approval database in this design. Because Personal Workstation Bash intentionally has the WSL user's authority, description text cannot form a privilege boundary against deliberate raw CLI use; it is routing guidance intended to prevent accidental expensive work.


## Edit mutation guarantees

Edit V2 coordinates all requested canonical paths through the existing in-process mutation coordinator, plans every target before the first edit mutation, and revalidates file identity plus exact snapshot bytes through the same open file descriptor used for write/truncate. This reduces stale-path and cooperating-writer races but is not a cross-file transaction, rollback system, fsync durability guarantee, or compare-and-swap against arbitrary Bash/Python/editor processes. A post-mutation failure may therefore be reported as an explicit partial or uncertain state that requires rereading before retrying.

## File topology mutation guarantees

Personal `file_ops` operates only on existing regular-file directory entries. It canonicalizes and authorizes the parent while preserving the requested final entry identity, opens the source without following the final component, and rejects symbolic links and other non-regular entries. Delete revalidates the requested entry before guarded unlink. Move is same-filesystem only: it creates a no-overwrite hard link to the same inode, verifies source/destination identity, then removes the source name; `EXDEV` is explicit and there is no copy fallback.

All affected entry paths participate in the same in-process mutation coordinator used by cooperating Dev mutations, and sources are revalidated after the lease is acquired. Once a move has created the destination link, cancellation does not deliberately interrupt the guarded link-to-unlink sequence. A later failure is reported as structured `FILE_OPS_PARTIAL` state with completed, failed, uncertain, and unattempted operations plus confirmed side effects where known.

These guarantees do not provide kernel compare-and-swap or serialization against arbitrary Bash, Python, editors, or other external filesystem actors. Path-based unlink has an unavoidable final race if an external actor replaces the directory entry after the last guard and before unlink. Treat `file_ops` as cooperative Dev serialization plus stale-state detection, not as a general filesystem transaction boundary.

## Sudo

Sudo is never an automated credential feature.

- The harness may execute `sudo` only when the operator deliberately requests it.
- Password entry belongs in an explicitly human-controlled Terminal session.
- The bridge must not store, infer, log, transmit, or auto-fill a sudo password.

## Human Terminal observation and ownership handoff

The human frontend is any suitable interactive TTY; Kitty is not a security or runtime dependency. tmux remains the PTY/process lifetime authority and the broker remains the model mutation gate.

`bin/wsl-term new <session>` creates a human-first collaborative session under a pending human lease before the tmux session is exposed, closing the create-to-attach model-write race. The attached writable client blocks model send/resize/ordinary close while model reads remain available.

`bin/wsl-term give <session>` changes the designated human client to read-only + ignore-size and releases the human lease only after the tmux transition is verified. `bin/wsl-term take <session>` establishes human blocking before making the designated client writable. `terminal_yield` uses the same take path and can only return control to a human; it cannot seize human control for the model.

`Ctrl-b T` is a direct tmux `switch-client -r` ownership toggle because tmux read-only clients ignore conditional wrapper bindings. A read-only observer cannot inject pane input until the human explicitly invokes this takeover. Before every model mutation, the broker reconciles actual client flags: any writable client or live lease blocks the model, a unique writable client becomes the designated human target, and multiple writable clients fail closed rather than being auto-resolved.

`bin/wsl-term watch <session>` starts read-only + ignore-size and does not acquire a human lease. `bin/wsl-term attach <session>` is writable human takeover/rejoin and becomes the designated human client when observed. Unknown tmux client state remains writable for fail-closed control.

Human keystrokes are never copied into a separate broker-side input log. Sudo/password input continues to travel directly from the interactive terminal through tmux to the PTY.

## Public exposure

1MCP listens on loopback `:3050`. Cloudflare exposes HTTPS and OAuth remains required for the public MCP origin. Providers and browser debugging endpoints remain local implementation details; the reference deployment does not intentionally expose raw provider stdio, the Local inner 1MCP, Chrome DevTools endpoints, or Terminal broker sockets beyond the host boundaries that own them.

Pinned 1MCP 0.36.0 permits only loopback OAuth callback origins in its consent-page CSP. The reference installer applies a fail-closed compatibility patch that also permits the exact registered HTTPS callback origin; it does not permit arbitrary HTTPS form destinations. Requalify this patch when changing the pinned 1MCP version.

Local capability authority is separate from Dev/Code/Terminal: `tag:local` exposes the three-tool Local broker, whose inner 1MCP contains `browser-devtools` and `browser-fast`. Both can reach resource-local browser state only after explicit client authorization at that outer domain.

## Sensitive state

Keep these outside Git:

- `.env` deployment identity;
- generated 1MCP configuration;
- OAuth/session state;
- logs and PID/runtime files;
- Terminal state;
- credentials and tunnel secrets.

Historical engineering evidence under `docs/history/` is excluded from the public reference distribution because it can contain superseded or machine-specific context.
