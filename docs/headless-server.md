# Headless Server (Machine B) & Cloudflare Email OTP Setup

Use the `server` profile for a trusted owner's headless Linux/ARM server (**Machine B**). It exposes Dev plus Local (`terminal`, `skill-library`, owner MCPs, and the hidden `dev` fallback mirror) with no desktop, WSLg, Host, or Browser providers.

## 1. Install on Machine B

Prerequisites: Linux with user-systemd, Node.js 24+, `npm`, `tmux`, `git`, `curl`, `flock`, and native `cloudflared` (`aarch64` or `x86_64`).

```bash
git clone <your-webharness-repo> ~/repo/webharness
cd ~/repo/webharness
cp .env.example .env
# Set MCP_PUBLIC_URL=https://mcp-server.example.com and MCP_TUNNEL_NAME=<tunnel-name-or-empty>

./bin/webharness doctor --profile server
./bin/webharness setup --profile server --enable-startup
just init-connector-policy   # optional: copy-if-missing starter policy (auto-detects Gemini)
just sync-skills             # optional: sync local Skillshare skills into gitignored skill-library/packs/
./bin/webharness status
```

## 2. Cloudflare Tunnel with an existing domain

If you already manage a domain on Cloudflare (e.g. `example.com`) and run Machine A on `mcp.example.com`, give Machine B its own tunnel, UUID, hostname (`mcp-server.example.com`), and OAuth state. Never share one tunnel UUID across two MCP hosts as replicas.

Run these steps once from **Machine A** (which has a browser and your Cloudflare account login):

```bash
# 1. Authenticate cloudflared once on Machine A (opens browser, saves ~/.cloudflared/cert.pem)
cloudflared tunnel login

# 2. Create a dedicated tunnel for Machine B
cloudflared tunnel create webharness-arm
# Note the printed Tunnel UUID and credentials file: ~/.cloudflared/<UUID>.json

# 3. Route a subdomain on your existing Cloudflare domain to the new tunnel UUID
#    (--config /dev/null prevents Machine A's default tunnel config from hijacking the route)
cloudflared tunnel --config /dev/null route dns <TUNNEL_UUID> mcp-server.example.com

# 4. Copy ONLY that tunnel's JSON credential to Machine B (keep cert.pem on Machine A)
scp ~/.cloudflared/<TUNNEL_UUID>.json user@machine-b:~/.cloudflared/
ssh user@machine-b 'chmod 600 ~/.cloudflared/<TUNNEL_UUID>.json'
```

## 3. Approve headless Machine B from Machine A via Cloudflare Access Email OTP

Machine B has no browser, and web connectors (ChatGPT, Claude, Gemini) register their own HTTPS callbacks (`https://<platform>/callback`). You approve each connector from **Machine A's browser**. **Cloudflare Zero Trust Access (Email One-Time PIN)** protects the browser-facing routes. The bridge verifies the signed Access identity before displaying or accepting consent.

### Browser routes behind Access

| Path | Cloudflare Access | Routed to |
|---|---|---|
| `/authorize`, `/oauth/consent` | **Protected (owner email OTP only)** | `http://127.0.0.1:3050` |
| `/mcp`, `/register`, `/token`, `/revoke`, `/.well-known/*`, `/health/ready`, `/v1/*` | **No Access app** (direct protocol/Bearer traffic) | `http://127.0.0.1:3050` |

Never apply Access to the whole hostname—interactive login on `/mcp`, `/register`, `/token`, or `/.well-known/*` breaks MCP clients.

### One-time Cloudflare Zero Trust setup (on Machine A browser)

1. Open **Cloudflare Zero Trust** -> **Settings** -> **Authentication** -> confirm **One-time PIN** is enabled as a login method (built-in, free, no external IdP required).
2. Go to **Access** -> **Applications** -> **Add an application** -> **Self-hosted**.
3. Name it (e.g. `WebHarness Machine B Approval`) and set **Session Duration** to `720h` (30 days—this only governs browser approval logins, not MCP tokens).
4. Add these paths for the public hostname in that same application:
   - `mcp-server.example.com` with path `authorize`
   - `mcp-server.example.com` with path `oauth/consent`
5. Add an **Allow** policy:
   - Include -> **Emails** -> `your-owner-email@example.com` (exact email that will receive the OTP).
   - Authentication -> **One-time PIN** (selected).
6. Save the application and copy two values from its **Overview** tab:
   - **Team domain prefix (`teamName`)**: the `<team>` part of `<team>.cloudflareaccess.com`.
   - **Application Audience (`AUD`) Tag**: the 64-character hex string.

Set `WEBHARNESS_ACCESS_TEAM` and `WEBHARNESS_ACCESS_AUD` to those same values in a user-systemd drop-in for `mcp-dev-bridge.service` under `[Service]` as `Environment=` assignments. Run `systemctl --user daemon-reload` before restarting the bridge. Use an Access application whose policy admits only the owner.

### Configure `~/.cloudflared/config.yml` on Machine B

