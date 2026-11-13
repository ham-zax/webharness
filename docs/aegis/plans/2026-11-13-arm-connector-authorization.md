# ARM connection simplification — revised review plan

Status: implemented and locally verified after review. The owner subsequently authorized ARM rollout, restart, commit, and push. Machine-specific deployment evidence is kept in the private operations repository; the browser owner gate remains a separate configuration dependency.

## Scope clarifications during implementation

Two user clarifications arrived while this plan was being implemented. They narrow the work; they do not widen it.

**Cross-device approval is the platform-connector path.** The clients are ChatGPT, Claude, and Gemini web sessions, not command-line clients. They register an HTTPS callback on their own platform, so the owner opens the authorization link on the home browser, approves, and the browser redirects to the platform's callback while the web client continues on its own. The headless target needs no desktop, no browser, no SSH forward, and no URL editing. That is why step 3 gates exactly `/authorize` and `/oauth/consent` and leaves every protocol path ungated. A client that registers a loopback callback is a same-machine client; that limitation is documented, not worked around.

Explicitly out of scope and not implemented: RFC 8628 device authorization, a CLI login wrapper, a public callback relay, a remote browser, and mandatory callback forwarding. None is needed for the real client paths, and each would add auth surface this deployment does not require.

**WebSession clients use the existing bearer and pairing flows.** Transient HTTP/Python clients authenticate with the long-lived master bearer in an `Authorization` header or with an existing pair code. They must not depend on an interactive per-sandbox OAuth round trip or on a borrowed connector credential. The adapter's own upstream credential is the separately provisioned service identity from step 4.

**Review and rollout.** The initial review-only stop was superseded by the owner’s authorization to fix the external review findings, deploy and restart ARM, then commit and push. Preserve existing grants and keep public consent refused until the owner gate is configured.

## Intended experience and decisions

Enter `https://mcp-arm.example.com/mcp` in Gemini with Client ID and secret blank, sign in as the owner when needed, and click Approve once. The connector receives the whole published machine toolset. Normal use, new chats, and service restarts require no browser authorization.

Choose **Option B: keep automatic registration** because URL-only Gemini setup is the requested experience. Registration identifies a connector; it grants no access. Option A (one static client, disabled registration, manually supplied credentials) remains an alternative only if the owner later chooses it. Do not mix the two modes or auto-approve arbitrary dynamically registered clients.

Replace the fixed 30-day cutoff with **365-day access tokens and renewable 365-day refresh authority**. Successful refresh renews the refresh lifetime; no original-approval deadline forces reauthorization every 30 days. Client registrations remain until explicitly removed. This is long-lived access, not a guarantee that a client will retain credentials or refresh successfully forever.

Approve `tag:dev` and `tag:local` together for this single-owner ARM deployment. Preserve scope enforcement internally; automatically granting both avoids split checkboxes without globally bypassing authorization. The existing `server` profile already supplies unrestricted shell and user-path access. No new sandbox or custom authority-warning UI is planned. Keep one understandable Approve/Deny decision naming the connector and full machine access.

WebSession HTTP is part of the same deliverable: keep quick pairing and add direct long-lived bearer authentication, with an independent permanent upstream adapter identity over loopback. Connector credentials and WebSession credentials must not depend on each other.

## Verified basis and bounded unknowns

- Local `bin/adapter` currently seeds `oauth.json` from the newest connector session without refresh credentials. Its default upstream URL prefers the public tunnel. Both behaviors need replacement for ARM.
- Local WebSession `server.mjs` exchanges the master bearer for a six-hour capability. `store.mjs` additionally caps ordinary main capabilities at 24 hours. Direct bearer support must cover the shared authorization/store path rather than just `/v1/calls`.
- ARM's installed `FileBasedClientsStore.registerClient` stores client records with `AUTH_CONFIG.CLIENT.OAUTH.TTL_MS`, currently 30 days. That expiration can prevent future token operations; it does not establish that an already issued access token immediately stops working.
- Earlier ARM checks found the corrected ingress, working root discovery, path-specific metadata returning 404, public consent returning 403, and missing-bearer MCP returning 401. The known topology is wake proxy 3050, backend 3060, adapter 3051. Implementation needs a quick targeted readback of affected settings, not a new baseline exercise.
- The installed audience check rejects `/mcp` and absent resources. The previous plan called this an interoperability issue; it has not been established as an upstream defect.

