---
name: provenfast
description: "Measurement-first performance improvement for any app, repo, OS, or agent harness. Default is a lean pass: briefly triage the main interactions, fix the largest worthwhile bottlenecks with proportionate effort, verify affected behavior and before/after performance, and finish when the target (the user's, or a provisional one stated up front) is met. Reuse existing tools; add a new regression gate only when a regression has recurred or on request. Extended sprints and ongoing monitoring require an explicit request. Use for \"make it faster\", \"speed up\", \"latency\", \"slow\", \"startup time\", \"jank\", \"frame drops\", \"perf regression\", \"benchmark\", \"profile\", \"ratchet\", \"wall clock\", \"instruction count\", \"call count\", or a perf CI gate. Not for one-off micro-tuning without a user-visible journey."
---

# ProvenFast

> If it can be measured, it can be improved. Once a metric exists, an agent can
> iterate against it without waiting for field data.

Distilled from Anthropic's August 2026 claude.ai speed sprint
(<https://claude.dev/blog/how-we-made-claude-ai-faster/>). In that sprint, an
agent working in one shared channel made the core journeys 3.1x faster
(geometric mean across 13 metrics) in two weeks. Anthropic reports 3,000+
merged changes without a single customer-facing incident or rollback. That is
their claim, and a critic later found UX bugs it does not capture
(`references/field-lessons.md` B1). The useful part is not any single trick but
the **loop**, the **metric ladder**, and the **guardrails** below. They work for
any stack.

## Default: the most improvement for the least effort

Deliver the largest practical improvement to ordinary users for a proportionate
total cost (section 7). Unless the user explicitly
asks for deeper work, run the **lean pass**:

Keep a normal invocation bounded to the current task. Complete worthwhile fixes
and verification, then return the result; ongoing optimization is separate work.

1. **Triage briefly, then focus.** If the user names a slow interaction, start there. For a broad request, briefly inspect startup, navigation, and the main interaction using available timings or traces, then select the largest worthwhile bottleneck. Measure on a representative device and input, including a realistic large input when size affects the cost. Use the user's target; if there is none, state a provisional target grounded in the baseline and the observed pain, and proceed.
2. **Measure lightly.** Before/after wall clock (median of at least 3 runs) and a targeted trace or profile are usually enough. Add measurement only when it resolves uncertainty or makes the next experiment cheaper.
3. **Fix the dominant cost with proportionate effort.** Prefer existing tools and simple changes: fewer duplicate fetches, narrower re-renders, smaller payloads, startup work deferred, better data loading (catalogue in section 4). A larger bounded change, such as moving parsing to a worker, can be the efficient choice if it removes the main bottleneck. Weigh user benefit against total cost (section 7); line count alone does not decide.
4. **Verify what the change could break.** Run the affected tests. When the change touches caching, fetching, or saving, check freshness and persistence (section 5). Scale verification to risk.
5. **Stop at the target** (section 7). The target is the user's, or the provisional one from step 1; meet it, then finish. Past the target, continue only while another improvement is both clear (the profile shows it) and inexpensive (a small change with existing tools). Avoid repeated searches for tiny gains. Report the measured result and any significant remaining bottleneck; label unmeasured gains as estimates or unknown.

**Deep mode** needs an explicit request for an extended performance project: exhaustive investigation, specialized benchmark infrastructure, runtime replacement, or ongoing deploy monitoring. A broad app request permits brief triage of several journeys. A lean pass may reuse an existing counter, gate, or rollout mechanism. It adds a new regression gate only when the same regression has already recurred or the user asks for one. A request for one gate authorizes that gate, not a sprint. Material scope expansion still needs agreement.

The rest of this file is a toolbox for both modes. Read only relevant references,
and use only the measurements and safeguards justified by the selected change.
Steps marked *deep mode* apply only to the requested deeper work.

## 0. Adapt before you measure

Do this once per task, only as far as the journey needs. It decides which tools and which section of the references apply.

1. **Harness.** Map the verbs in this skill to your tools (table below). If you cannot run commands, produce the exact commands and ask the user to run them and paste the output.
2. **System.** If the environment or available tools are unclear, run `scripts/doctor.sh [repo]` (Linux/macOS/WSL) or `scripts/doctor.ps1 [repo]` (Windows PowerShell). It reports OS, cores, load, the available tools, and an install command for each missing one.
3. **Missing tools.** **Ask the user before installing anything.** Give the exact command for their OS (`references/tools-by-os.md`). Never run `sudo` or elevated installs yourself; ask the user to run them (in Claude Code: `! sudo apt-get install -y valgrind`). If they decline, fall back to the next metric on the ladder and say what precision you lost.
4. **Repo conventions win.** Look for existing bench, profile, and trace tooling first (`bench`, `perf`, `profile`, `benchmark` scripts, tracing env flags, CI perf jobs) and reuse it. Repo instructions (AGENTS.md, CLAUDE.md, CONTRIBUTING) override this skill on run counts, memory caps, commit rules, and test commands.
5. **Stack.** Open the matching section of `references/stacks.md` (web/browser, Node, Python, Go, Rust, JVM, .NET, native, mobile, databases/backends, CI/builds, agent/LLM workflows).
6. **Drive the app.** Confirm you can reproduce and time the journey (a CLI command, an existing bench script, or browser tools). Automate repeated interactions when useful; a reproducible manual flow can suffice for a lean pass. Set up additional tooling only when the missing capability prevents a trustworthy result (ask before installing).

| Verb in this skill | Claude Code | Codex / OpenCode / Gemini CLI / Aider | Cursor / Windsurf / IDE agents | Chat only (no shell) |
|---|---|---|---|---|
| run a command | Bash (cap memory per repo rules) | shell tool | terminal tool | give command, user pastes output |
| ask the user | AskUserQuestion, or ask in text | ask in chat | ask in chat | ask in chat |
| browser counters | browser skill / Playwright / CDP | Playwright via shell | built-in browser or Playwright | snippet from `references/browser.md` pasted in DevTools |
| parallel threads | subagents or workers, one journey each | separate sessions or worktrees | separate chats or branches | one journey at a time |
| long-running wait | background task plus notification | blocking wait | terminal | user reports back |

## 1. The loop

Run one loop per **journey**: a user-visible flow with a start and an end, such as "cold launch to typeable", "open conversation", "send to first token", "search request p50", "`index` on repo X", or "CI job wall time".

1. **Choose the journey.** After brief triage, name the journey, the user-visible endpoint, and the baseline. Keep implementation focused. A lean pass needs no separate thread or project artifact.
2. **Build the benchmark.** Trace the real flow end to end and reproduce it with fixed inputs. In a lean pass, a scripted repro and a timer are enough. In deep mode, build a lab harness at a typical size *and* a worst-case size taken from real shapes (the longest real conversation, the biggest repo). Toy fixtures hide superlinear work. Record a baseline (section 3).
3. **Find the dominant cost.** Profile; don't guess. Rank costs, and attack the biggest one the profile shows (section 4).
4. **Make a coherent change, sized for risk.** Establish the affected behavior with existing tests or a targeted check before optimizing. Add regression tests where meaningful coverage is missing. Guard user-perceptible changes in proportion to risk (section 5).
5. **Verify the result.** Re-run the same journey and affected behavior checks. Read comparable field data if already available; distinguish a lab win from a confirmed field win. Deployment and monitoring follow the user's authorized scope.
6. **Protect valuable wins.** Reuse an existing gate or lower an existing ratchet ceiling. Add a new focused gate only when the same regression has already recurred or the user asks for one. Dedicated CI or nightly infrastructure belongs to explicitly requested deeper work.
7. **Finish or continue.** Apply section 7 before another experiment. Deep mode permits further investigation within the requested journeys and budget; it does not remove stopping rules.

## 2. The metric ladder

Use three tiers. Each tier has a different job, so do not substitute one tier for another.

A lean pass usually needs Truth and Explain: before/after wall clock and a targeted trace or profile. Add a counter when it is a cheaper reliable way to compare experiments; add a new gate only under section 1, step 6. Using a diagnostic counter does not require CI integration. Validate proxies against wall clock before claiming a user-visible gain.

| Tier | Purpose | Examples | Property |
|---|---|---|---|
| **Truth** | What users feel; the number you report | wall clock per journey, p50/p95 latency, time-to-interactive, frames per second, peak RSS | noisy, hardware-dependent |
| **Gate** | CI ratchets, fast iteration, tiny diffs | instruction counts, function call counts, allocations/op, render commits, style recalcs, layouts, DOM mutations, DB queries, network requests, bytes | deterministic for fixed input; machine-independent or nearly so |
| **Explain** | Why a number moved | CPU profile, call tree, flame graph, per-function call counts, query log, frame-by-frame trace | diagnostic, not gated |

Rules:

- **Validate every gate proxy against truth** before trusting it. Make one real optimization and measure both the proxy and the wall clock. They must move in the same direction with a plausible ratio. In the sprint, cutting instructions by 48% cut wall clock by 78% on one hot path, and 31% fewer instructions gave 44% less wall clock on another. If the proxy moves and the wall clock does not, the proxy is measuring the wrong work. Pick another proxy. Validation covers one mechanism: re-check against wall clock whenever the kind of change, the workload, or the fixture changes, because a proxy can drop for work that was never on the slow path.
- **Measure the noise of the gate.** Run it twice on unchanged code. Deterministic counts should agree within 0.1%; instruction counts under Valgrind with `node --predictable` typically agree within 0.001%. Set the ratchet tolerance just above the observed noise.
- **Subtract fixed startup cost.** A process-level count includes runtime boot. For example, an empty `node` process costs about 96M instructions, which can hide a 40% workload win as a 3% total change. Either measure a no-op baseline and subtract it, or measure in-process around the journey.
- **Count calls to explain instructions.** `scripts/call-counts.mjs` showed a resolver called 59,999 times instead of 20,000: the "resolve each ID once, not three times" fix is visible directly.
- **Pair every gate with a counter-check.** A count rewards deleting work, including the work that keeps the app correct: revalidation, cache invalidation, persistence, retries, syncing. Before removing a request, write, or render, prove it is redundant (a named invariant already guarantees its result). Add a check that fails if it wasn't: freshness after a change made elsewhere, durability across a refresh mid-action, convergence to server truth. Fewer requests with stale data on screen is a regression, not a win.
- **Split at the ready mark, then identify the critical path.** Split each count at the journey's ready mark into *before ready* and *after ready*. Before-ready is only an upper bound on blocking work: analytics or a prefetch can start early without holding anything up. Use the trace to identify dependencies; where ambiguous, vary a request's delay and compare ready times (`references/browser.md`). A large artificial delay can create a bottleneck that was absent in the original run. Optimize observed blocking work first, usually by reordering: fetch what the first interaction needs first, then keep data fresh in the background. Background work still costs battery, data, and server load, but remove it only with the redundancy proof above.
- **Ratchet absolute counts per journey, never global ratios.** Coverage percentages and averages can block deleting dead code. Deleting code should only ever lower a count.
- **Count events, not scores.** A summed or averaged score can pass while users see a problem. Each sidebar shift in the sprint scored about 0.008 CLS, well inside the 0.1 "good" threshold, yet the page felt janky. Attribute raw entries (each layout shift, each long frame) to named regions, and fail on any where none is expected.
- **Several cheap counters beat one perfect one.** Each new instrument tends to expose new targets. In the sprint, about a third of the PRs added telemetry or a guardrail.

## 3. Measurement protocol

### Wall clock (truth)

- **Audit the window first.** Start at the user's action (the input event's timestamp or navigation start), not at component mount or request start. End when the user can use the result. Separate client time from server time. Check the instrumented number once against a screen recording: a dashboard that starts the clock late will "prove" a slow journey is fast.
- Use `hyperfine --warmup 3 --runs 10 '<cmd>'`, or the stack-native harness (pyperf, `go test -bench` plus benchstat, criterion, JMH, BenchmarkDotNet).
- Report **median of at least 3 runs** (more if the repo asks) and the spread (IQR or min/max). Increase runs when noise could change the conclusion. Measure **peak memory** when the change trades memory for speed or memory is part of the complaint (`/usr/bin/time -v` on Linux, `/usr/bin/time -l` on macOS, process stats on Windows).
- Record machine load (`uptime` or `doctor.sh`), core count, power mode, and whether the cache was warm or cold. Compare before and after only on the same machine, input, and load.
- For cold-start journeys, state how you made the start cold: dropped OS caches, a fresh profile, or a cleared app cache.
- Investigate tail percentiles when they are part of the complaint or requested deeper work; reuse field data where possible. For percentile estimates, aim for at least 10 observations beyond the percentile: about 200 runs for p95 and 1,000 for p99 as a starting point, not a precision guarantee. With 100 samples, p99 is just the slowest run or two. Report the distribution and uncertainty. A lean pass can report medians and spread without claiming p95/p99.
- Always give absolute times next to percentages. "−78%" is very different at 60 ms and at 4 s.

