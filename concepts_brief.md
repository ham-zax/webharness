# WebHarness: five-lens review of a working personal agent bridge

* **Author:** review session, 2026-11-03
* **Status:** brainstorm brief, all six lenses complete (contrarian, token economics, migration, tech debt, observability, client UX)
* **Baseline:** `main` at `a90c3fd feat(websession): fence turns and read binary files`; adapter tests 43/43; `bin/status` reports `issues: 0`

## Overview

The bridge works. A ChatGPT or other MCP client reaches one ARM machine through Cloudflare, gets an OAuth session or a finite capability, and calls tools on the host: shell, browser, terminal, skills. The adapter and 1MCP are supervised, the tunnel is watched, and the test gate is broad.

The review question was "it works, but can it be better", with no predefined success measure. Five independent lenses attacked the design: contrarian, migration, tech debt, observability, and my own direct reading of the code. They agree on the shape of the answer, and it is not what a normal review would say.

**The weak point is not capability. It is that one job has several owners.** Three client programs encode the same protocol. Two credential mints grant the same authority. Two browsers serve one purpose. Two call protocols need two log sanitizers. Two 1MCP aggregators run on one box. Each owner was individually justified, and together they cost failure modes, not features.

The second finding is subtler and worth the whole review: **a feature I shipped today silently locks a capability.** Turn fencing stores a monotonic turn id per capability. There is no delete path. `store.mjs:187` reads `if (turnId == null) return !current;`. Once one numbered call arrives, every later unnumbered call is rejected forever, and the universal GET path answers **HTTP 200** with an error body (`server.mjs:265`) while `POST /v1/calls` answers 409 (`server.mjs:496`). The documented simple path (`docs/websession-clients.md:135-141`) is the one that dies, and the only reset is to mint a new capability and lose the idempotency history. That is a defect, not a trade-off.

## Analysis

### 0. The token bill is smaller than it looks, and two drafts of this review got it wrong

**Corrected measurement, per turn, as deployed:**

| Item | Bytes | Source |
| --- | --- | --- |
| 1MCP generic instruction template | 4,907 | `@1mcp/agent build/core/instructions/templateTypes.js:31`, applied at `build/core/server/serverManager.js:213` |
| top-level catalog: dev, 5 tools | 5,065 | `providers/pi-dev/server.mjs` |
| top-level catalog: local broker, 5 tools | ~4,500 | `providers/local-tools/server.mjs` |
| local broker instructions | 1,495 | `providers/local-tools/server.mjs:685` |
| dev instructions | 129 | `providers/pi-dev/server.mjs` |
| **total** | **~16 KB ≈ 4-4.5K tokens** | |

A 40-turn session therefore re-pays about 160-180K input tokens before any result text. Real, worth fixing, and about 2.5 times smaller than this review first claimed.

`config/templates/mcp-personal.json` mounts only `dev` and `local`. The `chrome-devtools` catalog of 29 tools and 42,407 bytes lives inside the broker's inner 1MCP, and `tool_list` returns `conciseTool` output — name, description, parameter signature (`providers/local-tools/server.mjs:104-122`) — not full schemas. Those bytes are paid only on an explicit `tool_schema` call.

**Per discovery GET, duplicated instructions.** `server.mjs:209` appends `instructions_json: ${JSON.stringify(access.instructions)}` to the plaintext `/v1/s/{cap}/tools` body, and `toolListSnapshot` (`protocol.mjs:19-26`) repeats it in the JSON body. A client that rediscovers pays the 4.9 KB template a second time.

**Per call, envelope 210-330 bytes.** `enhancedSnapshot` emits protocol, state, `operation_id`, `status_url` (~70 B) and `chunk_count` even when the result is already inline (`protocol.mjs:166-190`); `renderChunk` adds a 64-character `sha256` plus `operation_id` per chunk (`protocol.mjs:149-160`). Forty calls and about 100 chunks cost roughly 21 KB per session.

**Not worth effort.** Tool-name prefixes cost 11 bytes per mention, about 440 bytes per session. Chunking itself adds about 130 bytes per chunk.

**Two refuted claims, recorded so they are not repeated.**