## Five implementation steps

### 1. Retain URL-only registration and make clients durable

Keep `/register` and its advertised metadata endpoint available. Retain PKCE and exact registered callback validation. Make client records non-expiring in the actual client repository/storage path, including cleanup behavior; simply changing one TTL constant is insufficient if another cleanup path still expires them. Use the store's explicit non-expiring representation rather than numeric Infinity or an arbitrary timestamp.

Preserve existing client IDs and secrets, and remove expiry from existing valid ARM client records through the same controlled migration. Do not recreate connectors or reset OAuth state. Expired records already deleted cannot be reconstructed from a TTL patch; report any such client separately. Scope permanence changes to inbound registrations, not unrelated cached outbound OAuth credentials sharing a constant.

### 2. Apply small, reproducible 1MCP policy patches

Persist patches in `scripts/install-bridge-runtime.sh` or its existing canonical patch mechanism, verifying the deployed package/source shape before application. Do not reinstall the pinned runtime blindly over ARM's current patches.

- Set rendered `auth.sessionTtl` to **525600 minutes**, with focused smoke-check updates. Audit access-token, refresh, and authority expiry owners so no hidden 30-day ceiling overrides this setting. Set renewable refresh authority to 365 days. Keep explicit revocation effective immediately.
- Grant both `tag:dev` and `tag:local` at owner approval, including refresh scope ceilings. Replace separate scope choices with one full-access approval. Existing limited grants remain as issued until the owner explicitly upgrades them; do not silently widen another client's grant.
- Serve `/.well-known/oauth-protected-resource/mcp` and root metadata from the same producer. Preserve the existing issuer and advertised root resource to keep issued credentials compatible.
- Treat exactly `https://mcp-arm.example.com/` and `https://mcp-arm.example.com/mcp` as this deployment's equivalent resource identifiers. Bind omitted/empty resources to this machine at issuance. Accept existing audience-less credentials only from this deployment's local token store/client authority; do not disable audience validation, trust request Host headers, or accept arbitrary origins/paths. Apply this consistently to authorization, exchange, refresh, and MCP verification. This is a deliberate compatibility policy, not a claim that missing-resource clients follow the MCP specification.
- Make duplicate refresh requests safe. Prefer a bounded, persisted retry window that returns the original successful rotation result for the same client/token/request parameters; distinguish that from requests with changed scopes/resources or expired retry windows. Keep the returned result private and compatible across restart. Outside that window, return a token error without automatically revoking an otherwise active connector solely because an old refresh token was retried. Keep owner revoke and invalid-client rejection. Record this relaxation of replay-triggered family revocation explicitly; 365-day tokens alone do not fix retries.

Apply these single-owner policy choices to ARM without silently changing every deployment's authorization policy. Reuse existing runtime configuration where available; add only the minimal configuration needed where the pinned runtime has no setting.

### 3. Protect browser approval routes only

Configure Cloudflare Access restricted to the owner's email/identity on **`/authorize` and `/oauth/consent` only**. Reuse existing owner identity/session configuration where possible. No hostname-wide login application and no interactive Access gate on `/mcp`, `/register`, `/token`, discovery, revocation, or `/v1/*`.

Once the owner gate is enforced, remove the static consent 403 and route the protected consent path to 3050. Never expose the ungated approval POST during the transition. Check effective Access path matching, including accepted trailing-slash variants and alternate ingress routes, before activation. Keep origins loopback-only. Preserve authorization state and callback parameters through login; keep request binding and CSRF protection. Owner-browser session expiration affects future approvals, not existing connector tokens. Select a supported remembered-login duration; do not assume Cloudflare permits 365-day browser sessions.

Identity-provider/Access configuration needs existing account access or the owner's setup. If unavailable, leave the existing private approval route intact and report that dependency; do not substitute public unauthenticated approval.

### 4. Fix WebSession HTTP independently