### Deterministic counts (gate)

- **Instructions:** `scripts/instr-count.sh -- <cmd>`. It uses the Valgrind backend where available, then `perf stat` with a PMU, then macOS `time -l`. For Node, add `--predictable --random-seed=1`. Keep the workload small, because Valgrind is 20-80x slower.
- **Calls:** `node scripts/call-counts.mjs --filter <src-dir> --json calls.json -- node <entry>` for JS. For other stacks, see `references/stacks.md` (cProfile ncalls, Go pprof counts, callgrind call counts, JFR, EventPipe).
- **UI work:** render commits, style recalculations, layouts, DOM mutations, long animation frames, and layout shifts per interaction (`references/browser.md`).
- **I/O work:** queries per request, rows/buffers read, network requests and bytes per journey, file reads, cache misses, process spawns. These are often the biggest wins and the easiest gates.
- **Agent/LLM workflows:** tool calls, model round trips, input/output tokens, and cache-hit ratio per task.

Write every gate into a single flat `metrics.json` (`{"journey.metric": number}`) so `ratchet.mjs` can check it.

### Frame budget (smoothness)

For streaming, scrolling, and animation, use the target device's frame budget: 16.67 ms at 60 Hz and 8.33 ms at 120 Hz. Start with a recording and a rendering trace of the problematic interaction; examine long tasks and frame stalls. An FPS readout from `requestAnimationFrame` timestamps can help but does not prove frames were presented smoothly.