1. *First draft:* a 50-tool, 64.4 KB catalog on every turn. Refuted: that is the inner broker aggregate, reachable only through `tool_list` and `tool_schema`.
2. *Second draft:* a 22,104-byte guide served to clients at `providers/websession-adapter/server.mjs:369-372`, so 54-80% of every turn is text meant for a different client. Refuted: `server.mjs:369-372` serves `access.instructions`, which `mcp-client.mjs:46` fills from `connection.client.getInstructions()` — the 1MCP server instructions. The guide is a repository file. No adapter route serves it, and `rg 'websession-clients'` finds only `README.md:245`, `tests/publication.sh:110`, `scripts/public-paths.sh:19` and two docs that link to it. The guide costs only what a human pastes into a chat.

The guide's section sizes still matter, because a human pastes from it: header 1,646; compatibility 822; **operator setup 2,453 (no client needs it)**; reusable six-hour bootstrap 922; programmable HTTP agent prompt 6,941; ChatGPT native MCP prompt 1,913; curl-only prompt 4,977; GET-only prompt 2,430.

### 0b. The client contract has dead ends an agent cannot escape

1. **A master bearer is unusable in every served client.** The guide recommends the reusable secret path for POST-capable clients. `client.sh:183-206` validates one 43-character capability and fails with `invalid capability`, exit 1. Master bearers are 32-128 characters, and neither client has a `/v1/access` branch (`client.sh` commands are `login|tools|instructions|schema|sh|call|status`). Fix: one `wh login --master` branch, plus a message that names the remedy.
2. **Fencing is a one-way trap with a misleading message.** One `X-Turn-Id` from any client kills the universal-GET profile and `wh` for the rest of the capability's life. The universal path answers HTTP 200 with `message: this capability requires the current turn ID via POST` (`server.mjs:283-285`) to a client that has no header channel at all. `wh` never sends `X-Turn-Id`; only `client.py:141-142` honours `WS_TURN_ID`.
3. **Every universal-GET failure is the same `code: not_found`.** Expired capability, revoked capability, malformed nonce, unknown tool and unknown route return identical bytes at HTTP 404 (`server.mjs:167, 194-197, 210-213, 322-325, 345`). `curl -f` reports 404 for an auth problem, and `/v1/about` keeps answering 200 so the documented check discriminates nothing.
4. **`/v1/raw` is an orphan route.** No served client can call it, so the guide instructs the agent to hand-build a Bearer `curl` — the exact thing the native-MCP prompt forbids. Raw also ignores the fence (`server.mjs:521-524`) and returns a third error format with no `protocol` or `state` field.
5. **The guide is not served, so an agent given only a URL and a capability cannot read its own contract.** There is no guide route. `/v1/about` lists `client_url` and `client_python_url` but no documentation pointer and no fence state.
6. **`wh` dumps 600 bytes of raw JSON on failure.** `client.sh request()` prints `HTTP 400: {"protocol":…}` truncated mid-token. An agent then guesses instead of reading a code.
7. **No request identifier reaches a rejected client.** `operation_id` exists only after a successful submit, so "did my call arrive" has no answer to match.
8. **Undocumented starting value for the fence.** The guide never says what a second client sharing one capability should use as its first turn id. Both starting at 1 means the second client is rejected until it guesses higher.

### 1. One job, several owners

| Job | Owners | Where |
| --- | --- | --- |
| Call protocol | `POST /v1/calls`, universal `GET /v1/s/{cap}/call/{nonce}/{b64}` | `server.mjs:744-747`, `:806-820` |
| Client | `client.sh` (217 lines), `client.py` (275), `bin/websession-call` (175) | `server.mjs:21-22,780-797`, `bin/websession-call:12,39-45` |
| Credential mint | `/v1/access` master bearer, local `AdapterStore` mint | `server.mjs:559-575`, `bin/websession-call:39-45` |
| Browser | `browser-devtools` (27 MB), `browser-fast` (159 MB) | `config/templates/mcp-local.json:11-34` |
| Aggregator | outer 1MCP, inner 1MCP under Local | `providers/local-tools/server.mjs:12-42,798-810` |
| Shell | `pi-dev/shell.mjs`, `legacy-shell` monkeypatch | `config/templates/mcp.json:5-28`, `providers/legacy-shell/server.py:9-30` |
| Config template | `mcp.json`, `mcp-personal.json`, `mcp-server.json`, `mcp-local.json` | `scripts/render-config.mjs:426` |

`/v1/access` and the local mint produce the same 6-hour main capability with the same scope. Neither splits privilege and neither audits differently. The only real function of the master bearer is bootstrap from a URL alone, on a client that never had shell access.

