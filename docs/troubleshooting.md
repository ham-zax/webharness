# Troubleshooting

Start with `webharness doctor` for configuration/reference-environment issues and `webharness status` for live lifecycle issues. Change one layer at a time.

## A tool call times out around a minute

That is usually a connector/RPC request-duration limit, not a WSL process limit.

Treat direct Dev `exec`/`bash` as short-RPC work only. Use 45 seconds as the routing target; if runtime is uncertain or may approach a minute, the mandatory Personal Workstation path is:

1. start the work through Local `server="terminal"` with `terminal_open` in a durable Terminal session;
2. use Dev `wait` for `terminal_exit`, `terminal_output`, a port, file, HTTP, or another readiness condition;
3. call Local `server="terminal"`, tool `terminal_read`, for incremental or final output.

The Dev provider can accept a larger internal `timeout_seconds`, but that does not extend the model-facing connector lifetime. Do not put a long suite into one direct MCP `exec`/`bash` request and interpret a transport timeout as a command failure.

A `timeout_seconds` value above 300 is rejected before the command runs, with `timeout_seconds must be from 1 to 300`. The cap is deliberate, because the deadline cannot outlive the connector window. Do not raise it. Use the Terminal and `wait` path above, or pass `detach=true` to `exec` and wait on its exit file.

## A browser tool call fails with `-32603 Error calling tool`

When the outer 1MCP gateway wraps an upstream failure, or when diagnosing slow/crashing downstream providers, the Local broker records per-server lifecycle, stderr, and failed call diagnostics (`server`, `tool`, `duration_ms`, and error message) in `logs/local-inner.log`.

```bash
grep -n 'browser-devtools' "${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge/logs/local-inner.log" | tail -20
```

Read three things in that line: the upstream server, the elapsed time, and the upstream message.

*   A duration close to 180000 ms means the browser did not start in time. Check that `npx -y chrome-devtools-mcp` starts on its own, and that the browser named in `~/.config/mcp-dev-bridge/browser-fast.json` is reachable.
*   A temp-directory rejection means the path form did not match the target. `browser_target: windows` needs a Windows path such as `C:\\Users\\<user>\\AppData\\Local\\Temp\\shot.png`; `browser_target: linux` needs a POSIX path such as `/tmp/shot.png`. The provider rejects the mismatch before it starts a browser.
*   `BROWSER_CHILD_START_FAILED` means the `chrome-devtools-mcp` process itself did not start.

If the inner log does not exist, the deployment predates the inner `[logging]` block. Re-render with `scripts/render-config.mjs`, then restart the bridge.

## A local server reports `DOWNSTREAM_UNAVAILABLE`

The Local broker (`providers/local-tools/server.mjs`) sends `DOWNSTREAM_UNAVAILABLE` when a forced reload of one downstream server finishes and that server still lists no tools. The message now carries the wait: `local server is configured but unavailable after 34.2s: browser-devtools`.

A reload only restarts the backend. The browser backend boots through `cmd.exe` and `npx` into Windows, which measured 11 to 34 seconds on WSL. A check that runs before the boot finishes reports a healthy server as missing, and each following call starts another restart, so the server never becomes ready.

Since the recovery budget is 90 seconds and polls with backoff, a cold browser recovers inside one call. If the wait expires anyway, the backend itself is failing. Confirm it starts on its own:

```bash
npx -y chrome-devtools-mcp --browserUrl http://127.0.0.1:<port> --no-usage-statistics --no-performance-crux
```

Two `chrome-devtools-mcp` clients on one Chrome also cause this. The `wh-browser devtools` daemon and the MCP `browser-devtools` provider both attach to the same `--browserUrl`, and one can close the pages of the other. Stop the CLI daemon while an MCP client drives that browser.

## `webharness status` reports local health failure

Check the generated source/config paths first:

```bash
webharness status
webharness doctor
cat "${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge/bridge.env"
```

If the config points at a removed checkout, rerender from the canonical repository root and follow [safe source cutover](operations.md#safe-source-cutover).

## Public health fails but local health is ready

Inspect cloudflared and the configured public URL. Verify the tunnel hostname reaches the local 1MCP origin and OAuth remains enabled.

## `/v1/*` returns 502 after about 30 seconds

Cloudflare reached the tunnel, but the adapter origin listener on port 3051 was not there. `/health` still answers because the wake proxy and 1MCP serve it. Check the adapter first:

```bash
bin/adapter status
systemctl --user status websession-adapter.service
```

A manual `bin/adapter start` inherits the systemd scope cgroup of the caller. The adapter then stops, without an error line in its log, when that scope stops. An adapter that an agent session started ends with that session. Install the supervised unit so the adapter survives the caller and restarts after a crash:

```bash
scripts/install-websession-adapter-user.sh
bin/adapter status
```

See [WebSession adapter lifetime](designs/websession-adapter-lifetime.md) for the ownership model.

## `systemctl --user` says it cannot connect to the bus

A non-login process may be missing environment variables. Try:

```bash
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
systemctl --user status
```

## Terminal actions fail

Separate the two lifetime layers:

```bash
systemctl --user status wsl-agent-tmux.service
systemctl --user status wsl-agent-terminal-broker.service
```

- tmux down: PTY lifetime is unavailable.
- broker down with tmux still active: restart the broker; existing tmux panes should survive.
- stale/replaced session errors: the session generation changed; create a fresh wait/read boundary rather than accepting old transcript state.

## `WAIT_SOURCE_UNAVAILABLE`

The durable wait still exists, but its current source cannot be observed (for example, the Terminal broker or user systemd bus is temporarily unavailable). Restore the source and resume the same wait name before its absolute timeout.

## `WAIT_HOLD_EXPIRED`

The first durable baseline could not be committed within the positive call hold. No durable wait was created. Retry with the condition to establish a fresh boundary. Name-only resume should return `WAIT_NOT_FOUND`.

## `pkill -f` killed the calling command

`pkill -f <pattern>` matches the runner's own `bash -c` command line, so it can terminate the calling RPC itself. Inspect with `pgrep -f "[p]attern"` first, or list with `ps -o pid= -o args=` and exclude the caller PID before signalling.


## 1MCP does not come back after killing its process (cold-start mode)

With `BRIDGE_COLD_START=1` the watchdog supervises only the wake proxy and cloudflared; it never respawns an idle or killed 1MCP backend. A bare `kill -TERM <1mcp pid>` therefore leaves the backend down, and the proxy still believes it is `ready`: `/health/ready` only probes the backend and does not change that state. The first real request through the public port returns 502 and marks the proxy `failed`; the next request restarts the backend.

Restart deliberately instead:

```bash
bash lib/bridge/backend-control.sh stop                      # lock-aware backend stop
for _ in 1 2 3; do curl -s -m 40 -o /dev/null http://127.0.0.1:$MCP_ONE_MCP_PORT/health; done   # wakes it
curl -s http://127.0.0.1:$((MCP_ONE_MCP_PORT + 10))/health   # backend itself, not the proxy
```

Stopping the proxy (`SIGTERM`) also works: it stops the backend, and the watchdog restarts only the proxy within about 20 seconds. `webharness restart --wait` is the last resort because it also restarts the tunnel.


## ChatGPT shows an old action catalog

After provider composition changes, refresh Actions/connector metadata and start a fresh MCP-backed session if necessary. Verify the local rendered provider set before blaming the client.
