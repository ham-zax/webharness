# Deferred improvements

Known improvements that were evaluated and intentionally not built yet. Each entry says why it was deferred and what would trigger doing it.

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
