# WebSession client bootstrap prompts

Use this guide when connecting an AI environment to the existing WebHarness deployment through ordinary HTTPS. WebSession is intentionally an **on-demand transport adapter**: the main WebHarness lifecycle does not start, stop, or supervise it.

While the adapter is running, an AI environment with a usable outbound HTTPS primitive can use WebSession as long as it can retain an ordinary capability secret for the session. Programmable clients that support POST plus custom headers use the richer JSON profile. Constrained `GET`/`open`/`fetch`-only agents use the universal GET profile with an explicit confirmation step. Native MCP clients should normally use `/mcp` directly and treat WebSession as an optional secondary path.

WebSession discovery includes authenticated MCP initialization guidance. Header-authenticated `/v1/tools` returns `instructions`; `/v1/instructions` returns it separately, and universal GET discovery uses `instructions_json` in its text response. Generic 1MCP boilerplate is compacted while server guidance is retained. Read that guidance before tool selection. Native MCP clients receive initialization guidance directly; client adherence is not enforced by the server.

WebSession discovers tool names and schemas from the authenticated live 1MCP endpoint. Discovery reconnects to retrieve current initialization guidance. Execution reuses pooled MCP connections and caches tool names for up to 60 seconds, invalidating them on tool-list change notifications; a dispatch failure is never automatically replayed. 1MCP therefore remains the authority for OAuth scope, tool names, tool schemas, availability, and permissions. Rediscover tools in a fresh client session rather than hard-coding a previously observed catalog.

For master-bearer lifetime, rotation, exchange, and storage rules, see [WebSession master bearer](websession-master-bearer.md).

## Compatibility at a glance

| Client capability | WebSession profile | Credential bootstrap |
|---|---|---|
| HTTPS GET + POST + custom headers | enhanced JSON (`json-post-v1`) | master bearer exchange or finite capability |
| Python stdlib HTTPS (chat or code sandbox) | pair + served client (`wh.py` through `POST /v1/pair`) | one-time pair code from `bin/adapter connect` |
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

The adapter lifecycle is manual. Nothing starts it: not `webharness setup --enable-startup`, the `mcp-dev-bridge` service, the watchdog, or a reboot. Nothing stops it either: it has no idle timer, and it keeps serving after every capability has expired or been revoked. It runs from `bin/adapter start` until `bin/adapter stop` or until the host or WSL session ends, and it is not restarted afterwards. A capability expiring ends that client's access only.

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

## Recommended: One-command sandbox-safe pairing

For AI environments inside cloud sandboxes or chat surfaces, skip hand-built bearer flows and pair with one command. On the workstation run:

```bash
bin/adapter connect --here           # pin the current directory as the sticky cwd
bin/adapter connect --cwd ~/repo/webharness
bin/adapter connect --ttl 86400 --pair-ttl 600
```

`bin/adapter connect` starts the adapter when it is not running, resolves the public HTTPS base URL (in this order: `WEBSESSION_ADAPTER_PUBLIC_URL`, `TUNNEL_URL`, the tunnel URL file, then `MCP_PUBLIC_URL` from bridge state or a repo `.env`), creates a one-time pair code with a default `--pair-ttl 300` (five minutes), and prints a ready-to-paste prompt. The client fetches `/v1/client.py` (`wh.py`), exchanges the pair code through `POST /v1/pair`, and stores the resulting ordinary capability in a `0600` private session file (`~/.wh/session.json` or `$WH_SESSION_FILE`) for the default `--ttl 21600` seconds (six hours) so later commands never pass secrets on the command line. The helper never prints the capability bearer secret: only `capability_id`, the operator revocation handle, travels with the summary. Revoke access with `bin/adapter revoke-cap <capability-id>`.

Why `POST /v1/pair` + `wh.py connect` is the canonical pairing path for cloud sandboxes:

