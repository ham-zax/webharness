# WebHarness Agents Implementation Plan

**Goal:** After WebHarness stabilization is complete and the public `webharness` checkout is the canonical live source, add first-class parallel ChatGPT workers through one small `agents` MCP surface, a persistent WebHarness Agent Broker daemon, and the vendored ChatGPT browser extension as the first worker backend.

**Architecture:** Keep Dev, Code, Terminal, Local, Browser, and Browser DevTools unchanged. Add `Agents` as a separate outer MCP authority domain. The MCP provider is intentionally thin: the persistent Agent Broker owns prime/worker identity, worker lifecycle, queues, browser commands, and durable agent state. The vendored Chrome extension under `third_party/chat-on-steroids-extension/` is the only ChatGPT-side adapter: it proves conversation/request identity from ChatGPT page evidence, opens/revives worker chats, sends worker prompts, and reports turn lifecycle back to the broker. A narrow pinned-1MCP compatibility hook carries the inbound ChatGPT request ID to the Agents provider and appends queued agent messages to ordinary WebHarness tool results.

**Tech Stack:** Node.js 24+, MCP SDK, pinned 1MCP 0.36.0 compatibility patching, systemd user services, Unix domain sockets, loopback HTTP bridge, Chrome Manifest V3 extension, existing Cloudflare/OAuth transport, existing WebHarness lifecycle/rendering.

## Global Constraints

- This plan starts only after `2026-08-29-webharness-product-stabilization.md` is complete, the canonical `webharness` public checkout is the development source, and the maintained workstation is running from that checkout.
- Do not add a Workspace object, `workspaceId`, worktree management, project authority, project lifecycle, or automatic repository isolation.
- Agents are a new first-class outer domain. Do not put worker orchestration behind Local, Browser, Browser DevTools, Dev, Code, or Terminal.
- The authoritative ChatGPT browser adapter is the vendored snapshot at `third_party/chat-on-steroids-extension/`. Do not fetch or depend on upstream source during implementation. Modify this vendored copy only; refresh it later only as an explicit vendor update with a new pinned commit recorded in `UPSTREAM.md`.
- Do not port the vendored project's desktop app, session recorder, goal loop, Compact & Resume system, workspace subsystem, or general chat-history product. Reuse only extension mechanisms needed for ChatGPT conversation identity, request correlation, worker tab creation/revival, command acknowledgement, and worker turn observation.
- ChatGPT worker conversations are the only backend in this implementation. Do not introduce Codex/API/provider abstractions until a second real backend exists.
- Do not make the model carry a worker/prime bearer token. Agent identity is the exact ChatGPT conversation proven by browser request-id evidence.
- Workers share the same WSL user, files, repositories, terminals, and browser capabilities as the prime subject to the existing WebHarness tool/profile authority. Agents does not create filesystem isolation. The prime is responsible for assigning disjoint work when concurrent mutation would conflict.
- Keep one executing swarm globally in V1, with at most eight workers occupying active slots. Sleeping workers retain their ChatGPT conversation but consume no active slot. A different prime receives `AGENTS_BUSY` while another swarm is executing.
- Do not create an autonomous hidden model scheduler. MCP cannot start a new prime model turn. Worker messages are delivered into the next proven WebHarness tool result for that conversation, and `agents status` is the explicit retrieval path when the prime is otherwise idle. Automatic synthetic user-message injection into the prime chat is out of scope.
- Browser Fast and Browser DevTools do not own or drive worker ChatGPT tabs. The Agents extension is an independent browser-side adapter for the user's ChatGPT session.
- Preserve existing Terminal/tmux lifetime semantics and bridge OAuth/session state.
- Testing remains governed by repository policy. Do not create a new Agents unit-test architecture merely for this plan; update existing mandatory root/lifecycle/publication contracts where the new provider/service changes their asserted composition, then run the repository-required gate once at candidate final state.

## Target Model-Facing Contract

The outer personal composition becomes:

```text
Dev
Code
Terminal
Local
Agents    agents(action=spawn|message|status|finish)
```

`Agents` is not present in `restricted` or `trusted-dev` unless a later authority decision explicitly adds it.

The single `agents` tool uses an action-discriminated schema:

```text
spawn
  tasks: 1..8 [{ task, label? }]
  context?: shared text prepended to each worker brief
  caps: task <= 8,000 chars, label <= 80 chars, context <= 8,000 chars

message
  messages: 1..16 [{ to, text }]
  caps: each text <= 8,000 chars
  - prime may address workers by agent id
  - a worker may address only `prime`

status
  agents?: agent ids
  - prime sees its worker states and unread/result summaries
  - worker sees only its own state plus prime-message availability

finish
  result: final worker report, <= 16,000 chars
  - worker-only
  - transitions that worker to sleeping, not destroyed

broker delivery
  - at most 200 unacknowledged messages per recipient
  - at most 32,000 appended characters in one ordinary tool result
```

A later `message` from the prime to a sleeping worker revives that exact ChatGPT conversation. V1 does not expose worker deletion, cancellation, workspace inheritance, model selection, or backend selection.

## Runtime State Model

The Agent Broker owns these states:

```text
worker:
  invited   browser command queued/opening
  active    exact worker conversation bound and working
  detached  worker conversation known but no live tab observation while work may still be running
  waking    sleeping worker is being reopened for a new prime message
  sleeping  not executing; exact conversation retained for reuse
  failed    bootstrap/revival irrecoverably failed
```

`finish` and an extension-proven settled final assistant turn both stop active execution. Explicit `finish` carries the worker's chosen report. If the worker forgets to call `finish`, the extension-proven final assistant text becomes the fallback result sent to the prime. Closing a tab while a turn may still be running produces `detached`, not immediate failure; bounded silence may return it to `sleeping` without inventing a result.

The broker persists only agent orchestration facts needed to resume its own runtime:

- prime conversation id for the swarm;
- run id and active/dormant state;
- worker id, label, task, bound conversation id, lifecycle state, timestamps;
- queued prime/worker messages and bounded delivery cursor;
- pending browser commands and command acknowledgements;
- extension pairing state;
- last known extension heartbeat and worker turn facts.

It does **not** persist a general ChatGPT transcript or project/workspace model.

---

### Task 1: Define the WebHarness Agent Broker protocol and persistent owner

**Files:**
- Create: `providers/agents/package.json`
- Create: `providers/agents/package-lock.json`
- Create: `providers/agents/broker.mjs`
- Create: `providers/agents/rpc-client.mjs`
- Create: `systemd/wsl-agent-agents.service.in`
- Create: `scripts/install-agent-broker-user.sh`
- Modify: `docs/development.md`

**Interfaces:**
- Consumes: existing external state/runtime conventions, systemd-user ownership pattern, Node.js runtime.
- Produces: persistent Agent Broker Unix-socket RPC plus a local browser-extension bridge.

**Steps:**
- [ ] Implement one long-lived `providers/agents/broker.mjs` process as the sole owner of swarm state, worker lifecycle, queues, browser commands, request-id correlations, and durable agent metadata.
- [ ] Use `${XDG_RUNTIME_DIR}/wsl-agent-agents.sock` for private MCP/1MCP-to-broker RPC. Remove only a stale socket the broker itself owns; refuse ambiguous ownership rather than deleting an arbitrary path.
- [ ] Store durable broker state beneath `${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge/agents/` with mode `0700`; write state atomically and keep credentials/state outside Git.
- [ ] Expose a browser bridge compatible with the vendored extension's retained transport pattern: probe the fixed `127.0.0.1:8765..8769` range, bind exactly one free port, and identify it with a WebHarness-specific `/hello` response so another local app on the range is never mistaken for this broker.
- [ ] Before relying on Windows Chrome -> WSL `127.0.0.1` forwarding, make the installer perform one bounded reachability preflight from Windows. If the maintained WSL networking mode cannot reach the WSL loopback listener from Windows Chrome, stop this task at that boundary and use a thin Windows loopback relay that forwards only the extension bridge protocol to the same WSL broker; the WSL Agent Broker remains the authority and no browser-side state moves into the relay.
- [ ] Keep the browser bridge narrow. Implement only `/hello`, `/pair`, `/activity`, `/events`, `/correlations`, `/commands/redeem`, `/commands/ack`, and `/closed`. The broker must not implement the vendored app's goal, compact/resume, settings, filesystem, command-execution, or general session-history APIs.
- [ ] Keep the extension pairing credential in broker-private state and the extension service worker's Chrome storage. `/pair` is loopback-only; authenticated routes require the bearer plus a `chrome-extension://` Origin, bounded bodies, and bounded request rates. Browser endpoints cannot execute WSL tools directly.
- [ ] Define the private Unix RPC operations required by later tasks: `agents_call`, `deliver_inbox`, `health`, and `status`. `agents_call` receives the proven ChatGPT request id plus the model-facing action payload. `deliver_inbox` receives the proven request id and returns a bounded text appendix or no appendix.
- [ ] Make browser command delivery idempotent by command id. A worker bootstrap/revival is considered sent only after `/commands/ack` names the exact ChatGPT conversation that accepted the message.
- [ ] Render/install `wsl-agent-agents.service` using the same user-systemd ownership conventions as Terminal. The service owns only the Agent Broker; it does not own 1MCP, Cloudflare, Terminal/tmux, or Chrome lifetime.

