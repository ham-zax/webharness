# Operations

## Core commands

```bash
webharness start
webharness status
webharness stop
```

Healthy status should report one config-scoped 1MCP process, local health ready, cloudflared running, watchdog running, public health OK, bounded retained-diagnostic storage, and `issues: 0`. It prints both the rendered live source root and, when different, the checkout from which diagnostics are being run; live watchdog ownership is matched against the rendered root so inspecting from a candidate worktree does not create a false "watchdog stopped" result. In personal mode it also reports the Terminal broker socket and, when the user-systemd bus is directly reachable, `ActiveState` plus `NRestarts` for the broker unit. A missing user bus is reported separately from the broker socket so user-systemd observability ambiguity is not mistaken for broker failure.

## Personal Workstation installed lifecycle

The maintained full reference installation is:

```bash
webharness setup --profile personal --enable-startup
```

The flag is the explicit startup-consent boundary. The bootstrap renders the personal MCP state, installs `wsl-term` under `~/.local/bin`, renders all user units, enables user linger, and runs `systemctl --user enable --now` for:

```text
wsl-agent-tmux.service
wsl-agent-terminal-broker.service
mcp-dev-bridge.service
```

It also installs a personal `mcp-dev-bridge.service.d/personal.conf` drop-in with `Wants=`/`After=` ordering on the broker. That is startup ordering only: the bridge does not own or stop the tmux lifetime service. Once installed, the services start when this WSL user's systemd manager starts in later WSL sessions. Nothing here configures Windows to launch WSL.

Omitting `--enable-startup` prepares dependencies/configuration and the user-local `wsl-term` command but deliberately leaves user-systemd and linger untouched.

## Optional WebSession HTTP compatibility adapter

WebSession is intentionally **manual/on-demand** and is separate from the main bridge lifecycle. Neither `webharness start` nor the personal user-systemd units start or supervise it.

Start it only for an HTTP compatibility window:

```bash
bin/adapter start
bin/adapter status
```

While it is running, the configured tunnel routes `/v1/*` to the adapter. Programmable HTTP clients can use the enhanced POST/JSON profile; constrained GET/open/fetch-only clients can use the universal GET profile. The adapter discovers the current authenticated 1MCP tool catalog dynamically, so it does not require per-tool maintenance when the MCP surface changes.

When finished:

```bash
bin/adapter stop
```

Stopping WebSession does not stop the main `/mcp` endpoint. See [WebSession client bootstrap prompts](websession-clients.md) for client-specific connection prompts and capability handling.

## Smaller-profile user-systemd bridge service

Install the generic bridge unit with:

```bash
scripts/install-systemd-user.sh
systemctl --user start mcp-dev-bridge.service
```

The generated unit uses external `bridge.env` state and the repository's public lifecycle entrypoints.

## Personal Workstation Terminal services: lower-level repair path

The Personal Workstation has two separate user services:

```text
wsl-agent-tmux.service
wsl-agent-terminal-broker.service
```

The personal bootstrap installs these during the normal path. To render/enable only the Terminal units during repair or source cutover, use:

```bash
scripts/install-terminal-broker-user.sh
```

Start them directly only when performing lower-level recovery:

```bash
systemctl --user start wsl-agent-tmux.service wsl-agent-terminal-broker.service
```

Do not restart tmux merely to deploy broker/provider or frontend-launch code. tmux owns the PTY lifetime. Retained-dead panes remain available for reads and exit status, but their transcript `pipe-pane` is finalized at pane death so the per-pane writer receives EOF and exits; broker reconciliation applies the same finalization to historical dead panes that still have a pipe attached.

## Personal Workstation Terminal frontend

The personal provider keeps Terminal sessions headless by default. `MCP_TERMINAL_FRONTEND=kitty|windows-terminal` selects which presentation launcher is used only when a visible collaborative client must be created; `kitty` remains the compatibility default. An already attached designated frontend is reused regardless of this preference. Both launchers attach to the exact existing tmux PTY through `wsl-term present <session>`; neither owns PTY/process lifetime or broker authority.

Kitty discovery order is:

1. `MCP_TERMINAL_KITTY_BIN` when it names an executable;
2. `$HOME/.local/kitty.app/bin/kitty`;
3. `kitty` found on `PATH`.

