# Operations

## Core commands

```bash
webharness start
webharness status
webharness stop
```

Healthy status reports the wake proxy listening, the backend either asleep or ready, cloudflared and watchdog running, local/public health available, bounded diagnostic storage, and `issues: 0`. Intentional backend sleep is healthy and health probes do not wake it. In direct mode, one config-scoped 1MCP process and its held runtime lock remain required. Status prints the rendered live source root and separately reports Terminal broker socket/user-systemd observations in personal mode.

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

WebSession is separate from the main bridge lifecycle. Neither `webharness start` nor the `mcp-dev-bridge` service starts or supervises it. Choose one of two modes.

### Supervised mode

Install the adapter's own user unit once:

```bash
scripts/install-websession-adapter-user.sh
```

The installer renders `websession-adapter.service`, enables it for user-session startup, and starts it. The unit runs `bin/adapter run`, restarts the adapter after a crash, and appends the request log to the state log directory. While the unit is installed, `bin/adapter start`, `bin/adapter stop` and `bin/adapter status` delegate to `systemctl --user`. See [WebSession adapter lifetime](designs/websession-adapter-lifetime.md) for the lifetime model and the cgroup rules.

```bash
bin/adapter status
journalctl --user -u websession-adapter.service -f
```

### Manual mode

Without the unit, start the adapter for one HTTP compatibility window:

```bash
bin/adapter start
bin/adapter status
```

A manual start inherits the systemd scope cgroup of the caller. `setsid` detaches the process from the terminal, but not from that cgroup, so systemd stops the adapter when the calling scope stops. An adapter that an agent session starts therefore ends with that session. Use the supervised unit for long-lived access.

While it is running, the configured tunnel routes `/v1/*` to the adapter. Programmable HTTP clients can use the enhanced POST/JSON profile; constrained GET/open/fetch-only clients can use the universal GET profile. The adapter discovers the current authenticated 1MCP tool catalog dynamically, so it does not require per-tool maintenance when the MCP surface changes.

When finished:

```bash
bin/adapter stop
```

A supervised adapter restarts after a crash and after the next host start. Stop the unit instead when the access window is over:

```bash
systemctl --user disable --now websession-adapter.service
```

Stopping WebSession does not stop the main `/mcp` endpoint. See [WebSession client bootstrap prompts](websession-clients.md) for client-specific connection prompts and capability handling.

## Deploy Dev and WebSession source updates

After updating the configured live source checkout, restart both runtimes so their loaded modules and served Python client come from the new source:

```bash
# From the repository root in an external shell (SSH or Local Terminal):
./bin/webharness restart --wait
./bin/adapter stop
./bin/adapter connect --cwd "$PWD"
./bin/webharness status
./bin/adapter status
```

When invoking the restart from an MCP call owned by the bridge, use plain `restart` and reconnect before the adapter steps; `--wait` requires an external shell. Check the rendered source root in status before assuming this checkout is live. A source update does not require restarting tmux.

Copy the exact prompt printed by `connect` to the remote sandbox promptly: its pair code expires after five minutes by default and can be redeemed only once. If it expires or was already used, run `connect` again for a new code. The prompt uses HTTP requests for pairing and discovery; downloading a helper is optional. Existing capabilities remain subject to their own expiry/revocation; generating a fresh pairing does not revoke older sessions. Use `bin/adapter revoke-cap <capability-id>` when retiring one.

The main bridge restart does not reload an already-running adapter. The adapter's stop/start cycle also clears its in-memory MCP connection pool. See [WebSession clients](websession-clients.md) for client cwd and batch behavior.

## Smaller-profile user-systemd bridge service

Install the generic bridge unit with:

```bash
scripts/install-systemd-user.sh
systemctl --user start mcp-dev-bridge.service
```

The generated unit uses external `bridge.env` state and keeps the foreground watchdog as the supervised service process. It reports ready only after the initial WebHarness reconciliation succeeds; ordinary `webharness start` routes through this unit when it is installed.

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