**Acceptance criteria:**
- The Agent Broker can restart without losing bound worker identities, sleeping workers, queues, or pending command state.
- Browser-facing routes cannot directly reach Dev/Code/Terminal/Local execution.
- The broker has one authoritative place for every agent state transition; the MCP provider and extension do not maintain competing swarm state.

---

### Task 2: Add proven ChatGPT caller identity to the pinned 1MCP boundary

**Files:**
- Create: `scripts/patch-1mcp-agent-hooks.mjs`
- Modify: `scripts/install-bridge-runtime.sh`
- Modify: `scripts/render-config.mjs`
- Modify: `docs/operations.md`
- Modify: `docs/security.md`

**Interfaces:**
- Consumes: ChatGPT inbound HTTP `x-request-id`, vendored extension `/correlations` evidence, Agent Broker Unix RPC.
- Produces: trusted `_meta["webharness/request-id"]` on the downstream Agents tool call plus a post-tool inbox-decoration hook.

**Steps:**
- [ ] Extend the existing pinned-1MCP installation compatibility work with one fail-closed patch script rather than hand-editing the global package at runtime. The patch script must validate and patch the exact 1MCP 0.36.0 files `build/transport/http/routes/streamableHttpRoutes.js` and `build/core/protocol/toolRequestHandlers.js`, create the qualified helper `build/core/protocol/webharnessAgentContext.js`, and refuse an unknown upstream source shape.
- [ ] Add a tiny AsyncLocalStorage request context inside the installed pinned 1MCP runtime. At the Streamable HTTP POST boundary, normalize `x-request-id` to the portion before `/`; duplicate, malformed, absent, or overlong values resolve to no identity rather than a guessed value.
- [ ] In 1MCP direct tool dispatch, overwrite any caller-supplied `_meta["webharness/request-id"]` with the request id captured from the actual inbound HTTP request. When no trusted request id exists, omit the key.
- [ ] Preserve every other downstream MCP request field and result shape. The Agents provider is the only provider that consumes the reserved metadata key.
- [ ] After any direct WebHarness tool call returns, ask the Agent Broker `deliver_inbox` for the same trusted request id. When no agent message is pending, return the upstream `CallToolResult` unchanged. When messages are pending, append one bounded text content block and leave existing text/images/resources/structured content intact.
- [ ] Inbox decoration is non-authoritative for ordinary tool execution: if the Agent Broker is unavailable, Dev/Code/Terminal/Local results must still return unchanged. The `agents` tool itself fails normally when its broker is unavailable.
- [ ] Implement bounded at-least-once inbox delivery: a broker offer is acknowledged by the next proven tool call from that same conversation, then the next undelivered slice may be offered. Cap one appended inbox slice so a worker backlog cannot dominate an unrelated tool result.
- [ ] Render the broker socket path into the environment inherited by the outer 1MCP process, using the existing bridge state/runtime configuration rather than hard-coded home paths.
- [ ] Document this as a qualified pinned-1MCP compatibility patch beside the existing OAuth CSP and log-rotation patches.

**Acceptance criteria:**
- A model cannot become prime or worker by supplying a token, agent id, conversation id, or forged `_meta` field.
- The only authority join is: inbound ChatGPT request id -> extension-observed request id/conversation id correlation -> broker-owned conversation role.
- Agent inbox delivery cannot break or reinterpret an otherwise successful non-Agents tool call.

