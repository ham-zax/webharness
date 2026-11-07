# OAuth clients and remote login

The gate is multi-tenant by design: each app mints its own OAuth client, identified by `clientId`. Grants and access-token sessions are per client, so connecting one app never touches another.

## Mint a client for a new app

The gate's dynamic registration mints a client per app. Ask it with `POST /oauth/register` and set `token_endpoint_auth_method=client_secret_post` plus the app's registered redirect URI:

```text
client_id:     <uuid>
client_secret: <hex>
auth_method:   client_secret_post
redirect_uri:  https://oauth-redirect.googleusercontent.com/r/<app-specific>
```

Each app owns its own redirect URI. A Gemini connector registers a Google one; a ChatGPT or Claude app registers its own. The gate accepts every client the same way and records grants per client.

## Connect a client

1. Delete the app's old connector (a stale connector keeps its own, possibly dead, client).
2. Add a custom MCP server: URL `https://mcp-arm.example.com/mcp`.
3. In the connector's additional settings, paste the minted Client ID and Client secret. This step is the one that decides the outcome: every attempt that left those fields empty sent the approval to a client the app registered by itself, and the minted credentials never took effect.
4. **Next.** The app now builds the authorize link itself.
5. Check the address bar: it must contain `client_id=<minted-uuid>`. If you see any other UUID there, the credentials did not take effect. Stop and redo step 3.
6. Log in, then **Approve**.

The approval page needs a login only on first connect. A machine that is already logged in skips straight to Approve.

## Verify the exchange landed

Approval alone is not completion. The connector is live only after the token exchange:

```text
POST /token                       <- the app's backend, minutes after the 302
Exchanged authorization code for access token  {clientId: <minted-uuid>}
Scope operation: scope_validation_success      {grantedScopes: [...]}
```

Watch for those lines in `one-mcp.log` after clicking Approve. No `/token` line within a couple of minutes means the app never called back - reconnect through the client.

## Multi-client safety

Grant and token state is keyed by `clientId`, so existing logins survive minting a new client: each machine keeps its own access-token session and granted scopes. The gate has held several clients side by side, each exchanging codes and validating scopes independently. A machine that is already logged in continues to work; nothing about a new client touches its grants.

Grant state lives under the 1MCP state dir (`sessions/`); expired or corrupted grant files are cleaned up on their own schedule.

## Adding a machine

Repeat [Connect a client](#connect-a-client) on the machine: delete the old connector, re-add the MCP server URL, and paste credentials - or leave the fields empty, in which case the gate mints a fresh client by itself. Every client gets its own grants either way.
