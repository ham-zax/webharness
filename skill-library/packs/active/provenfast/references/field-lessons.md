# Field lessons: the sprint, its critics, and what holds up

Two sources:

- **The sprint.** Anthropic's write-up of the claude.ai speed sprint (<https://claude.dev/blog/how-we-made-claude-ai-faster/#an-8-millisecond-budget>).
- **The critique.** Theo Browne's video review of the write-up (<https://www.youtube.com/watch?v=FsDUOUV9Vs8&t=3289s>). He tested claude.ai live and compared it with his own apps (T3 Chat, T3 Code).

Theo had no access to the code. Where he guesses at a cause, this file says so. The verdicts are ProvenFast's judgment, not his, and not Anthropic's:

- **Adopt:** a rule in `SKILL.md`.
- **Limit:** adopt with a stated boundary.
- **Unproven:** a plausible claim that is not established. It becomes a test to run, not a rule.
- **Reject:** does not hold as a general rule.

Each entry: what the sprint did, what the critique said, the verdict, and the rule.

Apply these lessons through `SKILL.md`'s scope and cost rules. The sprint's
telemetry, nightly jobs, preview infrastructure, and exhaustive checks are
examples, not mandatory setup for a lean pass. Preserve affected correctness
invariants and choose safeguards proportionate to the change.

## A. Measuring the right thing

**A1. Journey windows.** *Sprint:* every journey starts at a user interaction, ends once the result is rendered, and separates client time from server time. *Critique:* teams often start the clock at component mount or at request start. Their dashboard then "proves" that an 8-second journey takes 200 ms. *Verdict:* **Adopt.** *Rule:* audit each journey's window once against a screen recording or video frame count. Start at the input event's timestamp or navigation start, and end when the user can use the result.

**A2. Percentages hide magnitude.** *Sprint:* "−48% instructions, −78% wall clock." *Critique:* this does not say whether 200 ms became 60 ms or 4 s became 0.5 s, and only the second matters much. *Verdict:* **Adopt.** *Rule:* report absolute times next to every percentage. Rank work by time saved × how often the journey runs (user-hours), not by percent.

**A3. Realistic fixtures.** *Critique:* Theo's payload-size gate replays the app's real request formats against a stored "real fake" thread. His slowest real thread (about 500 prompts over four months) is the one that matters. *Verdict:* **Adopt.** *Rule:* benchmark at a typical size *and* a worst-case size taken from production shapes. Empty or toy fixtures hide superlinear work.

**A4. Instruction counts.** *Sprint:* run the benchmark once under Valgrind with `node --predictable`, compare it with a checked-in baseline, and skip statistics. *Critique:* none. *Verdict:* **Limit.** *Rule:* the claim is true in practice (spread under 0.001%), but verify determinism once per benchmark by running it twice. Subtract runtime startup.

**A5. The browser count ladder.** *Sprint:* React commits, V8 call counts, style recalcs, layouts, and DOM mutations, each validated against wall clock. Benchmarks that could not prove a wall-clock win were removed. *Critique:* an agent that blindly lowers counts deletes work that is not on the critical path, such as revalidation and syncing. The app then shows stale data. *Verdict:* **Limit.** The validation step stops *useless* metrics but not *harmful* wins. *Rule:* pair every gate with a counter-check of correctness (B1). Theo suggests these metrics caused the sidebar bugs he saw. That is **Unproven**.

**A6. "Extra requests don't matter once the page works."** *Critique:* on desktop and broadband, background requests barely affect what users feel. The fix is to reorder requests so the first interaction gets its data first, not to delete requests. *Verdict:* **Limit.** Reordering is right for latency. Background work still costs battery, data, server load, and rate limits, especially on mobile. *Rule:* count work before and after the journey's ready mark separately, prove which before-ready items actually block (delay one and see whether ready moves), and optimize those first, by reordering. Remove background work only with proof that it is redundant, plus a freshness test.

**A7. Ratios as gates.** *Critique:* at Twitch, a global coverage threshold blocked deleting 500k lines of dead code. The replacement was fully tested, but removing the old code moved the ratio below the threshold. *Verdict:* **Adopt.** *Rule:* ratchet absolute counts per journey, never global ratios or averages. Deleting code should only ever lower a count. Retiring a deleted journey's ceiling is a reviewed baseline edit.

**A8. Ceilings follow wins.** *Sprint:* a daily job lowered each ceiling whenever the count went down. *Critique:* agreed, because a win that isn't ratcheted becomes headroom for the next regression. *Verdict:* **Adopt.** *Rule:* run `ratchet.mjs update` on the main branch after merges, or nightly.

