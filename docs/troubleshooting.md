# Troubleshooting

Start with `webharness doctor` for configuration/reference-environment issues and `webharness status` for live lifecycle issues. Change one layer at a time.

## A tool call times out around a minute

That is usually a connector/RPC request-duration limit, not a WSL process limit.

For long tests, builds, servers, or watches:

1. start the work in a durable Terminal session;
2. use `wait` for a marker, process exit, port, file, HTTP, or systemd condition;
3. use `terminal_read` for incremental output.

Do not put several long suites into one giant MCP Bash request and interpret a transport timeout as a test failure.

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

## Code results lag immediately after an edit

The rooted CodeDB watcher is eventually consistent. Use Files/Bash for immediate post-edit verification, then use Code once the watcher catches up. Do not switch to a different `project=` argument; repository routing is determined by `cwd`.

## ChatGPT shows an old action catalog

After provider composition changes, refresh Actions/connector metadata and start a fresh MCP-backed session if necessary. Verify the local rendered provider set before blaming the client.