The Kitty launcher inherits the explicit Terminal broker socket. If GUI variables are missing under WSL, it derives only the Kitty child environment from WSLg sockets: `/mnt/wslg/runtime-dir/wayland-0`, the WSLg X11 socket, and `/mnt/wslg/PulseServer`. It does not change the broker or tmux service environment.

Windows Terminal presentation requires `wt.exe`, WSL interoperability, and a resolvable current distribution. The launcher uses `WSL_DISTRO_NAME` when valid, otherwise parses the distro from the documented `\\wsl.localhost\<distro>` or `\\wsl$\<distro>` form returned by `wslpath -w /`. It uses the running Linux process account and propagates the provider's `process.execPath` as `TERMINAL_NODE_BIN`, so re-entry does not depend on login-shell/NVM `PATH`. `cmd.exe /d /c` starts with child cwd `/mnt/c` to avoid UNC-current-directory fallback.

`cmd.exe /c` is a shell-parsing boundary even though Node supplies an argv array. The Windows launcher therefore builds one guarded command line: ordinary spaces are quoted, and unsupported CMD metacharacters/control characters in dynamic values fail closed before launch. It does not put the broker socket, passwords, MFA values, or other user-entered secrets on the Windows command line; human input travels directly from the local terminal client into the tmux PTY.

Broker state remains readiness authority for Windows Terminal because `wt.exe` can hand off to an existing Windows Terminal host and exit before `wsl-term present` registers. A clean transient launcher exit does not mean presentation failed, and an observed attachment wins over launcher exit status. If `FRONTEND_NOT_READY` says the human attachment is still settling, re-list before retrying or manually attaching so a duplicate window is not created. Only when neither `humanLease` nor `humanAttached` remains should you attach immediately:

```bash
wsl-term attach <session>
```

Automatic-presentation failure never destroys the tmux session. Kitty cleanup is limited to the exact detached Kitty process group it launched. The Windows path does not broadly terminate `wt.exe`, WindowsTerminal.exe, or unrelated terminal windows; a settling/inert presentation tab is safer than killing another user terminal.

Use `wsl-term present <session>` when you want a designated read-only collaborative viewport while the model keeps control; use `watch` for anonymous observation and `attach` for immediate writable human control. `Ctrl-b T` or `wsl-term give <session>` returns the same designated client to read-only/model-owned mode for either frontend.

## User-systemd environment

Some non-login shells do not carry the user-bus environment even though the user manager is healthy. For diagnostics:

```bash
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
systemctl --user status wsl-agent-tmux.service
```

## Logs and state

Default bridge state:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge
```

Default Terminal state:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/wsl-agent-terminal
```

`bin/status` reports current/rotated 1MCP log bytes against the rendered native-rotation policy, finalized Bash spool bytes against the configured aggregate budget, active Bash spool bytes separately, and oldest retained ages. It also flags the obsolete runtime `one-mcp.log` append file if one remains from a pre-hardening launch. 1MCP uses restart-stable tailable Winston rotation, and bridge startup prunes stale numeric log siblings left by the older incrementing rotation mode. Pi Dev performs Bash spool cleanup at startup and opportunistically after every Bash command.

1MCP's current log lives under `mcp-dev-bridge/logs/` and is rotated by the pinned 1MCP/Winston runtime according to `1mcp/config.toml`. Do not recreate shell `>> one-mcp.log` capture. After upgrading from a deployment that predates `config.toml`, rerun the renderer/bootstrap before restart; `scripts/smoke-local.sh` deliberately rejects stale generated state.

Use `bin/status`, `systemctl --user status ...`, and `journalctl --user -u <unit>` before changing state manually. When a non-login shell lacks the user bus, the broker socket remains the direct runtime signal; derive the bus environment as shown above before interpreting `systemctl --user` failures.

## Safe restart order

For ordinary bridge reconciliation after the rendered state is current:

```bash
webharness restart
```

When the installed user-systemd bridge unit is available, this command queues `mcp-dev-bridge.service` for restart with `--no-block`. The systemd manager therefore owns the stop/start sequence and starts it immediately even when the caller is connected through the 1MCP process being replaced or has only a minimal non-login `PATH`. If the user service is unavailable, the CLI falls back to the direct `bin/stop` + `bin/start` lifecycle.

