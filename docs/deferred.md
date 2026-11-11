# Deferred improvements

Known improvements that were evaluated and intentionally not built yet. Each entry says why it was deferred and what would trigger doing it.

## Repeat agent-instruction experiments with token-aware acceptance

**Status:** proposal after the 2026-10-25 local experiment. No new benchmark
service or runtime gate is installed.

**Observed failures.** A composed candidate reduced a limited byte proxy by
15.3% while recorded input/cache tokens increased. Temporary HTTP processes
also stopped with their launching shell, causing seven failed attempts. Some
trials overlapped and shared a byte trace despite the sequential brief.

**Proposal.** For a later experiment, compare reported tokens before choosing a
candidate, hold fixture processes in a managed terminal, and serialize trials
with separate traces. Include different task structures and schemas that agents
must inspect. Separate client display limits from actual model context use.

**Do it when** repeated production tasks justify another bounded experiment.
Keep existing MCP guidance until separate-task evidence supports a replacement.

## Run `cloudflared` as its own service

**Status:** deferred (decided 2026-10-07). Applies to every host that uses the Cloudflare transport (WSL and the ARM server).

**Today.** `bin/start` calls `bridge_start_cloudflared` (`lib/bridge/common.sh`), which launches `cloudflared tunnel run` with `setsid`, tracked by a pidfile in the bridge run directory. The process stays in the cgroup of the bridge's systemd unit (`mcp-dev-bridge.service`). `bin/stop` and `bin/start` stop and start it together with the bridge, and `lib/bridge/watchdog.sh` re-launches it if it dies.

**Problem.** Every `webharness restart` therefore takes the public tunnel down with the bridge:

- Remote clients see Cloudflare error 1033 for about 20 s until the tunnel reconnects. `restart --wait` hides this from the operator but does not remove it.
- Detached jobs started through the Dev provider's `exec` (`detach: true`) live in the same cgroup and end on restart.

**Proposal.**

1. Add a user unit (for example `webharness-tunnel.service`) that runs `cloudflared tunnel run [$MCP_TUNNEL_NAME]` with `Restart=on-failure`, installed by `webharness setup` next to the bridge unit.
2. Make `bridge_start_cloudflared` and `bridge_stop_cloudflared` no-ops (or status checks) when that unit is active, so `restart` leaves the tunnel alone and the wake proxy answers "not ready" during the gap.
3. Keep the pidfile path for hosts that have no systemd user manager (the current behaviour), and keep the watchdog reconciling in that mode.
4. Cover with `tests/harness.sh` and `tests/lifecycle.sh`: restart keeps the same `cloudflared` pid; stop still stops it when the unit is absent.
5. Detached jobs need their own fix, since this change alone does not move them out of the bridge cgroup. Run them as transient units (`systemd-run --user --scope`/`--unit`) if jobs must survive a restart.

**Why deferred.** The cost is a roughly 20 s blip on a manual restart, which is rare, and the change touches start/stop logic, the watchdog, setup, docs, and tests on both hosts. If the tunnel unit failed, remote access would be lost (SSH still works). The claive supervisor on ARM (`claive-serve`) is a separate unit and is not affected by bridge restarts, so continuous agent work does not depend on this.

**Do it when** restarts become frequent (for example automated deploys or cutovers), when an agent needs detached jobs to survive restarts, or when a tunnel-only crash needs restarting without bouncing the bridge.

**Verify on ARM first** (`ssh -F ssh_config ARM` from the private `myservers` repo), then WSL.

## Fuzzy repository-name resolution and per-call gateway diagnostics

**Status:** proposal after the 2026-11-04 ARM WebHarness incident report. The
read-only directory listing from the same report shipped; these two parts did
not.

**Context.** An assistant read `repo/ahmed-hamza-workout` as `repo/Ahmed
Hamza/workout`, reported `ENOENT`, then reported that repository access was
lost because `exec` and `bash` failed. The listing tool and the built-in
file-access instructions settle both failures: one listing resolves the slug,
and the policy forbids the "access is gone" conclusion.

**Proposal, part one: `find_files`.** A case-insensitive name search under an
authorized root, bounded by depth and result count. Deferred because one
`list_directory` call on the parent answers the same question for every case in
the report, and a search tool adds an unbounded traversal surface for a result
count that `limit` already caps.

**Part two: gateway diagnostics, partially implemented 2026-11-12.** Dev and
Local now emit per-call start/completion records with correlation IDs. Local
passes IDs to direct downstream calls, including Dev execution-worker IPC. The
wake proxy returns an HTTP request ID and logs forwarding attempts and outcomes.
New diagnostic records exclude invocation arguments and contents. See
[reliability guidance](reliability.md) for coverage and mutation-state semantics.

External client/1MCP correlation and the legacy inner-1MCP path remain unresolved.
HTTP request IDs do not automatically correlate with MCP call IDs. Production
connector incidents still need their client, route, timestamp, and request ID.

**Do it when** a future incident shows a name-search need that repeated bounded
listings cannot meet, or when a gateway rejection must be attributed to a
specific layer and `bin/status` plus the 1MCP log no longer suffice.

## Report WebSession adapter health in `bin/status`

**Status:** proposal after the 2026-11-11 `/v1/*` 502 incident. The adapter now has its own unit, but nothing reports it.

**Today.** `bin/status` reports the bridge, the wake proxy, 1MCP, and the terminal broker. It does not mention the adapter. The watchdog probes the public `/mcp` path only. When the adapter stops, `/health` still answers 200, so the deployment looks healthy while `/v1/*` returns 502 after about 30 s.

**Proposal.** Add one read-only line to `bin/status` when the adapter unit is installed or the adapter port answers: unit state, `MainPID`, and `/health/ready`. Report it as informational, not as a bridge failure, because the adapter stays optional. Do not add adapter recovery to the bridge watchdog: the unit already restarts it.

**Do it when** an operator must check `/v1/*` separately from `/mcp`, or when a second silent adapter stop costs an outage.


## Bound the stream-shutdown test before investigating another stall

**Status:** proposal after the 2026-11-12 reliability work. A full run stalled
in the wake-proxy stream-shutdown test. Baseline and changed isolated suites
passed, and the bounded runtime rerun passed. No production cause was established.

**Proposal.** Add explicit deadlines and event-driven fixture readiness to this
test before another stress investigation. Keep a failing deadline visible.
Do not change production shutdown behavior without a reproducible failure.

**Do it when** the stall recurs or the test is next changed.