**A9. Results where agents read them.** *Critique:* Theo's payload gate posts its numbers as a PR comment. Both the coding agent and the review agent see regressions and often fix them before a human looks. *Verdict:* **Adopt.** *Rule:* `ratchet.mjs check ... --markdown "$GITHUB_STEP_SUMMARY"`, or write to a file and post it as a PR comment.

**A10. Passing scores hide jank.** *Sprint:* a screen recording showed sidebar rows popping in after load, which no monitor had caught. Each shift scored about 0.008 CLS, well inside the 0.1 "good" threshold. Reading the Layout Instability API's raw entries showed that 31% of web page loads moved something after the page was usable. *Critique:* Theo says this needed no new measurement, only a cached query (see B2). *Verdict:* **Adopt** the measurement. *Rule:* a summed or averaged score under its "good" threshold is not evidence that users see nothing wrong. Attribute raw entries (each layout shift, each long frame) to named regions, and fail on any shift where none is expected. When a user reports jank that the metrics miss, check the metric against a recording.

## B. Staying correct while getting faster

**B1. What the critic saw live.** After the sprint, Theo found two problems on claude.ai:

- Threads he deleted in one browser stayed in the other browser's sidebar after reloads, and errored when clicked, until they disappeared minutes later.
- A new thread vanished when he refreshed right after sending.

Both are freshness and durability failures that no speed metric would catch. The causes are **Unproven** from outside. *Rule:* any change to caching, fetching, persistence, or navigation must pass the adversarial scenarios in `SKILL.md` §5:

- change it in a second tab or device, then reload;
- refresh mid-action;
- cold, warm, and stale caches;
- slow or offline network.

**B2. The zero-shift test.** *Sprint:* an integration test held the sidebar's data until after first paint and failed on any shift in a named region. *Critique:*

- If the cached list differs from the server's, correct reconciliation *must* move rows, so a zero-shift test penalizes being correct.
- The real fix is to cache the query.

*Verdict:* the first point is **Adopt**. The second is **Reject** as a general fix. Per-region attribution found causes that caching does not touch: a late header row, a caret that slid when the user's name loaded, a scrollbar that appeared. *Rule:* test two cases, as described in `browser.md`:

- cache equals server: zero shift;
- cache differs from server: the page converges to server truth, and any shift is limited to the changed rows.

**B3. Provisional cached data.** *Critique:*

