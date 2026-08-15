# WebHarness

**Turn a ChatGPT web session into a native Linux development harness.**

Read, edit, and create files inside your workspace — or opt into full trusted Bash access to the Linux account. WebHarness keeps the model-facing surface compact: four native coding primitives instead of a sprawling generic tool catalog.

WebHarness is a self-hosted Linux/WSL harness for people who want a web-based AI session to work against a real local codebase with predictable file semantics and an explicit trust boundary.

> Independent open-source project. Not affiliated with or endorsed by OpenAI. ChatGPT is a trademark of OpenAI.

## A starting point, not a ceiling

WebHarness is a starting point, not a one-size-fits-all agent stack. Use this repository as the backbone for your particular web-based AI session. You can add or remove tools, change the trust boundary, adapt the MCP surface, and customize the runtime for your machine and workflow.

The four-tool surface in this repository is the tested backbone, not a claim that every setup should stop here. Fork it, trim it down, or extend it around the capabilities your web session actually needs.

## Why WebHarness

Coding over MCP gets awkward when the model has to reason through dozens of overlapping tools, absolute host paths, verbose structured wrappers, and command-specific adapters. This bridge deliberately keeps the model-facing surface small and predictable.

## Four native coding primitives

You get one provider and four concepts:

| Tool | What it means |
| --- | --- |
| **Read** | Read text below the configured workspace root, including bounded line ranges. |
| **Edit** | Apply exact, guarded replacements and return one compact diff. |
| **Write** | Create a new text file atomically; existing files are never silently overwritten. |
| **Bash** | Run one native Bash command string on explicitly trusted development machines. |

## Choose your trust profile

| Profile | Tools | Authority |
| --- | --- | --- |
| `restricted` | Read, Edit, Write | Workspace-confined file operations only. |
| `trusted-dev` | Read, Edit, Write, Bash | Bash runs with the effective permissions of the Linux service user. |

Start with `restricted` unless you intentionally want ChatGPT to have normal developer-shell authority on that machine.

## How it works

```text
ChatGPT
   |
   | authenticated MCP route
   v
1MCP on 127.0.0.1:3050
   |
   v
dev provider
   |
   v
configured Linux / WSL workspace
```

1MCP stays on loopback. The supplied lifecycle manages the local gateway, Cloudflare tunnel process, health checks, and watchdog. Mutable deployment state lives outside the Git checkout.

## Quick start

### 1. Requirements

- Linux or WSL
- Node.js `>=22.19`
- npm / npx
- `cloudflared`
- `curl`
- `flock`
- systemd user services if you use the supplied service installer
- an HTTPS tunnel/hostname that reaches the local 1MCP origin

### 2. Configure the workspace

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
MCP_WORKSPACE_ROOT=/home/alice/code
MCP_PUBLIC_URL=https://mcp.example.com
MCP_TUNNEL_NAME=my-mcp-tunnel
MCP_DEV_MAX_OUTPUT_BYTES=1048576
```

### 3. Choose a profile and render deployment state

```bash
scripts/setup.sh --profile restricted
```

Or, on a dedicated development machine where full shell authority is intentional:

```bash
scripts/setup.sh --profile trusted-dev
```

### 4. Install and start the user service

```bash
scripts/install-systemd-user.sh
systemctl --user start mcp-dev-bridge.service
bin/status
```

### 5. Connect ChatGPT

Point your ChatGPT MCP connection at `MCP_PUBLIC_URL`, complete the OAuth authorization flow, refresh the tool catalog, and verify the expected surface:

```text
restricted  -> Read, Edit, Write
trusted-dev -> Read, Edit, Write, Bash
```

See [Installation](docs/installation.md) and [Acceptance](docs/acceptance.md) for the complete verification path.

## Behavior that matters

### Workspace-relative files

Read, Edit, and Write reject absolute paths, parent traversal, and symlink escapes outside `MCP_WORKSPACE_ROOT`. The model works with paths such as `src/server.ts`, not host-specific absolute paths.

### Exact edits

Edit requires exact unique text before writing. It snapshots the file, refuses ambiguous matches, and stops if the file changes during the operation.

### Create-only writes

Write uses exclusive creation semantics. If a file already exists, the operation fails and the model must use Edit instead.

### Native trusted Bash

`trusted-dev` accepts one normal Bash command string with an optional workspace-relative `cwd`. Timeouts and cancellation terminate the spawned process tree. Large output is bounded for the model while the bridge can retain the full local output in private state.

## Security model

`restricted` and `trusted-dev` are intentionally different products of the same bridge.

- `restricted` does **not** expose Bash. Its model-facing authority is the workspace-confined file primitive set.
- `trusted-dev` Bash is **not a sandbox**. Anything the Linux service user can normally access may be reachable through Bash.
- 1MCP OAuth authorization is not, by itself, a human owner/team identity perimeter for an arbitrary public service. Put the bridge behind an authenticated access boundary appropriate to your deployment.
- This project is a self-hosted development bridge, not a multi-user SaaS isolation layer.

Read [Security](docs/security.md) before enabling `trusted-dev` or publishing the endpoint beyond your own trusted access perimeter.

## Operations

```bash
bin/start
bin/status
bin/stop
```

Persistent state defaults to:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge/
```

Transient runtime state defaults to:

```text
${XDG_RUNTIME_DIR:-/run/user/$UID}/mcp-dev-bridge/
```

`bin/status` reports local/public health, process ownership, and lifecycle problems. See [Operations](docs/operations.md) for recovery and upgrade details.

## Public beta

This repository is a **Public beta** for self-hosted Linux/WSL development environments.

Current constraints worth knowing:

- the bridge pins 1MCP `0.34.4` and applies a fail-closed compatibility patch during setup;
- the pinned 1MCP OAuth server uses finite-lived access-token sessions and does not implement refresh-token exchange, so reconnecting may occasionally be required;
- the supplied runtime assumes a Cloudflare tunnel workflow and systemd user services for autostart;
- multi-user hosted isolation is intentionally out of scope.

## Documentation

- [Installation](docs/installation.md) — get running from a fresh machine
- [Configuration](docs/configuration.md) — workspace, profile, URL, state, and output policy
- [Security](docs/security.md) — authority boundaries and deployment expectations
- [Architecture](docs/architecture.md) — runtime and process model
- [Operations](docs/operations.md) — day-two lifecycle and recovery
- [Acceptance](docs/acceptance.md) — verify an installation or release
- [Development](docs/development.md) — contribute and run the test suite

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and [Development](docs/development.md).

## License

MIT. See [LICENSE](LICENSE).
