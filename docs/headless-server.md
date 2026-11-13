# Headless Server

Use the `server` profile for a trusted owner's Linux server. It publishes the same Dev and Local broker surfaces as Personal, but Local contains Terminal, the read-only skill library and the hidden Dev recovery mirror. Browser and Host providers, WSLg, and desktop launchers are excluded. Owner-added Local stdio servers remain an explicit capability grant.

## Install

Prerequisites: Linux with systemd user services, Node.js 24+, npm, tmux, git, curl, flock, and cloudflared. Install a native binary for the host architecture.

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

## Owner approval from a home browser

The supported cross-device mode is a hosted connector with its own registered HTTPS callback. ChatGPT, Claude, and Gemini web sessions register an HTTPS callback on their own platform, so the approval round trip never touches a loopback address:

```text
web client   -> POST /register          platform callback registered
home browser -> GET  /authorize?...     owner signs in, approves once
home browser -> POST /oauth/consent     approval, same origin
home browser -> 302  https://<platform>/callback?code=...&state=...
platform     -> POST /token             code plus PKCE verifier
web client   -> POST /mcp               Bearer access token
```

The owner opens the authorization link on the home browser and approves. The browser then redirects to the platform's registered HTTPS callback, the platform backend exchanges the code, and the web client continues on its own. The headless server needs no desktop, no browser, no SSH forward, and no URL editing. The exact registered callback, `state`, and PKCE `code_challenge` are carried through unchanged; the server never rewrites a callback.

Two properties make this work and must be preserved:

- `/authorize` and `/oauth/consent` are reachable from the owner's browser over the public HTTPS origin.
- Every other protocol path stays directly reachable by the client without an interactive login: `/mcp`, `/register`, `/token`, `/revoke`, discovery, and `/v1/*`.

A client that registers a `http://127.0.0.1:PORT/callback` redirect is a same-machine client. Its callback resolves on whichever machine runs the browser, so it cannot complete from a different computer. That is a client limitation, not a server setting: WebHarness does not rewrite a registered loopback callback, and this deployment offers no device-code or callback-relay flow. Use a hosted connector for cross-device approval, or run the loopback client on the machine with the browser.

## Owner gate on the approval routes

The pinned 1MCP consent form is an authorization decision, not an owner login. Gate exactly the two browser routes with Cloudflare Access restricted to the owner's identity:

| Path | Access policy | Routed to |
| --- | --- | --- |
| `/authorize` | owner identity only | `http://127.0.0.1:3050` |
| `/oauth/consent` | owner identity only | `http://127.0.0.1:3050` |
| every other protocol path | no Access application | `http://127.0.0.1:3050` |

Do not create a hostname-wide Access application. An interactive login on `/mcp`, `/register`, `/token`, `/revoke`, discovery, or `/v1/*` breaks the protocol clients that must call those endpoints directly.

Before enabling the gate, confirm the effective path match including trailing-slash variants and any alternate ingress route, and confirm that an unauthenticated `POST /oauth/consent` is refused. Keep the origin loopback-only. Preserve authorization state and callback parameters across the Access login; the owner's browser session expiring affects future approvals only, never an existing connector token.

Create one self-hosted Access application with two public destinations: the server hostname plus `/authorize`, and the same hostname plus `/oauth/consent`. A shared application lets both routes use the same application audience and browser session. Restrict its Allow policy to the owner email. The application and policy can use `720h` (30 days) for the approval-browser session; this is separate from connector token lifetime.