- The chat never contains a 43-character capability bearer token in a Bash command, which earlier LLM content-safety filters could block.
- No capability-bearing URL exists in the conversation, so GET link-prefetchers cannot burn single-use capability codes before the client uses them.
- The generated prompt includes the download/connect command and compact guidance for the supplied Python client.
- The connection keeps a sticky default `cwd` from `--here` or `--cwd`, so commands run in the intended project directory.
- Native subcommands (`sigs`, `ls`, `rg`, `read --outline`, `edit`, `write`, `sh`, `review`, and `batch` without JSON-escaping errors) replace hand-written JSON envelopes.

### `wh.py` subcommand reference

`/v1/client.py` (`wh.py`) implements the WebSession JSON profile over these subcommands:

| Command | Meaning |
|---|---|
| `wh.py connect <base> <pair_code>` | exchange the one-time pair code; store base and capability; set the sticky cwd |
| `wh.py tools` / `wh.py sigs` | one compact signature line per live 1MCP tool (`tools --names` for bare names) |
| `wh.py instructions` | authenticated owner and server guidance (compacted) |
| `wh.py pwd`, `wh.py cd <dir>`, `wh.py ls [path]` | session working directory and listings |
| `wh.py rg <pattern> [path]` | structured `dev_search` ripgrep call (vendor dirs excluded by default) |
| `wh.py read <path> --outline` | structural symbol outline of a file |
| `wh.py read <path> <offset> <limit>` | narrow slice read |
| `wh.py read --targets` | targets JSON on stdin; read several files in one call |
| `wh.py edit` | edit JSON on stdin |
| `wh.py write <path>` | file content on stdin |
| `wh.py sh` | shell script on stdin or as arguments |
| `wh.py review [paths...]` | review changed files |
| `wh.py batch` | JSON array on stdin; single-RTT `POST /v1/batch` across up to 20 calls |

## Working directories and output

`connect` saves the base URL, capability, initial wait, and optional cwd to `~/.wh/session.json` (mode `0600`). Set `WH_SESSION_FILE` to keep separate sessions for different hosts or projects. `pwd` prints the selected session cwd when present; `cd <dir>` changes the client's saved context and `cd --clear` removes that client override. These commands do not change the server process's cwd or validate that a selected directory exists.

Relative file paths resolve against the selected cwd. Absolute paths stay absolute, and `~` / `~/...` are passed to Dev for expansion against the remote service user's home, even when a project cwd is active. A capability issued with `--cwd` also supplies a server-side default for supported Dev tools, so clearing a client cwd does not remove the capability's default. This default selects context, not a new authority boundary.

Client environment overrides:

- `WS_BASE` and `WS_CAP` select an explicit host/capability. With `WS_CAP`, the saved client cwd is ignored unless `WS_CWD` is set.
- `WS_CWD` overrides the saved cwd; an empty value disables client-side cwd injection.
- `WS_WAIT` selects the initial POST hold in whole seconds (`0..90`, default `2`). `0` returns the operation recovery URL promptly; later status reads long-poll it.
- `WS_TURN_ID` enables the existing cooperative turn fence. Assign increasing turn numbers when several requests share a capability.
- `WS_MAX_OUTPUT` caps displayed UTF-8 payload bytes (default `8192`; `0` prints everything).

A large Python-client result prints its head and tail and saves the complete text in a private temporary file **in the calling sandbox**. Dev command truncation instead names an output file **on the remote host**. Use the printed location to read the right file; do not repeat a mutation just to retrieve omitted output.

## Search, outline, and focused reads

After downloading and connecting the served client, navigate without constructing shell commands:

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

Admission is atomic; execution is not. Once accepted, tools can succeed or fail independently, and completed effects are not rolled back. Read-only calls may overlap mutations as well as other reads; mutations are serialized. A read listed after a write is therefore not a read-after-write barrier. Submit dependent verification only after the mutation completes.

Each result has its own opaque `status_url` and, for a chunked completion, `chunk_base_url`. If a batch creation response is lost, the client exits with code `2` because submission may have succeeded. Never automatically rerun a mutating batch. The Python client resolves results in input order and stops on a failed item; other accepted items may still be running. Custom clients should retain every returned status URL and inspect each operation's outcome. GET status/chunk failures do not prove that the original operation did not execute.

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