**Deep mode, when needed:** drive a compatible headless Chromium rig with deterministic frame stepping (CDP `HeadlessExperimental.beginFrame`) and inspect the worst case frame by frame (`references/browser.md`). Verify that N begin frames produce N callbacks before relying on the rig. Virtual frame cadence alone does not prove real hardware meets its rendering budget; validate on a representative device. Gate on main-thread blocking and worst frame costs rather than average FPS. The sprint used this method to remove work growing with message length, memoize finished blocks, and move tokenization to a worker; it then retained the rig as a nightly job.

## 4. Hunting: where the time actually goes

Choose the **census** suggested by the profile; these are investigation options,
not a checklist to run in full. Each found a large, invisible cost in the sprint:

- **Subscription/re-render census:** count components, hooks, store subscriptions, and listeners that wake on one keystroke or event. One composer had about 6,900 hooks and 900 subscriptions re-rendering per keystroke.
- **Selector/rule audit:** a single expensive CSS selector (`:root:has(...)`) added 24 ms to every DOM change. The same applies to regex tables, middleware chains, and validation rules.
- **Code path tracing:** a forgotten `location.reload()` caused about 500k hidden reloads a day. Grep for reloads, retries, polling, and duplicate fetches.
- **Idle profiling:** profile while the user does nothing. One idle tab cloned cache snapshots into IndexedDB twice a minute on the main thread.
- **Data-flow census:** count fetches, cache reads and writes, and renders per journey. Repeated work, such as the same ID resolved three times, often traces back to one data-loading pattern that also triggers extra renders.
- **Encoding and representation:** the sprint found that a character outside Latin-1 (an em dash or a curly quote, but not `é`, which fits) made the reply use V8's two-byte string representation and slowed its highlighting regexes. Copying eligible code blocks into one-byte strings cut a 1.0 s freeze to 0.35 s. Apply this only when profiling shows the same cost; preserve code points that require two bytes.
- **Re-check against the budget after a micro-fix.** 0.35 s is still about 40 frames at 120 Hz. If the work is still over budget, ask whether it belongs on that thread at all. A worker or WASM module, lazy-loaded, takes it off the main thread entirely. Memoize its results per finished block on the calling side, so each new chunk does not re-run it over everything. Count the costs: bundle size, message passing, ordering, and cancellation.
- **Style, paint, and GPU:** CPU profiles miss these costs. Count style recalcs and layouts via CDP, and use the DevTools Rendering panel (paint flashing, layout-shift regions, layer borders).
- **Costs in a dependency.** When the profile points into a library, runtime, or browser, the fix may belong upstream; the sprint landed changes in Electron, Chromium, and Node. Ship a local workaround that links the upstream issue, and remove it once the fix is released.

