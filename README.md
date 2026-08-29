# WebHarness

WebHarness is a public reference implementation for turning a WSL development machine into a high-capability MCP workstation for ChatGPT and other MCP clients.

It keeps files, processes, repositories, durable terminals, and browser state on the machine that already owns them, while presenting a compact model-facing capability surface. The maintained full deployment is the **Personal Workstation** (`personal`) profile. Smaller `restricted` and `trusted-dev` profiles demonstrate narrower authority choices.

This repository is a capability showcase and reproducible reference, not a promise of universal host support. The qualified environment is WSL2 + Ubuntu + x86_64 + Node.js 24+ + systemd user services, with WSLg for headed Linux browser capability. See [Reference Environment](docs/reference-environment.md).

## What the workstation exposes

Agents should reason about four capability domains rather than individual backend packages:

| Capability | Use it for | Important boundary |
|---|---|---|
| **Dev** | files, guarded edits, native Bash, durable waits, local host actions | execution has the authority of the selected trust profile |
| **Code** | repository structure, symbols, semantic context, callers/dependencies | routes to the nearest canonical Git root; raw CodeDB tools stay hidden |
| **Terminal** | long-running or interactive commands and human handoff | tmux owns PTY/process lifetime; the broker owns transcript and control state |
| **Local** | high-cardinality local capabilities without bloating the outer MCP catalog | exposes only `tool_list`, `tool_schema`, and `tool_call`; Browser is currently the main downstream domain |

The full workstation composition is deliberately small at the client boundary:

```text
Dev       read edit write file_ops wait bash pc_sleep
Code      code_search code_context code_symbol
Terminal  terminal_open terminal_read terminal_send terminal_resize terminal_list terminal_yield terminal_close
Local     tool_list tool_schema tool_call
            |-- browser-fast      observe / execute
            `-- browser-devtools  Chrome DevTools diagnostics
```

`browser-fast` is for routine interaction. `browser-devtools` keeps the full Chrome DevTools MCP surface for network, console, performance, Lighthouse, heap, screenshots, and detailed debugging.

## Architecture

```text
MCP client (for example ChatGPT)
  |
  | HTTPS + OAuth
  v
Cloudflare Tunnel
  |
  v
1MCP on loopback
  |
  +-- Dev
  +-- Code
  +-- Terminal --------> broker --------> tmux PTYs
  `-- Local
        |
        `-- inner 1MCP
              |-- browser-fast ---------> Agent Browser
              `-- browser-devtools -----> Chrome DevTools MCP
                         |
                         +-- Windows: dedicated persistent MCP Chrome
                         `-- Linux: managed visible Chrome through WSLg
```

Cloudflare is the current public HTTPS transport and 1MCP is the OAuth/MCP gateway. Providers remain local stdio processes. The Local broker exists so adding or upgrading a large downstream tool catalog does not force the entire catalog into every client session.

## Choose an authority profile

There is no silent default. Pick the authority you intend to give the agent.

| Profile | Authority | Reference role |
|---|---|---|
| `personal` | WSL-user paths, native Bash, Code, persistent Terminal, waits, Local/Browser, optional Windows host sleep | maintained full Personal Workstation reference |
| `restricted` | workspace-bounded files plus an allowlisted legacy shell | conservative smaller example |
| `trusted-dev` | workspace-bounded files plus unrestricted Bash as the Linux service user | smaller trusted-development example; use only on a dedicated host |

`trusted-dev` and `personal` can act with the Linux account's authority. The `personal` Local domain can additionally control its dedicated Windows MCP Chrome profile after explicit `tag:local` authorization. Read [Security](docs/security.md) before enabling either powerful profile.

## Quick start

The reference operator flow is:

```bash
cp .env.example .env
# Set MCP_PUBLIC_URL and any profile-specific local paths.

./bin/webharness doctor --profile personal
./bin/webharness setup --profile personal
# Add --enable-startup only when persistent user-systemd startup is intended.

webharness start
webharness status
```

`doctor` is non-mutating. `setup` qualifies dependencies and renders configuration. `--enable-startup` is an explicit consent boundary: without it, setup does not enable user linger or persistent services.

Machine-specific owner policy stays outside the checkout under operator-controlled paths referenced by `MCP_OWNER_CONTEXT_FILE` and `MCP_OWNER_ENV_FILE`. The repository also cannot silently install or replace ChatGPT Skills or client authorization.

Generated configuration and OAuth/session state live outside Git by default:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge/
```

