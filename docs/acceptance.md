# Acceptance Checklist

Use this after a fresh installation, profile change, or release upgrade.

## 1. Portable tests

From the repository root:

```bash
bash tests/harness.sh
bash tests/publication.sh
bash tests/lifecycle.sh
npm --prefix providers/pi-dev test
npm --prefix providers/pi-dev audit --omit=dev
```

All must pass.

## 2. Render both profiles without touching live state

Use a temporary deployment fixture:

```bash
tmp="$(mktemp -d)"
cat > "$tmp/deployment.env" <<'ENV'
MCP_WORKSPACE_ROOT=/tmp/example-workspace
MCP_PUBLIC_URL=https://mcp.example.test
MCP_TUNNEL_NAME=
ENV
mkdir -p /tmp/example-workspace

node scripts/render-config.mjs --profile restricted \
  --env-file "$tmp/deployment.env" --state-dir "$tmp/restricted"
node scripts/render-config.mjs --profile trusted-dev \
  --env-file "$tmp/deployment.env" --state-dir "$tmp/trusted-dev"
```

Both rendered `mcp.json` files must contain exactly one provider: `dev`.

Expected tool policy:

```text
restricted  -> read, edit, write
trusted-dev -> read, edit, write, bash
```

## 3. Verify the live service

```bash
bin/status
```

Confirm local health, public health, and zero reported issues.

## 4. Local MCP initialize smoke

```bash
scripts/smoke-local.sh
```

This proves local MCP connectivity. It does not replace tool-level acceptance.

## 5. ChatGPT tool smoke

After connecting/refreshing the MCP integration:

- Read: read a harmless workspace text file.
- Write: create a disposable file with a workspace-relative path.
- Edit: replace one exact string in that disposable file and inspect the returned diff.
- Read: verify the edited contents.
- Bash (`trusted-dev` only): run a harmless command such as `pwd` inside the workspace.

Clean up the disposable file afterward.

## 6. Security expectation

Before using `trusted-dev`, verify that the Linux service account contains only the credentials/resources you intentionally allow an unrestricted development agent to reach. Before exposing the route beyond your trusted users, verify the separate authenticated identity/access perimeter described in [Security](security.md).
