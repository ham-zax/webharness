# Security and Trust Profiles

The effective security boundary is the selected profile plus the Linux account running the bridge.

## `restricted`

Use when conservative workspace-bounded authority is required.

- Files are confined to the configured workspace.
- Dev does not expose unrestricted `exec` or Bash.
- A separate legacy shell provider enforces an allowlist policy.
- Local is not present, so Code, Terminal, Host, and Browser logical servers are absent.

## `trusted-dev`

Use only on a dedicated development host where unrestricted shell authority is intentional.

- Files remain workspace-bounded.
- Dev exposes shell-free structured argv execution and native Bash with the permissions of the Linux service user.
- Both `exec` and Bash may reach files, processes, network resources, developer tools, and credentials accessible to that account even when the Files tools are workspace-bounded. `exec` removes shell parsing; it is not a privilege boundary.
- Local is not present, so Code, Terminal, Host, and Browser logical servers are absent.

## `personal` — Personal Workstation

Full reference-workstation authority.

- Files use user-mode paths and may accept absolute paths.
- `import_file` can create one new WSL-user-accessible file from a ChatGPT-native file reference; it never overwrites an existing destination.
- `review_changes` can inspect Git working trees reachable by the WSL user and returns a bounded aggregate patch without creating Git refs or commits.
- `exec` and Bash have the authority of the WSL user.
- Local `server="code"` can inspect Git repositories reachable by that user.
- Local `server="terminal"` can create and control persistent tmux-backed PTYs.
- Local `server="host"` can put the Windows host to sleep after its explicit confirmation guard.
- Durable waits can observe local process/port/file/HTTP/systemd and WebHarness Terminal state.
- Local Browser access can control the dedicated persistent Windows MCP Chrome profile or the configured WSLg browser identity (Chrome or Clearcote) after explicit `tag:local` authorization; everyday Windows Chrome remains outside MCP control.

This profile is intentionally powerful. Treat it like giving a coding agent an interactive shell as your WSL user plus, when `tag:local` is granted, access to Code, Terminal, Host, Browser, and owner-added logical servers. Because `fallback_dispatch` can reach the hidden Dev mirror, that Local grant also carries recovery-path authority equivalent to the selected Dev operation.

The outer `local` provider is the `tag:local` authorization boundary. Ordinary `tool_call(server, tool, arguments)` and same-route `tool_batch(server, tool, calls)` operate on public Local downstream servers including `code`, `terminal`, `host`, Browser, and owner-added MCPs. `fallback_dispatch(server, tool, arguments)` is intentionally broader only in one direction: it can also reach the fallback-only mirror of outer Dev so an already-authorized writable Dev operation can still be attempted when its normal model-facing call is unavailable or unreliable. The fallback tool is intentionally advertised with `readOnlyHint` for transport compatibility, but that hint is not an authorization or side-effect guarantee; the selected downstream operation retains its real authority and may edit, create, delete, execute, control a PTY, sleep the host, or otherwise mutate state. Batch concurrency changes orchestration, not authorization. The `browser-devtools` and `browser-fast` logical servers intentionally share this local browser trust domain, and owner-configured `MCP_LOCAL_SERVERS_FILE` entries join that same authority domain. The owner file is accepted only for the Personal profile, must be a bounded current-user-owned regular file, cannot replace built-in Local servers, and may launch only an existing absolute executable with literal args/env and an optional existing absolute working directory. Owner stdio servers are supervised by 1MCP on unexpected exit unless explicitly opted out. Local privately enables only 1MCP's reload action for targeted backend recovery; the reserved `1mcp` namespace is filtered from discovery and rejected as a model route, so this lifecycle authority does not become another model-facing Local metatool or a general management surface. Adding a server is therefore an explicit capability grant; a genuinely different trust domain needs a separate broker/scope or direct exposure.

Personal Dev `import_file` is an ingress boundary, not a general downloader. Its `file` argument is declared as a ChatGPT native file parameter, the provider accepts only the expected host-supplied file-reference shape, requires HTTPS on explicitly trusted OpenAI file hosts (including validated redirects), streams into an exclusive private partial, enforces `MCP_DEV_IMPORT_MAX_BYTES`, fsyncs and size-checks the completed bytes, then publishes with a no-overwrite hard link under the same cooperative mutation coordinator used by other Dev writes. Signed source URLs are not returned in normal tool output. The destination parent must already exist. Import does not grant Browser upload authority and does not modify the Browser artifact manifest.

The DevTools `browser-devtools` facade intentionally does not advertise MCP filesystem roots to its internal Chrome DevTools MCP clients. Upstream path-bearing browser tools therefore remain restricted to the relevant OS temp directory. `browser-fast` has two narrow filesystem reads owned by the facade. Observation may read Markdown plus platform `match.json` beneath `~/.config/mcp-dev-bridge/browser-memory/` and return bounded content as strategy/policy metadata. Upload may read `~/.config/mcp-dev-bridge/browser-artifacts.json`, resolve one explicitly named approved file, and hand that file path to Agent Browser. The model never supplies a raw path, and an unlisted artifact is rejected before browser action dispatch. The artifact manifest is an upload allowlist, so it should contain only files the operator is willing to send to websites; it is not a destination allowlist and does not remove the need to verify the current form/site before uploading.