### Pattern catalogue

Use the profile to select a candidate. Verify preserved behavior with existing
tests or targeted equivalence checks; caches and scheduling changes also need
freshness, ordering, and interaction checks. More complex patterns must justify
their setup and maintenance.

| Smell | Fix |
|---|---|
| Same lookup repeated per item | resolve once and pass it down; hoist out of loops |
| Plain objects used as dictionaries over many shapes (megamorphic lookups) | `Map`, or a stable shape; resolve once |
| Expensive regex/parse on every line | cheap first-character or length prefilter, then the full check |
| O(total length) work per streamed chunk | memoize finished blocks; only process the growing tail |
| Heavy work on the UI/main/request thread | move it to a worker, thread pool, or background job; memoize results per finished unit; keep a fallback |
| Big layout/paint in one frame | split it across frames (cell by cell, row by row) to fit the budget |
| Interactive UI waits for framework boot | ship a static shell rendered from the same component, then hydrate over it; test the handoff |
| Recompiling the same code every start | bytecode or code cache, snapshot, AOT, persistent compile cache |
| Navigation waits on fetch | prefetch on intent (hover, focus, viewport), with cancellation and a concurrency cap |
| Persistent UI remounts on navigation | keep it mounted across routes (composer, sidebar) |
| Page waits on the network for data it showed last time | render the cached copy immediately (provisional if needed), then revalidate and reconcile; never skip the revalidation |
| Constant per-session work repeated per request | cache it behind a witness (hash, stat signature, frozen value identity); fall back when unsure |
| N+1 queries or round trips | batch, join, or preload; gate on query count |
| Re-render storms | narrow subscriptions, stable props, selector memoization; gate on commit count |
| Late content moving the layout | reserve space, pin layout, gate on layout shifts per region; allow movement only where reconciliation changed the data |
| Regions shown together resolve at different times | load them from the same cache or request, or hold the group and reveal it together; measure when the *last* one is usable |

