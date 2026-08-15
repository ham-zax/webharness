# WSL trusted-dev example

This example is for a dedicated WSL development environment where Bash authority as the Linux service user is intentional.

```bash
cp examples/wsl-trusted-dev/.env.example .env
# edit the workspace, public URL, and tunnel name
scripts/setup.sh --profile trusted-dev
scripts/install-systemd-user.sh
systemctl --user enable --now mcp-dev-bridge.service
bin/status
```

Expected ChatGPT tools after connection/refresh:

```text
Read
Edit
Write
Bash
```

Read [Security](../../docs/security.md) before using this profile on an account that holds sensitive credentials or broad host access.