- Show cached data immediately, but styled as unconfirmed (dimmed) until the server confirms it, so the page never shows confidence in data it has not verified. With a fade on the rows that change, a shift of one or two rows when real data arrives is acceptable.
- A sync engine with live queries (Convex, in Theo's apps) pushes changes made elsewhere, which prevents the two-browser staleness in B1. It still has no data at first paint, so T3 Chat also shows a `localStorage` copy immediately.
- When the only database is on the user's own machine (T3 Code), the local copy *is* the truth, and none of this applies.

*Verdict:* **Limit.** Each is one valid design. The invariant is *convergence*, not the styling or the sync technology; those are the owner's call. *Rule:* name which side owns the truth. If the server owns it, the cached copy is a guess: show it, reconcile it, and run the two-case test from B2.

**B4. Fewer cache writes.** *Sprint:* idle tabs cloned cache snapshots into IndexedDB twice a minute on the main thread, and the sprint removed this. *Critique:* reducing cache writes may be what left the sidebar stale. *Verdict:* **Unproven.** *Rule:* when you reduce cache writes or reads, add a test that the cache reflects server state after a change made elsewhere.

**B5. Users don't report subtle regressions.** *Critique:* nobody files a bug about two-browser staleness. Field metrics stay green. Only people who use the build find it. Theo stays in the loop for this reason: he asks the agent for theories about why a journey is slow, has it build a demo of each, and tries each one to see whether it feels faster. *Verdict:* **Adopt.** *Rule:* make human testing a single step, such as a preview URL per PR or a PR label that builds the desktop artifact. When several fixes are plausible, build each as a demo the owner can try. Have the owner use the change before rollout.

**B6. Auto-merge has limits.** *Critique:* Theo's agent auto-merged about 40 performance PRs. Two were regressions: an animation change people disliked and a broken marketing ticker. Both were visual, and no metric covered them. *Verdict:* **Adopt.** *Rule:* auto-merge only where gates cover the behavior. Changes to visuals, animation, or interaction need a human to look at a before/after recording.

**B7. Flags.** *Sprint:* about 200 short-lived flags in two weeks, each classified as a kill switch or a ramp, and more than half retired by the end. *Critique:* Theo doubts that everything user-visible was flagged. *Verdict:* **Adopt** the practice. Doubt is not evidence. *Rule:* classify each flag as kill switch or ramp, give it an owner and a removal date, and keep it in one list.

**B8. Generated verification.** *Critique:* Theo generated about 100 lines of throwaway tests per line of shipped code while reworking data loading, and saw no regressions. *Verdict:* **Limit.** *Rule:* generate as many lab checks as help. Commit only the ones that guard a real invariant, within the repo's test budget.

**B9. Hand-offs.** *Sprint:* the static composer's markup is generated by rendering the real component in JSDOM. Tests compare it with the live render at 14 viewport sizes to within 1 px, and type keys through the hand-off. The field reports any shift greater than 0.1 px, and the agent opens a thread for each one. *Critique:* none. *Verdict:* **Adopt.** *Rule:* generate the fast copy from the source of truth, never by hand. Test the seam, and alert on any non-zero field movement.

## C. Fixing the right thing

**C1. Repeated lookups.** *Sprint:* a quarter of the message-tree routine's instructions were megamorphic dictionary lookups that resolved the same ID three times. Fixing them cut instructions by 48% and wall clock by 78%. *Critique:* most problems like this are data-loading patterns, and repeated resolution usually means a fetch shape that also triggers extra renders. *Verdict:* **Limit.** It is a good heuristic but was not shown here, because this was a pure JS hot path. *Rule:* run a data-flow census (fetches, cache reads and writes, renders per journey). Resolve each ID once. Replace plain objects used as dictionaries over many shapes with `Map`.

**C2. Micro-fix vs moving the work.** *Sprint:* an em dash made V8 store the whole reply as two-byte UTF-16, which put every highlighting regex on a slower path. A 20-line copy to a one-byte string cut the freeze from about 1 s to 0.35 s. *Critique:* 0.35 s on the main thread is still unacceptable. Highlighting belongs in a worker or WASM, lazy-loaded, with a fade over the swap. Its results should be memoized per finished block on the UI side, so that each new chunk does not re-run the worker over the whole reply. *Verdict:* **Adopt both.** The cheap fix helps wherever the code runs. The sprint itself later moved tokenization of growing code fences to a worker. *Rule:* after a micro-fix, re-check the result against the frame budget. If it is still over, move the work off the thread and memoize its results per finished block. Count the costs: bundle size, message passing, ordering, and cancellation.

**C3. Perceived speed.** *Sprint:*

- a static composer baked into the HTML;
- a precompiled V8 code cache for the desktop shell;
- the composer kept mounted between conversations;
- sessions prefetched on hover;
- sidebar re-renders cut by 90%.

*Critique:* prefetch on hover is one of the strongest cheap tricks. *Verdict:* **Adopt.** *Rule:* cancel prefetches when intent ends, and cap how many run at once.

**C4. The viewport can change after first paint.** *Sprint:* Chrome pre-rendered the page during typing in the address bar, at the height of the new-tab page, which includes a 56 px managed-profile footer. After navigation the page grew taller, about 100 ms after first paint. *Critique:* Theo first guessed an extension (wrong), then guessed the composer was positioned with JS percentages (**Unproven**). *Rule:* a page can be rendered at one size and shown at another (prerender, bfcache, browser UI changes). Check `document.prerendering` and the `prerenderingchange` event, and test a resize after first paint.

**C5. Rendering costs DevTools hides.** *Critique:* CPU and JS costs are easy to profile. Style, paint, and GPU costs are hard. *Verdict:* **Adopt.** *Rule:* count style recalcs and layouts through CDP. Use the DevTools Rendering panel (paint flashing, layout-shift regions, layer borders, frame rendering stats) and traces with rendering and GPU categories.

**C6. What is shown together should load together.** *Sprint:* the Chat and Cowork sidebar rows resolved at different times, and the page felt janky even though each row was fast. *Critique:* in his own app, Theo found it jarring that the sidebar appeared at once from cache while the model picker and other composer selectors arrived later. He had his agent cache them the same way. *Verdict:* **Adopt.** A fast path for part of a view can feel worse than a uniformly slower view. *Rule:* list the regions users read as one unit, and measure when each becomes usable, not only when the first one does. Put the stragglers on the same path (same cache, same request), or hold the group and reveal it together. Which of the two is a taste call (D4).

## D. Steering agents

**D1. Ambition.** *Sprint:* the agent offered a small PR "this week". The reply was "If you put it up right now, I will get it merged and deployed. Please be braver." Later: "The targets are not the stopping point. What's next?" *Critique:* agents default to small scope, and wording moves them. "I'm open to wacky ideas", "boil the ocean", and "three proposals, the more extreme the better" got Theo a custom V8 runtime that ran 2-4x faster. He also suggests a standing line in `CLAUDE.md` or `AGENTS.md`: "Assume you have my permission to keep going. If I state what I want the outcome to be, hill climb till you get there." His explanation, that models are "word maps" steered by bold wording, is **Unproven**. Note that the sprint pushed for boldness *because* it trusted its guardrails. *Verdict:* **Limit.** *Rule:* a lean pass can pursue a substantial fix when its user benefit justifies investigation, verification, and maintenance. Extended exploration beyond the requested outcome belongs to deep mode; an explicit target is a stopping limit unless the user asks to continue. Ask for ambition only once the guardrails in `SKILL.md` §5 are in place; boldness without them is how B1 happens. In deep mode, when wins plateau, propose three options from incremental to radical. Give each an estimated time saved, its complexity, and the benchmark that would prove it. The owner picks. A standing instruction to keep going toward a stated outcome is fine, but repo rules on scope and approval still win. Measurement and the complexity gavel (D3) still apply.

**D2. Time estimates.** *Sprint:* "Realistically, code's number waits a few days for merge, deploy, and a baseline window." *Critique:* models estimate in human working days and are far too high. Theo was told a rewrite would take 25 days; he expected a few hours. *Verdict:* **Adopt.** *Rule:* estimate impact in milliseconds, not effort in days. Within the authorized scope, do the work now instead of scheduling it.

**D3. The complexity gavel.** *Sprint:* a 900-line build plugin to save 2 ms per send was rejected. *Critique:* agree, and agents will soon propose changes this big on their own. *Verdict:* **Adopt.** *Rule:* weigh time saved × frequency and responsiveness against investigation, implementation, verification, and maintenance cost. Line count alone does not decide. New infrastructure needs a perceptible win.

**D4. Taste.** *Sprint:* questions went to the thread's owner, for example:

- Should a table fill cell by cell or row by row?
- Should a skeleton appear immediately or after 0.5 s?
- Is a word-by-word fade worth a fifth of the frame budget?

*Critique:*

- Reveal tables when they are complete.
- Derive the skeleton delay from the measured load-time distribution so it never flashes for one or two frames. Going further, time each request per user, cache the timings locally, and decide per user.
- Word fades are never worth the cost.
- Stream at paragraph or block granularity, not token by token.
- Hold a heading until the content under it is complete.
- Never reveal code blocks row by row: partial code breaks highlighting and adds render work.

*Verdict:* the data-driven skeleton timing is **Adopt**. The rest are preferences. Holding content back delays the first thing users see, and some users want progressive output. *Rule:* measure the frame cost of each option, build two or three variants, and let the owner choose.

**D5. Report results, not transcripts.** *Critique:* the sprint's threads show outcomes, not tool calls or command dumps, and that is easier to follow. *Verdict:* **Adopt.** *Rule:* lead the report with the result, and put commands at the end.

**D6. The agent needs to drive the app.** *Critique:* how well an agent can control a browser and pull traces limits deep performance work more than model quality does. Theo also moves agent runs that control a browser to a second machine, because he doesn't want the agent "spamming my machine with computer use requests and browser control while I'm using it." *Verdict:* **Adopt.** *Rule:* before a browser journey, confirm that you can script the interaction and read traces and counters (Playwright or CDP). If you can't, ask the user to set that up first. Where possible, run agent-driven browsers and wall-clock benchmarks on a separate machine, VM, or container. The user's activity then stays out of the numbers, and the agent stays off the user's screen.

**D7. Review the reasoning, then prove it.** *Critique:* Theo inferred likely causes of the sidebar regressions from the write-up alone, without the code. He argues that reading every line of agent-written code doesn't scale, while reading the agent's reasoning and turning each suspicion into a theory the agent must prove does. *Verdict:* **Limit.** Reading the reasoning finds wrong *assumptions* quickly, but it cannot see a wrong *implementation*. Equivalence tests and code review still guard invariants. *Rule:* review each thread's stated mechanism and its counter-checks, not only its numbers. When a mechanism looks wrong, write the doubt as a falsifiable claim, and have the agent build the test that proves or disproves it before the change merges.
