# Getting Started

WebHarness is a reference implementation for a high-capability ChatGPT workstation. The maintained full deployment is the `personal` profile, documented as the **Personal Workstation**. `restricted` and `trusted-dev` are smaller authority examples built from the same source.

Before installing anything, read [Reference Environment](reference-environment.md). The maintained qualification target is WSL2 + Ubuntu + x86_64 + Node.js 24+ + systemd user services, with WSLg for headed Linux browser capability.

## 1. Configure deployment identity

```bash
cp .env.example .env
```

Set the public MCP URL and any local paths that apply to the profile you intend to use. `.env` is machine-local deployment input and is ignored by Git.

For workspace-bounded profiles, set:

```text
MCP_WORKSPACE_ROOT=/absolute/path/to/code
MCP_PUBLIC_URL=https://mcp.example.com
MCP_TUNNEL_NAME=
```

For `personal`, `MCP_PERSONAL_DEFAULT_CWD` is optional; when omitted, WebHarness uses the WSL user's home directory.

## 2. Diagnose before setup

Run the non-mutating doctor first:

```bash
./bin/webharness doctor --profile personal
```

Doctor validates the selected profile, deployment env, templates, and reference-environment assumptions without writing generated state or starting providers. Missing optional capabilities are warnings; failures identify requirements that prevent the selected deployment from being rendered or qualified.

## 3. Set up a profile

Full Personal Workstation reference deployment:

```bash
./bin/webharness setup --profile personal
```

This installs/qualifies the reference toolbox and provider dependencies, renders the Personal Workstation configuration, and installs `webharness` and `wsl-term` in `~/.local/bin`. It does **not** enable linger or persistent user services unless you explicitly add:

```bash
./bin/webharness setup --profile personal --enable-startup
```

`--enable-startup` is the only setup path that enables persistent user-systemd startup. The bootstrap does not configure Windows to launch WSL.

Smaller authority examples use the same operator command:

```bash
./bin/webharness setup --profile restricted
./bin/webharness setup --profile trusted-dev
```

Read [Security](security.md) before granting `trusted-dev` or `personal` authority.

## 4. Operate the runtime

After setup, use the operator shell:

```bash
webharness start
webharness status
webharness stop
```

A healthy running deployment reports local 1MCP health, Cloudflare transport, watchdog health, public health, and `issues: 0`.

When the model-facing provider composition changes, refresh the ChatGPT MCP connection/catalog so the client sees the current schemas.

## 5. Generated state

Persistent configuration, logs, and OAuth/session state stay outside Git by default:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge/
```

Transient bridge state stays under:

```text
${XDG_RUNTIME_DIR:-/run/user/$UID}/mcp-dev-bridge/
```

The retained `mcp-dev-bridge` path is an implementation compatibility identifier beneath WebHarness branding. Do not move generated OAuth/session state into the checkout.

## Forking the reference

The lower-level scripts remain available for repair and development, but `bin/webharness` is the demonstrated operator surface. The reference bootstrap currently owns a pinned, globally installed 1MCP runtime and applies qualified compatibility patches to it. Forks that need different package ownership, host platforms, transports, or browser lifecycles should change those assumptions deliberately and re-qualify the affected boundaries.

## Next

- [Reference Environment](reference-environment.md)
- [Configuration](configuration.md)
- [Architecture](architecture.md)
- [Operations](operations.md)
- [Security](security.md)
- [Troubleshooting](troubleshooting.md)