Transient bridge state lives under:

```text
${XDG_RUNTIME_DIR:-/run/user/$UID}/mcp-dev-bridge/
```

## How an agent should route work

Use the narrowest domain that owns the task:

| Task | Route |
|---|---|
| inspect or mutate known files; Git/build/test; bounded command | Dev |
| understand symbols/callers/dependencies after initial repository orientation | Code |
| command must persist, needs a PTY, or may need human input | Terminal |
| routine navigation/forms/clicks in a resource-local browser | Local -> `browser-fast` |
| network/console/performance/screenshot/DevTools investigation | Local -> `browser-devtools` |

For large or unfamiliar repositories, begin with bounded Bash/`rg` and focused reads before paying the cost of a new CodeDB index unless indexed intelligence is specifically useful.

For `browser-fast`, observe first and pass the returned `active_tab` to `execute`. Execution validates that exact pinned CDP target before using observation refs. `observe` is the recovery/rebind boundary if the old target disappears. A click follows exactly one newly created target before later actions; multiple new targets stop the sequence rather than guessing. Failed, partial, or unknown actions are never automatically replayed.

## Why Windows Chrome and WSLg are separate targets

This split came from runtime qualification, not from a preference for two browser implementations.

### WSLg is the Linux GUI compatibility layer

The Linux browser target and the Kitty Terminal frontend run as Linux processes beside the WSL filesystem, processes, and network namespace. WSLg gives those processes visible GUI/audio integration without requiring a separate X server.

A daemon or user-systemd service cannot be assumed to inherit the graphical variables from an interactive shell. Where a GUI child needs them, the harness supplies or derives only that child's WSLg environment from the observed WSLg endpoints:

```text
XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir
WAYLAND_DISPLAY=wayland-0
DISPLAY=:0
PULSE_SERVER=unix:/mnt/wslg/PulseServer
```

The broker/tmux parent environment is not rewritten just to make a GUI launcher work. During Linux Chrome qualification, Chrome selected X11 through WSLg by default; the project therefore treats WSLg as the compatibility boundary and does not claim native Wayland unless a future configuration explicitly selects it.

Terminal follows the same principle. tmux owns the PTY lifetime. Kitty/WSLg and Windows Terminal are presentation adapters that attach to the existing PTY; closing or replacing a frontend must not own the shell process.

### Windows uses a dedicated MCP Chrome profile

The earlier attempt to attach automation to the everyday Windows Chrome profile proved unreliable; direct qualification of that normal-profile debugging endpoint produced `403 Forbidden`. The current design does not require `chrome://inspect` and never copies or attaches the user's normal Chrome data directory.

Instead, the harness owns:

```text
%LOCALAPPDATA%\mcp-dev-bridge\chrome-profile
```

It launches visible Chrome with that custom `--user-data-dir` and `--remote-debugging-port=0`, waits for the profile's `DevToolsActivePort`, health-checks the loopback endpoint, and reuses the browser while it remains healthy. Chrome chooses the debugging port, so the product does not reserve a global `9222`.

Both Windows browser surfaces share that one profile and endpoint:

```text
browser-fast     -> Agent Browser 0.35.0 -> direct CDP WebSocket
browser-devtools -> Chrome DevTools MCP   -> loopback browser URL
```

This gives the agent persistent cookies/sign-ins in an automation-specific browser without granting MCP control over everyday Chrome. The debugging listener remains loopback-only.

Native Agent Browser on Windows also has a client/daemon lifetime wrinkle when invoked through WSL interoperability: the persistent daemon can inherit output handles from a short-lived CLI and keep the WSL call open. The harness uses a one-shot Windows Node helper that redirects CLI stdout/stderr to bounded files and waits for the CLI process exit, so the daemon does not become the lifetime owner of the WSL invocation.

## Day-to-day operation

```bash
webharness start
webharness status
webharness stop
```

`webharness setup --profile personal --enable-startup` is the demonstrated persistent-service path. For Terminal lifetime, broker recovery, logs, safe restarts, source cutovers, and Browser runtime details, see [Operations](docs/operations.md).

## What this adds beyond a direct coding bridge