`legacy-shell` is specific: `scripts/render-config.mjs:426` picks `mcp.json` only when the profile is neither personal nor server, so the template is live, not dead. It patches private attributes of `mcp-shell-server==1.1.8` to re-tokenize `| ; && ||` and clear `DANGEROUS_COMMANDS`, while `pi-dev/shell.mjs` already owns shell modes.

### 2. Test-only routes sit on the public listener, unauthenticated

`/probe/*` is seven routes (`server.mjs:737-742`, `:825-900`), including `/probe/delay/<0..30>` which holds a connection for up to 30 seconds. Only `:444` authenticates; probe does not. Every probe request runs `randomUUID` + `appendFileSync` + `chmodSync` + `statSync` (`server.mjs:49-67`) and writes `probe.jsonl` (4 MiB cap) into the same directory as `continuation.key` and `operations.sqlite`.

The only consumer is `tests/adapter-probe.sh`, and it is **not** in the CI gate: `scripts/test-all.sh` has no reference to `adapter-probe`. Probe also defines a second protocol dialect (`WEBSESSION-PROBE/1`) and the 405 branch at `server.mjs:774-778` chooses which error dialect to emit. That branch is the sign of structural entanglement, not adjacency.

Do not delete it blindly. The probe suite is the only proof that the tunnel preserves `idempotency-key` and that Cloudflare prefetch does not fire canary URLs, which are the two assumptions the capability-in-URL design rests on.

### 3. The largest file, and the state machine, are untested

`providers/websession-adapter/server.mjs` is 914 lines. No test imports it: every module under `test/` imports `core.mjs`, `store.mjs`, or `protocol.mjs` only. The router, `/v1/raw` confinement, chunk routing, and the 200-vs-409 fencing split have no HTTP-level test. Churn data agrees: `server.mjs` appears in 5 of the last 25 commits.

`.github/workflows/ci.yml:19-25` runs `npm ci` for six providers and **not** for `providers/websession-adapter`, yet `scripts/test-all.sh:18-24` runs its `npm test`. CI is green only because no test touches `@modelcontextprotocol/sdk` today.

### 4. Observability: four hops, no shared identifier

| Hop | Identifier that exists | Reaches the next hop? |
| --- | --- | --- |
| Cloudflare | `cf-ray` | captured only in `probe.jsonl`, `server.mjs:57` |
| Client | `mcp-session-id`, `traceparent` | in the 1MCP header dump only |
| wake proxy | none | `/health/ready` returns `{status, backend}` only |
| adapter | `operation_id`, `request_id` (probe only) | back to the client only |
| dev provider | spool file name, job id | no |

The wake proxy (`lib/bridge/wake-proxy.mjs`) logs nothing. Its refusals are bare strings at `:110`, `:171`, `:184`. The adapter has exactly two `console.*` calls (`server.mjs:726,730`) and logs only `method path - UA`; `sendFailure`, `tool_failed`, `unknown_outcome` and `expired` never reach the log. `requestLogPath` (`:69-80`) rewrites the operation id to the literal placeholder `{operation}`, so the one request that knows the id logs a constant.

`operations.sqlite` already stores `tool`, `state`, `dispatch_started_ms`, `result_text`, `error_text`, `created_ms`, `updated_ms` — the best 3 AM artifact in the system — and nothing reads it. `bin/status` never mentions the adapter at all.

Cost of the fix is small and comes mostly free: 1MCP's `[POST] /mcp` line already dumps every inbound header verbatim, so any header the client sets already lands there. Only the proxy and the adapter must be taught to print it.

### 5. Patching a global npm package is the upgrade hazard

Three patches in `scripts/install-bridge-runtime.sh`, each guarded by "throw if the source shape changed":

| Patch | State on 0.39.8 | Consequence |
| --- | --- | --- |
| OAuth callback origin | needed, but file moved to `build/sdk/legacy/auth/sdkOAuthServerProvider.js` and the predicate grew (`getValidatedLoopbackCallbackOrigin`, lines 498-523) | `readFileSync` ENOENT before the guard; path plus shape both wrong |
| Logger `tailable` | still needed, anchor identical at `build/logger/logger.js:111` | fine today, textual proof only |
| Stdio supervisor `state='connected'` | **fixed upstream**, `build/core/server/backendStdioSupervisor.js:133-143`, cites #547 | installer hard-fails on the stale anchor |

The install order makes this worse: the `npm install` at line 18 replaces the global package before the patches run, so a throw at line 87 leaves the machine on unpatched 0.39.8 with a healthy-looking `bin/status`. There is no rollback snapshot.

