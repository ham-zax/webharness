# Operations

## Core commands

```bash
webharness start
webharness status
webharness stop
webharness restart        # non-blocking via mcp-dev-bridge.service when installed
```

Healthy status shows the wake proxy listening, 1MCP asleep or ready, `cloudflared` and watchdog running, local/public health OK, bounded log/spool usage, the rendered live source root, and `issues: 0`. Intentional backend sleep is healthy; health probes never wake it.

## Personal Workstation installed lifecycle

```bash
webharness setup --profile personal --enable-startup
```

`--enable-startup` renders state, installs `~/.local/bin/{webharness,wsl-term}`, enables user linger, and enables three user-systemd units:

- `wsl-agent-tmux.service` — owns PTY/process lifetime (do not restart just to update broker or bridge code)
- `wsl-agent-terminal-broker.service` — owns session metadata, transcripts, and human/model leases
- `mcp-dev-bridge.service` — supervises the foreground watchdog, wake proxy, and `cloudflared` (with `Wants=`/`After=` on the broker only for startup ordering)

Omitting `--enable-startup` prepares dependencies, config, and `~/.local/bin` commands without touching systemd or linger. Setup does not configure Windows to launch WSL.

For smaller profiles (`restricted`, `trusted-dev`), install the bridge unit with `scripts/install-systemd-user.sh` and start `mcp-dev-bridge.service`. For lower-level Terminal repair, run `scripts/install-terminal-broker-user.sh`.

If a non-login shell lacks the user D-Bus environment:

```bash
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
```

## Optional WebSession HTTP compatibility adapter

WebSession is independent of `webharness start`/`stop`.

- **Supervised (recommended for long-lived access):** `scripts/install-websession-adapter-user.sh` installs and starts `websession-adapter.service`. `bin/adapter start|stop|status` then delegate to systemd. Disable with `systemctl --user disable --now websession-adapter.service`.
- **Manual (single window):** `bin/adapter start` / `bin/adapter status` / `bin/adapter stop`. Manual starts inherit the caller's systemd scope and stop when that scope exits.

See [WebSession clients](websession-clients.md) and [WebSession adapter lifetime](designs/websession-adapter-lifetime.md).

## Deploy Dev and WebSession source updates

From an external shell (SSH or Local Terminal) in the repository root:

```bash
./bin/webharness restart --wait
./bin/adapter stop
./bin/adapter connect --cwd "$PWD"
./bin/webharness status
./bin/adapter status
```

From inside an MCP call owned by the bridge, use `just deploy` (or plain `restart` with a 1s detached delay, never `--wait`) and reconnect after ~15–20s. `webharness restart` does not reload a running WebSession adapter and does not require restarting tmux.

## Safe restart order

1. If provider composition, `config.toml`, or instruction templates changed, re-render first (`just render personal` or `node scripts/render-config.mjs --profile <profile>`).
2. For broker-only updates: keep `wsl-agent-tmux.service` running and restart only `wsl-agent-terminal-broker.service`.
3. Restart the bridge with `webharness restart` (or `webharness restart --wait` from an external shell). Because `cloudflared` runs in `mcp-dev-bridge.service`, restarts cause a brief tunnel reconnect (~20s) and end detached Dev `exec` jobs—use `pueued.service` or tmux for jobs that must survive restarts.

## Safe source cutover

Rendered configs embed absolute source paths. Before removing an old checkout or worktree:

1. Verify the new checkout is clean and tested.
2. Re-render from the new `--repo-root` (or run `scripts/bootstrap-personal.sh --enable-startup` from the new root).
3. Re-install/restart `wsl-agent-terminal-broker.service` without restarting `wsl-agent-tmux.service`.
4. Restart the bridge from an external shell (such as a tmux pane).
5. Verify rendered source root, `issues: 0`, and a live tool call before deleting the old checkout.

**OAuth continuity:** Copy active inbound OAuth session records under `$BRIDGE_STATE_DIR/1mcp/sessions/sessions/server/` when migrating hosts.

## Logs, state, and smoke checks

- Bridge state: `${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge` (`logs/one-mcp.log`, `logs/local-inner.log`, `1mcp/config.toml`, `local-1mcp/config.toml`)
- Terminal state: `${XDG_STATE_HOME:-$HOME/.local/state}/wsl-agent-terminal`
- Smoke check: `scripts/smoke-local.sh [MCP_URL]` (checks readiness and unauthenticated refusal). Add `--auth-state-dir DIR --read-path PATH` to verify authorized read access using an existing unexpired adapter token.
- Instruction-template check: `node --test lib/test/instruction-template.test.mjs`.

## 1MCP 0.39.8 compatibility

WebHarness pins `@1mcp/agent@0.39.8` with targeted runtime supervision and patches:

- Supervises the real Node entrypoint directly (never `serve --background`) under a kernel `flock` lease with a 10s graceful TERM window.
- Patches consent-page CSP to allow exact registered HTTPS callback origins (required by hosted web connectors) and seeds `InstructionAggregator` at cold start so `activeInstructionTemplate` applies before hot reload.
- Uses Winston native tailable file rotation configured via `1mcp/config.toml` and hot-reloads `mcp.json` changes automatically.

Requalify these patches whenever upgrading 1MCP.

## Per-client connector policy (`connector-policy.yaml`)

External MCP connectors (not `User-Agent: websession-adapter/*`) are shaped per client via `~/.config/mcp-dev-bridge/connector-policy.yaml` (override with `BRIDGE_CONNECTOR_POLICY_FILE`).

