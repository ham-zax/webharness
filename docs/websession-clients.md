# WebSession client bootstrap prompts

Use this guide when connecting an AI environment to the existing WebHarness deployment through ordinary HTTPS. WebSession is intentionally an **on-demand transport adapter**: the main WebHarness lifecycle does not start, stop, or supervise it.

While the adapter is running, an AI environment with a usable outbound HTTPS primitive can use WebSession as long as it can retain an ordinary capability secret for the session. Programmable clients that support POST plus custom headers use the richer JSON profile. Constrained `GET`/`open`/`fetch`-only agents use the universal GET profile with an explicit confirmation step. Native MCP clients should normally use `/mcp` directly and treat WebSession as an optional secondary path.

WebSession discovery includes authenticated MCP initialization guidance. Header-authenticated `/v1/tools` returns `instructions`; `/v1/instructions` returns it separately, and universal GET discovery uses `instructions_json` in its text response. Generic 1MCP boilerplate is compacted while server guidance is retained. Read that guidance before tool selection. Header-authenticated instructions and tool-list responses include a compact HTTP contract with the call endpoint, headers, envelope, polling, batch, and cwd rules, even when the upstream has no initialization instructions. Universal GET discovery retains only compact upstream guidance, so GET-only clients are not directed to POST/header routes. Native MCP clients receive initialization guidance directly; client adherence is not enforced by the server.

WebSession discovers tool names and schemas from the authenticated live 1MCP endpoint. Discovery reconnects to retrieve current initialization guidance. Execution reuses pooled MCP connections and caches tool names for up to 60 seconds, invalidating them on tool-list change notifications; a dispatch failure is never automatically replayed. 1MCP therefore remains the authority for OAuth scope, tool names, tool schemas, availability, and permissions. Rediscover tools in a fresh client session rather than hard-coding a previously observed catalog.

For master-bearer lifetime, rotation, exchange, and storage rules, see [WebSession master bearer](websession-master-bearer.md).

## Compatibility at a glance

| Client capability | WebSession profile | Credential bootstrap |
|---|---|---|
| HTTPS GET + POST + custom headers | enhanced JSON (`json-post-v1`) | master bearer exchange or finite capability |
| Python stdlib HTTPS (chat or code sandbox) | direct JSON HTTPS through `urllib.request` | one-time pair code from `bin/adapter connect` |
| Generic code/runtime HTTP client | enhanced JSON (`json-post-v1`) | master bearer exchange or finite capability |
| Shell with curl only (no MCP client) | enhanced JSON via served client (`/v1/client.sh`) | finite capability issued by the operator |
| HTTPS GET/open/fetch only | universal GET (`universal-get-v1`) | finite capability issued by the operator |
| Native MCP client | direct `/mcp` preferred | normal MCP OAuth; WebSession optional |

An environment with no outbound HTTPS primitive, or one that cannot safely retain a capability secret between requests, cannot use WebSession.

## Operator setup

Start the adapter only when you want the HTTP compatibility path exposed:

```bash
bin/adapter start
bin/adapter auth-status
bin/adapter status
```

The main `/mcp` endpoint is independent. The public `/v1/*` WebSession routes are available only while the adapter is running; when it is stopped those routes are intentionally unavailable (typically surfaced by the tunnel as an upstream error).

The adapter lifecycle is separate from the main bridge. `webharness setup --enable-startup`, the `mcp-dev-bridge` service and the watchdog never start it. Nothing stops it either: it has no idle timer, and it keeps serving after every capability has expired or been revoked. A capability expiring ends that client's access only.

A manual `bin/adapter start` inherits the systemd scope cgroup of the caller, so the adapter stops when that scope stops. For long-lived access, install the adapter's own unit with `scripts/install-websession-adapter-user.sh`. The unit starts at user-session startup and restarts the adapter after a crash. See [operations](operations.md#optional-websession-http-compatibility-adapter).

For a finite client capability:

```bash
bin/adapter issue-cap                         # 24 hours, the default and the maximum
bin/adapter issue-cap 3600 --here             # pin the current directory as default cwd
bin/adapter issue-cap --cwd ~/repo/webharness # 24 hours with an explicit default cwd
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

Treat the capability as a secret. Do not commit it, paste it into documentation, or ask the client to repeat it in its answer. When the HTTP access window is over, revoke outstanding finite capabilities as appropriate and stop the adapter explicitly:

```bash
bin/adapter stop
```

For ChatGPT sessions that already have native MCP access to this WSL, prefer the local wrapper instead of constructing bearer-bearing curl commands in the model-visible Bash request:

```bash
bin/websession-call dev_bash '{"command":"pwd"}'
```

`bin/websession-call <tool> '<arguments-json>'` creates a temporary ordinary capability in private adapter state, submits the exact tool call through the public WebSession `POST /v1/calls` path, follows status/chunks to a terminal result, and revokes the temporary capability after a known terminal outcome. It never prints the capability. If submission or status transport becomes ambiguous, it does not retry the operation and leaves the temporary capability to expire rather than changing an unresolved operation.

## Recommended: One-command HTTP pairing

On the host, issue a one-use code and a ready-to-paste HTTP connection prompt. Choose the project directory the agent will actually work in:

```bash
bin/adapter connect --here           # pin the current directory as the sticky cwd
bin/adapter connect --cwd ~/repo/my-project
bin/adapter connect --ttl 86400 --pair-ttl 600
```

`bin/adapter connect` starts the adapter if needed, resolves the public base URL (in order: `WEBSESSION_ADAPTER_PUBLIC_URL`, `TUNNEL_URL`, the tunnel URL file, then `MCP_PUBLIC_URL` from bridge state or repo `.env`), and issues a single-use pair code. The code defaults to a five-minute redemption window (`--pair-ttl 300`); the resulting capability defaults to six hours (`--ttl 21600`). The generated prompt describes ordinary HTTP pairing and discovery and does not download or execute a helper. It states the owner's authorization, expiry, selected cwd, and task scope explicitly. Agent-specific acceptance cannot be guaranteed by prompt wording.

The default prompt redeems `POST /v1/pair?discover=1` with `{"code":"<pair-code>"}` and retains the returned capability privately. One response includes compact `instructions`, `signatures`, `tool_count`, and `default_cwd` when set. Pairing without `discover=1` keeps the original lightweight response. Discovery is bounded to 10 seconds; if unavailable, the response still has `state: ready`, the capability, `discovery_state: unavailable`, and the HTTP contract. Save access and retry only discovery; do not redeem again. Python's built-in `urllib.request` works without installing packages. The public clients at `/v1/client.py` and `/v1/client.sh` remain optional conveniences for environments where the operator has chosen to install them. Their availability is not a prerequisite for HTTP pairing.

The summary prints `capability_id` as the revocation handle; it does not print the capability bearer. Revoke with `bin/adapter revoke-cap <capability-id>`.

### Select project context once

`bin/adapter connect --cwd ~/repo/my-project` stores that project default on the capability. Supported Dev calls inherit it: shell calls can omit `cwd`, file calls use relative paths, and search/listing can omit `path`. The WebHarness checkout is only where the operator command lives; it is not the required working directory. Omitting both `--cwd` and `--here` leaves the provider's configured default in effect.

To switch projects once during a session without repeating `cwd` or long absolute paths on every request, call `POST /v1/cwd` with `Authorization: Bearer <capability>`, `Content-Type: application/json`, and `{"cwd": "~/repo/other-project"}` (`{"cwd": null}` clears the capability default, and `GET /v1/cwd` reads the active `default_cwd`). The adapter validates and canonicalizes the directory through `dev_list_directory`, updates `default_cwd` on the capability in SQLite, and returns both the canonical `default_cwd` and top-level directory `listing` in a single round-trip. Subsequent Dev calls (`dev_read`, `dev_edit`, `dev_write`, `dev_search`, `dev_list_directory`, `dev_bash`, `dev_exec`, `dev_file_ops`, `dev_review_changes`) inherit the new `default_cwd` automatically. The optional Python client also supports `cd <dir>` locally. Use separate capabilities for concurrent sessions working in different folders; Local Terminal tools still take their own `cwd` when opening a terminal.

### `wh.py` subcommand reference

`/v1/client.py` (`wh.py`) implements the WebSession JSON profile over these subcommands:

| Command | Meaning |
|---|---|
| `wh.py connect <base> <pair_code>` | pair with bundled discovery; save private access before discovery; print signatures and guidance |
| `wh.py import-session [base] [--cwd DIR]` | import existing session JSON from stdin without pairing or making a network request |
| `wh.py tools` / `wh.py sigs` | one compact signature line per live 1MCP tool (`tools --names` for bare names) |
| `wh.py instructions` | authenticated owner and server guidance (compacted) |
| `wh.py pwd`, `wh.py cd <dir>`, `wh.py ls [path] [--depth 1..4] [--all]` | session working directory, single-level listings, or bounded repo trees |
| `wh.py rg <pattern> [path]` | structured `dev_search` ripgrep call (vendor dirs excluded by default) |
| `wh.py read <path> --outline` | structural symbol outline of a file |
| `wh.py read <path> <offset> <limit>` | narrow slice read |
| `wh.py read --targets` | targets JSON on stdin; read several files in one call |
| `wh.py edit` | edit JSON on stdin |
| `wh.py write <path>` | file content on stdin |
| `wh.py sh` | shell script on stdin or as arguments |
| `wh.py review [paths...]` | review changed files |
| `wh.py batch [--seq] [--continue]` / `wh.py pipe` | parallel or sequential (`edit -> test -> review`) single-RTT `POST /v1/batch` across up to 20 calls |
| `wh.py llist`, `wh.py lschema`, `wh.py lcall`, `wh.py lbatch` | unwrapped shortcuts for `local_tool_list`, `local_tool_schema`, `local_tool_call`, and `local_tool_batch` |
| `wh.py pull /tmp/<file> [local_path]` | download binary/artifact files (screenshots, PDFs, logs up to 10 MiB) via `GET /v1/raw` |
| `wh.py --save <file> <cmd> ...` | spool full command output privately (`0600`) in the local sandbox while printing a short preview |

## Adopt an existing HTTP session in the Python CLI

After HTTP pairing, do not reuse the single-use pair code. Once the operator approves a locally installed Python client, import the existing capability without placing it in command-line arguments:

```text
python3 /tmp/wh.py import-session https://mcp.example.com
```

Pass JSON on stdin from the runtime that already holds the capability: `{"capability":"<existing capability>"}`. The command also accepts `{"base":"https://mcp.example.com","cap":"<existing capability>"}` with no positional base. It writes only the base, capability, wait, and optional client cwd to `WH_SESSION_FILE` (default `~/.wh/session.json`) via atomic replacement, mode `0600`. It prints a short import confirmation, never the capability, and makes no HTTP requests. It does not validate server-side expiry or revocation; the next authenticated operation does that.

Omit cwd to inherit the server's current project selection. Importing `cwd` / `default_cwd`, or specifying `--cwd`, creates a client-local override; that override keeps taking precedence after a later server-side `/v1/cwd` change. Use a client-local override deliberately, or `cd --clear` to remove it. The agent can now use `python3 /tmp/wh.py tools`, `read`, `edit`, and `batch` with the tested client's polling and unknown-outcome handling. Helper installation stays a separate operator-approved step.

## Working directories and output

`connect` saves the base URL, capability, initial wait, and optional cwd to `~/.wh/session.json` (mode `0600`). Set `WH_SESSION_FILE` to keep separate sessions for different hosts or projects. `pwd` prints the selected session cwd when present; `cd <dir>` changes the client's saved context and `cd --clear` removes that client override. These commands do not change the server process's cwd or validate that a selected directory exists.

Relative file paths resolve against the selected cwd. Absolute paths stay absolute, and `~` / `~/...` are passed to Dev for expansion against the remote service user's home, even when a project cwd is active. A capability issued with `--cwd` also supplies a server-side default for supported Dev tools, so clearing a client cwd does not remove the capability's default. This default selects context, not a new authority boundary.

`sh` and generic `call dev_bash` / `call dev_exec` apply the same client cwd default (also used by batches, review, and file operations that accept cwd). An explicit `arguments.cwd` wins. If no client cwd is selected, the adapter can supply the capability's server-side default. This is remote project context: the sandbox process's own current directory is not sent automatically, and a `cd` inside one remote shell call does not persist to the next.

Client environment overrides:

- `WS_BASE` and `WS_CAP` select an explicit host/capability. With `WS_CAP`, the saved client cwd is ignored unless `WS_CWD` is set.
- `WS_CWD` overrides the saved cwd; an empty value disables client-side cwd injection.
- `WS_WAIT` selects the initial POST hold in whole seconds (`0..90`, default `2`; `batch`, `pipe`, and `l*` commands floor to `10` when `WS_WAIT` is unset). `0` returns the operation recovery URL promptly; later status reads long-poll it over the same keep-alive HTTP connection.
- `WS_TURN_ID` enables the existing cooperative turn fence. Assign increasing turn numbers when several requests share a capability.
- `WS_MAX_OUTPUT` caps displayed UTF-8 payload bytes (default `4096`; `0` prints everything).

A large Python-client result prints its head and tail and saves the complete text in a private temporary file **in the calling sandbox**. Dev command truncation instead names an output file **on the remote host**. Use the printed location to read the right file; do not repeat a mutation just to retrieve omitted output.

## Search, outline, and focused reads

When using an operator-installed reference client, navigate without constructing shell commands:

```bash
python3 /tmp/wh.py rg 'resolve_remote_path' providers -g '*.py'
python3 /tmp/wh.py read providers/websession-adapter/client.py --outline
python3 /tmp/wh.py read providers/websession-adapter/client.py 145 35
python3 /tmp/wh.py read --targets <<'JSON'
[{"path":"README.md","mode":"outline"},{"path":"docs/configuration.md","offset":1,"limit":40}]
JSON
```

`rg` calls `dev_search`, with smart-case matching by default. Use `-F` for literal matching, `-s`/`-i` for explicit case behavior, `-g` for file globs, and `-m` for the total result cap. The provider defaults to 80 matches overall and 20 per file, accepts up to 500 overall and 200 per file, and bounds output at 32 KiB. Vendored trees are excluded by default (`skill-library/packs`, `third_party`, `node_modules`, `.git`); `--all` disables those explicit exclusions but does not override ripgrep's normal hidden/ignored-file rules.

Line reads default to 160 lines, capped at 16 KiB per file. Outline mode returns numbered structural landmarks, with a bounded plain-text fallback when none match. Multi-file reads accept up to 20 targets with a combined 32 KiB output budget; request remaining targets separately if the batch is truncated. A missed edit anchor can return a short nearest-match snippet to help construct a corrected edit.

## Batch admission, ordering, and recovery

Group independent calls into one HTTP request. Use the exact names returned by `tools`; this example uses the `dev_read` and `dev_search` names:

```bash
python3 /tmp/wh.py batch <<'JSON'
[
  {"tool":"dev_read","arguments":{"path":"README.md","mode":"outline"}},
  {"tool":"dev_search","arguments":{"pattern":"pairing","path":"docs"}}
]
JSON
```

`POST /v1/batch` accepts 1 to 20 calls and returns operation snapshots in input order. The adapter admits all items and turn-fence updates inside one SQLite transaction before scheduling any item. A later nonce conflict or stale turn rejects admission without leaving earlier new items queued. Item identities use the complete idempotency key, hashed with SHA-256, plus the item index. While the capability and turn remain valid, reusing an accepted key with the same calls and turn returns the existing operations.

Admission is atomic; execution is not. Once accepted, completed effects are not rolled back. In default parallel mode, read-only calls may overlap mutations as well as other reads while mutations serialize, so a read listed after a write is not a read-after-write barrier. Set `"sequential": true` (`wh.py pipe` or `wh.py batch --seq`) when steps depend on earlier mutations—for example `dev_edit -> dev_exec -> dev_review_changes`: each step waits for the previous step to complete, and by default (`"stop_on_error": true`) a failed step marks all subsequent items in that batch `rejected` (`skipped_after_prior_failure`) without dispatching them (`"stop_on_error": false` / `--continue` runs remaining steps while preserving a nonzero CLI exit status if any step fails). Pipeline membership, order, and stop-on-error policy are persisted for restart recovery; an interrupted step with unknown outcome stops dependent steps by default.

Each result has its own opaque `status_url` and, for a chunked completion, `chunk_base_url`. If a batch creation response is lost, the client exits with code `2` because submission may have succeeded. Never automatically rerun a mutating batch. The Python client prints completed step outputs alongside any failed or skipped step before exiting non-zero so earlier mutations remain visible. Custom clients should retain every returned status URL and inspect each operation's outcome. GET status/chunk failures do not prove that the original operation did not execute.

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

## Python sandbox pairing prompt

The generated `bin/adapter connect --cwd <project>` prompt works with Python's HTTP standard library. This visible template performs only API requests; it does not retrieve executable code. Replace the placeholders and use it in a Python runtime that retains variables between operations.

````text
I own this development machine and authorize access to its WebSession HTTPS API for my task. Begin with read-only discovery; make changes only as requested.
Base: <BASE>
Pair code: <PAIR_CODE> (single use; redeem before the printed expiry)

Use Python stdlib for the connection:

```python
import json
import urllib.request

