# WebSession master bearer

The WebSession master bearer is an optional password-equivalent bootstrap secret for richer HTTP clients. It is useful for any AI environment that can make HTTPS POST requests with a custom `Authorization` header; it is not tied to a particular model, SDK, or programming language. It is never accepted by a URL-based universal GET route, and it must never appear in a URL.

WebSession itself is separate from the main bridge. The adapter must run before the public `/v1/*` routes are usable. Start it with `bin/adapter start`, or install the supervised unit with `scripts/install-websession-adapter-user.sh` so it starts at user-session startup and restarts after a crash. The main WebHarness `/mcp` lifecycle does not supervise the adapter.

## Lifetime

The master bearer has no time-based expiry. It remains valid until the operator rotates it, revokes it, replaces the adapter state directory, or otherwise removes the stored master-bearer hash.

The adapter resolves the master bearer into one stable stored service principal. That principal is created once, is explicitly non-expiring, and is reused by every request, so a direct-bearer client keeps the same operation ownership, working directory, idempotency records, and result history across restarts. The adapter does not mint a fresh capability per request.

## Use it directly

Send the master bearer in the `Authorization` header of an authenticated `/v1/*` data route. No prior exchange is required:

```text
POST https://<your-websession-host>/v1/calls
Authorization: Bearer <MASTER_BEARER>
```

The same header works for `POST /v1/batch`, `GET`/`PUT /v1/cwd`, `GET /v1/raw`, and the header-based discovery route. Continuation and confirmation credentials keep their own narrower purposes: the master bearer is not a substitute for a continuation token or a confirmation decision.

The master bearer is header-only. It is never accepted from a URL path, including the `/v1/s/{capability}/...` universal GET routes, even when its value happens to be 43 characters and therefore matches the ordinary capability shape. Ordinary capabilities keep working in those routes unchanged; only the master credential is refused there.

## Exchange for six-hour access

The exchange path still works for clients that prefer a short-lived capability:

```text
POST https://<your-websession-host>/v1/access
Authorization: Bearer <MASTER_BEARER>
```

No request body is required. A successful response contains a fresh ordinary capability:

```json
{
  "protocol": "WEBSESSION-MCP-BRIDGE/1",
  "state": "ready",
  "capability": "<six-hour-capability>",
  "scope": "main",
  "ttl_seconds": 21600,
  "expires_at": "<timestamp>"
}
```

Use the returned capability for `/v1/s/{capability}/...` discovery or `POST /v1/calls`. `bin/adapter connect` uses this path for pairing.

The exchange is master-only. An ordinary capability returned by the exchange cannot be presented to `/v1/access` to mint another capability; that request is rejected with `401 authorization_required`. The exchange also requires the current master service principal to be active, so an owner revocation stops the exchange as well as direct data access.

## Configure or rotate

From the repository root, generate a high-entropy master bearer:

```bash
bin/adapter set-master-bearer
```

The generated bearer is printed once. Keep it in a password manager or another operator-controlled secret store. The adapter persists only its hash in private state with mode `0600`; the raw master bearer is not recoverable from adapter state.

To set a custom value instead:

```bash
bin/adapter set-master-bearer '<your-master-bearer>'
```

Custom values must be 32-128 characters using only letters, digits, `.`, `_`, or `-`.

Rotation is immediate and complete. Setting a new value retires the previous principal generation, so the old bearer stops working at once and the new generation cannot inherit the old principal's operation access. Already-issued finite capabilities keep their original expiry and revocation state, and independently issued pair capabilities are not revoked by rotating the master. Revoke those separately with `bin/adapter revoke-cap <capability-id>`.

An owner revocation of the master principal survives an adapter restart. Restoring an older state directory out of band retires the stale generation rather than reviving it.

```bash
bin/adapter master-status   # report the current service principal and whether it is active
bin/adapter revoke-master   # revoke the current service principal immediately
```

`revoke-master` stops both direct header access and the `/v1/access` exchange. It does not revoke independently issued pair capabilities; revoke those with `bin/adapter revoke-cap <capability-id>`. Setting a new master bearer creates a new principal generation.

The live master bearer value must not be committed to Git, added to documentation, written to logs, or placed in a URL.

## Adapter service identity

The adapter's upstream 1MCP credential is a separate secret from the master bearer. It is a deliberate local owner grant, provisioned over loopback, carrying every published tag, with no time-based expiry. It is not a substitute for remote OAuth approval of an arbitrary tool, and it never reuses another connector's token.

```bash
bin/adapter identity-provision   # create the service identity if absent
bin/adapter identity-status      # report whether it exists, without printing the secret
bin/adapter identity-revoke      # delete only the adapter's own session
```

`identity-revoke` deletes only the session whose client id is `websession-adapter`, so revoking it cannot disturb a Gemini or Claude connector grant. Rotating the master bearer does not touch this identity, and revoking this identity does not touch the master bearer or any connector.

Ownership and lifetime are read from the 1MCP session record, never assumed from the local file:

- `present` means the stored token's session belongs to `websession-adapter`. `expires: never` is reported only when that record carries the runtime's explicit non-expiring sentinel; a timed session reports its real expiry.
- `borrowed` means the stored token belongs to another connector. It is reported with that connector's client id and real expiry, and it is never deleted or relabelled.
- `unverified` means the 1MCP session directory is not configured, so no ownership or lifetime claim is made.
- `missing` means the stored token no longer resolves to a session.

Startup runs `identity-ensure`, which is idempotent and migrates a pre-existing borrowed `oauth.json` by provisioning a dedicated identity while leaving the borrowed connector session intact. A repeated provision does not create a second permanent session, and any stale dedicated session left by an earlier provision is revoked first. An intentional `identity-revoke` is recorded in private state, so a restart does not recreate the identity; run `identity-provision` explicitly to create a new one.

## ChatGPT/native MCP wrapper

ChatGPT sessions that already have native MCP access to this machine should normally avoid handling the master bearer or temporary capability directly. From the repository root use:

```bash
bin/websession-call <exact-native-MCP-tool-name> '<arguments-json>'
```

For example:

```bash
bin/websession-call dev_bash '{"command":"pwd"}'
```

The wrapper creates a temporary ordinary capability directly in private adapter state, sends the operation through public `POST /v1/calls`, follows status and result chunks, prints only the tool result, and revokes the temporary capability after a known terminal outcome. If submission or later status becomes transport-ambiguous, it does not retry the operation and leaves the temporary capability to expire naturally.

## GET-only clients

A GET-only client such as a constrained `open`-only session cannot safely use the master bearer because the master bearer must never appear in a URL. Give such a client a normal finite capability instead and use the universal GET profile documented in [WebSession client bootstrap prompts](websession-clients.md).

## Security boundary

The master bearer does not expand WebSession or 1MCP permissions. It only authenticates the adapter's existing authenticated 1MCP authority. Tool names, schemas, availability, OAuth scope, and effective permissions remain owned by 1MCP. WebSession discovers that live catalog from 1MCP rather than maintaining per-tool mappings, so clients should rediscover tools instead of hard-coding a stale list.
