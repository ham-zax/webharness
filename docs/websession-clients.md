# WebSession client bootstrap prompts

Use this guide when connecting chat-based AI clients to the existing WSL bridge through WebSession.

WebSession is a transport adapter only. 1MCP remains the authority for OAuth scope, tool names, tool schemas, availability, and permissions. For master-bearer lifetime, rotation, exchange, and storage rules, see [WebSession master bearer](websession-master-bearer.md).

## Operator setup

From the repository root:

```bash
bin/adapter auth-status
bin/adapter status
bin/adapter issue-cap 3600
```

`issue-cap` prints:

```text
capability_id: <operator-revocation-id>
capability: <bearer-secret>
scope: main
expires_at: <timestamp>
```

Give the client the value after `capability:`. Do not give it `capability_id`; that ID is the operator handle used to revoke the bearer later:

```bash
bin/adapter revoke-cap <capability-id>
```

Treat the capability as a secret. Do not commit it, paste it into documentation, or ask the client to repeat it in its answer.

For ChatGPT sessions that already have native MCP access to this WSL, prefer the local wrapper instead of constructing bearer-bearing curl commands in the model-visible Bash request:

```bash
bin/websession-call dev_1mcp_bash '{"command":"pwd"}'
```

`bin/websession-call <tool> '<arguments-json>'` creates a temporary ordinary capability in private adapter state, submits the exact tool call through the public WebSession `POST /v1/calls` path, follows status/chunks to a terminal result, and revokes the temporary capability after a known terminal outcome. It never prints the capability. If submission or status transport becomes ambiguous, it does not retry the operation and leaves the temporary capability to expire rather than changing an unresolved operation.

## Reusable six-hour bootstrap

For a stable password-equivalent bootstrap secret, configure a master bearer once:

```bash
bin/adapter set-master-bearer
```

That generates and prints the master bearer once. To use your own value instead, pass a 32-128 character token containing only letters, digits, `.`, `_`, or `-`:

```bash
bin/adapter set-master-bearer '<your-master-bearer>'
```

Do not use the master bearer directly with `/v1/calls` or put it in a URL. Exchange it only through the richer HTTP profile:

```text
POST https://<your-websession-host>/v1/access
Authorization: Bearer <MASTER_BEARER>
```

The response contains a fresh ordinary `main` capability with `ttl_seconds: 21600`. Use that returned capability for discovery and calls exactly as below. Reusing the master bearer later issues another independent six-hour capability; rotating the master does not change capabilities that were already issued.

## Qwen / Python bootstrap prompt

Provide either `<MASTER_BEARER>` or an already-issued `<CAPABILITY>`. Prefer the master bearer when the client supports POST plus custom headers; it exchanges into a fresh six-hour capability without putting the master in a URL.

```text
Use Python `requests` to connect to my WSL through WebSession. Use the documented routes exactly; do not probe or guess authentication endpoints.

Base: https://mcp.example.com
Master bearer: <MASTER_BEARER_IF_PROVIDED>
Capability: <CAPABILITY_IF_PROVIDED>

Keep both credentials secret. Never echo them, log them, or write them to disk. Never put the master bearer in a URL. WebSession is transport only; use exact live 1MCP tool names and schemas.

1. GET `/v1/about` and verify `WEBSESSION-MCP-BRIDGE/1`.
2. If no capability was supplied, exchange the master exactly once with `POST /v1/access` and `Authorization: Bearer <MASTER_BEARER>`. The response must contain `state: ready`, `scope: main`, and `ttl_seconds: 21600`. Keep the returned capability only in memory.
3. GET `/v1/s/<CAPABILITY>/tools` to discover tools. Inspect an unfamiliar tool at `/v1/s/<CAPABILITY>/tool/<tool-name-b64>`.
4. Call tools with:

POST https://mcp.example.com/v1/calls
Authorization: Bearer <CAPABILITY>
Content-Type: application/json
Idempotency-Key: <fresh nonce>

{"version":1,"tool":"<exact tool name>","arguments":{...}}

The JSON envelope fields are exactly `version`, `tool`, and `arguments`. Do not use `args`, `params`, or a top-level `command` field. Use a fresh nonce for each new operation; reuse it only for an exact retry. The enhanced profile stays JSON for the full lifecycle: `POST /v1/calls`, every returned `status_url`, and every returned `chunk_base_url` response are JSON. If `state` is `queued` or `running`, poll `status_url` inside the same Python execution until a terminal state. For `completed`: when `chunk_count` is `1`, read `result` directly and do not request a chunk URL; when `chunk_count` is greater than `1`, fetch `chunk_base_url + "1"` through `chunk_base_url + str(chunk_count)` and concatenate each JSON response's `content` field in order. Never retry `unknown_outcome` automatically.

Treat Python as a coarse-grained transport runtime, not an RPC console. Aim for one code-interpreter execution per logical engineering phase, normally 3-6 executions for an ordinary repository task. Inside one Python execution, perform related WebSession calls, poll status, reconstruct chunks, and cache discovered tool schemas. Do not invoke Python once per HTTP request, poll, or chunk. Do not print polling progress, chunk metadata, credentials, or raw transport objects; print only compact semantic findings needed for the next reasoning step.

Transport chunks are not repository pagination. Navigate repository work with search first, then focused reads, then mutation: prefer `dev_1mcp_bash` with `rg`/`grep` to locate owners, then `dev_1mcp_read` with a narrow `offset`/`limit` (roughly 50-150 lines by default), expanding only when evidence requires it. Before the first call to any unfamiliar remote tool, inspect `/v1/s/<CAPABILITY>/tool/<tool-name-b64>`, cache that schema, and never guess its argument names. If an edit anchor fails, do not retry the identical payload; inspect the failed anchor, correct only that part, and submit once. Between tool phases, do not restate the product/design objective; keep a compact engineering ledger with `OWNER`, `OBSERVED`, `CHANGE NEEDED`, and `NEXT`.

Connection test: discover `dev_1mcp_bash`, call it with `{"command":"pwd"}`, then report only:

CONNECTED
WSL_PWD: <actual result>
TOOLS_AVAILABLE: <actual tool_count>
```