Prefer the exact prompt printed by `bin/adapter connect --here`: it includes the current base, one-use code, expiry, and remote cwd. The template below also works in a Python execution environment without a shell. Replace `<BASE>` and `<PAIR_CODE>` with the values from that generated prompt; keep any existing task instruction after this prompt.

````text
Connect to my development machine through WebSession using Python stdlib.
Base: <BASE>
Pair code: <PAIR_CODE> (single use; redeem before the operator's printed expiry)

Execute this Python code once in your sandbox:

```python
import subprocess
import sys
import urllib.request

base = "<BASE>".rstrip("/")
request = urllib.request.Request(
    base + "/v1/client.py", headers={"User-Agent": "websession-client/1.0"}
)
with urllib.request.urlopen(request, timeout=30) as response:
    source = response.read()
with open("/tmp/wh.py", "wb") as client:
    client.write(source)
subprocess.run([sys.executable, "/tmp/wh.py", "connect", base, "<PAIR_CODE>"], check=True)
```

The client deliberately saves a private 0600 session; do not print the capability or session file. If the code expired or was already redeemed, request a fresh `bin/adapter connect` prompt instead of guessing auth routes.

After CONNECTED, execute `instructions` and `pwd` through /tmp/wh.py. Read the guidance, then continue my task. Invoke later commands with subprocess.run([sys.executable, "/tmp/wh.py", ...], check=True); supply JSON or script content using input=..., text=True when a command reads stdin.

- Discover exact tool signatures with `tools`/`sigs`, and inspect `schema <tool>` before an unfamiliar raw call.
- Navigate with `ls`, `rg <pattern> [path]`, `read <path> --outline`, then `read <path> <offset> <limit>`. `read --targets` reads JSON on stdin for up to 20 files.
- `cd <dir>` selects client context; relative paths use it and ~ / ~/... refer to the remote user's home.
- Use `edit` (JSON stdin), `write <path>` (content stdin), `sh` (script stdin), and `review [paths...]` to change and verify work.
- `batch` reads a JSON array of 1..20 {"tool":"<discovered-name>","arguments":{...}} objects on stdin. Group independent calls only. Admission is atomic; tool effects are not rolled back, and reads may overlap writes. Verify mutations after they complete.
- Keep direct calls short. For long or uncertain commands, use discovered Local Terminal tools or Dev exec detach when available, then observe completion and read logs.
- Exit code 2 means submission/outcome is unknown. Inspect effects or a returned status URL before retrying. Never rerun a mutation just to recover display output. Python output files are in this sandbox; Dev spool files are on the remote host.

Report CONNECTED, the remote cwd, and a compact result for my task. Do not echo credentials.
````

## Programmable HTTP agent bootstrap prompt

Use this when the client has a general HTTPS runtime but cannot run the Python reference client. Supply one credential type: `<PAIR_CODE>` from `bin/adapter connect`, an ordinary `<CAPABILITY>`, or `<MASTER_BEARER>`. Remove unused credential lines before sharing.

```text
Connect to my development machine through WebSession using your HTTPS runtime.
Base: https://mcp.example.com
Pair code: <PAIR_CODE_IF_PROVIDED>
Capability: <CAPABILITY_IF_PROVIDED>
Master bearer: <MASTER_BEARER_IF_PROVIDED>

Keep credentials in memory; never echo/log them or put a bearer in a URL. Use the documented routes exactly:
1. GET /v1/about and confirm WEBSESSION-MCP-BRIDGE/1. This response is text, not JSON.
2. If a capability was supplied, use it. Otherwise redeem a pair code once with POST /v1/pair, Content-Type: application/json, body {"code":"<PAIR_CODE>"}; or exchange a master bearer with POST /v1/access and Authorization: Bearer <MASTER_BEARER>. Require state=ready and retain the returned capability. Do not use a pair code as a bearer. If pairing expires or its response is lost, request a fresh code.
3. GET /v1/signatures and /v1/instructions with Authorization: Bearer <CAPABILITY>. Read the guidance. Use exact live tool names; inspect GET /v1/tools/<name> before an unfamiliar call. If discovery returns default_cwd, resolve relative Dev paths against it; ~ / ~/... retain their remote-home meaning.
4. POST /v1/calls?wait=2 with Authorization: Bearer <CAPABILITY>, Content-Type: application/json, and a fresh runtime-generated Idempotency-Key matching ^[A-Za-z0-9._-]{1,64}$. Body fields are exactly {"version":1,"tool":"<discovered-name>","arguments":{...}}. Do not guess alternative envelope fields or tool aliases.
5. If queued/running, long-poll the returned status_url with wait=90. Treat returned URLs as opaque: preserve their paths, tokens, and other query parameters. If completed with chunk_count=1, read result. If chunk_count>1, GET chunk_base_url + each number from 1 through chunk_count and concatenate the JSON content values in order.
6. For independent calls, POST /v1/batch?wait=2 with the same headers and a fresh key. Body: {"version":1,"calls":[{"tool":"<name>","arguments":{...}}, ...]} (1..20 items). Track every returned result/status URL. Admission is atomic, execution is not: reads may overlap writes, mutations serialize, and completed effects are not rolled back. Submit dependent verification after the mutation completes.
7. Search -> outline -> focused reads using the discovered Dev tools before editing. Group independent checks; keep direct execution short and use discovered durable Terminal or detached-exec support for long work.
8. A lost/invalid submission response or unknown_outcome may mean the tool ran. Never automatically resubmit a mutation. A failed status read or HTTP 404 also does not prove non-execution. Keep recovery URLs private and inspect effects before retrying.

Verify the remote cwd with the discovered shell tool if available, then continue my task. Report CONNECTED, the remote cwd, and compact results only; do not print credentials or transport objects.
```

If Python is available but you already have a capability, fetch `/v1/client.py` and run it with `WS_BASE` and `WS_CAP` passed through your runtime's subprocess environment. If only a master bearer was supplied, first exchange it through `/v1/access`. This mode keeps the supplied capability in memory; set `WS_CWD` explicitly when needed. Pairing via `connect` instead intentionally saves a private session. Avoid stale `WS_BASE`/`WS_CAP` overrides when switching back to a paired session.

## HTTP wire contract reference

Integrators implementing custom non-Python HTTPS clients against `WEBSESSION-MCP-BRIDGE/1` must follow these exact routes:

- `GET /v1/about` (`text/plain`, never JSON): verifies `WEBSESSION-MCP-BRIDGE/1` and advertises limits and URLs.
- `POST /v1/pair` (`Content-Type: application/json`, body `{"code":"<pair-code>"}`): exchanges a one-time operator pair code for `{"state":"ready","capability":"...","default_cwd":"..."}`.
- `POST /v1/access` (`Authorization: Bearer <MASTER_BEARER>`): exchanges a master bearer for a six-hour `main` capability (`ttl_seconds: 21600`).
- `GET /v1/signatures`, `GET /v1/instructions`, `GET /v1/tools`, `GET /v1/tools/<name>` (`Authorization: Bearer <CAPABILITY>`): live 1MCP discovery (`instructions` strips generic proxy boilerplate; `signatures` and `tools` include `default_cwd` when bound).
- `POST /v1/calls?wait=<0..90>` (`Authorization: Bearer <CAPABILITY>`, `Content-Type: application/json`, `Idempotency-Key: ^[A-Za-z0-9._-]{1,64}$`, optional `X-Turn-Id: <uint>`): body `{"version":1,"tool":"<name>","arguments":{...}}`. Poll opaque `status_url` while `queued`/`running`; if `completed` with `chunk_count > 1`, concatenate `GET <chunk_base_url><1..chunk_count>` `.content`. Never auto-retry `unknown_outcome`.
- `POST /v1/batch?wait=<0..90>` (same headers as `/v1/calls`): body `{"version":1,"calls":[{"tool":"<name>","arguments":{...}}, ...]}` (`1..20` items). Atomically admits all items before dispatch; execution permits concurrent read-only tools while serializing mutations, returning `{"protocol":"WEBSESSION-MCP-BRIDGE/1","state":"ready","results":[...]}`.
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

## curl-only agent bootstrap prompt

Use this for an agent with a shell and `curl` but no MCP client. The served client keeps the prompt short: `wh tools` prints one signature line per tool, a full schema is fetched only when needed, shell scripts go through `wh sh` without JSON quoting, and large results are capped. It provides parity for tools only, not MCP resources or prompts, and each shell invocation submits one call. Read-only adapter operations can run concurrently; mutations stay serialized.

Replace `<HOST>` and paste the prompt as the first message. It contains no secret. The agent first asks you to run one command on the workstation, then does the setup itself once you reply:

```text
You have a shell with curl. I want you to use the tools on my workstation through WebHarness at https://<HOST>.

Step 1. Do nothing yet. Tell me to run this in the webharness checkout on my workstation, and to reply "did it" together with the output line that starts with `capability:`
  bin/adapter start && bin/adapter issue-cap
Tell me too that access lasts 24 hours and that the adapter keeps running until I stop it myself. If Python 3 is available, prefer the one-use pairing flow from `bin/adapter connect` instead.

Step 2. After I reply, set up once:
  mkdir -p ~/.wh && curl -fsS https://<HOST>/v1/client.sh -o ~/.wh/wh && chmod +x ~/.wh/wh
  printf '%s' '<capability from my reply>' | ~/.wh/wh login https://<HOST>
It must print `ok: <N> tools`. If it does not, show me the error and stop. Then run `~/.wh/wh tools` and `~/.wh/wh instructions`, verify the cwd with `~/.wh/wh sh pwd`, and continue the task I already supplied. Ask for a task only if I have not supplied one.

Shell work: pass the script on stdin so it needs no JSON quoting, and put several checks in one script instead of one call each:
  ~/.wh/wh sh <<'EOF'
  cd ~/repo/project && git status -sb
  EOF
Other tools: `~/.wh/wh tools` shows each tool's parameters on one line, `~/.wh/wh call <tool> '<json-arguments>'` runs one (`@file` or `-` reads the arguments from a file or stdin), and `~/.wh/wh schema <tool>` gives the full schema when the one-line form is not enough.
Results print as plain text. One over 8 KB shows its start and end, and the full text is saved to `~/.wh/last`: search that file locally instead of repeating the call.
Keep direct execution comfortably under the connector window (target 45 seconds). For long or uncertain commands, prefer the discovered Local Terminal tools; when unavailable and Dev exec supports detach, start detached, wait in short calls, then read the log. Discover the exact exec/wait names first; these examples use dev_exec/dev_wait:
  ~/.wh/wh call dev_exec '{"argv":["bash","-c","<command>"],"detach":true}'    # prints log and exit paths
  ~/.wh/wh call dev_wait '{"name":"job1","condition":{"kind":"file_exists","path":"<exit path>"},"hold_seconds":45}'
After a confirmed wait creation, resume with only `{"name":"job1","hold_seconds":45}` until it prints `matched`. If creation had an unknown outcome, inspect/resume that same name rather than starting the command again. Then `~/.wh/wh sh 'tail -50 <log path>; cat <exit path>'`.
After login, never print, echo or log the capability, and never put it in a URL.
Exit code 2 means the outcome is unknown: do not retry, check whether the effect happened first. Exit code 3 means the client timed out; run `~/.wh/wh status <status_url>` if it printed a status URL. If no status URL was available, do not retry automatically.
When I say I am finished, remind me to run `bin/adapter revoke-cap <capability-id>` and `bin/adapter stop`.
```

`issue-cap` also prints the `capability_id` needed for `revoke-cap`. To skip the guided step, issue the capability yourself and give the agent only Step 2 onwards with the capability filled in.

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