Also silent: `bin/adapter:85-87` scrapes `1mcp/sessions/sessions/server/session_sess-*.json` and derives the bearer from the file name. A miss is guarded by `if [ -n "$session_file" ]` with no `else`, so the adapter starts "healthy" with a stale `oauth.json` and every tool call returns 401.

One claim is refuted: **an upgrade saves no tokens.** Both 0.37.0 and 0.39.8 ship `core/capabilities/lazyLoadingOrchestrator.js` and tool-registry pagination. `core/filtering/clientFiltering.js` filters upstream backends, not end clients.

### 6. Two silent config failure modes

`configLoader.js:62-80` in 1MCP parses with a strict Zod schema; on `ZodError` it logs a hashed key and returns `{}`. Sub-objects `[auth]`, `[admin]`, `[logging]` are `.strict()`. One renamed key therefore drops `logging.maxSize`/`maxFiles` and the unbounded log returns, or drops `[admin] enabled=false` and exposes the inner admin surface. Nothing warns.

Public/private classification is a stale deny-list: `scripts/public-paths.sh:11-26` lists whole directories as private while the default is publish-everything, and it names `timer-ping-test.log`, which does not exist.

### 7. Where the review's own framing was wrong

The first draft of the hypothesis said "seven credential paths and no connect-and-verify command". That understates it. The paths do not need a verifier. Two of them are the same mint duplicated and one is stdin-piped. A `doctor` subcommand would have to encode seven special cases and would become the eighth path.

The second draft said the cost of two browser servers is catalog tokens. It is mostly not. `browser-fast` is 159 MB of vendored runtime and a second Windows shim (`windows-chrome.cjs` against `windows-runner.cjs`), plus a second recovery target on every 1MCP reload. The token cost of the extra entry is a few KB.

## Goals vs. Non-Goals

**In scope**

1. Cut the per-turn fixed prefix from ~16 KB to ~11 KB: replace the 4,907-byte 1MCP template with a minimal one, stop advertising the fallback-only Dev tools, and stop duplicating `instructions_json` in every discovery body.
2. Remove the permanent-fence defect and make one status code tell the truth on every profile.
3. Give one caller-visible identifier to every hop and one reader for `operations.sqlite`.
4. Reduce owners: one client implementation, one credential mint, one browser surface, one shell provider.
5. Put an HTTP-level test over `server.mjs` and add the missing `npm ci` line.
6. Make the 1MCP patch set versioned, skippable, reversible, and self-checking.
7. Gate `/probe/*` off by default and keep its protocol-checking value.
8. Make `bin/status` report the adapter and any divergence between components.

**Out of scope (deliberately)**

- OpenTelemetry spans, a collector, or a trace store. 1.4 MB/day needs an id, not an index.
- A log shipper, structured JSON logging everywhere, or a time-series database.
- Vendoring 1MCP into the repo. The three patches are cheaper than ownership.
- A config-precedence module for the env-overridable ports `3050/3051/3052/3060`.
- A schema-migration framework for `operations.sqlite`.
- A synthetic canary that asserts every hop on a timer. Useful later; it answers "is the path healthy", not "explain the call that failed".
- Multi-user authorization. This is one machine with one owner.

## Alternatives Weighed

| Option | Why rejected |
| --- | --- |
| Add a `bin/webharness doctor` that verifies all credential paths | Encodes seven special cases and becomes the eighth path. Delete duplicate mints instead. |
| Keep both call protocols "for compatibility" | Two auth parses, two size ceilings, two renderers, one log sanitizer that exists only because secrets ride in URLs. Pick one. |
| Vendor `@1mcp/agent` into the repo | Turns three patches into a fork to merge on every upstream release. Version table plus `already-fixed` skip is cheaper. |
| Build per-request tracing into `recordEvidence` | Synchronous append and chmod on the hot path, 4 MiB rotation that rolls in hours, and it still stops at the adapter. |
| Delete `client.py` to keep one client | A chat client may have Python and no bash. The right cut is to remove `bin/websession-call`'s independent implementation, keeping its interface. |
| Delete `browser-fast` and keep only `browser-devtools` | Reverses the cost: the full CDP catalog is the *larger* per-session token cost, and `observe`/`execute` refs plus the browser-memory resolver are the parts that make automation finish. The honest cut is to demote `browser-devtools` to on-demand. |
| Gate probe behind an env var only | Leaves 200 lines and a second protocol dialect on the production listener. Keep the three transport-verification routes, drop `delay`/`echo-path`/`request` and the evidence file. |
| Move to 1MCP 0.39.8 now | The installer cannot complete against 0.39.8 and would leave the machine upgraded and unpatched. Blocked until the patch set is versioned. |