## 5. Guardrails: what makes bold changes safe

- **Establish behavior first.** Reuse existing tests or a targeted reproduction before optimizing. Add tests for meaningful uncovered regression risks; a simple local change does not require a new test framework.
- **Equivalence, not just speed.** Verify that output and behavior are preserved. Use differential fixtures when an algorithm, parser, or fast path changes; uncertain fast paths fall back. For subtle cache keys or witnesses, mutation-check that the test catches a broken key, then restore it. This extra check is justified by that failure risk, not required for every optimization.
- **Hand-offs get their own tests.**
  - Generate the fast copy from the source of truth, never by hand. The sprint rendered the real component in JSDOM to produce the static markup.
  - Static-to-live UI swaps need layout comparisons across several viewport sizes (the sprint used 14 viewports with ±1 px tolerance), plus keystroke-ordering tests.
  - Worker offloads need ordering and cancellation tests.
  - Caches need invalidation tests.
  - Where seam telemetry exists, investigate unexpected movement; add dedicated monitoring only when justified by risk and scope.
- **Adversarial scenarios.** Users rarely report these failures, and speed metrics never show them. Select the scenarios affected by the change; freshness and durability remain required when those behaviors are touched:
  - change or delete something in a second tab or device, then reload;
  - refresh or navigate away mid-action (right after send);
  - cold, warm, and stale caches;
  - slow and offline networks;
  - the worst-case fixture.