Run `scripts/smoke-local.sh [MCP_URL]` to check readiness and unauthenticated Bearer refusal. These checks do not prove authorized tool access. To check a harmless UTF-8 file, add `--auth-state-dir DIR --read-path PATH`. This mode requires the installed adapter and an existing unexpired `access_token` in `oauth.json`; it uses that token read-only without refreshing or rotating OAuth credentials (re-run `bin/adapter auth` if the token has expired). It does not print file contents or begin interactive authorization.

After updating the instruction template, re-render the deployment and restart the bridge during an approved maintenance window. The renderer writes both `instructions-template.md` and `activeInstructionTemplate: "webharness"` for the outer and Local inner runtimes. Default `node --test lib/test/instruction-template.test.mjs` qualifies the installed `@1mcp/agent@0.39.8` runtime; to also compare against a pristine upstream tarball before deployment, unpack `npm pack --quiet @1mcp/agent@0.39.8` into `/tmp/<dir>`, link `ln -s "$(npm root -g)/@1mcp/agent/node_modules" /tmp/<dir>/package/node_modules`, and run `WEBHARNESS_REQUIRE_1MCP_QUALIFICATION=1 WEBHARNESS_PRISTINE_1MCP=/tmp/<dir>/package node --test lib/test/instruction-template.test.mjs`.

The Local broker starts a second 1MCP process that writes its own log at `logs/local-inner.log`, rotated by `local-1mcp/config.toml`. A failed browser tool call surfaces as `-32603 Error calling tool` at the client, and the cause is recorded only in that inner log. `bin/status` prints a `Local inner 1MCP logs:` line beside the outer one; both are checked against their own rendered rotation policy.

Use `bin/status`, `systemctl --user status ...`, and `journalctl --user -u <unit>` before changing state manually. When a non-login shell lacks the user bus, the broker socket remains the direct runtime signal; derive the bus environment as shown above before interpreting `systemctl --user` failures.

## Safe restart order

For ordinary bridge reconciliation after the rendered state is current:

```bash
webharness restart
```

When the installed user-systemd bridge unit is available, `webharness start`, `stop`, and `restart` route lifecycle ownership through `mcp-dev-bridge.service`; stop/restart remain non-blocking so an MCP caller can hand the replacement to systemd before its current 1MCP process disappears. The service keeps the watchdog in the foreground as its supervised main process and reports ready only after the initial local/public reconciliation succeeds. If the user service is unavailable, the CLI falls back to the direct `bin/start` / `bin/stop` lifecycle.

From a shell outside the bridge (SSH, a Terminal session, a local console), `webharness restart --wait [--timeout SECONDS]` queues the same restart, then blocks until systemd reports a new invocation of `mcp-dev-bridge.service` as active. Because the unit is `Type=notify`, that state means the public readiness check passed. The command exits 1 if the unit fails or the timeout expires (default 180 s). It refuses to run inside the unit itself, such as a Dev `exec`, because the restart would kill it. From MCP, use plain `restart` and reconnect after about 20 s. `cloudflared` runs inside the same unit, so any restart briefly drops the public tunnel (Cloudflare 1033) and also ends detached Dev `exec` jobs. Without systemd, `restart` already blocks on `bin/start`'s health gate.

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

1MCP's `--config-dir` (`$BRIDGE_STATE_DIR/1mcp`) is also its writable OAuth/session home. When moving a deployment, copy active inbound OAuth session records under `1mcp/sessions/sessions/server/` before replacing the live service, and do not treat Streamable HTTP transport sessions as credential state.

## 1MCP 0.39.8 compatibility

This project intentionally:

- supervises the real 1MCP Node entrypoint instead of relying on `serve --background`;
- holds a kernel `flock` lease for the entire 1MCP process lifetime; the inherited descriptor is released automatically by the kernel on normal exit, crash, SIGKILL, or OOM, so WebHarness ownership does not depend on cleanup code running;
- reclaims upstream 1MCP's persisted `runtime.owner` only after acquiring that process-scoped lease and only when no live 1MCP process matches the exact config root; this is recovery for legacy/crash residue rather than the primary ownership mechanism;
- gives 1MCP a 10-second graceful TERM window by default before escalating to KILL, while retaining the shorter generic daemon stop window for the watchdog and Cloudflare transport;
- verifies that the pinned runtime supports structured native `logging.maxSize` / `logging.maxFiles` rotation before relying on it;
- patches 1MCP's consent-page CSP (`build/sdk/legacy/auth/sdkOAuthServerProvider.js`) to permit an exact registered HTTPS callback origin and completes consent outside `form-action`; upstream 0.39.8 still permits only registered loopback callbacks by default, which blocks ChatGPT's HTTPS callback after consent;
- seeds `InstructionAggregator.setRuntimeInstructionConfiguration(configManager.getRuntimeInstructionConfiguration())` at cold startup in `build/server.js`, because upstream 0.39.8 otherwise applies `activeInstructionTemplate` only on later config hot-reloads while modern `2026-07-28` HTTP `server/discover` ignores `customTemplate`;
- verifies that upstream 1MCP's stdio supervisor marks recovered clients `connected` before `activate()` (#547), preserving negotiated capabilities across supervised restarts;
- uses built-in `mcp.json` hot reload for provider-only changes, including atomic renderer replacements; restart the bridge only when the 1MCP executable itself changes or when observed reload failure requires it.

Failed launches report only native log bytes written by that launch, plus a separate startup-stderr tail when present. Older retained health records are not presented as evidence for the new process.

These are pinned-version compatibility behaviors. Requalify them when upgrading 1MCP.

For the Personal Workstation, outer 1MCP exposes direct Dev plus Local `tool_list`, `tool_schema`, `tool_call`, `fallback_dispatch`, and `tool_batch` under `tag:local`. Local starts an inner 1MCP over stdio in normal direct mode. The inner 1MCP starts on first scoped use and stops after `MCP_LOCAL_INNER_IDLE_MS` (default 30 minutes, `0` disables idle stop), so idle inner providers hold no memory; inner state can be evicted. Terminal PTYs survive independently. Unscoped `tool_list` reports public logical servers including `terminal`, `host`, `browser-devtools`, `browser-fast`, and owner-configured MCPs; the Dev mirror stays hidden there and remains rejected by ordinary `tool_call` and `tool_batch`. When the outer Dev catalog/schema path itself is unavailable, explicit read-only `tool_list(server="dev")` and `tool_schema(server="dev", tool=...)` provide recovery inspection. `fallback_dispatch` can then target that Dev mirror when the normal writable Dev call is unavailable or unreliable, while preserving the same downstream arguments and result. Its `readOnlyHint` is intentional transport metadata, not a side-effect guarantee. `tool_batch` repeats one selected public downstream route over several structured argument objects with bounded concurrency. Owner stdio MCPs are supervised with `restartOnExit: true` by default. The Local child enables only 1MCP's reload management action for broker-owned targeted recovery, while the reserved `1mcp` namespace remains filtered and unreachable through model-facing Local routing. A failed direct call is never auto-replayed after recovery because its original outcome may be ambiguous. The renderer writes the inner config before the outer config and carries a deterministic inner-config revision so downstream changes recycle only Local. Stock lazy `tool_invoke` remains outside this path because direct mode preserves downstream MCP results.

Windows browser calls do not attach to the everyday Chrome profile and require no `chrome://inspect` setup. Profileless calls use `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile`, which remains shared by `browser-fast` and `browser-devtools`. An explicit Browser Fast `browser_profile=<name>` instead uses `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profiles\\<name>` with its own Chrome process, DevTools endpoint, Agent Browser session, and operation queue; Browser DevTools currently targets only the shared default. On first use or after the selected browser exits, the runtime launches visible Chrome with `--user-data-dir=<selected directory>` and `--remote-debugging-port=0`, waits for that directory's `DevToolsActivePort`, and health-checks the loopback endpoint. Chrome chooses the port, so the bridge does not reserve a global `9222`. Profiles are persistent: sign into the selected MCP Chrome window once when needed, and cookies/local storage remain across restarts. Do not copy the everyday Chrome data directory into them. Agent Browser 0.39.0 plus its one-shot Windows Node helper remain materialized under `%LOCALAPPDATA%\\mcp-dev-bridge\\agent-browser\\0.35.0`; the helper owns bounded stdout/stderr files so cold daemon startup cannot keep the WSL interop lifetime open. Do not publish debugging endpoints beyond the trusted local machine. `browser_target=linux` selects the separate WSLg paths.

