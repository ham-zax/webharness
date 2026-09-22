# Browser Jev Provider Design

## Purpose

Add a `browser-jev` MCP provider beside `browser-fast`. It exposes the
Jev Ultrafast agent loop as one autonomous tool plus four stateful control
tools while using the browser identities already managed by WebHarness:

- managed Linux Clearcote profiles, including `x-main`;
- managed Linux Chrome sessions;
- managed Windows Chrome profiles.

The provider must not take ownership of a shared browser process or the
active browser-fast tab. Every run creates and controls only its own
background CDP target.

## Public Tool Contract

The provider exposes exactly five tools:

### `jev_run`

Accepts the same `url`, `goal`, and `scenario` contract as `jev_start`.
It starts one run and advances the existing Jev worker loop internally without
returning to the MCP client between cycles. Deterministic success verification
is applied after every observation, and the autonomous run ends immediately
when those checks pass rather than requiring a final model `DONE`. If Jev
selects `DONE` before deterministic success, the worker resets that terminal
choice for the autonomous path and continues within the normal Jev model/action
budgets. The provider always closes the run-owned target, namespaced Browser
Harness daemon, and worker before returning. Its final sanitized state retains
the completed run ID for diagnostics, but that ID is no longer live and cannot
be used with `jev_state`, `jev_tick`, or `jev_stop`.

An optional `scenario.collection` accumulates rendered-visible text records
across intermediate observations so evidence survives virtualized/infinite-scroll
DOM replacement. A collection request must include at least one URL, title,
or visible-text success check that identifies the intended document.
Accumulation begins only while those identity checks pass and resets when that
document identity changes. It accepts only a start-line prefix, an exact end-line marker, and
bounded count/stability limits. No selectors, regular expressions, or
executable extraction logic are accepted. Collection is deduplicated and
bounded to at most 200 returned records. Supplying `scenario.collection`
automatically enables deterministic `collection_complete` verification. It
requires the configured minimum plus the configured number of provider-owned
settling WAIT observations with no new record. Each no-new scroll schedules one
such settling WAIT but does not itself count as a stable observation. Whole-document scroll exhaustion
is reported separately and is not sufficient for collection completion because
a lazy-loaded page can expose a transient bottom. `success.scroll_exhausted: true`
is available separately when reaching the document bottom itself is the required
postcondition.

This is the preferred throughput path when the caller wants Jev to complete a
goal autonomously. Once collection records have appeared and the ordinary
URL/title/text/history checks identify the intended page, the provider may use
its observed `scroll_down`/`wait` controls deterministically for mechanical
collection traversal instead of spending a TypeSafe decision on every scroll.
The stateful tools remain the control path when a caller needs to inspect or
steer between individual decisions. If the MCP request is cancelled, the
autonomous loop observes that cancellation between bounded worker cycles and
runs the same owned-resource cleanup before ending.

### `jev_start`

Inputs:

- `url`: required non-empty HTTP or HTTPS URL;
- `goal`: required non-empty natural-language goal;
- `scenario`: required object containing browser routing, optional bounded collection, and success checks.

Scenario routing fields:

- `browser_target`: `windows` or `linux`; omitted means `windows`;
- `browser_backend`: `chrome` or `clearcote`; Windows accepts only `chrome`;
- `browser_profile`: optional profile name using the same validation and
  resolution rules as browser-fast.

Scenario collection fields:

- `start_prefix`: required non-empty visible-line prefix, at most 200 characters;
- `end_exact`: required non-empty exact visible line, at most 200 characters;
- `min_unique`: optional integer 1-200, default 1;
- `stable_observations`: optional integer 1-10, default 3;
- `max_items`: optional integer 1-200, default 200 and never below `min_unique`.

Scenario success fields:

- `url_contains`: optional non-empty array of non-empty strings;
- `title_contains`: optional non-empty array of non-empty strings;
- `text_contains`: optional non-empty array of non-empty strings;
- `required_operations`: optional non-empty array whose values are exactly
  `CLICK`, `TYPE_TEXT`, `SELECT`, or `WAIT`;
- `collection_complete`: optional explicit literal `true`, valid only with a collection; supplying `scenario.collection` enforces the same check automatically;
- `scroll_exhausted`: optional literal `true` requiring no current downward
  scroll action.

At least one success field must be present and non-empty. Every supplied
check must pass. Checks are deterministic substring, history, collection, or
scroll-state scans; the provider accepts no regex, DOM selectors, JavaScript,
callbacks, or executable verification logic.

The tool resolves the selected browser endpoint at call time, starts one
namespaced worker, creates one Jev run, and returns the opaque run ID plus
the first state.