On the narrow ingress rule for those two routes, enable [cloudflared Access JWT validation](https://developers.cloudflare.com/tunnel/reference/origin-parameters/#access). The team name is the part before `.cloudflareaccess.com`, and the audience tag comes from that Access application:

```yaml
  - hostname: mcp-server.example.com
    path: '^/(authorize|oauth/consent)/?$'
    service: http://127.0.0.1:3050
    originRequest:
      access:
        required: true
        teamName: YOUR_TEAM_NAME
        audTag:
          - YOUR_APPLICATION_AUDIENCE
```

Place this rule before the protocol rule, remove `authorize` from the unguarded protocol rule, and replace the consent refusal only after verifying the Access application protects both routes. Validate ingress before restarting the tunnel. The tunnel checks the signed login token before forwarding approval requests, while protocol routes remain outside this guard.

**Installation requirement:** installing the runtime does not create the Cloudflare Access application. Until the owner gate is configured and verified, keep the private approval route below and leave public consent refused. Once enabled, test owner login and a real connector callback from the owner browser before claiming the full connection flow is verified.

## Fallback: private approval route

Until the owner gate exists, approve through a private route rather than exposing public consent. A narrowly allowed ingress can expose discovery, client registration, authorization, token exchange, revocation, health, and MCP while refusing every other path:

```yaml
tunnel: YOUR_SEPARATE_TUNNEL_UUID
credentials-file: /home/user/.cloudflared/YOUR_SEPARATE_TUNNEL_UUID.json
ingress:
  - hostname: mcp-server.example.com
    path: '^/(mcp/?|health/ready|\.well-known/oauth-(authorization-server|protected-resource)(/mcp)?|authorize|token|register|revoke)$'
    service: http://127.0.0.1:3050
  - service: http_status:403
```

Use the configured `MCP_ONE_MCP_PORT` in place of 3050. Validate ingress rules with `cloudflared tunnel ingress validate`.

To approve an app, open the SSH forward on the same computer as the browser that owns the client session. For Claude in a Windows browser, run this in Windows PowerShell:

```powershell
ssh -F "$env:USERPROFILE\.ssh\config" -N -o ExitOnForwardFailure=yes -L 127.0.0.1:43070:127.0.0.1:3050 YOUR_ARM_HOST_ALIAS
```

Replace `YOUR_ARM_HOST_ALIAS` with the matching `Host` alias from the Windows SSH config. Keep this PowerShell window open while approval is in progress. Check the forward from another PowerShell window:

```powershell
curl.exe -sS -o NUL -w "%{http_code}\n" http://127.0.0.1:43070/health/ready
```

The result must be `200` before you continue. Then:

1. Start or retry connection setup in the client's signed-in browser. Use the same browser profile for approval and the callback.
2. When the public `/authorize?...` page opens, replace only its origin with `http://127.0.0.1:43070`. Keep the full path and query unchanged, including the client ID, redirect URI, PKCE challenge, state, resource, and requested scopes. Keep the configured MCP server URL on its public HTTPS origin.
3. Check the client name and requested scopes, then approve. The form submits through SSH and redirects to the registered client callback.
4. Press Ctrl+C in the PowerShell window after the client reports success. Normal MCP calls and token refresh use the public URL. The forward is needed only for owner approval.

Do not put complete authorization URLs or callback URLs in repository files. They contain temporary OAuth state.

Keep `MCP_PUBLIC_URL` set to the public HTTPS origin throughout. Changing the issuer to localhost would break client discovery and token validation. Each client and each machine receives its own grant. An unauthenticated public `/mcp` call must fail, and public `/oauth/consent` must remain refused.

## Connector lifetime and registrations

An approved connector keeps working until the owner revokes it:

- Access tokens are issued for 365 days (`auth.sessionTtl = 525600` minutes).
- Refresh authority is 365 days and restarts on every successful rotation, so a connector that refreshes normally never reaches a fixed approval deadline.
- Client registrations are durable. A registration records identity metadata only; it grants nothing until the owner approves it.
- A duplicate refresh request inside a bounded retry window returns the original rotation result instead of being treated as a replay. Outside that window the request fails as a token error without revoking an otherwise active connector. Owner revocation and invalid-client rejection still apply immediately.

This is long-lived access, not a promise that a client keeps its credentials or refreshes successfully forever. A client that discards its refresh token needs a new approval.

The `server` profile approves the deployment's whole published tag set in one decision. Scope enforcement is unchanged: the grant is still the published tags, and per-request tag checks still apply.

These lifetime and registration choices are scoped to the `server` profile. The renderer writes `sessionTtl = 525600` and sets `WEBHARNESS_OAUTH_SINGLE_OWNER=1` / `WEBHARNESS_OAUTH_SERVICE_IDENTITY=1` for `server`. Other profiles explicitly receive both flags as `0` so inherited server settings are cleared; `restricted`, `trusted-dev`, and `personal` keep the previous 30-day access-token lifetime, the 30-day registration lifetime, per-tag consent checkboxes, and replay-triggered family revocation. Re-rendering one state directory for another profile rewrites both `bridge.env` and `config.toml`, so a stale single-owner policy is not left behind.

## Upgrade

Update the committed source, rerender the same `server` profile, and restart the bridge and Terminal broker. Preserve the state root, `.env`, tunnel credentials, and tmux service. Do not regenerate OAuth state or restart tmux just to upgrade MCP providers.

Qualification is limited to the headless Dev/Local/Terminal path. This profile does not imply browser parity with the Personal workstation.

## Optional headless Browser Fast (aarch64 or x86_64, no GPU)

The `server` profile excludes browser providers. An owner can add `browser-fast` alone through `MCP_LOCAL_SERVERS_FILE`; `scripts/doctor.sh` accepts it in the `server` profile only when that variable is set in `.env`. Managed CloakBrowser is not used here; sessions attach to the external Chromium below. `browser-fast` stays the Linux-target `observe`/`execute` pair; on a non-WSL host an omitted `browser_target` already resolves to `linux`.

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

`~/.config/mcp-dev-bridge/browser-fast.json` selects the external endpoint (the `cloakbrowser` label only means "external CDP port" in version 1):

```json
{"version":1,"linux":{"browser":"cloakbrowser","cdpPort":9222}}
```

`MCP_LOCAL_SERVERS_FILE` points at a JSON file with absolute paths:

```json
{"version":"1.0.0","mcpServers":{"browser-fast":{"type":"stdio","protocolVersion":"2026-07-28","command":"/usr/local/bin/node","args":["/abs/path/webharness/providers/browser-fast/server.mjs"],"env":{"XDG_RUNTIME_DIR":"/run/user/UID"}}}}
```

To also add `browser-devtools`, register `providers/browser/server.mjs` the same way (`command` an absolute `node`, `env` with `XDG_RUNTIME_DIR`, `DISPLAY=:99` and a `PATH` that includes `npx`). With the version 1 config above it attaches to `http://127.0.0.1:9222` instead of launching a browser, so it sees the same tabs as `browser-fast`.

Re-run setup so `local-1mcp/mcp.json` is re-rendered, then restart the bridge. The CDP port is loopback-only; never expose it. Verify with `observe` then a `navigate` through `execute`.

## Troubleshooting

### Approval link opened on a different computer never completes

Check the client's registered redirect URI first. A hosted connector registers an HTTPS callback on its own platform and completes from any browser. A client that registers `http://127.0.0.1:PORT/callback` needs the browser on the same machine as the client; opening its approval link elsewhere sends the callback to the wrong computer. The server does not rewrite that callback. Approve from the machine running the client, or use a hosted connector.

### Local approval page says connection refused

Nothing is listening on local port 43070. This is the fallback private approval route, not the owner-gated mode. Start the SSH forward on the browser's computer and keep its terminal open. Check that `/health/ready` through the forward returns `200` before opening the local authorization URL.

### Approval shows HTTP 403

A consent page at the public `/authorize?...` URL is visible, but its Approve button submits to the private `/oauth/consent` path. With the fallback ingress guard, clicking Approve while still on the public origin returns HTTP 403. This does not mean the OAuth client lacks the selected scopes.

Either configure the owner gate on `/authorize` and `/oauth/consent` so the public origin accepts the approval, or go back to the original authorization URL, start the SSH forward, and replace only the origin with `http://127.0.0.1:43070` before approving. Preserve the entire path/query. Changing the denied `/oauth/consent` URL alone cannot restore the authorization parameters. If browser history no longer contains the original URL, restart connection setup in the client. The final callback still uses the registered client URL.

If the client reports `connect_request_unconfirmed` or sends the browser to sign-in, the callback may have opened in a different or signed-out browser profile. Start a fresh authorization from the client's signed-in browser and approve it there. Do not reuse an authorization URL that already reached the callback.

### Discovery shows HTTP 404

Check the DNS record's target against the intended tunnel UUID. A workstation's default cloudflared configuration can select its existing tunnel during DNS routing even when a different tunnel is supplied. Use the explicit empty-config command above, then allow the edge route to update and require public health plus OAuth discovery to succeed before retrying client setup.

### Revoked or invalid token shows HTTP 500

Historical 1MCP 0.37.0 threw a generic error when its access-token session was missing or invalid (0.39.8 throws `InvalidTokenError`, though legacy vs v2 error-class routing in upstream 1MCP should still be verified during deployment checks). The SDK maps that error to `HTTP 500` with `server_error`, rather than the expected OAuth invalid-token refusal status. A deployment check reproduced this after revoking a temporary test grant; no MCP access was granted, and health remained ready. Requests without a bearer token returned HTTP 401.

This is an upstream status-reporting quirk, not evidence that a revoked grant remains usable. Reconnect through owner approval when a grant is invalid. WebHarness does not currently patch this upstream behavior. A future 1MCP upgrade should recheck both refusal and the returned status.
