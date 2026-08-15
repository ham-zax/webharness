# Configuration

The deployment has two layers: a small `.env` file for machine identity and an explicit trust profile selected during setup.

## Workspace root

```dotenv
MCP_WORKSPACE_ROOT=/home/alice/code
```

Read, Edit, Write, and Bash `cwd` values are interpreted relative to this root. File tools reject absolute paths, parent traversal, and symlink escapes.

## Public URL

```dotenv
MCP_PUBLIC_URL=https://mcp.example.com
```

The URL must be absolute HTTPS. 1MCP uses it when advertising OAuth/protected-resource metadata and the lifecycle uses it for public readiness checks.

## Tunnel name

```dotenv
MCP_TUNNEL_NAME=my-mcp-tunnel
```

If your `cloudflared` configuration already selects the intended tunnel, this may be left empty.

## Bash output policy

```dotenv
MCP_DEV_MAX_OUTPUT_BYTES=1048576
```

This is deployment policy, not a model-controlled tool parameter. Large Bash output is reduced to a bounded model-visible tail; full output may be retained in private bridge state.

## Trust profiles

### `restricted`

```text
read
edit
write
```

No Bash tool is registered.

### `trusted-dev`

```text
read
edit
write
bash
```

Bash executes with the effective permissions of the bridge's Linux service user.

Render either profile with:

```bash
scripts/setup.sh --profile restricted
scripts/setup.sh --profile trusted-dev
```

## State directory

By default persistent state is stored under:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge
```

Override it during setup when needed:

```bash
scripts/setup.sh --profile restricted --state-dir /srv/user-state/mcp-dev-bridge
```

The state directory contains generated bridge configuration and OAuth/session data and should not be committed to Git.
