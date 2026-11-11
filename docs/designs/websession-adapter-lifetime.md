# WebSession adapter lifetime and cgroup ownership

- **Status:** Implemented
- **Date:** 2026-11-11
- **Related:** [Operations](../operations.md#optional-websession-http-compatibility-adapter), [Deferred improvements](../deferred.md#run-cloudflared-as-its-own-service)

## Problem

The WebSession adapter is an optional HTTP front end for `/v1/*`. It is not part of the main bridge lifecycle. The bridge service, the watchdog, and `webharness setup --enable-startup` never start it.

An operator or an agent session started it with `bin/adapter start`. That command used `setsid` to detach the process from the terminal. `setsid` creates a new session, but it does not change the cgroup.

An agent session runs inside a `systemd-run` scope. Every process that the session starts stays in that scope. When the scope stops, systemd sends SIGTERM to the whole cgroup. The adapter then exits, and `/v1/*` returns 502 until someone starts it again.

The same class of problem is already recorded for `cloudflared` in [deferred improvements](../deferred.md#run-cloudflared-as-its-own-service).

## Decision

The adapter gets its own lifetime owner: a systemd user unit. Three layers now own three separate things.

| Layer | Owner | Lifetime |
|---|---|---|
| Public transport and `/mcp` | `mcp-dev-bridge.service` | Bridge start, stop, and restart |
| `/v1/*` adapter | `websession-adapter.service` | Its own unit, enabled for user-session startup |
| Caller shell or agent session | `systemd-run` scope | The session |

The bridge stays unaware of the adapter. `tests/adapter-probe.sh` still fails if `bin/start`, `bin/stop`, `bin/status` or the watchdog reference the adapter.

## How it works

### Foreground entry point

`bin/adapter run` is new. It prepares state, resolves the MCP URL, and then `exec`s the server in the foreground. It takes no lock, because the unit owns the lifetime.

The unit calls this action:

```ini
ExecStart=@REPO_ROOT@/bin/adapter run
Restart=always
RestartSec=5
```

`exec` keeps one PID, so the unit `MainPID` is the node process.

### Lifecycle delegation

When the unit file exists at `$XDG_CONFIG_HOME/systemd/user/websession-adapter.service` and the user bus answers, `bin/adapter` delegates:

| Command | Delegated action |
|---|---|
| `bin/adapter start` | `systemctl --user start websession-adapter.service`, then wait for `/health/ready` |
| `bin/adapter stop` | `systemctl --user stop websession-adapter.service` |
| `bin/adapter status` | `systemctl --user is-active` and `MainPID`, then probe `/health/ready` |

`status` keeps its exit codes: 0 running, 1 stopped, 2 active but unhealthy.

Without the unit file, or without a user bus, the old `setsid` path runs unchanged. That path still serves hosts with no systemd user manager, and it still serves the isolated test sandbox.

### Unit contents

| Setting | Value | Reason |
|---|---|---|
| `ExecStart` | `bin/adapter run` | One place resolves env and state |
| `Restart` | `always` | A crash must not need an operator |
| `RestartSec` | `5` | Short gap, bounded restart rate |
| `After` | `network-online.target mcp-dev-bridge.service` | The adapter needs the public MCP URL |
| `Wants` | `network-online.target` | Boot ordering only, no hard dependency |
| `StandardOutput` | `append:<state>/logs/websession-adapter.log` | Keeps the existing request log path |
| `WantedBy` | `default.target` | Starts with the user systemd manager |

The unit sets `HOME` and `PATH`. It inherits `XDG_RUNTIME_DIR` from the user manager.

### Installer

`scripts/install-websession-adapter-user.sh` renders the template, then enables and starts the unit.

| Variable | Effect |
|---|---|
| `WEBSESSION_ADAPTER_SYSTEMD_TARGET_DIR` | Target unit directory |
| `WEBSESSION_ADAPTER_SYSTEMD_DRY_RUN=1` | Render only, no `systemctl` |
| `BRIDGE_STATE_DIR` | State root for the log path |
| `BRIDGE_SYSTEMD_PATH` | `PATH` value written into the unit |
| `--no-start` | Enable without starting |

The installer stops a running manual adapter before it installs the unit. A manual instance holds port 3051 and would block the unit.

### Overrides

| Variable | Effect |
|---|---|
| `WEBSESSION_ADAPTER_UNIT_NAME` | Unit name that `bin/adapter` delegates to |
| `WEBSESSION_ADAPTER_UNIT_FILE` | Unit file path that enables delegation |

## Why not the alternatives

- **Put the adapter in `mcp-dev-bridge.service`.** The repository rule is that the main bridge lifecycle must not reference the optional adapter. A test enforces it. A bridge restart would also take `/v1/*` down.
- **Keep `setsid` only.** It does not change the cgroup, so the process still ends with the caller scope. That is the defect.
- **Use `systemd-run --user --scope`.** A scope created from a session stays a child of that session cgroup. It does not escape the caller.
- **Use a transient `systemd-run --user --unit`.** It escapes the caller cgroup, but it does not survive a reboot and it leaves no unit file to inspect. It was used once as an interim step during the incident.

## Verification

```bash
systemctl --user is-enabled websession-adapter.service
systemctl --user is-active websession-adapter.service
systemctl --user show -p MainPID --value websession-adapter.service | xargs -I{} cat /proc/{}/cgroup
bin/adapter status
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' https://mcp.example.test/v1/client.py
```

The cgroup line must end in `websession-adapter.service`. If it names a `t3code-*.scope` or a shell scope, the process is still owned by the caller.

Restart behaviour:

```bash
kill -9 "$(systemctl --user show -p MainPID --value websession-adapter.service)"
sleep 3
bin/adapter status
```

## Failure modes

| Symptom | Cause | Action |
|---|---|---|
| `/v1/*` returns 502, `/health` returns 200 | No origin listener on port 3051 | `bin/adapter status`, then `systemctl --user status websession-adapter.service` |
| `status` reports `stopped` and the unit is enabled | Unit failed at boot | `journalctl --user -u websession-adapter.service -n 50` |
| `status` returns 2 | Unit active, health not ready | Check the request log and the MCP URL |
| `start` reports `failed to become healthy` | Port busy or MCP discovery failed | Check `ss -ltnp` for port 3051, then the log |
| Delegation does not happen | Unit file missing or user bus unreachable | Run the installer, or check `systemctl --user status` |

## Tests

- `tests/lifecycle.sh`: unit contract, and a dry-run render that `systemd-analyze verify` accepts.
- `tests/adapter-probe.sh`: a fake `systemctl` proves that `start`, `stop` and `status` delegate to the unit instead of spawning a process.