## Key Decisions & Staging for Next Steps

**Fix first, cheapest and largest return (token bill):**

0. Replace the 4,907-byte 1MCP generic template with a minimal server-instructions template (S). Saves 4.4 KB per turn.
0b. Stop advertising the fallback-only Dev tools in the default `tool_list`; they stay reachable through `tool_list(server=dev)` and `tool_schema`, both of which already exist (S). Saves 5 KB per turn.
0c. Stop duplicating `instructions_json` in the plaintext discovery body (`server.mjs:209`) (S). Saves 4.9 KB per discovery GET.
0d. Omit `status_url` and `chunk_count` when a result completes inline, and make `sha256` opt-in (S/M). Saves ~10-15 KB per session.

**Fix first, broken promises (the contract says something the code does not do):**

0e. Add `wh login --master` and a remedy in the `invalid capability` message (S).
0f. Serve the guide, or at least the matching section, from a real route and advertise it in `/v1/about` (S).
0g. Split `code: not_found` into `invalid_capability` 401, `operation_not_found` 404, `operation_expired` 410 (S).
0h. Add `wh raw <path>`; wrap raw errors in the common envelope; delete the hand-built-curl instruction (S/M).
0i. Print `request_id` and the `message` field in `client.sh` failures instead of 600 bytes of JSON (S).

**Fix now, independent of any upgrade (defects, not design):**

1. Return 409 for `superseded_by_newer_turn` on every profile (`server.mjs:265`), and give a capability an explicit fence reset. Document that the fence is otherwise permanent.
2. Make the session-file miss fatal at `bin/adapter start`; add an authenticated `tools/list` round-trip as `bin/adapter verify`.
3. Add `npm --prefix providers/websession-adapter ci --omit=dev` to CI.
4. Add an HTTP-level test that boots the real `server.mjs` against the stub backend already in `test/discovery-client.test.mjs`, covering `/v1/raw`, chunk routing, and both fencing status codes.

**Fix next, largest return per hour:**

5. One correlation header (`x-webharness-id`) printed by the wake proxy, the adapter access log, the error renderers, and echoed in `cf-ray`; plus `bin/ops` reading `operations.sqlite`.
6. `bin/status` gains an adapter block: pid, health, 24 h counts, oldest non-terminal operation age.
7. Gate probe off by default; move `probe.jsonl` out of the state dir; delete `delay`, `echo-path`, `request`.

**Design work, needs a decision each (not started):**

8. Collapse three clients to one wire client plus one CLI wrapper.
9. Collapse two credential mints to one.
10. Collapse two browser servers to one, demoting the other to on-demand.
11. Decide whether `legacy-shell` and the inner-1MCP fallback mirror survive.
12. Version the 1MCP patch table with `already-fixed` states, a `--repatch-only` mode, and a pre-upgrade dist snapshot. Then, and only then, consider 0.39.8.

**One deliberate acceptance:** the tunnel lives in the bridge cgroup, so a restart gives Cloudflare 1033 for about 20 seconds and kills `detach: true` jobs. That is documented in `docs/deferred.md`. Do not fix it before the items above.

## Goldfish objections to settle before any code

- **Token economics:** if the client prompt-caches a stable prefix, cutting bytes may save less than reordering for cache hits. Decide whether the fix is byte reduction or a stable-prefix layout, or measure a real session first.
- **Contrarian:** deleting probe deletes the only way to re-verify the tunnel's header and prefetch assumptions after a Cloudflare change. Which three routes must survive?
- **UX:** making a master bearer usable by `wh` extends password-equivalent authority into a shell that writes capabilities to disk. Is that the intended trade, or should the shell client stay out of the bootstrap path?
- **Migration:** the fence fix and the fence reset change wire behaviour. Is a capability allowed to reset its own fence, or must the owner re-mint?
- **Tech debt:** collapsing clients touches the documented quick path in `docs/websession-clients.md`. Which client is the "wire client" that ChatGPT-class clients can actually obtain?
- **Observability:** one header plus one line per hop answers four of the five 3 AM questions. Do you accept the header contract as the new protocol minimum, which means a version bump in `/v1/about`?
