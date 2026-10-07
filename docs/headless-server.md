# Headless Server

Use the `server` profile for a trusted owner's Linux server. It publishes the same Dev and Local broker surfaces as Personal, but Local contains Terminal and the hidden Dev recovery mirror only. Browser and Host providers, WSLg, and desktop launchers are excluded. Owner-added Local stdio servers remain an explicit capability grant.

## Install

Prerequisites: Linux with systemd user services, Node.js 24+, npm, tmux, git, curl, flock, and cloudflared. Install a native binary for the host architecture. The server profile does not need the legacy shell provider or uv.

Clone the same WebHarness revision used on the workstation. Copy `.env.example` to a private `.env` and set a separate public HTTPS origin, tunnel name, and existing workspace directory. Use a separate machine account and retain that account's state across upgrades.

```bash
./bin/webharness doctor --profile server
./bin/webharness setup --profile server --enable-startup
./bin/webharness status
```

Startup enables lingering user services and starts the bridge and Terminal core. tmux owns terminal processes independently of the bridge. Keep the loopback listener private; Cloudflare is the HTTPS ingress. An existing API gateway on ports 80/443 can remain alongside this outbound tunnel.

## Independent connection

Create a separate Cloudflare tunnel on the server and give it a distinct hostname, such as `mcp-server.example.com`. Register `https://mcp-server.example.com/mcp` as a separate app in the client. Its OAuth grants and runtime state must be separate from the workstation's. Give the app a recognizable machine name so either connection can be disabled independently.

When creating the DNS route from a workstation that already has another tunnel configured, select the new tunnel UUID with an explicit empty configuration:

```bash
cloudflared tunnel --config /dev/null route dns YOUR_SEPARATE_TUNNEL_UUID mcp-server.example.com
```

This prevents the workstation's default tunnel configuration from selecting a different tunnel. Verify the resulting DNS record points at the new UUID before starting the server.