Raw `agent-browser` callers that attach to an already running Chromium (`--cdp <port> --session <name> --pin-tab`) should use the drop-in `providers/browser-fast/agent-browser-cli.mjs`: `ln -sfn <repo>/providers/browser-fast/agent-browser-cli.mjs ~/.local/bin/agent-browser`. It passes every argument through and closes the blank page a new pinned session allocates once that session moves to another tab or ends. Start such a session with `tab list`; the provider's `observe`/`execute` path reclaims the same page itself.

When a call omits `browser_target`, the browser providers use `windows` on WSL hosts and `linux` elsewhere, so a headless server never tries to reach `cmd.exe`. Detection reads the kernel release because 1MCP does not pass the bridge's environment (including `WSL_DISTRO_NAME`) to provider processes. To override it, set `MCP_BROWSER_DEFAULT_TARGET=windows` or `linux` in the browser server's own `env` block: through `MCP_OWNER_ENV_FILE` on the personal profile, or directly in the `MCP_LOCAL_SERVERS_FILE` entry for an owner-added server. Setting it in the service or `.env` environment has no effect. Each provider resolves the default once at startup, so an invalid value fails provider startup with `INVALID_BROWSER_TARGET` instead of failing every call.

### Selecting the Linux browser backend

`~/.config/mcp-dev-bridge/browser-fast.json` defines the Linux default and managed CloakBrowser profiles for both browser surfaces. The maintained workstation keeps `cloakbrowser` / `x-main` as its normal default. Do not rewrite this shared selector to switch backend; set `browser_backend` on the call that needs a different backend.

For a normal CloakBrowser operation, use `browser_target="linux"` and omit `browser_backend`, or set `browser_backend="cloakbrowser"`. `browser-fast` returns the resolved `browser_backend` and `browser_profile`; pass those values back to `execute` with the observed tab/ref state. It also owns the managed CloakBrowser process lifecycle.

Use the same selector on `browser-devtools`. It attaches to the live CloakBrowser CDP endpoint, so all surfaces see the same cookies and authenticated session. If that managed profile is not running, initialize it once through `browser-fast` and retry; browser-devtools does not launch a second process against the CloakBrowser profile.

For a Chrome operation, use `browser_target="linux"` with `browser_backend="chrome"`. On `browser-fast`, omit `browser_profile` for the existing shared Chrome behavior, or provide a stable name to create/reuse a persistent isolated profile beneath the bridge state directory. On `browser-devtools`, an explicit Chrome backend keeps the standalone Linux Chrome path; a named profile uses the corresponding persistent bridge-state directory. This does not change `browser-fast.json` or close a managed CloakBrowser runtime.

That Linux Chrome mode does not launch today. `browser-fast` fails on the first `observe` with `BROWSER_FAST_OBSERVE_FAILED` and a tab identity from a second browser, and a named profile exits before writing `DevToolsActivePort`. `docs/designs/browser-fast-linux-chrome-repair.md` records the cause. Until the mode is repaired or retired, use managed CloakBrowser for every Linux browser task. Windows Chrome is unaffected.

When more than one managed CloakBrowser profile exists and the configured default does not identify the desired one, set `browser_profile` together with `browser_backend="cloakbrowser"`. The named profile must be defined under `cloakbrowser.profiles`; unknown names fail instead of cloning state or falling back. Otherwise omit `browser_profile`; the configured profile, or the only configured CloakBrowser profile, is used.