## ChatGPT / native MCP + optional WebSession bootstrap prompt

```text
You already have native MCP access to my WSL. You also have a local WebSession wrapper for sending an operation through the public WebSession HTTPS path without placing bearer credentials or curl construction in the model-visible Bash command.

Use native MCP as the primary interface and discover/use its tools normally.

For a WebSession execution from native MCP, do not probe WebSession auth routes and do not construct `curl` commands containing `Authorization: Bearer`. From the repository root call only:

bin/websession-call <exact-native-MCP-tool-name> '<arguments-json>'

Example connection test:

bin/websession-call dev_1mcp_bash '{"command":"pwd"}'

The wrapper mints and consumes the temporary capability inside WSL, submits through `POST /v1/calls`, follows status/chunks, prints only the tool result, and revokes the temporary capability after a known terminal outcome. If it reports an unresolved transport outcome, do not retry automatically.

Use exact tool names and argument schemas from the native MCP catalog; WebSession mirrors that live 1MCP surface. Do not use `args` or `params` in place of `arguments`.

For multi-part work, use only genuinely independent tasks:
- native MCP for primary repository/tool work
- WebSession for one independent durable operation when useful
- Terminal for long-running processes

Never execute the same mutation through both paths or run competing edits against the same files.
Do not assume WebSession operations themselves execute concurrently; current adapter dispatch may serialize them.

First verify WSL access with `pwd` through native MCP. When a WebSession-path check is useful, run the wrapper `pwd` example above. Then proceed with my task autonomously.
```

## GLM / universal GET bootstrap prompt

Replace `<CAPABILITY>` with a freshly issued ordinary capability. A GET-only client cannot safely exchange the master bearer because the master is header-only and must never appear in a URL.

```text
Use your `open` tool as the HTTPS GET transport to connect to my WSL through WebSession. Do not decide that `open` is unsuitable before trying it.

Base: https://mcp.example.com
Capability: <CAPABILITY>

Keep the capability secret. WebSession is transport only; use exact live 1MCP tool names and schemas. Do not guess routes or request fields.

1. `open` `https://mcp.example.com/v1/about`. Continue if the returned content contains `WEBSESSION-MCP-BRIDGE/1`. Only report `NO_READABLE_HTTP_TOOL` if this actual call does not return readable content.
2. `open` `https://mcp.example.com/v1/s/<CAPABILITY>/tools` to discover tools. Inspect an unfamiliar tool at `/v1/s/<CAPABILITY>/tool/<tool-name-b64>`.
3. For a call, the JSON fields must be exactly `version`, `tool`, and `arguments`: `{"version":1,"tool":"<exact tool name>","arguments":{...}}`. Do not use `args`, `params`, or a top-level `command` field. Compact-JSON encode it, base64url encode it without `=` padding, and keep the encoded request <=256 chars. Use an actual encoder when one is available; do not manually calculate Base64 character-by-character.
4. With a fresh nonce, `open` `/v1/s/<CAPABILITY>/call/<nonce>/<request-b64>`. Read `confirmation_base` and `challenge`, concatenate them exactly, and `open` that URL. Follow `status_url` if queued/running; fetch numbered chunks if returned. Never retry `unknown_outcome` automatically.

Connection test: confirm `dev_1mcp_bash` exists, then use this pre-encoded `{"command":"pwd"}` request with a fresh nonce:

https://mcp.example.com/v1/s/<CAPABILITY>/call/<nonce>/eyJ2ZXJzaW9uIjoxLCJ0b29sIjoiZGV2XzFtY3BfYmFzaCIsImFyZ3VtZW50cyI6eyJjb21tYW5kIjoicHdkIn19

Complete confirmation/polling, then report only:

CONNECTED
WSL_PWD: <actual result>
TOOLS_AVAILABLE: <actual tool_count>
```