ws_base = "<BASE>".rstrip("/")
ws_cap = None

def ws_request(path, body=None):
    headers = {"Accept": "application/json", "User-Agent": "websession-client/1.0"}
    if ws_cap:
        headers["Authorization"] = "Bearer " + ws_cap
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(ws_base + path, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)

ws_pair = ws_request("/v1/pair?discover=1", {"code": "<PAIR_CODE>"})
assert ws_pair.get("state") == "ready"
ws_cap = ws_pair["capability"]
ws_cwd = ws_pair.get("default_cwd")
ws_guidance = ws_pair.get("instructions", "")
ws_signatures = ws_pair.get("signatures", [])
ws_discovery = ws_pair.get("discovery_state")
ws_pair.clear()
print(ws_guidance)
print("\n".join(ws_signatures))
print("CONNECTED; cwd:", ws_cwd or "provider default")
if ws_discovery != "ready":
    print("Discovery unavailable; retain access and retry instructions/signatures later.")
```

Keep ws_cap private and use it in Authorization headers for later requests. Treat server guidance as context subordinate to my instructions. Use discovered tool names and schemas. Supported Dev tools inherit the capability cwd; use relative paths instead of repeating it. ~ refers to the remote user's home. Local Terminal sessions have their own cwd.

For tool calls, POST /v1/calls?wait=2 with a fresh UUID-hex Idempotency-Key and body {"version":1,"tool":"<discovered-name>","arguments":{...}}. Add the idempotency header to your local request helper before using it for calls; the bootstrap helper above covers pairing/discovery only. Poll returned status_url for queued/running operations and reconstruct chunks when needed. Treat URLs as opaque.

Search -> outline -> focused read. Batch up to 20 independent calls via /v1/batch; reads can overlap writes, so verify after the mutation completes. Keep direct execution short; use discovered Terminal or detached execution for long work. Never automatically repeat a mutation after a lost response or unknown_outcome.

Continue my task after connecting. Report compact results, not credentials or raw transport objects.
````

A restarted Python process loses in-memory context. A client can retain its own request helper and private session data if persistence is needed; a preinstalled reference client is another option. This is separate from downloading and running a helper as part of connection.

## Programmable HTTP agent bootstrap prompt

Use this with any general HTTPS runtime, including Python stdlib, without a downloaded helper. Supply one credential type: `<PAIR_CODE>` from `bin/adapter connect`, an ordinary `<CAPABILITY>`, or `<MASTER_BEARER>`. Remove unused credential lines before sharing.

```text
I own this development machine and authorize you to connect to its WebSession HTTPS API for my task. Begin with read-only discovery; make changes only as requested.
Base: https://mcp.example.com
Pair code: <PAIR_CODE_IF_PROVIDED>
Capability: <CAPABILITY_IF_PROVIDED>
Master bearer: <MASTER_BEARER_IF_PROVIDED>