- Set ARM's `WEBSESSION_ADAPTER_MCP_URL=http://127.0.0.1:3050/mcp`, using the wake proxy so cold starts continue working. Keep public issuer/resource identity separate from this transport address.
- Remove `adapter_prepare_state` borrowing the newest connector token. Provision a dedicated, locally managed adapter client/session with both machine tags, persisted privately and explicitly revocable. This adapter service identity is non-expiring and independent of Gemini/Claude grants; implement that lifetime specifically for this local service identity, not for arbitrary public clients. Local owner provisioning is a deliberate service grant, not a public auth bypass.
- Accept the configured long-lived master bearer directly in Authorization headers on authenticated `/v1/*` data routes, without requiring `/v1/access` first. Keep `/v1/access` and `bin/adapter connect` working for existing exchange/pairing users. Public pairing/bootstrap routes retain their existing semantics.
- Resolve direct bearer requests into one stable stored principal through the existing authorization path. Preserve operation ownership, cwd, idempotency, batches, status/result/chunk retrieval, and restart persistence. Do not create a fresh capability per request. Keep confirmation/continuation credentials confined to their existing purposes; do not turn the master bearer into a substitute for those protocol decisions.
- Reuse hashed credential storage and private file permissions. Never put the bearer in URLs or logs. Define rotation as invalidating the old direct bearer immediately, with a new principal generation so it cannot inherit old operation access accidentally. Keep ordinary capability revocation intact and document that rotating the master does not implicitly revoke independently issued pair capabilities.

The permanent upstream adapter grant and direct WebSession bearer are separate credentials: rotating either must not disconnect unrelated MCP clients. Extend the existing store carefully; do not build another OAuth service.

### 5. Run focused checks, deploy, and update instructions

Use existing focused test locations plus live checks; no new broad security suite, latency benchmark, disconnect-tracing project, or 30-day wait. Only add regression checks needed for changed behavior:

1. Client registration survives expiry cleanup; generated token policy has no remaining 30-day cutoff. A focused boundary check verifies refresh renewal and duplicate-refresh retry behavior.
2. Root, `/mcp`, and omitted-resource compatibility work; an unrelated resource is rejected. Both tags are present on new full-access approvals.
3. Browser approval requires the owner; unauthenticated consent POST fails. `/mcp` and `/v1/*` continue bearer authentication without Access login redirects.
4. Connect Gemini with blank optional fields, approve once, run harmless Dev and Local operations, and confirm existing Claude access still works.
5. Authenticate directly to WebSession with the long-lived bearer, complete one `/v1/calls` operation and retrieve its result. Confirm quick pairing still works. A restart preserves access, and revoking a disposable connector grant does not break the adapter. Keep this revocation check isolated from existing owner grants.

Keep a private backup of modified configuration and state before deployment. Validate ingress before restart. Update `docs/headless-server.md`, `docs/oauth-clients.md`, WebSession client/master-bearer documentation, and affected operational instructions around the demonstrated flow. Preserve SSH as recovery, without making it part of normal connection setup. Document owner-side revocation; Gemini disconnect cannot be assumed to notify the server.

## Files, rollback, and review boundary

Expected files: `scripts/install-bridge-runtime.sh`, `scripts/render-config.mjs`, affected smoke checks, `bin/adapter`, `providers/websession-adapter/{server,store,oauth,auth}.mjs` and the shared authorization/operation path as needed, focused existing tests, and the documentation above. Confirm exact runtime storage owners before editing; preserve existing runtime patches and OAuth state. Live configuration changes are ARM-only.

Change necessity: configuration handles routing, lifetimes where supported, and Access policy. Runtime edits are needed for durable client records, audience compatibility, combined approval, retry semantics, and direct bearer/service-identity behavior where current code lacks them. Keep one OAuth authority and the existing WebSession store. TDD route remains off for mandated test-first sequencing; focused checks above are required verification.

Rollback restores previous routing/runtime/configuration while retaining valid client registrations and grants. Account for new non-expiring records and WebSession principal state before reverting readers. Never restore stale credential state blindly: that can undo revocation or token rotation. Keep the previous private consent route available until browser approval passes.

Review should focus on the explicit policy choices: 365-day renewable connector authority, permanent client records and adapter service identity, full machine grants, accepted resource aliases/omission, direct long-lived WebSession bearer, and refresh retry/replay behavior. These are deliberate changes for a single-owner machine. No implementation or deployment is authorized by the document itself.