---

### Task 3: Add the first-class `Agents` MCP provider

**Files:**
- Create: `providers/agents/server.mjs`
- Modify: `config/templates/mcp-personal.json`
- Modify: `scripts/render-config.mjs`
- Modify: `scripts/smoke-local.sh`
- Modify: `tests/harness.sh`
- Modify: `tests/publication.sh`
- Modify: `providers/README.md`
- Modify: `docs/compatibility.md`

**Interfaces:**
- Consumes: `MCP_AGENT_SOCKET`, trusted `_meta["webharness/request-id"]`, Agent Broker `agents_call` RPC.
- Produces: one model-facing `agents` tool in a new outer provider/tag domain.

**Steps:**
- [ ] Implement `providers/agents/server.mjs` as a thin stdio MCP server. It owns the `agents` schema and converts broker replies into bounded MCP text/structured results; it does not own swarm state or browser tabs.
- [ ] Expose exactly one tool named `agents` with the `spawn`, `message`, `status`, and `finish` action shapes defined in this plan. Reject fields that do not belong to the selected action rather than silently ignoring them.
- [ ] Extract only the reserved trusted request-id metadata inserted by 1MCP and pass that value to the broker. When it is absent, return `AGENT_IDENTITY_UNAVAILABLE` for identity-sensitive actions; do not fall back to current tab, timing, task text, worker id, or caller claims.
- [ ] Implement broker role rules: the first successful `spawn` from a proven non-worker conversation establishes that conversation as the prime; an active worker conversation resolves only to its bound worker; a sleeping worker cannot act until its prime revives it; every unrelated conversation is a stranger.
- [ ] `spawn` stages 1..8 worker records and browser bootstrap commands atomically after prime identity and global-capacity checks pass. Return worker ids and lifecycle state without keeping the MCP call open for browser loading.
- [ ] `message` from the prime queues text to the named worker. If the worker is sleeping, atomically reserve a slot and stage a revival command for the exact bound conversation. `message` from a worker may address only `prime`.
- [ ] `status` returns role-appropriate bounded state. Do not expose another prime's swarm or another worker's task/message history to a worker.
- [ ] `finish` is worker-only. It records the final report once, queues it to the prime, releases the active slot, and transitions the worker to `sleeping`. Exact repeated `finish` on the already-stopped turn is idempotent rather than duplicating the report.
- [ ] Add outer provider `agents` only to the full Personal Workstation composition, with its own `agents` tag and `MCP_AGENT_SOCKET`. Do not place it behind Local or add it to the restricted/trusted-dev profiles in this wave.
- [ ] Update existing hard-coded personal provider-set/publication assertions from `code,dev,local,terminal` to include `agents`, and extend syntax/structure checks to the new provider without creating a separate test framework.

**Acceptance criteria:**
- ChatGPT sees one additive first-class Agents tool; existing Dev/Code/Terminal/Local tool contracts are unchanged.
- A worker can never promote itself to prime, adopt another worker id, inspect another swarm, or revive itself.
- Sleeping workers preserve their exact ChatGPT conversation for reuse while consuming no active slot.

---

### Task 4: Adapt the vendored extension into the WebHarness ChatGPT worker adapter

**Files:**
- Modify: `third_party/chat-on-steroids-extension/manifest.json`
- Modify: `third_party/chat-on-steroids-extension/background.js`
- Modify: `third_party/chat-on-steroids-extension/content.js`
- Modify: `third_party/chat-on-steroids-extension/popup.html`
- Modify: `third_party/chat-on-steroids-extension/popup.js`
- Modify: `third_party/chat-on-steroids-extension/popup.css`
- Preserve: `third_party/chat-on-steroids-extension/chatgpt-dom.js`
- Preserve: `third_party/chat-on-steroids-extension/fiber.js`
- Preserve as an unused vendored source file after removing it from the manifest: `third_party/chat-on-steroids-extension/overlay.css`
- Preserve: `third_party/chat-on-steroids-extension/LICENSE`
- Update: `third_party/chat-on-steroids-extension/UPSTREAM.md`

**Interfaces:**
- Consumes: Agent Broker browser bridge and ChatGPT page/DOM/request metadata.
- Produces: exact request-id/conversation correlations, worker tab lifecycle observations, bootstrap/revival command execution, extension health.

