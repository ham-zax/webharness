# Installation

## Requirements

WebHarness targets Linux and WSL development machines.

Required commands:

```text
node >= 22.19
npm
npx
cloudflared
curl
flock
```

The supplied autostart installer also expects a working systemd user manager. You need an HTTPS route that forwards to the local 1MCP origin on `127.0.0.1:3050`.

## 1. Clone

Clone the repository into a normal user-owned directory and enter it.

## 2. Configure `.env`

```bash
cp .env.example .env
```

Set at least:

```dotenv
MCP_WORKSPACE_ROOT=/home/alice/code
MCP_PUBLIC_URL=https://mcp.example.com
MCP_TUNNEL_NAME=my-mcp-tunnel
```

`MCP_WORKSPACE_ROOT` must be an existing absolute directory.

## 3. Choose a trust profile

For workspace-confined file operations only:

```bash
scripts/setup.sh --profile restricted
```

For Read/Edit/Write plus unrestricted Bash as the Linux service user:

```bash
scripts/setup.sh --profile trusted-dev
```

There is no implicit default profile.

Setup installs the pinned 1MCP runtime, installs the pinned Pi provider dependencies, applies the verified 1MCP OAuth-consent compatibility patch, and renders deployment state outside the repository.

## 4. Install the user service

```bash
scripts/install-systemd-user.sh
systemctl --user start mcp-dev-bridge.service
```

Inspect it with:

```bash
bin/status
```

## 5. Connect ChatGPT

Use `MCP_PUBLIC_URL` as the MCP endpoint in ChatGPT, complete OAuth authorization, then refresh the tool catalog.

Expected tools:

```text
restricted  -> read, edit, write
trusted-dev -> read, edit, write, bash
```

OAuth authorization controls MCP access/scopes; it is not a substitute for a human identity perimeter on an arbitrary public endpoint. See [Security](security.md).

## 6. Verify

Run the local smoke test after the service is healthy:

```bash
scripts/smoke-local.sh
```

Then follow [Acceptance](acceptance.md) for the profile/tool verification.