- **Make human testing easy.** Use an existing preview URL or downloadable build, or give short reproduction steps. Add preview infrastructure only when its reuse justifies the cost. Build alternatives when a real interaction trade-off needs an owner's decision; otherwise implement the best-supported fix. Have the owner try perceptible interaction changes before rollout.
- **Auto-merge only what gates cover.** Visual, animation, and interaction changes need a human to look at a before/after recording, because no count covers them.
- **Guard perceptible changes in proportion to risk.** Use what the project already has: a feature flag, a config or env switch, a release channel, or for a CLI or small tool, a plain revert. Where flags and staged rollout exist, roll out to the team, then to a small share of users, then to everyone. Classify each flag as a *kill switch* or a *ramp*, give it an owner and a removal date, keep all flags in one list, and retire them. The sprint created about 200 and retired more than half before it ended.
- **Review.** Follow the project's review requirements. Show perceptible interaction changes as before/after recordings where practical. Review the stated mechanism and counter-checks, not just the numbers, and turn consequential doubts into falsifiable checks (`references/field-lessons.md` D7).
- **Lab checks vs committed tests.** Generate as many throwaway checks as help you prove a change. Commit only the ones that guard a real invariant, within the repo's test budget.
- **Ratchet valuable wins.** Reuse an existing gate. Add a new one only for a regression that has already recurred, or when the user asks for one.
  - `scripts/ratchet.mjs check` runs in CI or nightly.
  - Post the result where agents and reviewers read it: `--markdown "$GITHUB_STEP_SUMMARY"`, or a file posted as a PR comment. The coding agent and the review agent then catch regressions before a human has to.
  - `update` only ever lowers ceilings. Raising a ceiling must be a reviewed edit with a stated reason.
- **Headless isn't the user's machine.** Headless browsers lack real browser UI, prerendering, extensions, and GPUs. A page can be rendered at one viewport size and shown at another: Chrome prerendered claude.ai at the new-tab page's height, and the page grew 56 px after first paint. When field data disagrees with the lab, reproduce the field condition in the lab and add it as a test.

## 6. Deep mode: many narrow threads, not one wide one

Only for explicitly requested extended work, such as a sprint or exhaustive
optimization across named journeys. Match the workflow to that request; one
gate or one difficult bottleneck does not authorize every step below.

