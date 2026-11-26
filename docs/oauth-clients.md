# OAuth clients and remote login

The gate is multi-tenant by design: each app mints its own OAuth client, identified by `clientId`. Grants and access-token sessions are per client, so connecting one app never touches another.

## Set up the owner account

1MCP 0.40 requires an administrator to sign in before approving a connector. For an existing bridge, deploy the updated generated config with `just deploy <profile>` using the bridge's current profile. For a fresh install, `webharness setup` already renders the config.

Create the first admin once on the bridge host as the same Linux user that runs the bridge. For a custom state directory, point `--config-dir` at its `1mcp` subdirectory.

```bash
read -r -s -p 'New 1MCP admin password: ' webharness_admin_password
printf '\n'
1mcp admin bootstrap --config-dir "${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge/1mcp" \
  --username owner --password "$webharness_admin_password"
unset webharness_admin_password
```

Sign in at `/admin` on the same origin you use for approval. An existing admin account can be reused. Bootstrapping is only needed for a runtime that has no admin account.

## Connect a client with blank optional fields

This is the supported path for a hosted connector. Add a custom MCP server with the deployment's public URL and leave the optional Client ID and Client secret empty:

```text
URL: https://mcp-arm.example.com/mcp
Client ID:     (leave empty)
Client secret: (leave empty)
```

The connector then registers itself through `POST /register` and builds its own authorization link. A registration records identity metadata only: client id, secret, redirect URIs, and grant types. It grants no access. Access begins only when the owner approves that client.

Choose one mode per connector. Either leave both optional fields empty and let the connector register itself, or paste a client you minted yourself. Mixing them sends the approval to a client the app registered by itself, and the pasted credentials never take effect. If the address bar shows a `client_id` you did not mint, the credentials did not take effect; delete the connector and start again.

## Approve with a one-time workstation link

Start the connector with the normal `/mcp` URL. Copy its full authorization URL, then run this command as the bridge owner on the workstation hosting that bridge:

```bash
webharness approval-link
```

Paste the authorization URL and press Enter. The command prints a bearer link valid for five minutes. It accepts this bridge’s authorization requests with explicit scopes and S256 PKCE. Open the link in any browser to review the connector, callback, and permissions. Click **Approve** or **Deny**. You can open the review page repeatedly until one decision consumes the link. Anyone holding the link during that window can make that decision.

For a terminal approval, paste the minted link at the prompt:

```bash
read -r -s -p 'One-time approval link: ' approval_link
printf '\n'
curl -fsS "$approval_link"
curl -si --data 'action=approve' "$approval_link"
unset approval_link
```

The POST returns the registered callback in the HTTP 303 `Location` header. Open that callback in the originating connector’s browser session to finish. Use `action=deny` to decline. If the connector starts a new request, mint a new link for that request.

## Cross-device approval

A hosted connector registers an HTTPS callback on its own platform, so approval works from any browser:

```text
web client   -> POST /register          platform callback registered
home browser -> GET  /authorize?...     redirects to /admin/oauth/authorize
home browser ->      owner signs in on the approval page if needed
home browser -> POST /admin/oauth/consent  approval, same origin
home browser ->      https://<platform>/callback?code=...&state=...
platform     -> POST /token             code plus PKCE verifier
web client   -> POST /mcp               Bearer access token
```

The owner opens the authorization link in their browser. If prompted, sign in on that page. Review the requested permissions and approve. The browser continues to the platform's registered HTTPS callback, where the platform backend exchanges the code. The exact registered callback, `state`, and PKCE `code_challenge` are carried through unchanged.

A client that registers `http://127.0.0.1:PORT/callback` is a same-machine client. Its callback resolves on whichever machine runs the browser, so it cannot complete from a different computer. That is a client limitation, not a server setting: WebHarness does not rewrite a registered loopback callback, and this deployment offers no device-code or callback-relay flow. Approve from the machine running that client, or use a hosted connector.

## Mint a client for a new app

The alternative to automatic registration is to mint the client yourself and paste it into the connector. Ask the gate with `POST /oauth/register` and set `token_endpoint_auth_method=client_secret_post` plus the app's registered redirect URI:

```text
client_id:     <uuid>
client_secret: <hex>
auth_method:   client_secret_post
redirect_uri:  https://oauth-redirect.googleusercontent.com/r/<app-specific>
```

Each app owns its own redirect URI. A Gemini connector registers a Google one; a ChatGPT or Claude app registers its own. The gate accepts every client the same way and records grants per client.

## Verify the exchange landed

Approval alone is not completion. The connector is live only after the token exchange:

```text
POST /token                       <- the app's backend after the callback
Exchanged authorization code for access token  {clientId: <uuid>}
Scope operation: scope_validation_success      {grantedScopes: [...]}
```

Watch for those lines in `one-mcp.log` after clicking Approve. No `/token` line within a couple of minutes means the app never called back - reconnect through the client.

## Lifetime and revocation

An approved connector keeps working until the owner revokes it:

- Access tokens are issued for 365 days.
- Refresh authority is 365 days and restarts on every successful rotation, so a connector that refreshes normally never reaches a fixed approval deadline.
- Client registrations are durable. They are not deleted on a 30-day schedule, and an existing registration keeps its client id and secret.
- A duplicate refresh request inside a bounded retry window returns the original rotation result instead of being treated as a replay. Outside that window the request fails as a token error without revoking an otherwise active connector.

This is long-lived access, not a promise that a client keeps its credentials or refreshes successfully forever. A client that discards its refresh token needs a new approval.

These choices are scoped to the `server` profile. Other profiles keep the previous 30-day access-token and registration lifetimes, per-tag consent checkboxes, and replay-triggered family revocation.

Revocation is owner-side. Removing a connector in the app's own settings does not notify this server: Gemini, ChatGPT, and Claude disconnects leave the registration and its grant in place until the owner revokes them here. Revoke through the gate's revocation endpoint or by deleting that client's records under the 1MCP state directory, and revoke one client at a time so unrelated connectors keep working.

## Multi-client safety

Grant and token state is keyed by `clientId`, so existing logins survive minting a new client: each machine keeps its own access-token session and granted scopes. The gate has held several clients side by side, each exchanging codes and validating scopes independently. A machine that is already logged in continues to work; nothing about a new client touches its grants.

Grant state lives under the 1MCP state dir (`sessions/`). Registrations are durable; access-token sessions and refresh families still expire or are revoked on their own terms.

## Adding a machine

Repeat [Connect a client with blank optional fields](#connect-a-client-with-blank-optional-fields) on the machine: add the MCP server URL and leave the optional fields empty, or paste credentials you minted. Every client gets its own grants either way. Each machine's grant is independent, so revoking one machine's connector does not affect another's.