Isolation is always explicit. Browser Fast does not switch profiles because another agent is active. Omitted profile means shared browser state. A named profile is persistent rather than incognito, and `observe` returns the resolved target/backend/profile values that must be passed unchanged to `execute`. Windows serializes calls within each profile while allowing different named profiles to proceed independently. On Linux, a call that supplies `browser_profile` must also explicitly supply `browser_backend`.

Managed CloakBrowser owns persistent profiles beneath bridge state and exposes ephemeral debugging endpoints on loopback only. One runtime is kept per active profile; concurrent startup for the same profile is coalesced in-process, while different profiles may remain live concurrently. The maintained `x-main` profile is shared for authentication state, but a blank tab untouched for 10 minutes is reused by the next no-tab observation, and other observations receive separate tab workspaces and tab-specific Agent Browser sessions, so different agents do not wait behind a Linux-wide operation lock. Reuse the returned `active_tab` for continuation; same-tab work still serializes. Agent Browser owns snapshots, refs, and tab IDs; CloakBrowser owns supported humanized input. The Personal bootstrap installs the tracked `cloakbrowser` / `x-main` policy when the file is missing and preserves every existing file; an unsupported backend fails the call with a clear configuration error. Other owner-managed V1 external `cdpPort` configurations remain readable but do not support per-call managed-profile selection. Firefox remains unsupported because the current Agent Browser observation layer is Chromium-CDP-only.

## Browser access from other local harnesses

Local agents can use `scripts/wh-browser.cjs` directly through their shell tool. The CLI starts its own provider daemon and needs neither the WebHarness bridge nor the WebSession adapter. It uses the same installed provider dependencies and browser configuration.

Install the command once:

```bash
ln -sf "$HOME/repo/webharness/scripts/wh-browser.cjs" "$HOME/.local/bin/wh-browser"
wh-browser fast tools
wh-browser fast schema observe
```

For Linux browser work, use a distinct managed CloakBrowser profile for the local task:

```bash
wh-browser fast observe '{"browser_target":"linux","browser_backend":"cloakbrowser","browser_profile":"local-agent-task","scope":"compact"}'
```

Reuse the returned `active_tab` and the same target, backend, and profile on later calls. Close only tabs created by that task. Use one access route per task. Concurrent bridge and standalone tasks need separate browser profiles or explicitly coordinated tab ownership. A different profile name does not isolate a shared Windows CDP browser.

The CLI shares one daemon per tier within its runtime directory. Do not stop a daemon that other tasks use. Provider subprocess cleanup targets only process groups created by that provider, so another harness's independent provider remains outside that cleanup.

## File mutation coordination

Dev serializes cooperating mutations by canonical pathname and existing device/inode identity. Hard-link aliases share the inode lease. Path leases precede sorted inode leases, and Linux abstract sockets coordinate separate Dev processes without lockfiles. Non-Linux hosts use process-local leases.

Editors, Git, and arbitrary shell commands do not participate in these advisory leases. Snapshot checks detect external changes before the mutation guard, but cannot make comparison and writing atomic against external writers. Use separate Git worktrees for independent agents that edit and commit in the same repository.

## Qualify cold startup

After changing idle policy, rerender configuration and restart only the bridge service; leave the tmux and Terminal broker services running. Verify these boundaries:

1. After the idle grace period, `webharness status` reports the backend asleep with no health issues. Repeated public health probes keep it asleep.
2. A harmless authenticated Dev read wakes the backend and returns the expected content. Repeat after another idle shutdown using the client's normal reconnection behavior.
3. Unscoped Local `tool_list` lists configured servers without starting inner providers. Scoped schema discovery starts the inner backend.
4. A long response stream keeps the backend alive.
5. Existing tmux sessions remain usable across bridge sleep/restart.

Cold startup adds first-call latency. An open event stream intentionally keeps 1MCP resident; periodic tool traffic may likewise prevent the idle grace period from elapsing. Backend eviction preserves on-disk OAuth state, but clients must support reinitializing MCP transport sessions after restart. Set `BRIDGE_COLD_START=0` for a client that cannot reconnect.