| Capability | WebHarness reference | Current gap |
|---|---|---|
| Semantic repository intelligence | Code routes to repository-rooted CodeDB search/context/symbol tools | indexing has a real disk/RAM cost and is not forced for every task |
| Durable interactive processes | Terminal separates tmux process lifetime from broker/model control | no built-in cross-chat recording/journal product |
| Event-driven waiting | Dev `wait` persists named process/port/file/HTTP/systemd/timer conditions | a wait does not itself create a new model turn |
| Browser interaction | `browser-fast` provides compact observe/execute with persistent browser state | Chromium/CDP is the qualified browser family |
| Browser diagnostics | `browser-devtools` provides the full Chrome DevTools MCP surface | shares the Local authorization domain with routine Browser |
| High-cardinality local MCPs | Local keeps only three outer metatools and discovers downstream schemas on demand | all MCPs admitted to one Local broker share its authorization domain |
| First-class delegated workers | not implemented in the stabilized runtime | Chat WSL-style Agents and cross-chat recordings are the primary current capability gap |

The next planned additive capability is a small Agents surface—`spawn`, `message`, `status`, `finish`—backed by an Agent Broker. It is intentionally not part of this stabilization and does not require a Workspace/worktree/project-authority subsystem. See the [Agents implementation plan](docs/superpowers/plans/2026-08-29-webharness-agents-implementation.md) for that follow-on.

## End-to-end orchestration example

A single ChatGPT session can use the capability boundaries together without making one provider own the entire workflow:

```text
Dev/Code      inspect the repository and identify the real owner
Terminal      start a long-running service in a durable tmux PTY
Dev wait      wait on HTTP/TCP/process readiness instead of polling
browser-fast  exercise the visible application with compact refs/actions
browser-devtools
              inspect network, console, performance, or screenshots
Dev           edit the responsible source and run bounded checks
WebHarness    rerender/restart the MCP bridge while the tmux PTY survives
Terminal      yield the exact PTY to a human for MFA/sudo/manual inspection
Terminal      resume model control on the same process afterward
```

That separation is deliberate: Dev owns files/commands/readiness, Code owns semantic repository intelligence, Terminal owns durable PTY interaction, and Local owns downstream MCP routing.

## Reference implementation and forking

The full generic workstation source is public, but the maintained qualification is intentionally narrow. The reference currently assumes a pinned globally installed 1MCP 0.36.0 runtime with qualified compatibility patches, a Personal Workstation toolbox, WSL user-systemd, and the documented browser ownership model. Those are reproducibility constraints, not claims that every Linux/macOS/Windows environment is supported.

Forks should preserve the model-facing contracts they rely on, then deliberately replace transport, package ownership, browser lifecycle, or host integration as needed. See [MCP Compatibility](docs/compatibility.md) and [Reference Environment](docs/reference-environment.md).

## Compatibility and security notes

- The project currently pins 1MCP 0.36.0 after qualification of the current provider composition, direct-mode rich Browser results, config reload, and OAuth behavior. Upgrade it deliberately rather than treating it as an unqualified interchangeable dependency.
- 1MCP listens on loopback; Cloudflare supplies the public HTTPS route. OAuth remains required for the public MCP origin.
- The Local broker is one authorization domain. Every downstream MCP admitted behind the same `tag:local` grant must legitimately share that authority.
- Browser debugging endpoints are local implementation details and are not intentionally published beyond loopback.
- Sudo/password/MFA input belongs in a human-controlled Terminal client, not in MCP arguments or agent-visible logs.

See [Security](docs/security.md) for the full trust model.

## Documentation

- [Documentation index](docs/README.md) — choose the right guide
- [Getting started](docs/getting-started.md) — reproduce the reference deployment
- [Reference environment](docs/reference-environment.md) — qualified host/runtime assumptions and forking caveats
- [Architecture](docs/architecture.md) — Dev, Code, Terminal, Local, and Browser ownership
- [MCP compatibility](docs/compatibility.md) — model-facing contract and breaking-change rules
- [Operations](docs/operations.md) — run, inspect, restart, recover, and cut over source
- [Security](docs/security.md) — authority profiles and trust boundaries
- [Personal Workstation](docs/personal/harness.md) — full reference deployment details
- [Acceptance](docs/acceptance.md) — portable gate plus real-WSL qualification
- [Development](docs/development.md) — repository/publication workflow

## License

MIT. See [LICENSE](LICENSE).
