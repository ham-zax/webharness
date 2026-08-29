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

## 1MCP 0.36.0 compatibility

This project intentionally:

- supervises the real 1MCP Node entrypoint instead of relying on `serve --background`;
- verifies that the pinned runtime supports structured native `logging.maxSize` / `logging.maxFiles` rotation before relying on it;
- patches 1MCP's consent-page CSP to permit an exact registered HTTPS callback origin; upstream 0.36.0 permits only registered loopback callbacks, which blocks ChatGPT's HTTPS callback after consent;
- uses built-in `mcp.json` hot reload for provider-only changes, including atomic renderer replacements; restart the bridge only when the 1MCP executable itself changes or when observed reload failure requires it.

These are pinned-version compatibility behaviors. Requalify them when upgrading 1MCP.

For the Personal Workstation Local domain, the outer 1MCP exposes only Local `tool_list`, `tool_schema`, and `tool_call` under `tag:local`; the Local provider starts an inner 1MCP over stdio in normal direct mode. That inner config contains the `browser-devtools` and `browser-fast` surfaces. The renderer writes the inner config before the outer config so a hot reload cannot start Local against a missing file. Stock lazy `tool_invoke` remains outside this path because direct mode preserves downstream MCP results.

Windows browser calls do not attach to the everyday Chrome profile and require no `chrome://inspect` setup. The shared Windows runtime owns `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile`; on first use or after that browser exits, it launches visible Chrome with `--user-data-dir=<that directory>` and `--remote-debugging-port=0`, waits for the profile's `DevToolsActivePort`, and health-checks the loopback endpoint. Chrome chooses the port, so the bridge does not reserve a global `9222`. `browser-devtools` passes the resulting HTTP endpoint to Chrome DevTools MCP with `--browserUrl`; `browser-fast` passes the WebSocket endpoint to native Agent Browser with `--cdp` and `--pin-tab`. The profile is persistent: sign into sites in that MCP Chrome window once when needed, and cookies/local storage remain in that directory across restarts. Do not copy the everyday Chrome data directory into it. Agent Browser 0.35.0 plus its one-shot Windows Node helper remain materialized under `%LOCALAPPDATA%\\mcp-dev-bridge\\agent-browser\\0.35.0`; the helper owns bounded stdout/stderr files so cold daemon startup cannot keep the WSL interop lifetime open. Do not publish the debugging endpoint beyond the trusted local machine. Both logical servers default to this Windows profile; `browser_target=linux` selects the separate WSLg paths.

### Switching the Linux browser-fast backend

The live selector is `~/.config/mcp-dev-bridge/browser-fast.json`. It is reread without restarting the bridge. The normal Chrome configuration is:

```json
{
  "version": 2,
  "linux": {
    "browser": "chrome"
  },
  "clearcote": {
    "profiles": {
      "x-main": {
        "fingerprint": "x-main",
        "platform": "linux",
        "brand": "Chrome",
        "headless": false,
        "humanize": true,
        "lightStealth": false
      }
    }
  }
}
```

To use the managed Clearcote profile, change only the Linux selector:

```json
{
  "version": 2,
  "linux": {
    "browser": "clearcote",
    "profile": "x-main"
  },
  "clearcote": {
    "profiles": {
      "x-main": {
        "fingerprint": "x-main",
        "platform": "linux",
        "brand": "Chrome",
        "headless": false,
        "humanize": true,
        "lightStealth": false
      }
    }
  }
}
```

Use `browser_target="linux"` and observe again. `browser-fast` starts and owns the persistent Clearcote profile beneath the bridge state directory and exposes its ephemeral debugging endpoint on loopback only. Agent Browser owns snapshots, refs, and tab IDs; Clearcote owns supported humanized input. `lightStealth` is optional and defaults off when omitted; set it to `true` only when you deliberately want Clearcote's light-stealth metadata preset. In Clearcote 0.27.0 that mode consumes the fingerprint seed while building launch arguments, so the later humanization installer does not receive that seed for its stable motor persona; persistent browser state remains on disk. Switch only between complete `browser-fast` operations and discard prior refs. The V1 external `cdpPort` form remains readable during migration but no separate `clearcote-serve` process is required for V2. Selecting `firefox` fails explicitly because the current Agent Browser observation layer is Chromium-CDP-only; Firefox needs a separate future driver adapter, not another config value.