Put the Access-validated approval rule **above** the unguarded protocol rule (replace `3050` if you changed `MCP_ONE_MCP_PORT`):

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /home/<user>/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: mcp-server.example.com
    path: '^/(authorize|oauth/consent)/?$'
    service: http://127.0.0.1:3050
    originRequest:
      access:
        required: true
        teamName: <YOUR_TEAM_NAME>
        audTag:
          - <YOUR_APPLICATION_AUDIENCE_TAG>
  - hostname: mcp-server.example.com
    path: '^/(mcp/?|health/ready|\.well-known/oauth-(authorization-server|protected-resource)(/mcp)?|token|register|revoke|v1/.*)$'
    service: http://127.0.0.1:3050
  - service: http_status:403
```

Validate and restart on Machine B, then verify from Machine A before connecting an AI client:

```bash
# On Machine B:
cloudflared tunnel ingress validate
./bin/webharness restart

# From Machine A:
curl -sS -o /dev/null -w "health=%{http_code}\n" https://mcp-server.example.com/health/ready      # expect 200
curl -sS -o /dev/null -w "authorize=%{http_code}\n" https://mcp-server.example.com/authorize  # expect Access redirect or denial
```

### How the Email OTP approval flow works (Machine A -> Machine B)

1. In ChatGPT, Claude, or Gemini on **Machine A's browser**, add a new custom MCP app pointing to `https://mcp-server.example.com/mcp`.
2. The AI platform calls `POST /register` (unguarded) and redirects Machine A's browser to `https://mcp-server.example.com/authorize?...`.
3. **Cloudflare Access intercepts `/authorize`** and displays an email login prompt on Machine A.
4. Enter your allowlisted email (`your-owner-email@example.com`). Cloudflare immediately emails a **6-digit One-Time PIN (OTP)** to that inbox.
5. Paste the 6-digit code in Machine A's browser. Cloudflare issues a signed Access JWT cookie and forwards the request through Tunnel B.
6. `cloudflared` on Machine B validates the JWT (`teamName` + `audTag`). The bridge independently checks the assertion signature, issuer, audience, expiry, and user identity, then displays consent at `/authorize`.
7. Click **Approve** (`POST /oauth/consent`). 1MCP returns Machine A's browser to the AI platform's registered HTTPS callback, and the platform exchanges the code at `POST /token`.

Zero browser on Machine B, zero SSH tunnel, and zero URL rewriting. Because `server` sets `WEBHARNESS_OAUTH_SINGLE_OWNER=1` and `auth.sessionTtl = 525600`, issued tokens last **365 days** with rolling 365-day refresh authority until revoked.

*(Note: Clients using loopback redirects like `http://127.0.0.1:PORT/callback` must run on the same machine as the browser; use hosted web connectors for cross-device approval.)*

## 4. Fallback: temporary SSH approval (before Cloudflare Access is set up)

With the Access environment settings unset on the bridge, omit the browser routes (`/authorize`, `/admin`, and `/admin/*`) from public ingress and forward Machine B's port temporarily from Machine A:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:43070:127.0.0.1:3050 YOUR_SERVER_ALIAS
curl.exe -sS -o NUL -w "%{http_code}\n" http://127.0.0.1:43070/health/ready  # expect 200
```

Start connector setup in your browser, replace only the `/authorize?...` origin with `http://127.0.0.1:43070` (keep the full path/query intact), and complete sign-in and approval on the forwarded origin. Then press `Ctrl+C` on the SSH forward. Never commit full authorization/callback URLs.

## 5. Upgrades, CLI accelerators & `pueued.service`

- **One-command host-local upgrade:** Once `just` is installed, run `just update` directly on Machine B (`git pull --ff-only origin main`, auto-detects `MCP_BRIDGE_PROFILE=server` from `bridge.env`, and runs `just deploy`). Preserves `.env`, tunnel credentials, OAuth state, and `tmux`.
- **Headless CLI toolbox:** `scripts/bootstrap-server.sh` qualifies the required core (`git`, `rg`, `jq`, `node`, `tmux`) and installs optional accelerators (`ast-grep`, `fd`, `yq`, `pueue`, `pueued`, `difft`, `just`, `scc`, `hyperfine`, `mcp-inspector`) best-effort via `scripts/setup-personal-toolbox.sh --headless` (idempotent, SHA-256 verified, `--ignore-scripts` for `mcp-inspector`, `sudo -n` guarded).
- **Restart-proof builds:** `--enable-startup` (or `scripts/install-pueued-user.sh`) installs `pueued.service` (`parallel=1`) in its own user-systemd cgroup so `just queue <cmd>` survives bridge restarts.

## 6. Optional headless Browser Fast (aarch64/x86_64, no GPU)

To opt into `browser-fast` (and optionally `browser-devtools`) on a headless server via `MCP_LOCAL_SERVERS_FILE`:

1. Install `xvfb`, fonts, Chromium (`npx playwright install chromium`), and `providers/browser-fast` dependencies.
2. Run persistent user units for `Xvfb :99` and Chromium with `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=%h/.local/state/mcp-dev-bridge/chrome-profile --no-sandbox --use-gl=angle --use-angle=swiftshader --disable-dev-shm-usage`.
3. Set `~/.config/mcp-dev-bridge/browser-fast.json` to `{"version":1,"linux":{"browser":"cloakbrowser","cdpPort":9222}}` (V1 external CDP selector).
4. Register `providers/browser-fast/server.mjs` (and optionally `providers/browser/server.mjs` with `DISPLAY=:99`) in `MCP_LOCAL_SERVERS_FILE`, re-render, and restart. Keep port `9222` loopback-only.
