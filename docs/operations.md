# Operations

## Daily commands

```bash
bin/start
bin/status
bin/stop
```

For normal autostart:

```bash
scripts/install-systemd-user.sh
systemctl --user enable --now mcp-dev-bridge.service
```

## Healthy state

`bin/status` should show one config-scoped 1MCP process, one `cloudflared` process, one watchdog, healthy local/public readiness, and zero lifecycle issues.

The lifecycle deliberately avoids global process-name killing. It owns processes through scoped PID files/process groups and checks that the listener/process command belongs to the configured bridge.

## Logs and state

Persistent state defaults to:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge
```

Transient runtime state defaults to:

```text
${XDG_RUNTIME_DIR:-/run/user/$UID}/mcp-dev-bridge
```

Use `bin/status` to confirm the resolved locations for the active deployment.

## Watchdog recovery

The watchdog runs only after local and public readiness succeed. It shares the lifecycle lock with manual start/stop operations and can reconcile 1MCP or `cloudflared` after an unexpected exit.

## Failed startup

Startup is transactional. If 1MCP, `cloudflared`, or public readiness fails, the bridge rolls managed processes back instead of leaving a half-started service. Fix the reported condition and run `bin/start` again.

## 1MCP compatibility patch

The public beta pins `@1mcp/agent@0.34.4`. During setup, the bridge verifies the installed OAuth consent CSP and permits an HTTPS form target (`form-action 'self' https:`) when the exact expected upstream source shape is present.

Setup refuses to patch an unexpected 1MCP source file. Revalidate this compatibility behavior before changing the pinned 1MCP version.

## Safe upgrades

1. Stop the service or schedule maintenance outside active tool calls.
2. Update the repository.
3. Run `scripts/setup.sh --profile <your-profile>` to reinstall pinned dependencies and render current configuration.
4. Restart `mcp-dev-bridge.service`.
5. Run `bin/status` and [Acceptance](acceptance.md).

Do not delete the external 1MCP state directory merely to change provider configuration; doing so can discard valid OAuth continuity.
