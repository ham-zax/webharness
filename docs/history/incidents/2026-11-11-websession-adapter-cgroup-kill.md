# Incident: WebSession `/v1/*` returned 502 after an agent scope stopped

- **Date:** 2026-11-11
- **Impact:** Public `/v1/*` WebSession routes only. `/mcp` and `/health` stayed available.
- **Duration:** 8 min 12 s of outage (00:03:22Z to 00:11:34Z). The durable fix landed at 00:31Z.
- **Status:** Fixed. The adapter now runs in its own systemd user unit.

## Summary

The WebSession adapter ran inside the systemd scope of the agent session that started it. T3 stopped that scope at 00:03:22Z. systemd sent SIGTERM to every process in the cgroup, and the adapter exited.

Cloudflare then had no origin listener for `/v1/*`. It returned 502 after about 30 s. `GET /health` still answered 200, because the wake proxy and 1MCP serve that path from a different process.

## Timeline (UTC)

| Time | Event |
|---|---|
| 23:30:57 | T3 started `t3code-pi-83e59421.scope` for a Pi session. |
| 23:32:11 | `bin/adapter status` reported `stopped`. |
| 23:32:26 | The session ran `bin/adapter connect --here`. That started the adapter inside the scope. |
| 23:32:27 | Adapter health ready. Pairing prompt issued. |
| 23:34:00 | `mcp-dev-bridge.service` restarted. The adapter kept running, because that service does not own it. |
| 23:34:50 to 00:01:09 | Normal `/v1` traffic: pair, batch, calls, operations. |
| 00:03:22 | T3 stopped the scope. The adapter exited cleanly. |
| 00:04:40 | A `websession-client/1.0` probe reached `/health` and got 200. |
| 00:11:34 | Operator restarted the adapter with `bin/adapter start`. |
| 00:13:33 | Adapter moved to a transient unit, outside the operator session cgroup. |
| 00:15:53 | The client paired again and resumed work. |
| 00:31:15 | Supervised unit `websession-adapter.service` installed and enabled. |

## Evidence

| Source | Observation |
|---|---|
| User journal | `05:33:22 IST: Stopping t3code-pi-83e59421.scope`, then `Stopped`, then `Consumed 21s CPU over 32min`. |
| 1MCP log | `00:03:22.184Z [GET] /mcp completed {"duration":"1446341ms"}`, then `Disconnected transport for session stream-828e...`. |
| Adapter log | Last line `00:01:09.944Z POST /v1/batch`. No error line and no stack trace. |
| `operations.sqlite` | Modification time 00:03Z. No `-wal` or `-shm` files. That is a clean SQLite close, so the process received SIGTERM, not SIGKILL. |
| `bin/adapter status` | `stopped`. No process and no listener on port 3051. |
| `/proc/<pid>/cgroup` after the first restart | `.../t3code-pi-e9afb265.scope`. The operator session scope. The restart repeated the same defect. |

The scope stop at 00:03:22Z and the adapter exit at 00:03:22Z are the same second.

## Root cause

`bin/adapter start` used `setsid` to detach the adapter from the terminal. `setsid` creates a new session. It does not change the cgroup.

An agent session runs inside a `systemd-run` scope. A process that the session starts stays in that scope, even after `setsid`. When the scope stops, systemd sends SIGTERM to every process in the cgroup. The adapter then shuts down. Its `shutdown()` handler closes the server and the SQLite store, then exits 0. That is why the log has no error.

Nothing supervised the adapter. The bridge service does not own it, by design. So the adapter stayed down until an operator noticed the 502.

## Why the error took about 30 s

cloudflared had a healthy tunnel and a configured route to `127.0.0.1:3051`. Nothing listened on that port. cloudflared waited for the origin connection and then reported `cfOrigin;dur=30825 ms` with HTTP 502.

## What did not cause it

- **No memory pressure.** The kernel log had no OOM kill.
- **No bridge restart.** `mcp-dev-bridge.service` started at 23:34Z and stayed active. The adapter survived that restart.
- **No test run.** `tests/adapter-probe.sh` isolates `HOME`, state, port, and log file. It cannot stop the production adapter.
- **No crash.** A crash writes a stack trace to the log. The log ends with a normal request line.

## Fix

The adapter now has its own lifetime owner. See [WebSession adapter lifetime](../../designs/websession-adapter-lifetime.md) and [operations](../../operations.md#optional-websession-http-compatibility-adapter).

1. New unit template `systemd/websession-adapter.service.in`. It runs `bin/adapter run` with `Restart=always`, `RestartSec=5`, and `WantedBy=default.target`.
2. New installer `scripts/install-websession-adapter-user.sh`. It renders the unit, enables it for user-session startup, and starts it.
3. `bin/adapter` gains a foreground `run` action for the unit. `start`, `stop` and `status` delegate to `systemctl --user` when the unit is installed. The `setsid` path stays for hosts without a user systemd manager.
4. Docs: `operations.md`, `troubleshooting.md`, `websession-clients.md`, `websession-master-bearer.md`, and two personal docs.
5. Tests: `tests/lifecycle.sh` checks the unit contract and renders the unit. `tests/adapter-probe.sh` checks that lifecycle commands delegate to systemd instead of spawning a process in the caller cgroup.

## Verification after the fix

| Check | Result |
|---|---|
| `systemctl --user is-enabled websession-adapter.service` | `enabled` |
| `systemctl --user is-active websession-adapter.service` | `active` |
| `/proc/<MainPID>/cgroup` | `.../app.slice/websession-adapter.service` |
| `kill -9 <MainPID>` | New MainPID and ready health after 2.2 s |
| `bin/adapter stop` then `start` | Unit inactive, then active with ready health |
| `curl https://mcp.hamza.my.id/v1/client.py` | 200 in 0.48 s |
| `curl https://mcp.hamza.my.id/health` | 200 in 0.45 s |
| `scripts/test-all.sh` | All suites pass |

## Prevention

- The unit restarts the adapter after a crash, and starts it at user-session startup.
- A lifecycle command cannot place the adapter in a caller scope when the unit is installed.
- `tests/adapter-probe.sh` fails if `bin/adapter` stops delegating to the unit.

## Open item

Nothing reports adapter health during normal operation. `bin/status` covers the bridge only, and the watchdog does not probe `/v1`. The operator found this outage. A proposal is in [deferred improvements](../../deferred.md#report-websession-adapter-health-in-bin-status).
