# Providers

WebHarness is organized around capability boundaries, not one tool per package.

## Dev — `providers/pi-dev/`

Files, ChatGPT-native file ingress, aggregate Git change review, short-RPC shell-free structured argv execution, short-RPC native Bash, regular-file topology operations, and durable local waits. Long or duration-uncertain commands belong in the Local Terminal server and are observed through Dev `wait`.

Personal Workstation surface:

```text
read edit write import_file file_ops review_changes wait exec bash
```

`import_file` and `review_changes` are Personal Workstation tools: the former streams one trusted ChatGPT-native file to a create-only WSL destination, while the latter returns a bounded aggregate view of the current Git working tree without creating checkpoints or refs. `restricted` and `trusted-dev` expose smaller subsets according to their trust policy.

## Code logical server — `providers/code-router/`

Repository intelligence published through Local as `server="code"`:

```text
code_search code_context code_symbol
```

Each call resolves the nearest canonical Git root and routes to a correctly rooted CodeDB child. The raw CodeDB MCP catalog is not model-facing.

## Terminal logical server — `providers/terminal/`

Persistent PTY control published through Local as `server="terminal"`:

```text
terminal_open terminal_read terminal_send terminal_resize terminal_list terminal_yield terminal_close
```

The MCP provider talks to a local broker over a Unix socket. tmux owns PTY/process lifetime; the broker owns metadata, transcript/cursor state, and human/model control leases.

## Host logical server — `providers/pi-dev/host-server.mjs`

Personal Windows-host actions are published through Local as `server="host"`. The current surface is `pc_sleep`; its implementation reuses the Pi Dev package dependencies but is not part of the direct Dev tool catalog.

## Local — `providers/local-tools/`

Stable downstream tool-broker surface:

```text
tool_list tool_schema tool_call fallback_dispatch tool_batch
```

The Local provider connects over stdio to one inner 1MCP in direct mode. It exposes logical `{server, tool}` identities, bounded live discovery, exact schema lookup, ordinary one-shot `tool_call`, recovery-only `fallback_dispatch`, and bounded same-tool batch dispatch over structured arguments. The Personal Workstation inner composition contains public `code`, `terminal`, `host`, `browser-devtools`, `browser-fast`, and `browser-jev` servers plus owner-added MCPs, alongside one fallback-only mirror of outer Dev. Unscoped `tool_list` hides the Dev mirror, while explicit read-only `tool_list(server="dev")` and `tool_schema(server="dev", tool=...)` may inspect it for recovery. Ordinary `tool_call` and `tool_batch` still reject Dev; only `fallback_dispatch` can execute through that mirror. The fallback is intentionally advertised with `readOnlyHint` for transport compatibility even though the selected downstream operation may mutate state. The outer Local provider remains tagged only `local`.

## Browser — `providers/browser/`

The `browser-devtools` logical server is the resource-local DevTools surface behind Local. It republishes the complete pinned Chrome DevTools MCP catalog internally and adds `browser_target`, `browser_backend`, and `browser_profile`. Calls default to the dedicated persistent Windows MCP Chrome profile. On Linux, the same backend/profile policy as `browser-fast` selects Chrome or Clearcote; managed Clearcote attaches to the selected running profile's live loopback CDP endpoint, while an explicit Chrome backend can use a standalone named persistent profile. Keep this surface for network, console, performance, Lighthouse, heap, screenshots, and detailed debugging.

## Browser Fast — `providers/browser-fast/`

The `browser-fast` logical server exposes only `observe` and `execute`. Omitted `browser_profile` preserves shared browser state; an explicit stable name requests persistent isolation. On Windows, profileless calls share `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profile` with `browser-devtools`, while named Browser Fast profiles use `%LOCALAPPDATA%\\mcp-dev-bridge\\chrome-profiles\\<name>` with separate visible Chrome processes, Agent Browser sessions, and operation queues. Everyday Chrome is outside this MCP boundary, and Browser DevTools currently targets only the shared default Windows profile. Linux uses the current-user-owned `~/.config/mcp-dev-bridge/browser-fast.json` for its default and managed Clearcote catalog. Each Linux call can explicitly select `browser_backend=chrome` or `browser_backend=clearcote`; a supplied profile requires that explicit backend. Chrome profile names create or reuse isolated persistent bridge-state directories. Clearcote profile names must exist in the configuration catalog. Managed Chrome keeps Agent Browser 0.35.0 as observer and executor. Managed Clearcote uses pinned `clearcote@0.27.0` to own persistent profiles and ephemeral loopback CDP endpoints; one runtime is kept per named profile, and concurrent startup for the same profile is coalesced in-process. Within one Clearcote profile, `observe` claims an unclaimed tab for the first caller and a fresh tab for later independent callers, then derives a strict Agent Browser session from that target. Different Linux tabs run concurrently while operations on the same tab serialize; explicitly different profiles can remain live concurrently. Supported input routes through Clearcote's humanized Playwright context while Agent Browser keeps refs and target IDs. `execute` requires the target/backend/profile/tab tuple from `observe`, validates the pinned tab before mutation, never retries, and reports partial or unknown outcomes explicitly. Windows process launch uses ephemeral `DevToolsActivePort` endpoints and a native one-shot helper with bounded output so WSL interop cannot retain GUI-launch pipes. Firefox is not supported by the Chromium-CDP Agent Browser backend.