### `jev_tick`

Accepts only `run_id`. It performs exactly one Jev prediction and execution
cycle, then returns the elapsed time, status, decision, history, current page
summary, indexed elements, and verification state.

The provider does not retry the cycle or any browser mutation. Terminal,
failed, stopped, or unknown run IDs are rejected before invoking the worker.

### `jev_state`

Accepts only `run_id`. It returns the latest cached snapshot without making
a model call or browser mutation.

### `jev_stop`

Accepts only `run_id`. It closes the Jev-owned target, cleanly stops the
run's namespaced Browser Harness daemon, terminates the worker, removes the
run's ownership lease and live-registry entry, and returns a stopped
acknowledgement. It never closes the shared Clearcote or Chrome process.

## Returned State

State contains:

- opaque run ID;
- resolved browser target/backend/profile identity;
- provider status and elapsed milliseconds;
- current URL, title, visible text, and scroll summary;
- indexed elements and their supported operations;
- the current sanitized decision, when present;
- sanitized execution history;
- deterministic verification checks and their results;
- terminal/failure reason when applicable.

State excludes credentials, environment values, CDP endpoints, screenshots,
model request bodies, raw speculative response heads, selectors, source code,
and executable content.

## Jev Dependency

The Python runtime depends explicitly on the inspected upstream repository at
commit:

```text
jev-ultrafast @ git+https://github.com/browser-use/jev-ultrafast.git@1231850a0bf1a0c0341fe408ef1668dbbfdfac46
```

The provider includes a tracked `pyproject.toml` and `uv.lock`. Personal bootstrap
performs `uv sync --frozen` for this project. Verification includes a clean
frozen install. The WebHarness provider does not copy or port Jev's agent,
model, browser, or snapshot implementation.

## Components

### Node MCP server

`providers/browser-jev/server.mjs` owns:

- the five-tool MCP schema and request routing;
- argument and scenario validation;
- run IDs, the in-memory run registry, and bounded cross-observation collection state;
- backend endpoint resolution;
- profile-scoped operation queues;
- worker lifecycle and bounded JSON-lines transport;
- output sanitization and deterministic outcome verification;
- orderly provider shutdown.

The server imports existing exported WebHarness browser seams instead of
duplicating configuration parsing or browser lifecycle policy.

### Python worker

`providers/browser-jev/worker.py` owns one provider-managed Jev `Agent` per
process. It accepts bounded JSON-lines commands for start, tick, internal
collection traversal, state, and stop. It imports the pinned Jev loop from the locked environment and layers a
small provider-local runtime adapter over it rather than forking the planner or
executor. The local snapshot script hashes the full observed action semantics for
freshness, then retains only the first 250 model-visible actions and guards for
those selectable actions, so dense pages cannot inflate worker responses with
unbounded freshness metadata. Very sparse initial pages get a bounded hydration
window before the first model decision. Model-selected collection scrolls
receive a bounded post-scroll quiet-period re-observation so virtualized/lazy
records can materialize before the next decision. Once collection is active on
the verified target page, an internal deterministic collection command uses
only the already observed downward-scroll or wait control, performs a combined
freshness-check/action/observation boundary, and records that history entry as
provider-owned collection work. If the model returns `BLOCKED` while
deterministic collection work remains, the adapter briefly re-observes and
resumes only when meaningful browser capabilities appear. If the upstream
three-action no-progress guard blocks specifically on unchanged scrolling, the
adapter gets a bounded lazy-load re-observation; collection runs may continue
while a downward scroll action remains so deterministic collection stability,
rather than model terminal belief, decides completion. The worker projects Agent state
onto a bounded wire snapshot and never sends upstream cumulative model request
or raw-answer history to Node.