Keep credentials in memory; never echo/log them or put a bearer in a URL. Use the documented routes exactly:
1. GET /v1/about and confirm WEBSESSION-MCP-BRIDGE/1. This response is text, not JSON.
2. If a capability was supplied, use it. Otherwise redeem a pair code once with POST /v1/pair?discover=1, Content-Type: application/json, body {"code":"<PAIR_CODE>"}; or exchange a master bearer with POST /v1/access and Authorization: Bearer <MASTER_BEARER>. Require state=ready and retain the returned capability. Do not use a pair code as a bearer. If pairing expires or its response is lost, request a fresh code.
3. Use bundled instructions/signatures when discovery_state=ready. Otherwise retain the capability and GET /v1/signatures and /v1/instructions with Authorization: Bearer <CAPABILITY>; retry only discovery if unavailable. Read the guidance, including the HTTP contract. Use exact live tool names; inspect GET /v1/tools/<name> before an unfamiliar call. Supported Dev tools inherit the returned default_cwd; omit repeated cwd arguments and use relative paths. ~ / ~/... retain their remote-home meaning. Keep a separate local project context if switching directories; Local Terminal tools have their own cwd.
4. POST /v1/calls?wait=2 with Authorization: Bearer <CAPABILITY>, Content-Type: application/json, and a fresh runtime-generated Idempotency-Key matching ^[A-Za-z0-9._-]{1,64}$. Body fields are exactly {"version":1,"tool":"<discovered-name>","arguments":{...}}. Do not guess alternative envelope fields or tool aliases.
5. If queued/running, long-poll the returned status_url with wait=90. Treat returned URLs as opaque: preserve their paths, tokens, and other query parameters. If completed with chunk_count=1, read result. If chunk_count>1, GET chunk_base_url + each number from 1 through chunk_count and concatenate the JSON content values in order.
6. For independent calls, POST /v1/batch?wait=2 with the same headers and a fresh key. Body: {"version":1,"calls":[{"tool":"<name>","arguments":{...}}, ...]} (1..20 items). Track every returned result/status URL. Admission is atomic, execution is not: reads may overlap writes, mutations serialize, and completed effects are not rolled back. Submit dependent verification after the mutation completes.
7. Search -> outline -> focused reads using the discovered Dev tools before editing. Group independent checks; keep direct execution short and use discovered durable Terminal or detached-exec support for long work.
8. A lost/invalid submission response or unknown_outcome may mean the tool ran. Never automatically resubmit a mutation. A failed status read or HTTP 404 also does not prove non-execution. Keep recovery URLs private and inspect effects before retrying.