Copy only that tunnel's credential to the server, with mode 0600. Keep the account-wide Cloudflare certificate on the owner's machine. Do not attach different MCP deployments to the same tunnel UUID as replicas: a client must reach the deployment that issued its OAuth grant. Cloudflare explains tunnel routing and replicas in its [routing documentation](https://developers.cloudflare.com/tunnel/concepts/routing/).

## Private owner approval

The pinned 1MCP consent form is an authorization decision, not an owner login. On an internet-facing server, keep consent submission and management private rather than allowing any visitor to approve a new client.

A narrowly allowed Cloudflare ingress can expose discovery, client registration, authorization, token exchange, revocation, health, and MCP while refusing every other path:

```yaml
tunnel: YOUR_SEPARATE_TUNNEL_UUID
credentials-file: /home/user/.cloudflared/YOUR_SEPARATE_TUNNEL_UUID.json
ingress:
  - hostname: mcp-server.example.com
    path: '^/(mcp/?|health/ready|\.well-known/oauth-(authorization-server|protected-resource)(/mcp)?|authorize|token|register|revoke)$'
    service: http://127.0.0.1:3050
  - service: http_status:403
```

Use the configured `MCP_ONE_MCP_PORT` in place of 3050. Validate ingress rules with `cloudflared tunnel ingress validate`. Do not put an interactive login gate over all MCP traffic: the cloud client needs to call these protocol endpoints directly.

To approve an app from the owner's local browser:

1. Start an SSH forward to the server's loopback origin:

   ```bash
   ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:43070:127.0.0.1:3050 user@server
   ```

2. Start connection setup in the client. When its public `/authorize?...` consent page opens, replace only the URL origin with `http://127.0.0.1:43070`. Keep the entire path and query unchanged, including the client ID, redirect URI, PKCE challenge, state, resource, and requested scopes.
3. Inspect the client and requested scopes, then approve through that local page. The form submits through SSH and redirects back to the registered client callback.
4. Close the SSH forward when setup finishes. Normal MCP calls and token refresh use the public URL; the forward is needed only for a new owner approval.

Keep `MCP_PUBLIC_URL` set to the public HTTPS origin throughout. Changing the issuer to localhost would break client discovery and token validation. Each client and each machine receives its own grant. An unauthenticated public `/mcp` call must fail, and public `/oauth/consent` must remain refused.

## Upgrade

Update the committed source, rerender the same `server` profile, and restart the bridge and Terminal broker. Preserve the state root, `.env`, tunnel credentials, and tmux service. Do not regenerate OAuth state or restart tmux just to upgrade MCP providers.

Qualification is limited to the headless Dev/Local/Terminal path. This profile does not imply browser parity with the Personal workstation.

## Optional headless Browser Fast (aarch64 or x86_64, no GPU)

The `server` profile excludes browser providers. An owner can add `browser-fast` alone through `MCP_LOCAL_SERVERS_FILE`; `scripts/doctor.sh` accepts it in the `server` profile only when that variable is set in `.env`. Clearcote is x64-only and is not used. `browser-fast` stays the Linux-target `observe`/`execute` pair; on a non-WSL host an omitted `browser_target` already resolves to `linux`.

Requirements: `xvfb` plus fonts, a Chromium build for the host architecture (for example `npx playwright install chromium`), and `pnpm`/`npm install` in `providers/browser-fast`.

The provider runs one Agent Browser session per tab. Without `--cdp` each session launches its own Chrome and a pinned tab then fails with `No tab with target id ...`. Run one persistent Chromium and attach every session to it:

```ini
# ~/.config/systemd/user/webharness-xvfb.service
[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp
Restart=always
[Install]
WantedBy=default.target

# ~/.config/systemd/user/webharness-chrome.service
[Unit]
Requires=webharness-xvfb.service
After=webharness-xvfb.service
[Service]
Environment=DISPLAY=:99
ExecStart=/path/to/chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=%h/.local/state/mcp-dev-bridge/chrome-profile --no-sandbox --use-gl=angle --use-angle=swiftshader --disable-dev-shm-usage --no-first-run --no-default-browser-check about:blank
Restart=always
[Install]
WantedBy=default.target
```

`~/.config/mcp-dev-bridge/browser-fast.json` selects the external endpoint (the `clearcote` label only means "external CDP port" in version 1):

```json
{"version":1,"linux":{"browser":"clearcote","cdpPort":9222}}
```

`MCP_LOCAL_SERVERS_FILE` points at a JSON file with absolute paths:

```json
{"version":"1.0.0","mcpServers":{"browser-fast":{"type":"stdio","command":"/usr/local/bin/node","args":["/abs/path/webharness/providers/browser-fast/server.mjs"],"env":{"XDG_RUNTIME_DIR":"/run/user/UID"}}}}
```

To also add `browser-devtools`, register `providers/browser/server.mjs` the same way (`command` an absolute `node`, `env` with `XDG_RUNTIME_DIR`, `DISPLAY=:99` and a `PATH` that includes `npx`). With the version 1 config above it attaches to `http://127.0.0.1:9222` instead of launching a browser, so it sees the same tabs as `browser-fast`. `browser-jev` is not part of this setup: it needs the Python worker plus model credentials in `MCP_BROWSER_JEV_ENV_FILE`.

Re-run setup so `local-1mcp/mcp.json` is re-rendered, then restart the bridge. The CDP port is loopback-only; never expose it. Verify with `observe` then a `navigate` through `execute`.

## Troubleshooting

### Approval shows HTTP 403

A consent page at the public `/authorize?...` URL is visible, but its Approve button submits to the private `/oauth/consent` path. With the recommended ingress guard, clicking Approve while still on the public origin returns HTTP 403. This does not mean the OAuth client lacks the selected scopes.

Go back to the original authorization URL, start the SSH forward, and replace only the origin with `http://127.0.0.1:43070` before approving. Preserve the entire path/query. Changing the denied `/oauth/consent` URL alone cannot restore the authorization parameters. If browser history no longer contains the original URL, restart connection setup in the client. The final callback still uses the registered client URL.

### Discovery shows HTTP 404

Check the DNS record's target against the intended tunnel UUID. A workstation's default cloudflared configuration can select its existing tunnel during DNS routing even when a different tunnel is supplied. Use the explicit empty-config command above, then allow the edge route to update and require public health plus OAuth discovery to succeed before retrying client setup.

### Revoked or invalid token shows HTTP 500

Pinned 1MCP 0.37.0 throws a generic error when its access-token session is missing or invalid. The SDK maps that error to `HTTP 500` with `server_error`, rather than the expected OAuth invalid-token refusal status. A deployment check reproduced this after revoking a temporary test grant; no MCP access was granted, and health remained ready. Requests without a bearer token returned HTTP 401.

This is an upstream status-reporting quirk, not evidence that a revoked grant remains usable. Reconnect through owner approval when a grant is invalid. WebHarness does not currently patch this upstream behavior. A future 1MCP upgrade should recheck both refusal and the returned status.
