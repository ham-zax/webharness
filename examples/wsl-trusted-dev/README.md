# WSL trusted-dev example

This example represents a dedicated WSL development machine where unrestricted agentic shell authority is intentional.

```bash
cp examples/wsl-trusted-dev/.env.example .env
# edit paths and hostname
scripts/setup.sh --profile trusted-dev
scripts/install-systemd-user.sh
systemctl --user start mcp-dev-bridge.service
bin/status
```

`trusted-dev` does not make the filesystem provider global; its configured workspace roots still come from deployment configuration. The unrestricted shell, however, has the effective access of the Linux account running the bridge.
