# WebSession master bearer

The WebSession master bearer is an optional password-equivalent bootstrap secret for richer HTTP clients. It is not an ordinary WebSession submission capability and is never accepted by `/v1/calls` or any URL-based universal GET route.

## Lifetime

The master bearer has no time-based expiry. It remains valid until the operator rotates it, replaces the adapter state directory, or otherwise removes the stored master-bearer hash.

A successful master exchange issues a fresh ordinary `main` capability with a fixed lifetime of 21,600 seconds (6 hours). Each issued capability expires independently and can also be revoked independently.

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

Custom values must be 32-128 characters using only letters, digits, `.`, `_`, or `-`. Setting a new value immediately invalidates the previous master bearer. Already-issued finite capabilities keep their original expiry and revocation state.

The live master bearer value must not be committed to Git, added to documentation, written to logs, or placed in a URL.

## Exchange for six-hour access

Richer HTTP clients exchange the master bearer only through:

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

Use the returned capability for `/v1/s/{capability}/...` discovery or `POST /v1/calls`. Never send the master bearer to `/v1/calls`.

## ChatGPT/native MCP wrapper

ChatGPT sessions that already have native MCP access to this WSL should normally avoid handling the master bearer or temporary capability directly. From the repository root use:

```bash
bin/websession-call <exact-native-MCP-tool-name> '<arguments-json>'
```

For example:

```bash
bin/websession-call dev_1mcp_bash '{"command":"pwd"}'
```

The wrapper creates a temporary ordinary capability directly in private adapter state, sends the operation through public `POST /v1/calls`, follows status and result chunks, prints only the tool result, and revokes the temporary capability after a known terminal outcome. If submission or later status becomes transport-ambiguous, it does not retry the operation and leaves the temporary capability to expire naturally.

## GET-only clients

A GET-only client such as a constrained `open`-only session cannot safely use the master bearer because `/v1/access` requires an Authorization header and the master bearer must never appear in a URL. Give such a client a normal finite capability instead and use the universal GET profile documented in [WebSession client bootstrap prompts](websession-clients.md).

## Security boundary

The master bearer does not expand WebSession or 1MCP permissions. It only bootstraps an ordinary WebSession capability for the adapter's existing authenticated 1MCP authority. Tool names, schemas, availability, OAuth scope, and effective permissions remain owned by 1MCP.
