# Getting Started

WebHarness is a reference implementation for a high-capability MCP workstation (supporting ChatGPT, Claude, Gemini, and other MCP clients). The maintained full deployment is the `personal` profile, documented as the **Personal Workstation**. `restricted`, `trusted-dev`, and `server` are narrower profiles built from the same source.

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

### Provision the Cloudflare transport used by the reference deployment

The maintained workstation uses a locally-managed Cloudflare Tunnel. WebHarness does not create the Cloudflare account, tunnel, DNS record, or Cloudflare authentication files; those remain operator-owned state outside the repository.

Create the tunnel and DNS route with `cloudflared`:

```bash
cloudflared tunnel login
cloudflared tunnel create webharness
cloudflared tunnel route dns webharness mcp.example.com
```

Configure the tunnel in the normal `~/.cloudflared/config.yml`. A minimal example using the default origin port is:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /home/<user>/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:3050
  - service: http_status:404
```

Set the service port to match `MCP_ONE_MCP_PORT` in the deployment `.env` when you change the default. The maintained machine may use the same Cloudflare configuration for other ingress rules; those are unrelated to WebHarness. WebHarness only depends on the MCP hostname reaching the loopback 1MCP origin.

The maintained workstation deliberately leaves this value empty:

```text
MCP_PUBLIC_URL=https://mcp.example.com
MCP_TUNNEL_NAME=
```

With `MCP_TUNNEL_NAME` empty, WebHarness starts `cloudflared tunnel run` with no tunnel argument and `cloudflared` reads the tunnel identity from its default local configuration. Setting `MCP_TUNNEL_NAME=webharness` instead makes WebHarness start `cloudflared tunnel run webharness`. That named selector exists in the implementation, but it is not the path used by the maintained workstation.

A separate future connector path is OpenAI Secure MCP Tunnel. ChatGPT developer-mode apps can choose **Tunnel** as the connection type; OpenAI then routes MCP requests through an OpenAI-hosted tunnel endpoint to `tunnel-client` running inside the private network. For this workstation, the intended equivalent topology would be ChatGPT app -> OpenAI Secure MCP Tunnel -> `tunnel-client` in WSL -> the private 1MCP HTTP endpoint on loopback. `tunnel-client` initiates outbound HTTPS to OpenAI, so the MCP server itself does not need public ingress.

WebHarness does not currently install, configure, supervise, or health-check `tunnel-client`, and it does not render an OpenAI `tunnel_id`, runtime API key, or Platform-organization/ChatGPT-workspace association. The current 1MCP OAuth/public-origin behavior has also not been qualified through this transport. Treat Secure MCP Tunnel as a compatible alternative architecture for the ChatGPT connector path, not as implemented WebHarness support.

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

For a separate Linux server without desktop providers, use `--profile server` and follow [Headless Server](headless-server.md).

Read [Security](security.md) before granting `trusted-dev`, `personal`, or `server` authority.

## 4. Operate the runtime

After setup, use the operator shell:

```bash
webharness start
webharness status
webharness stop
```

A healthy running deployment reports local 1MCP health, Cloudflare transport, watchdog health, public health, and `issues: 0`.

When the model-facing provider composition changes, refresh your MCP client's connection/catalog so it sees the current schemas.

## 5. Optional add-ons (pick only what you use)

Everything below is opt-in and independent of the core bridge. Skip any piece that does not fit your workflow:

- **Per-client connector policy (`connector-policy.yaml`):** By default, WebHarness exposes all direct read and write tools with honest annotations (ideal for ChatGPT, Claude, and standard MCP clients). If you also connect Gemini Web, run `just init-connector-policy` (or copy `config/connector-policy.example.yaml` to `~/.config/mcp-dev-bridge/connector-policy.yaml`) once. It never overwrites an existing file and automatically detects Gemini via `User-Agent: Google` (with `?client=gemini` as an optional URL backup) while leaving other clients untouched.
- **Everyday browser (`browser-daily`):** Only active if you separately install and pair `browse` (`curl -fsSL https://opencode.ai/browse/install | bash`). If you prefer isolated automation browsers (`browser-fast` / `browser-devtools`) or no browser at all, skip it.
- **Linux browser backend (`browser-fast.json`):** `config/browser-fast.example.json` ships a starter managed CloakBrowser profile (`x-main`); rename, add, or replace profiles per host without modifying tracked files.
- **Optional CLI accelerators & `pueued.service`:** `scripts/setup-personal-toolbox.sh` (and `--headless` on servers) checks existing binaries first and skips any tool that already meets version requirements, so it never installs duplicates. See [Personal Linux CLI Toolbox](personal/toolbox.md).
- **Optional `justfile` workflows:** When `just` is installed, run `just host-audit`, `just test-fast`, `just deploy`, or `just update` from the repository root instead of typing multi-step shell commands.
- **Optional Gemini Web userscript:** `scripts/gemini-auto-continue.user.js` is a standalone browser userscript (Tampermonkey/Violentmonkey) for Gemini Web checkpoints and confirmation cards. Review its default-armed behavior in [Operations](operations.md#per-client-connector-policy-connector-policyyaml) before enabling it.

## 6. Generated state

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