**Steps:**
- [ ] Rename the unpacked extension's user-visible identity to **WebHarness Agents** while preserving the vendored MIT attribution/provenance.
- [ ] Keep `chatgpt-dom.js` and `fiber.js` at the vendored snapshot initially. Reuse the existing MV3 service-worker architecture, durable Chrome-storage journal/outbox pattern, tab-to-conversation tracking, command redeem/ack flow, ChatGPT composer insertion, and current request-id extraction mechanisms required for worker identity and reliable bootstrap delivery. Any later ChatGPT DOM/fiber repair is a separate evidence-driven change, not part of the first port.
- [ ] Change `/hello` compatibility checks and popup text to the WebHarness Agent Broker protocol. Keep the fixed loopback port permissions used by the broker.
- [ ] Reduce browser-to-broker traffic to the eight retained Agent Broker routes. Remove/disable extension calls and UI for goal loops, compact/resume, settings, general session recording, app dashboards, and unrelated desktop-app behavior rather than making the broker emulate those products. Remove `overlay.css` from `manifest.json` once the corresponding general session/goal overlay code is removed from `content.js`; keep the vendored file itself for provenance until a later vendor cleanup is explicitly requested.
- [ ] Report exact `{requestId, conversationId}` correlations gathered from ChatGPT's own page evidence. Never derive ownership from active tab, timing proximity, visible tool name, or task text.
- [ ] When the prime receives an `open-worker` command through its activity poll, open exactly one marked ChatGPT tab for that command. The fresh page redeems the command id, waits for a usable empty composer, inserts the broker-supplied worker bootstrap, submits once, learns the exact `/c/<conversationId>`, and ACKs that binding. Do not retry a send whose final outcome is unknown.
- [ ] Worker bootstrap text contains only broker-supplied standing instructions, shared context, label/id, and task. It contains no bearer credential. It tells the worker to use normal WebHarness tools and `agents finish` for its explicit final report.
- [ ] For a sleeping worker revival, reopen the exact recorded ChatGPT conversation and send the prime's queued message only after the page proves it represents that conversation and exposes an idle usable composer. Never send a revival into a different/new chat.
- [ ] Report worker turn start/end, settled final assistant text, tab closure, extension heartbeat, and enough context-size telemetry to diagnose exhausted chats. Do not turn this into a general transcript recorder.
- [ ] If a worker's settled assistant turn ends without an explicit `finish`, send the final assistant text to the broker as the fallback worker result and let the broker transition the worker to sleeping exactly once.
- [ ] Keep popup scope operational: broker connected/disconnected, protocol compatibility, active prime/run, worker counts, and last bridge error. Do not recreate the vendored desktop control plane inside the extension.

**Acceptance criteria:**
- The extension can establish exact prime/worker conversation identity without a model-carried credential.
- A queued spawn creates one worker chat and one bootstrap; browser reload/retry cannot create duplicate workers for the same command id.
- A sleeping worker can be revived in its exact old ChatGPT conversation.
- The adapted extension no longer depends on unimplemented goal/session/compact application APIs.

---

### Task 5: Complete broker lifecycle, message delivery, and failure semantics