Browser memory is not executable. `browser-fast` never writes learned content or automatically persists webpage text, and it does not execute Browser Harness-style `agent_helpers.py`. Treat active memory as trusted local agent/operator configuration because its contents can influence browser strategy. The Dev-only `browser-memory-author.mjs` stages proposed exact-site knowledge under `candidates/`, which the resolver ignores, and requires a separate explicit `promote` operation before that content becomes active under `sites/`. Promotion never overwrites an existing site-memory file. Summarize reusable mechanics in candidates; do not persist webpage instructions, secrets, personal/candidate data, or one-off form answers as browser memory. Editing memory or the artifact manifest through Dev remains a separate WSL-user-authority action; Local browser access alone does not gain arbitrary filesystem write or Python execution.

Extensions do not receive additional Browser authority. `bin/extension` is an operator/Dev-side installer that preflights declared sources, approved artifacts, memory targets, and alias conflicts before activation. It may copy declared read-only memory contributions, merge explicitly namespaced artifact aliases, and record configured source mappings for an extension. Conflicts fail instead of overwriting another extension. Removal deletes only extension-lifetime contributions and matching aliases; shared platform recognition, learned exact-site memory, and operator-owned source data remain outside the extension lifetime. The extension manager cannot install or remove ChatGPT Skills; that remains client-side state.

`execute` requires an observed tab ID plus the target/backend/profile selection returned by `observe`. On Linux, the complete operation is serialized by resolved backend/profile/tab; independent tabs use separate pinned Agent Browser sessions and may proceed concurrently, while same-tab work remains ordered and fail-closed. Windows serializes within each profile; different explicit profile names use separate data directories, browser processes, Agent Browser sessions, and operation queues. Agent Browser 0.35.0 remains the strict `--pin-tab` observation/ref layer; normalized tab IDs prefer the CDP `targetId`, which Agent Browser accepts as a tab reference and keeps stable across daemon restarts. Immediately before mutation, `browser-fast` reads the selected session's tab list and requires the current target to equal `execute.tab`; it deliberately does not switch tabs in this precondition because switching invalidates snapshot refs. `observe` may explicitly bind a chosen/current target before taking its fresh snapshot, which is the recovery boundary after a strict pinned target is externally closed. Managed Clearcote input is bound back to the same profile-scoped target ID before dispatch through its Playwright context; ref-targeted input does not invent CSS/XPath selectors. Clearcote profile startup is coalesced with process-local promises rather than persistent filesystem locks, so an agent failure cannot strand another agent behind stale ownership. A click may bind exactly one newly created target before later actions; multiple new targets stop the sequence without selecting one, preserving truthful completed/not-run states. On Windows, the default profile remains `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile`, while explicit Browser Fast profiles live under `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profiles\\<name>`; the everyday Chrome user-data directory is not attached, copied, or exposed to `tag:local`. All managed debugging endpoints remain ephemeral and loopback-only. The fast executor never automatically retries a failed, partial, or unknown action batch.

## CodeDB resource guidance

The Personal Workstation Local `code` tools are description-guided, not resource-enforced. A first Code call for a repository may start a persistent rooted CodeDB child and create or update substantial on-disk index state. On large repositories this can consume significant disk and RAM. The model-facing descriptions therefore direct large or unfamiliar repository discovery toward bounded Dev `exec` with `rg` (or Bash when shell syntax is needed) plus focused `read` before CodeDB-backed intelligence when CodeDB state/cost is unknown.

There is no repository-size preflight, threshold, cgroup, or approval database in this design. Because Personal Workstation `exec` and Bash intentionally have the WSL user's authority, description text cannot form a privilege boundary against deliberate raw CLI use; it is routing guidance intended to prevent accidental expensive work.


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

Pinned 1MCP 0.37.0 permits only loopback OAuth callback origins in its consent-page CSP. The reference installer applies fail-closed compatibility patches that permit the exact registered HTTPS callback origin, preserve negotiated capabilities across supervised stdio restarts, and keep restart-stable log rotation. The OAuth patch does not permit arbitrary HTTPS form destinations. Requalify these patches when changing the pinned 1MCP version.

Local capability authority is a separate outer grant from Dev. Unscoped Local discovery plus ordinary call/batch expose public logical servers such as `code`, `terminal`, `host`, `browser-devtools`, and `browser-fast`. Exact read-only inspection may name the hidden Dev recovery server through `tool_list(server="dev")` or `tool_schema(server="dev", tool=...)`; this does not make Dev callable through ordinary Local routes. `fallback_dispatch` is the only Local execution path that bridges into that Dev mirror after `tag:local` authorization.

## Sensitive state

Keep these outside Git:

- `.env` deployment identity;
- generated 1MCP configuration;
- OAuth/session state;
- logs and PID/runtime files;
- Terminal state;
- credentials and tunnel secrets.

Historical engineering evidence under `docs/history/` is excluded from the public reference distribution because it can contain superseded or machine-specific context.