- Run `just init-connector-policy` on a fresh host to copy `config/connector-policy.example.yaml` only if missing (never overwrites local edits).
- Changes hot-reload on the next `initialize` or `tools/list`; transient read/parse errors retain the last-good policy and log `connector_policy_parse_warning`.
- `clients:` rules run top-to-bottom (first match wins); multiple keys inside `match:` use AND semantics; unknown match keys fail closed. `query_client` is exact case-insensitive (`?client=<value>`); `user_agent` and `client_info` are case-insensitive regexes (substring fallback).
- Default policy keeps direct read + write tools with honest annotations for ChatGPT/Claude. The starter template matches Gemini automatically via `user_agent: "^Google$"` (with `?client=gemini` as backup), hiding outer write tools and applying `compat_annotations: true` to `local_fallback_dispatch` only for Gemini.
- Set `log_client_identifiers: true` to log exact client headers (`connector_client_identified`) in wake-proxy logs.

**Optional Gemini Web userscript:** `scripts/gemini-auto-continue.user.js` (Tampermonkey/Violentmonkey) automates checkpoints and confirmation cards. As of `v1.3.0`, both `armed` and `autoAllow` (no allowlist) start ON on page load unless disarmed in the widget—install only where unattended approval is intended.

## Browsers & standalone CLI (`wh-browser`)

- **Default target:** Omitted `browser_target` resolves to `windows` on WSL and `linux` elsewhere (override per server via `MCP_BROWSER_DEFAULT_TARGET` in `MCP_OWNER_ENV_FILE` or `MCP_LOCAL_SERVERS_FILE`, not `.env`).
- **Windows:** Profileless calls share `%LOCALAPPDATA%\mcp-dev-bridge\chrome-profile` across `browser-fast` (Agent Browser `0.43.0`) and `browser-devtools` on an ephemeral loopback `DevToolsActivePort`. Named `browser_profile=<name>` calls isolate under `chrome-profiles\<name>`. Everyday Chrome is never attached or copied.
- **Linux/WSLg:** `~/.config/mcp-dev-bridge/browser-fast.json` sets the default backend/profile (starter template uses CloakBrowser `x-main`, customizable per host). Override per call with `browser_backend="cloakbrowser"|"chrome"` (supplying `browser_profile` on Linux requires explicit `browser_backend`). Managed CloakBrowser coalesces startup per profile, reuses blank tabs idle for 10m, and runs different tabs concurrently while serializing same-tab work.
- **Everyday browser (optional):** `browser-daily` proxies to `browse mcp` (`opencode.ai/browse`) only if you install and pair `browse`.
- **Standalone CLI:** Symlink `scripts/wh-browser.cjs` to `~/.local/bin/wh-browser` to drive `browser-fast`/`browser-devtools` directly from local shells without the MCP bridge (`wh-browser profile list`, `wh-browser profile add <name>`, `wh-browser proxy set <name> <url>`, `wh-browser open <name> <url>`).
- **Raw `agent-browser` drop-in:** Symlink `providers/browser-fast/agent-browser-cli.mjs` to `~/.local/bin/agent-browser` to auto-close orphan blank pages on pinned `--cdp` sessions.

## Terminal frontend & file leases

- **Terminal frontend:** Sessions start headless by default. `MCP_TERMINAL_FRONTEND=kitty|windows-terminal` selects the collaborative launcher (`kitty` default under WSLg; `windows-terminal` via `wt.exe` re-entry). Use `wsl-term present <session>` for read-only viewing, `wsl-term attach <session>` for writable control, and `Ctrl-b T` or `wsl-term give <session>` to hand control back.
- **File mutation coordination:** Dev serializes cooperating mutations by canonical path and device/inode using Linux abstract sockets (process-local on non-Linux). External editors/Git/shell commands do not participate—use separate Git worktrees for concurrent editing agents.

## Qualify cold startup

1. After `BRIDGE_WAKE_IDLE_MS` (default 30m), `webharness status` reports backend asleep and `issues: 0`; `/health/ready` keeps it asleep.
2. An authenticated Dev read wakes 1MCP cleanly; unscoped `local_tool_list` does not wake inner providers.
3. Existing tmux sessions survive bridge sleep and restart. Set `BRIDGE_COLD_START=0` only if a client cannot reconnect after idle eviction.

## Optional background task queue (`pueued.service`) and `justfile` recipes

Install the standalone queue unit (also invoked best-effort by `--enable-startup` when `pueued` is installed):

```bash
scripts/install-pueued-user.sh
```

`pueued.service` runs in its own cgroup with `parallel=1` so heavy builds and tests survive `mcp-dev-bridge.service` restarts.

Repository `justfile` recipes (compact output, zero inline shell pipelines):

- `just test-fast` / `test-pidev` / `test-shell` / `test-all`: log-redirected test suites printing only counts and failures.
- `just queue <cmd>` / `queue-status` / `queue-log <id>`: submit and inspect `pueue` background tasks.
- `just diff [args]` / `just loc`: AST diffs (`difft`) and LOC counts (`scc`) with standard fallbacks.
- `just inspect-dev` / `inspect-local` / `inspect-mcp`: probe MCP servers directly via `mcp-inspector --cli`.
- `just host-audit` / `init-connector-policy` / `render` / `status` / `deploy` / `update` / `ship "<msg>"`: audit, starter policy init, and standalone publish/deploy helpers (never mix `ship`/`deploy`/`update` into multi-step `calls[]` batches).