## Browser Jev — `providers/browser-jev/`

The `browser-jev` logical server exposes `jev_run`, `jev_start`, `jev_tick`, `jev_state`, and `jev_stop`. `jev_run` is the fast one-call path: it starts a run, advances the existing Jev loop internally, and returns as soon as the declared deterministic success checks pass; a premature Jev `DONE` is treated as advisory during this autonomous path. Optional `scenario.collection` accumulates bounded visible text records across virtualized/infinite-scroll observations using a simple start-line prefix and exact end-line marker, deduplicates up to 200 records, feeds trusted progress back into Jev, and automatically becomes a deterministic `collection_complete` requirement. A collection request must include at least one URL/title/text success check to identify the intended document; records are accepted only while those identity checks pass, progress resets on document change, and only provider-owned settling WAIT observations count toward stability. A no-new scroll schedules settling, so unrelated model WAITs or a transient lazy-load bottom cannot complete collection. `success.scroll_exhausted` is also available when whole-document bottom is the real completion condition. The stateful start/tick/state/stop tools remain available for interactive inspection and steering. It runs the Git-pinned upstream Jev Ultrafast loop through one uv-locked Python worker per run, with provider-local bounded snapshot/dynamic-page adaptations: the model still sees at most 250 actions, full-action freshness is preserved by a compact deterministic hash, guards exist only for selectable actions, very sparse initial pages receive a bounded hydration window, model-selected collection scrolls get a short post-scroll quiet-period re-observation, and once collection has started on a page that already satisfies the non-collection success checks the provider switches to deterministic observed scroll/wait traversal without another TypeSafe decision per step. Transient `BLOCKED` states are re-observed when deterministic work remains, and the three-no-progress scroll guard gets bounded lazy-load recovery before blocking. The Python worker sends only Browser-Jev's bounded wire snapshot rather than upstream cumulative model-request state, stdout is bounded per JSON response rather than cumulatively across a persistent run, and an aborted autonomous MCP request is noticed between bounded worker cycles so the run-owned target/helper are cleaned instead of continuing as orphaned work. Deterministic URL requirements are resolved before TypeSafe when one unique observed link destination satisfies the unmet `url_contains` checks; relative hrefs are normalized, dynamic pages get a short bounded hydration window, and the click still goes through Jev's observed-node/freshness executor. If no unique deterministic destination is available, TypeSafe remains the semantic fallback and each link target includes its already-observed href so the Choice has the discriminating evidence it needs. The configured small text model is used only for `TYPE_TEXT`. It resolves the same Windows Chrome and Linux browser-fast identities at each start. Live Clearcote profiles are attached through their ephemeral loopback endpoint without launching a second browser; Linux Chrome obtains the resolved session endpoint through Agent Browser `get cdp-url`. Each run owns a background target and a unique namespaced Browser Harness daemon, and stop closes only those owned resources. The worker also writes a mode-0600 ownership lease beneath the current user's XDG state directory, marks the content tab in per-tab session storage, and marks the helper `about:blank` with a run-specific fragment. Clean stop removes the lease only after target absence and daemon exit are proven; if a worker/provider dies first, the next run for that managed profile reclaims only dead-owner tabs carrying that exact marker and independently confirms same-endpoint recorded target IDs. Profile operations serialize and tool output is sanitized. Tool schemas accept neither model credentials, DOM selectors, regular expressions, nor executable verification logic.

## Legacy shell — `providers/legacy-shell/`

Retained only for the `restricted` profile's conservative allowlisted shell policy.

See [Architecture](../docs/architecture.md) and [Security](../docs/security.md) for the current boundaries.