Verify the remote cwd with the discovered shell tool if available, then continue my task. Report CONNECTED, the remote cwd, and compact results only; do not print credentials or transport objects.
```

If you already have an ordinary capability, use it directly in the Authorization header and skip pair-code redemption. A master bearer is exchanged through `/v1/access`. An operator-installed Python client may also use `WS_BASE` and `WS_CAP`; set `WS_CWD` for a client-local project override. Remote helper installation is optional and separate from connection.

## HTTP wire contract reference

Integrators implementing custom non-Python HTTPS clients against `WEBSESSION-MCP-BRIDGE/1` must follow these exact routes:

- `GET /v1/about` (`text/plain`, never JSON): verifies `WEBSESSION-MCP-BRIDGE/1` and advertises limits and URLs.
- `POST /v1/pair[?discover=1]` (`Content-Type: application/json`, body `{"code":"<pair-code>"}`): exchanges a one-time operator pair code for `{"state":"ready","capability":"...","default_cwd":"..."}`. Optional discovery adds `discovery_state`, compact HTTP/owner `instructions`, `signatures`, and `tool_count`. Discovery failure retains the capability with `discovery_state: unavailable`; retry discovery only. Invalid or duplicate `discover` query parameters are rejected before redemption.
- `POST /v1/access` (`Authorization: Bearer <MASTER_BEARER>`): exchanges a master bearer for a six-hour `main` capability (`ttl_seconds: 21600`).
- `GET /v1/signatures`, `GET /v1/instructions`, `GET /v1/tools`, `GET /v1/tools/<name>` (`Authorization: Bearer <CAPABILITY>`): live 1MCP discovery (`instructions` strips generic proxy boilerplate; `signatures` and `tools` include `default_cwd` when bound).
- `POST /v1/calls?wait=<0..90>` (`Authorization: Bearer <CAPABILITY>`, `Content-Type: application/json`, `Idempotency-Key: ^[A-Za-z0-9._-]{1,64}$`, optional `X-Turn-Id: <uint>`): body `{"version":1,"tool":"<name>","arguments":{...}}`. Poll opaque `status_url` while `queued`/`running`; if `completed` with `chunk_count > 1`, concatenate `GET <chunk_base_url><1..chunk_count>` `.content`. Never auto-retry `unknown_outcome`.
- `POST /v1/batch?wait=<0..90>` (same headers as `/v1/calls`): body `{"version":1,"calls":[{"tool":"<name>","arguments":{...}}, ...],"sequential"?:true,"stop_on_error"?:true}` (`1..20` items). Atomically admits all items before dispatch; default mode permits concurrent read-only tools while serializing mutations, whereas `sequential: true` enforces strict step-by-step ordering and fail-fast skipping (`stop_on_error: true` default), returning `{"protocol":"WEBSESSION-MCP-BRIDGE/1","state":"ready","results":[...]}`.
- `GET /v1/cwd` (`Authorization: Bearer <CAPABILITY>`): returns the capability's current `default_cwd`. `POST /v1/cwd` (same bearer, `Content-Type: application/json`, body `{"cwd":"~/repo/project"}` or `{"cwd":null}`): validates and selects a project once or clears the default; returns `default_cwd` and a listing after a successful selection. Local Terminal cwd is separate.
- `GET /v1/raw?path=<url-encoded-/tmp/file>` (`Authorization: Bearer <CAPABILITY>`): streams regular `/tmp/*` files up to 10 MiB (rejects final-component symlinks).

## ChatGPT / native MCP + optional WebSession bootstrap prompt

```text
You already have native MCP access to my development machine. You also have a local WebSession wrapper for sending an operation through the public WebSession HTTPS path without placing bearer credentials or curl construction in the model-visible Bash command.

Use native MCP as the primary interface and discover/use its tools normally.

For a WebSession execution from native MCP, do not probe WebSession auth routes and do not construct `curl` commands containing `Authorization: Bearer`. From the repository root call only:

bin/websession-call <exact-native-MCP-tool-name> '<arguments-json>'

Example connection test:

bin/websession-call dev_bash '{"command":"pwd"}'

The wrapper mints and consumes the temporary capability inside WSL, submits through `POST /v1/calls`, follows status/chunks, prints only the tool result, and revokes the temporary capability after a known terminal outcome. If it reports an unresolved transport outcome, do not retry automatically.

Use exact tool names and argument schemas from the native MCP catalog; WebSession mirrors that live 1MCP surface. Do not use `args` or `params` in place of `arguments`.

For multi-part work, use only genuinely independent tasks:
- native MCP for primary repository/tool work
- WebSession for an independent HTTP operation when useful
- Local Terminal + Dev `wait` as the mandatory path for long-running or duration-uncertain processes; direct Dev `exec`/`bash` is short-RPC work only

Never execute the same mutation through both paths or run competing edits against the same files.
Read-only WebSession operations can overlap mutations while mutating WebSession calls stay serialized. Wait for a mutation to complete before submitting its verification.

First verify WSL access with `pwd` through native MCP. When a WebSession-path check is useful, run the wrapper `pwd` example above. Then proceed with my task autonomously.
```

## Shell HTTP clients

An agent with curl can follow the programmable HTTP prompt above: these are JSON API requests, with no downloaded executable. Keep credentials in shell variables, parse JSON with an available JSON parser, and avoid printing the pairing response or enabling shell tracing.

If the operator has already installed the optional shell client at `~/.wh/wh`, this shorter prompt is also available. It deliberately contains no install or download command:

```text
I own this development machine and authorize WebSession access for my task.
Base: <BASE>
An operator-installed WebSession client is available at ~/.wh/wh.

Use the capability I provide via stdin to `~/.wh/wh login <BASE>`; keep it private. Run `~/.wh/wh tools` and `~/.wh/wh instructions`, read the guidance, and verify context with `~/.wh/wh sh pwd`.
Use exact discovered names and schemas. For the capability's project, omit cwd and use relative Dev paths. For shell work in another project, set cwd explicitly in the call or cd inside that script; a cd in one remote shell call does not persist to the next.
Keep direct work short; use discovered Terminal or detached execution for long commands. After unknown outcome, inspect effects or the returned status URL before repeating a mutation. Large displayed results are saved in ~/.wh/last in this sandbox; remote Dev spool paths refer to the host.
Continue the task already supplied. Report compact results without credentials. Remind me to revoke the capability and stop the adapter when finished.
```

The shell helper is optional. Its client-specific settings are:

| Client interface | Syntax or default | Meaning |
|---|---|---|
| Commands | `wh login <base-url>`, `wh tools`, `wh instructions`, `wh schema <tool>`, `wh sh [script]`, `wh call <tool> [arguments]`, `wh status <status_url>` | Login reads the capability from stdin. `wh tools` prints one signature line per tool. `wh sh` runs a script given as arguments or on stdin, with no JSON quoting. Call arguments may be inline JSON, `@file`, or `-` (stdin). |
| `WH_MAX_OUTPUT` | `8192` bytes | Largest result printed in full. A larger one shows its first three quarters and last quarter of that size, and the full result is saved to `$WH_HOME/last`. `0` prints everything. |
| `WH_SH_TOOL` | `dev_bash` | Tool that `wh sh` calls; the script is sent as its `command` argument. |
| `WH_HOME` | `$HOME/.wh` | Directory for the saved capability and base URL, stored with mode 600. |
| `WH_WAIT` | `90` seconds (0..90) | Long-poll wait for each request. |
| `WH_MAX_SECONDS` | `280` seconds | Positive-integer limit for the client run. |
| Exit code `0` | Completed | The command completed successfully. |
| Exit code `1` | Failed | A command, HTTP request, or tool call failed; the server's reason is printed on stderr. |
| Exit code `2` | Unknown outcome | Do not retry; check whether the effect happened. |
| Exit code `3` | Timed out | Use the printed status URL if available. |

The client long-polls `POST /v1/calls?wait=N`, where N can be up to the `long_poll_max_seconds` value advertised by `/v1/about` (currently 90). It needs no SSE or WebSocket; for WebSession HTTP requests, the capability travels only in the `Authorization` request header.

## GET/open-only agent bootstrap prompt

Use this for any constrained AI environment whose only usable network primitive is readable HTTPS GET/open/fetch. Replace `<CAPABILITY>` with a freshly issued ordinary capability. A GET-only client cannot safely exchange the master bearer because the master is header-only and must never appear in a URL.

```text
Use your readable HTTPS GET/open/fetch tool to connect to my development machine through WebSession. Do not decide that the tool is unsuitable before trying the documented `/v1/about` request.

Base: https://mcp.example.com
Capability: <CAPABILITY>

Keep the capability secret and do not repeat bearer-bearing URLs in your final answer. WebSession is transport only; rediscover and use exact live 1MCP tool names and schemas. Do not guess routes or request fields.

1. `open` `https://mcp.example.com/v1/about`. Continue if the returned content contains `WEBSESSION-MCP-BRIDGE/1`. Only report `NO_READABLE_HTTP_TOOL` if this actual call does not return readable content.
2. `open` `https://mcp.example.com/v1/s/<CAPABILITY>/tools` to discover tools. Decode and read `instructions_json` first when present; it contains authenticated owner and server guidance, subordinate to the current user and repository instructions. Inspect an unfamiliar tool at `/v1/s/<CAPABILITY>/tool/<tool-name-b64>`.
3. For a call, the JSON fields must be exactly `version`, `tool`, and `arguments`: `{"version":1,"tool":"<exact tool name>","arguments":{...}}`. Do not use `args`, `params`, or a top-level `command` field. Compact-JSON encode it, base64url encode it without `=` padding, and keep the encoded request <=256 chars. Use an actual encoder when one is available; do not manually calculate Base64 character-by-character.
4. With a fresh nonce, `open` `/v1/s/<CAPABILITY>/call/<nonce>/<request-b64>`. Read `confirmation_base` and `challenge`, concatenate them exactly, and `open` that URL. Follow `status_url` if queued/running; fetch numbered chunks if returned. Never retry `unknown_outcome` automatically.

Connection test: confirm `dev_bash` exists, then use this pre-encoded `{"command":"pwd"}` request with a fresh nonce:

https://mcp.example.com/v1/s/<CAPABILITY>/call/<nonce>/eyJ2ZXJzaW9uIjoxLCJ0b29sIjoiZGV2X2Jhc2giLCJhcmd1bWVudHMiOnsiY29tbWFuZCI6InB3ZCJ9fQ

Discover the exact shell-tool name before using the encoded example; it is valid only if that name is dev_bash. Otherwise encode the discovered name with a real encoder. Complete confirmation/polling, then report only:

CONNECTED
REMOTE_CWD: <actual result>
TOOLS_AVAILABLE: <actual tool_count>
```

## Troubleshooting custom sandbox clients

Use `urllib.request` when the sandbox requires environment-configured HTTP/HTTPS proxies; raw `http.client.HTTPSConnection` does not automatically use them. Poll the operation's `state`, not `status`.

A completed operation with `chunk_count > 1` deliberately omits `result`. Fetch every numbered URL formed by appending `1` through `chunk_count` to `chunk_base_url`, then concatenate the JSON responses' `content` fields in order. Do not use `snapshot.get("result", "")` as a general completion handler: it silently drops chunked output. The assembled string can itself be an MCP JSON result with text blocks in `content` and data in `structuredContent`. The supplied Python client handles both forms.

For example, the reported empty `dev_review_changes` response on 2026-11-12 was retained in 16 chunks (123,362 UTF-8 bytes). Reassembly recovered a valid review of 17 files, including two untracked files. The server had produced the review; the missing inline result was not evidence of an empty working tree.

Use `/health/ready` for the deployed bridge readiness probe. `/` and `/health` are not documented health endpoints. Configure Cloudflare Tunnel's final catch-all as `service: http_status:404` so unmatched paths return 404 rather than a misleading 502 from a nonexistent upstream. Preserve explicit `/v1/*`, MCP, OAuth, SSH, and other application routes above the catch-all.