- Run one journey or benchmark per thread or worker, and scale by opening more threads. The sprint ran 150+ in parallel.
- Each thread has a named owner who supplies **taste**: which trade-offs are acceptable. The agent's job is to measure each option's cost (for example, a word-by-word fade's share of the frame budget) and build two or three variants. The owner chooses. Use data where it exists: pick a skeleton delay from the measured load-time distribution so the skeleton never flashes for a frame or two. Holding content back until it is complete makes rendering cheaper but delays the first thing users see, so that is a taste call, not a rule.
- A coordinator supplies **direction**: sequencing, deduplication, merging threads that step on each other, and closing threads at diminishing returns.
- Supply **ambition**: agents default to small scope. Push for boldness only once the guardrails in section 5 are in place; the sprint asked for it because it trusted them.
  - Continue beyond an initial target only when the requested project includes further optimization; respect explicit stopping limits and the complexity budget.
  - When wins plateau, propose three options, from incremental to radical (a cache layer, a worker or process boundary, a new data model, a different runtime). Give each an estimated time saved, its complexity, and the benchmark that would prove it. Implement the one the owner picks.
  - A standing instruction beats repeated nudges, for example in `AGENTS.md` or `CLAUDE.md`: "If I state the outcome, keep going and hill climb until you get there." Repo rules on scope and approval still win.
- **Estimate impact in milliseconds, not effort in days.** Agents estimate effort in human working days and overshoot badly. Within the authorized scope, do the work now instead of scheduling it.
- Where possible, run agent-driven browsers and wall-clock benchmarks on a separate machine, VM, or container, so the user's activity stays out of the numbers and the agent stays off their screen.
- On a single machine, keep heavy measurements serial. Parallel benchmarks corrupt each other's wall clock. Deterministic counts are safer to parallelize.

## 7. When to stop

Rank benefit by **absolute time saved × how often the journey runs**, accounting
for affected users and devices when known. For responsiveness, also consider
freezes and interaction delays. Weigh that benefit and confidence against the
**total cost**: investigation, implementation, verification, and maintenance.
Avoid a precise score when frequency or effort is unknown.

Stop when any of these is true:

- **Target met:** the user's target, or the provisional one stated in the lean pass, is met, affected behavior is verified, and no further improvement is both clear and inexpensive;
- the next win is below the measurement noise or below what users can perceive;
- the complexity cost is greater than the gain. In one sprint decision, saving 2 ms per send did not justify maintaining a 900-line custom build plugin. New infrastructure needs a perceptible win.

Whenever stopping below the target, report the shortfall and why. If the next
step requires material scope expansion, explain the evidence for that step;
do not claim the target was achieved.
Below the target, do not stop after a token win while a clear bottleneck remains
within scope. Do not start fresh investigations merely to populate a backlog.
Report only significant remaining issues already observed, with uncertainty.
In deep mode, open another thread only for a requested journey and within the
agreed scope and budget.

## 8. Report format

Lead with the result, and put the command log at the end.

For a lean pass, report the journey and input, before/after median, run count, and spread,
the cause and change, the behavior checks and results, and why work finished.
Include an unmet target or significant remaining limitation. Omit unused gates,
flags, mutation checks, ratchets, and unavailable frequency estimates.

For deeper work, use the relevant fields below:

```
Journey: <name> (<platform>, <input/fixture>, cold|warm)
Truth:   <before median> -> <after median>  (<x>x, n=<runs>, spread <IQR>, peak RSS <a> -> <b>)
Impact:  <ms saved> x <journey frequency> ; before/after-ready split and proven blocking items if relevant
Gates:   instructions <a> -> <b> (<-%>), calls <a> -> <b>, <other counts>
Proxy validated: <yes: proxy -% vs wall -%> | <no: why>
Cause:   <dominant cost from profile, file:line>
Change:  <what changed>; flag <name> | none
Safety:  <equivalence/differential test>, <mutation check result>
Counter: <freshness / durability / scenario checks that prove nothing necessary was removed>
Ratchet: <baseline file> lowered: <metric> <old> -> <new>
Command: <exact commands used> ; machine <cores, load>
```

When summarizing several journeys, use the geometric mean of the speedups, not the arithmetic mean.

## Files

- `scripts/doctor.sh`, `scripts/doctor.ps1`: detect OS, stack, and tools, and print install commands. They never install.
- `scripts/instr-count.sh`: instruction counts (valgrind | perf | macOS backends).
- `scripts/call-counts.mjs`: deterministic JS function call counts via V8 precise coverage.
- `scripts/ratchet.mjs`: `check` / `update` ceilings that only go down; `--markdown FILE` for CI summaries and PR comments.
- `references/tools-by-os.md`: tool matrix and install commands for Linux, macOS, Windows, and WSL.
- `references/stacks.md`: recipes per stack and workflow (truth, gate, and explain tools for each).
- `references/browser.md`: in-page counters (commits, style recalcs, DOM mutations, layout shifts, requests before and after ready, a delay test for blocking requests, frame meter), cache and freshness tests, and CDP frame stepping.
- `references/field-lessons.md`: claims in the sprint write-up, the main public critique, and verdicts on what holds up. Read relevant entries when a proposed optimization touches those mechanisms, especially when removing cache, sync, or persistence work.