**Files:**
- Modify: `providers/agents/broker.mjs`
- Modify: `providers/agents/server.mjs`
- Modify: `third_party/chat-on-steroids-extension/background.js`
- Modify: `third_party/chat-on-steroids-extension/content.js`
- Modify: `docs/security.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: Tasks 1-4 working transport/identity paths.
- Produces: end-to-end swarm semantics that remain correct across tab closure, bridge/provider restart, and sleeping-worker revival.

**Steps:**
- [ ] Enforce the single executing swarm claim in the broker. Dormant/sleeping worker history is keyed by its prime conversation and holds no global execution slot; when that prime later wakes a worker and no other swarm is executing, the broker creates a new active run incarnation over the retained worker set.
- [ ] Bound active capacity at eight slot-occupying workers (`invited`, `active`, `detached`, `waking`). Reject further work with a clear capacity result; do not silently queue unlimited worker execution.
- [ ] Give every broker message a monotonic sequence per recipient. `deliver_inbox` offers oldest-first bounded messages and records the offered-through sequence; the recipient's next proven WebHarness tool request acknowledges that prior offer before a new slice is returned.
- [ ] For active workers, prime messages may arrive through the next WebHarness tool-result appendix. For sleeping workers, the same `message` action performs a browser revival so the message becomes the next ordinary user turn in the exact worker chat.
- [ ] Worker-to-prime messages and final reports remain queued if the prime has no active model turn. Do not simulate a user message or start a hidden ChatGPT turn to wake the prime.
- [ ] If the extension reports a worker tab closed during an unfinished turn, mark it `detached` and retain its slot for a bounded silence window. If no further proven call/turn evidence arrives by that deadline, transition it to sleeping and report that the worker stopped without a confirmed final result; do not fabricate success or failure.
- [ ] Treat bootstrap/revival delivery as an explicit command transaction: staged -> redeemed by the intended page -> submitted -> ACKed with exact conversation -> committed. A timeout before ACK fails that command once; automatic retries must not open surprise tabs later.
- [ ] On broker restart, restore durable worker bindings/queues/commands, then wait for fresh extension heartbeats/correlations before making new browser assertions. Process-memory loss must not reassign conversations.
- [ ] Keep agent errors specific and bounded: `AGENTS_BUSY`, `AGENT_IDENTITY_UNAVAILABLE`, `AGENT_NOT_FOUND`, `AGENT_NOT_ACTIVE`, `AGENT_CAPACITY`, `AGENT_EXTENSION_UNAVAILABLE`, `AGENT_COMMAND_FAILED`, and `AGENT_BROKER_UNAVAILABLE`. Do not leak another swarm's ids or state in error text.

**Acceptance criteria:**
- Agent state remains attributable after broker/1MCP/provider restarts without inventing identity.
- Delivery is bounded and at-least-once; a large backlog cannot consume arbitrary model context.
- Browser ambiguity produces a visible failed/unknown agent outcome, never duplicate chat creation or a guessed conversation binding.

---

### Task 6: Integrate Agents into WebHarness setup, status, OAuth authority, and documentation

**Files:**
- Modify: `bin/webharness`
- Modify: `bin/status`
- Modify: `scripts/bootstrap-personal.sh`
- Modify: `scripts/render-config.mjs`
- Modify: `tests/lifecycle.sh`
- Modify: `README.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/operations.md`
- Modify: `docs/security.md`
- Modify: `docs/architecture.md`
- Modify: `docs/reference-environment.md`
- Modify: `docs/compatibility.md`

**Interfaces:**
- Consumes: stabilized `webharness` operator CLI and Personal Workstation setup/lifecycle.
- Produces: reproducible installation/diagnostics for the Agents capability without changing existing capability ownership.

**Steps:**
- [ ] Make the Personal Workstation setup path delegate Agent Broker unit/dependency installation to `scripts/install-agent-broker-user.sh`. Preserve the stabilized `--enable-startup` consent boundary: setup may install/render the unit, but persistent enablement follows the same explicit startup consent policy as the rest of the workstation.
- [ ] Add Agents diagnostics to `webharness doctor`/`status`: broker unit/socket, browser bridge port, extension heartbeat age/protocol, current prime/run id, active/sleeping worker counts, and bounded last bridge error. Do not print pairing credentials, conversation ids, message bodies, or task text by default.
- [ ] Add the `agents` OAuth tag as a distinct authority domain. Existing OAuth authorization must not silently inherit Agents merely because the provider appears in config. The rollout procedure explicitly refreshes/re-authorizes the ChatGPT connector so the user consents to the new Agents domain and then refreshes the model-visible tool catalog.
- [ ] Document that worker chats inherit the same connected WebHarness app/tool availability the user's ChatGPT account exposes, but Agents itself does not choose cwd, repository, worktree, or project authority for them.
- [ ] Update architecture diagrams to show `Agents -> Agent Broker -> ChatGPT extension -> worker conversations` beside, not inside, the existing Dev/Code/Terminal/Local branches.
- [ ] Update the README capability comparison so first-class parallel ChatGPT workers are no longer listed as the primary gap. Retain the actual remaining limitation: WebHarness cannot create a new prime model turn when the prime is idle because it still operates through ChatGPT/MCP rather than an API scheduler.
- [ ] Update the mandatory lifecycle/publication contracts for the new tracked provider, service template, vendored extension, and Personal Workstation provider set. Do not add Agents to smaller profiles implicitly.

**Acceptance criteria:**
- A technically capable user can load the vendored/adapted unpacked extension, run the Personal Workstation, authorize Agents, and see the first-class tool without changing Browser configuration.
- `webharness status` distinguishes broker health from extension presence and from 1MCP/provider health.
- Agents authority is additive and explicit; existing domains are not widened by aliasing Agents onto another tag.

---

### Task 7: Qualify the post-stabilization implementation and cut it into the maintained workstation

**Files:**
- No new implementation files. This task qualifies and activates the candidate produced by Tasks 1-6.
- Runtime source: canonical public `webharness` checkout

**Interfaces:**
- Consumes: Tasks 1-6 candidate final state.
- Produces: one qualified reference implementation running the Agents capability on the maintained WebHarness workstation.

**Steps:**
- [ ] Run the repository's mandatory full verification gate from `docs/development.md`, updated only to include static/dependency checks for the new Agents provider and the existing root assertions changed by the new provider/service. Do not create a separate Agents test suite unless repository policy or a later user request explicitly requires it.
- [ ] Run the maintained reference-environment acceptance path with the real ChatGPT extension/backend: prove prime identity, spawn at least two workers concurrently, worker tool use, worker -> prime message delivery, explicit `finish`, implicit final-turn fallback, sleeping-worker revival, foreign-chat `AGENTS_BUSY`/identity isolation, and broker/1MCP restart persistence.
- [ ] Exercise one failure path where a worker bootstrap/revival cannot be ACKed and confirm the broker reports one failed command without opening a duplicate replacement tab later.
- [ ] Confirm existing Dev/Code/Terminal/Local/Browser behavior remains independently usable while Agents is idle and while a swarm is active.
- [ ] Refresh/re-authorize the live ChatGPT connector for the new `agents` authority and tool catalog only after the local broker/provider/extension path is qualified.
- [ ] Inspect the final repository diff, update current docs to the observed final behavior, and stop. Do not add Workspace/worktree/session-recorder/automatic-prime-wake work to close adjacent gaps.

**Acceptance criteria:**
- The maintained ChatGPT session can spawn and reuse parallel worker conversations through WebHarness with exact conversation attribution.
- Worker results can reach the prime through the Agents inbox mechanism without polling every worker chat and without corrupting ordinary tool results.
- The live public WebHarness checkout remains the canonical source and the existing workstation capability domains continue to function.

---

## End-State Architecture

```text
                                  ChatGPT
                                     |
                     Cloudflare / OAuth / 1MCP
                                     |
          +-------------+------------+-----------+-------------+
          |             |            |           |             |
         Dev           Code       Terminal      Local        Agents
                                                |             |
                                        browser-fast      agents MCP
                                        browser-devtools       |
                                                          Unix socket
                                                               |
                                                        Agent Broker
                                                        /          \
                                              durable swarm      loopback bridge
                                                  state                |
                                                              WebHarness Agents
                                                              Chrome extension
                                                                     |
                                                       +------+------+------+
                                                       |             |      |
                                                     prime         worker  worker
                                                     chat            A      B...
```

The Agent Broker is the authority. The extension is an adapter. 1MCP is the proven-request transport seam. Individual ChatGPT conversations are identities, not credentials.

## Explicit Non-Goals

- Workspace/project/worktree management or isolation.
- Automatic Git branch/worktree creation for workers.
- General ChatGPT transcript recording/search.
- Compact & Resume or checkpoint transfer.
- Automatic prime-chat wake by synthetic user messages.
- Worker model selection.
- Codex/API/OpenRouter worker backends.
- Browser Fast/Browser DevTools orchestration of worker tabs.
- A desktop/Electron control plane.
- Replacing 1MCP or Cloudflare as part of Agents.

## Rollback Boundary

Agents is additive. Rollback removes/disables the `agents` outer provider/tag, stops/disables `wsl-agent-agents.service`, removes the Agents-specific 1MCP compatibility hook during a pinned-runtime reinstall, and disables the unpacked WebHarness Agents extension. Dev, Code, Terminal, Local, browser profiles, tmux sessions, OAuth state for existing domains, and repository state remain untouched.