If the source update changed generated provider/application policy (including the bounded 1MCP `config.toml`), rerun `scripts/render-config.mjs` or the appropriate bootstrap first. A fresh hardened 1MCP launch removes the legacy runtime append log and begins native rotated logging.

For a personal broker-code update:

1. keep `wsl-agent-tmux.service` running;
2. rerender/install the Terminal units if their source root changed;
3. restart `wsl-agent-terminal-broker.service` only;
4. restart/reconcile the bridge if provider composition or source paths changed;
5. verify tmux PID/lifetime and bridge health.

## Safe source cutover

Rendered configuration contains absolute provider source paths. Before deleting an old checkout/worktree:

1. verify the new source tree is clean and tested;
2. render the same profile using the new `--repo-root`;
3. rerender the Terminal broker units if personal mode is active;
4. restart the broker without restarting tmux;
5. restart the bridge from a control process that is not inside the 1MCP process tree being replaced;
6. verify generated provider paths, `issues: 0`, local/public health, and a real action call;
7. only then remove the old worktree.

For an installed personal checkout, rerunning `scripts/bootstrap-personal.sh --enable-startup` from the new canonical source root performs the normal render/unit/user-bin convergence before the old checkout is removed.

A tmux-owned Terminal shell is suitable as an external control process because the PTY lifetime is not owned by 1MCP.

## OAuth continuity

1MCP's `--config-dir` is also its writable OAuth/session home. When changing the state root, preserve inbound OAuth continuity with `scripts/migrate-legacy-oauth-state.sh` before replacing the live service. Do not treat Streamable HTTP transport sessions as credential state.

## 1MCP 0.37.0 compatibility

This project intentionally:

- supervises the real 1MCP Node entrypoint instead of relying on `serve --background`;
- reclaims a persisted `runtime.owner` only when no live 1MCP process matches that exact config root, covering malformed records and PID reuse after an unclean WSL restart;
- verifies that the pinned runtime supports structured native `logging.maxSize` / `logging.maxFiles` rotation before relying on it;
- patches 1MCP's consent-page CSP to permit an exact registered HTTPS callback origin; upstream 0.37.0 still permits only registered loopback callbacks, which blocks ChatGPT's HTTPS callback after consent;
- patches 1MCP's stdio supervisor so a recovered client is activated only after the supervisor state has become `connected`; upstream 0.37.0 activates the fresh client while still marked `restarting`, causing `ClientManager` to erase its freshly negotiated capabilities and making the recovered server disappear from `tools/list`;
- uses built-in `mcp.json` hot reload for provider-only changes, including atomic renderer replacements; restart the bridge only when the 1MCP executable itself changes or when observed reload failure requires it.

Failed launches report only native log bytes written by that launch, plus a separate startup-stderr tail when present. Older retained health records are not presented as evidence for the new process.

These are pinned-version compatibility behaviors. Requalify them when upgrading 1MCP.

For the Personal Workstation Local domain, the outer 1MCP exposes only Local `tool_list`, `tool_schema`, `tool_call`, `dispatch_intent`, and `tool_batch` under `tag:local`; the Local provider starts an inner 1MCP over stdio in normal direct mode. Unscoped `tool_list` reports configured logical servers with availability/tool counts; scope it with `server=...` to enumerate that downstream's tools. `tool_batch` repeats one selected downstream route over several structured argument objects with bounded concurrency, avoiding shell/CLI orchestration. That inner config always contains the `browser-devtools` and `browser-fast` surfaces and may also contain explicit owner-configured downstream MCPs from `MCP_LOCAL_SERVERS_FILE`. Owner stdio MCPs are supervised with `restartOnExit: true` by default. The Local child enables only 1MCP's reload management action for broker-owned targeted recovery, while the reserved `1mcp` namespace remains filtered and unreachable through model-facing Local routing. Scoped discovery/schema/batch may reload one configured-but-missing server; a failed direct call is never auto-replayed after recovery because its original outcome may be ambiguous. The renderer writes the inner config before the outer config so a hot reload cannot start Local against a missing file, and carries a deterministic inner-config revision on the outer Local provider so downstream changes recycle only that provider. Stock lazy `tool_invoke` remains outside this path because direct mode preserves downstream MCP results.