The worker calls `Agent.close()` during explicit stop, stdin EOF, and normal
shutdown. It then performs strict cleanup of the run's namespaced Browser
Harness daemon. Cleanup verifies the live daemon identity, obtains a Linux
`pidfd`, requires the daemon's clean `shutdown` acknowledgement, and waits
until the daemon-owned browser target is absent. Only after that browser
cleanup is proven may the worker send `SIGTERM` through the `pidfd` to end a
lingering daemon process; if the fast verification path is unavailable, it
falls back to Browser Harness's strict `restart_daemon(name,
require_clean=True)` behavior. This preserves the upstream PID-reuse and
clean-browser guarantees without paying its fixed 15-second post-cleanup
process grace on the normal WSL path. Failure to prove target absence or
process exit preserves the endpoint/PID ownership records and returns a cleanup
error instead of signaling early or reporting success.

Before returning from start, the worker also records a mode-0600 ownership
lease beneath the current user's XDG state directory. The lease contains only
the managed profile key, loopback endpoint, worker PID plus process-start
identity, daemon namespace, and owned target IDs. The content browsing context
is marked with the opaque run namespace in per-tab `sessionStorage`; the
namespaced daemon's `about:blank` helper is marked with the same namespace in
its URL fragment because opaque `about:blank` storage is unavailable. Clean
shutdown removes the lease. A future worker for the same profile may reclaim a
lease only when the recorded worker process identity is dead. It first uses the
run markers (which survive target-ID changes caused by browser session restore)
and independently confirms recorded target IDs on the same live endpoint. An
empty marker scan is inconclusive rather than proof of cleanup. Active or
unverifiable owners are never reclaimed. The worker uses a per-run name of the
form `jev-<run-id>` and never uses the `default` daemon.

### Backend resolver

Windows Chrome uses `ensureWindowsChrome(profile)`. That runtime reuses a
healthy managed Chrome process or launches it once when absent.

Linux selection first calls `resolveLinuxBrowserBackend(...)` from
browser-fast, preserving `~/.config/mcp-dev-bridge/browser-fast.json`
semantics.

For managed Clearcote, the provider builds the selected profile path beneath
`DEFAULT_CLEARCOTE_STATE_ROOT/profiles`, calls `readClearcoteEndpoint(...,
{allowMissing: true})`, and fails if no live endpoint exists. It never calls
`ManagedClearcoteRuntime.ensure`. The failure tells the operator to initialize
the profile once through browser-fast.

For Linux Chrome, the provider uses the resolved Agent Browser session and
the exported `AgentBrowserRunner`. Agent Browser 0.35.0 exposes the exact
read-only command:

```json
["get", "cdp-url"]
```

The runner supplies the session from the resolved backend. The provider does
not hardcode session names, socket paths, PID files, or runtime directories.
Agent Browser therefore reuses an already-live browser-fast Chrome daemon and
launches the same managed session only when it is absent.

## Run and Queue Lifecycle

`jev_start` creates a cryptographically random run ID, derives a valid
`BU_NAME=jev-<run-id>`, resolves a fresh endpoint, and starts a worker with
that endpoint in `BU_CDP_URL`. The endpoint is never returned through MCP or
placed in generated public state. While a run is live, the worker records the
loopback endpoint only in its private mode-0600 ownership lease together with
non-secret target/process ownership metadata; clean stop removes that lease.

Jev's unmodified `Browser` creates a background target with
`Target.createTarget(background=True)` and enables focus emulation. The
target is independent from browser-fast's active mediated tab.

Operations are serialized by resolved browser target/backend/profile. The
queue covers start, tick, and stop transitions that touch the shared profile.
A rejected operation always releases its queue position. Different profiles
may proceed concurrently.

The run registry stores the worker handle, queue identity, sanitized state,
and provider status. It does not store credential values or expose the CDP
endpoint through state.

## Credentials

Personal rendering accepts `MCP_BROWSER_JEV_ENV_FILE`, an absolute path to a
bounded, readable, current-user-owned regular file outside tracked provider
configuration. The file accepts only:

```text
TYPESAFE_API_KEY
TYPESAFE_MODEL
TEXT_MODEL_API_KEY
TEXT_MODEL_BASE_URL
TEXT_MODEL
TEXT_MODEL_REASONING
```

The generated private Local MCP configuration receives only the environment
file path. Credential values are not copied into generated JSON. At worker
startup the Node server revalidates the file, parses the allowlisted keys,
and supplies them only in the worker's server-side environment. Tool schemas
never contain credential arguments, and errors/logs never include credential
values.

`TYPESAFE_API_KEY` is required before a run starts. `TEXT_MODEL_API_KEY`
remains lazily required by Jev when a `TYPE_TEXT` decision occurs, preserving
Jev's fail-before-input behavior for goals that never type.

No `.env`, generated Local configuration, credential file, trace, or runtime
state is committed.

## Decision and Verification Semantics

Before asking TypeSafe, the provider resolves unmet `url_contains` checks in
ordinary code when exactly one observed link destination satisfies them. It
normalizes relative hrefs, gives dynamic pages a short bounded chance to expose
the deterministic target, and executes the click through Jev's existing
observed-node/freshness checks. When no unique deterministic destination is
available, the provider falls back to Jev's TypeSafe operation plus
operation-specific target-head decision. Fallback link criteria preserve the
already-observed href alongside the semantic label so otherwise-similar options
remain distinguishable. Only the target belonging to the selected operation is
consumed. The provider never accepts or produces browser selectors or model-
generated executable code.

`TYPE_TEXT` remains Jev's small text-model path. Missing or invalid text-model
output fails before browser input. A stale retry reuses generated text only
under Jev's existing identical-helper-input rule.

The `required_operations` verifier maps public names to Jev history kinds:

| Public operation | Jev history `kind` |
| --- | --- |
| `CLICK` | `click` |
| `TYPE_TEXT` | `fill` |
| `SELECT` | `select` |
| `WAIT` | `wait` |

Each required operation passes when at least one recorded history entry has
the corresponding kind.

When Jev chooses `DONE`, the provider evaluates every declared success check
against the post-decision snapshot and recorded history. Full success becomes
terminal `done`. Any failed check becomes terminal `blocked` with reason
`DONE_VERIFICATION_FAILED` and per-check evidence. The provider never treats
Jev's `DONE` selection alone as proof.

Jev `BLOCKED`, verified `done`, provider `failed`, and explicit `stopped`
states are terminal. No later tick invokes a model or browser operation.

## Failure Handling

- Invalid routing, URL, goal, scenario, profile, or success checks fail before
  worker creation.
- Inactive managed Clearcote fails without launching or deleting anything.
- Invalid or unavailable Agent Browser CDP output fails before Jev starts.
- Worker protocol output is bounded and must be one valid response for the
  outstanding request.
- Worker exit, timeout, malformed output, or transport failure marks the run
  `failed`; no tick is replayed.
- A mutation followed by an infrastructure error remains failed/unknown rather
  than being retried.
- Cleanup attempts owned-target close, strict namespaced-daemon stop, and
  worker termination independently so one cleanup failure does not skip the
  remaining steps.
- Provider shutdown drains all live run cleanups without closing shared
  browser processes.

## Repository Wiring

The implementation adds the provider package, worker, lockfile, and offline
tests. It registers `browser-jev` beside `browser-fast` in
`config/templates/mcp-local.json` and extends every exact built-in Local
server-list assertion and provider smoke check, including publication,
harness, doctor, and Local smoke coverage.

Personal bootstrap installs the Node dependencies and performs the frozen uv
sync. Generated configuration is rerendered after the tracked template and
renderer changes.

Current documentation is updated where the provider changes architecture,
security, configuration, development/setup, discovery, or acceptance facts.
At minimum this includes `docs/architecture.md` and `providers/README.md` as
required by the request.

The existing uncommitted changes in
`providers/browser-fast/browser-backend-config.mjs` remain untouched. The new
provider consumes its exported behavior without modifying or reverting it.

## Verification

When test work is explicitly authorized, automated tests use fakes and never call paid APIs. Relevant coverage includes:

- exactly five advertised tools and strict schemas, including `jev_run` sharing the start contract;
- successful start/tick/state/stop protocol;
- required non-empty deterministic success checks and bounded collection validation;
- fixed required-operation enum and Jev-kind mapping;
- stateful `DONE` accepted only after all checks pass;
- autonomous premature `DONE` resumed until deterministic success or another bounded terminal condition;
- collection deduplication/stability and scroll-exhaustion verification;
- per-response worker stdout limiting rather than lifetime-cumulative stdout limiting;
- terminal states reject ticks before worker calls;
- exact Agent Browser batch command `["get", "cdp-url"]`;
- Linux Chrome session supplied by backend resolution rather than hardcoding;
- call-time Clearcote endpoint reads and no Clearcote `ensure()` call;
- unique non-default per-run Browser Harness names;
- profile queue ordering, release after failure, and cross-profile concurrency;
- owned-target close plus strict namespaced-daemon cleanup;
- credentials accepted only from the allowlisted server-side file path;
- no credential values in generated Local configuration or tool output;
- frozen Git dependency resolution from a clean state;
- publication, renderer, harness, doctor, and Local smoke discovery contracts;
- unchanged browser-fast provider tests.

Live acceptance uses the existing ignored Jev credential file without copying
or logging its values:

1. Start at `https://example.com` with a confirm-and-stop goal and observable
   success checks; tick until verified `done`.
2. Start at Wikipedia with a search goal, require the destination article and
   `TYPE_TEXT`, and tick until verified `done`.
3. Stop both runs and confirm their namespaced Browser Harness daemons are no
   longer live.

The final report lists every changed file and includes fresh command output
for provider tests, publication and browser smoke scripts, browser-fast
regression tests, the frozen clean install, configuration rendering, and live
acceptance. No commit or push is performed.