Windows browser calls do not attach to the everyday Chrome profile and require no `chrome://inspect` setup. Profileless calls use `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile`, which remains shared by `browser-fast` and `browser-devtools`. An explicit Browser Fast `browser_profile=<name>` instead uses `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profiles\\<name>` with its own Chrome process, DevTools endpoint, Agent Browser session, and operation queue; Browser DevTools currently targets only the shared default. On first use or after the selected browser exits, the runtime launches visible Chrome with `--user-data-dir=<selected directory>` and `--remote-debugging-port=0`, waits for that directory's `DevToolsActivePort`, and health-checks the loopback endpoint. Chrome chooses the port, so the bridge does not reserve a global `9222`. Profiles are persistent: sign into the selected MCP Chrome window once when needed, and cookies/local storage remain across restarts. Do not copy the everyday Chrome data directory into them. Agent Browser 0.35.0 plus its one-shot Windows Node helper remain materialized under `%LOCALAPPDATA%\\mcp-dev-bridge\\agent-browser\\0.35.0`; the helper owns bounded stdout/stderr files so cold daemon startup cannot keep the WSL interop lifetime open. Do not publish debugging endpoints beyond the trusted local machine. `browser_target=linux` selects the separate WSLg paths.

### Selecting the Linux browser backend

`~/.config/mcp-dev-bridge/browser-fast.json` defines the Linux default and managed Clearcote profiles for both browser surfaces. The maintained workstation keeps `clearcote` / `x-main` as its normal default. Do not rewrite this shared selector merely to use Chrome; set `browser_backend="chrome"` on the call that needs Chrome.

For a normal Clearcote operation, use `browser_target="linux"` and omit `browser_backend`, or set `browser_backend="clearcote"`. `browser-fast` returns the resolved `browser_backend` and `browser_profile`; pass those values back to `execute` with the observed tab/ref state. It also owns the managed Clearcote process lifecycle.

Use the same selector on `browser-devtools`. It attaches Chrome DevTools MCP to the live Clearcote CDP endpoint, so both surfaces see the same tabs, cookies, and authenticated session. If that managed profile is not running, initialize it once through `browser-fast` and retry; `browser-devtools` does not launch a second process against the Clearcote profile.

For a Chrome operation, use `browser_target="linux"` with `browser_backend="chrome"`. On `browser-fast`, omit `browser_profile` for the existing shared Chrome behavior, or provide a stable name to create/reuse a persistent isolated profile beneath the bridge state directory. On `browser-devtools`, an explicit Chrome backend keeps the standalone Linux Chrome path; a named profile uses the corresponding persistent bridge-state directory. This does not change `browser-fast.json` or close a managed Clearcote runtime.

When more than one managed Clearcote profile exists and the configured default does not identify the desired one, set `browser_profile` together with `browser_backend="clearcote"`. The named profile must be defined under `clearcote.profiles`; unknown names fail instead of cloning state or falling back. Otherwise omit `browser_profile`; the configured profile, or the only configured Clearcote profile, is used.

Isolation is always explicit. Browser Fast does not switch profiles because another agent is active. Omitted profile means shared browser state. A named profile is persistent rather than incognito, and `observe` returns the resolved target/backend/profile values that must be passed unchanged to `execute`. Windows serializes calls within each profile while allowing different named profiles to proceed independently. On Linux, a call that supplies `browser_profile` must also explicitly supply `browser_backend`.

Managed Clearcote owns persistent profiles beneath bridge state and exposes ephemeral debugging endpoints on loopback only. One runtime is kept per active profile; concurrent startup for the same profile is coalesced in-process, while different profiles may remain live concurrently. The maintained `x-main` profile is shared for authentication state, but independent no-tab observations receive separate tab workspaces and tab-specific Agent Browser sessions, so different agents do not wait behind a Linux-wide operation lock. Reuse the returned `active_tab` for continuation; same-tab work still serializes. Agent Browser owns snapshots, refs, and tab IDs; Clearcote owns supported humanized input. `lightStealth` is optional and defaults off when omitted. Personal bootstrap migrates the known maintained V1 `clearcote:9222` selector to managed V2 `x-main`; other owner-managed V1 external `cdpPort` configurations remain readable but do not support per-call managed-profile selection. Firefox remains unsupported because the current Agent Browser observation layer is Chromium-CDP-only.
