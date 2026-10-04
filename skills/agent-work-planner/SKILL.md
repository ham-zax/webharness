---
name: agent-work-planner
description: Plan engineering work across human-launched AI coding sessions and follow-up missions. Use when splitting work into reasonably sized agent goals, balancing implementation iterations against review cycles, deciding whether the planner should act directly, continue an existing session as A2/B2, open a fresh implementation session, or create an independent Agent R review lane; batching review at coherent stable milestones; tracking blockers, waves, progress, integration readiness, workspace topology, prompts, replanning after frontier-changing events, and periodically performing a deep strategic reassessment of the objective, assumptions, target configuration, model fidelity, experiment validity, and remaining DAG.
---

# Agent Work Planner

Plan multi-session engineering work as a stateful human-operated orchestration system.

## Identity model

Treat an **Agent** as one human-launched AI coding chat/session. Treat a **Mission** as one bounded assignment inside that session.

Use mission identifiers to preserve continuity:

- `A1` = Agent A's first mission.
- `A2` = a follow-up mission pasted into the **same Agent A chat**.
- `B1` = another human-launched chat/session.
- `B2` = a follow-up mission in that same Agent B chat.
- `R1` = the first independent review mission in the reserved **Agent R** reviewer chat.
- `R2` = a re-review pasted into the **same Agent R chat** after the implementer addresses R1 findings.

Do not call `A2`, `B2`, or `R2` a new agent. Open a fresh Agent C/D/etc. only when a new implementation/diagnostic session is justified. Reserve Agent R for independent review work rather than implementation.

Never claim an agent/session is launched, active, or running unless the user or available tooling establishes that state.

## Core invariants

- **Coordination must earn its overhead.** Use the cheapest correct execution owner.
- **Optimize feedback cycles, not agent count.** Give each implementation session a reasonably sized coherent goal and allow multiple implementation missions before review when they build one stable candidate. Minimize reviewer/implementer ping-pong, not productive implementation passes. Do not force a review merely because `A1` ended if `A2` is a natural same-area continuation and early review would not materially change direction.
- **Size missions for useful progress.** A mission should be large enough to justify the session's context and produce a meaningful artifact, but small enough to own, verify, and hand off clearly. Do not create microscopic missions just to manufacture checkpoints, and do not overpack unrelated work into one mission merely to reduce the number of agents.
- **Planner absorbs bounded friction.** Small causally clear repairs, deterministic metadata/version closure, trivial integration conflicts, and clean integration work should be planner-owned when authorized and cheaper than another feedback cycle. Delegate only when substantial design, rediscovery, or subsystem ownership makes another session earn its cost.
- **Batch review, not risk.** When independent review is required, prefer one review of the largest coherent stable candidate, including directly related contracts and post-rebase/integration effects, instead of serial reviews after each implementation mission. Do not batch unrelated missions or defer an early review that is needed to prevent expensive downstream work.
- **Prefer file-backed handoffs on shared filesystems.** When delegated agents and the planner can access the same filesystem, assign a disposable handoff inbox and require each completed/blocked mission to write a timestamped receipt there before replying. Treat the receipt as coordination metadata, not repository truth; verify consequential Git/repository claims independently. Do not make the user copy summaries between chats when the planner can discover the receipt directly.
- **Blockers do not disappear implicitly.** A blocker is discharged only by evidence satisfying its recorded discharge condition.
- **READY implies action.** When work becomes READY, either execute planner-owned work, issue a same-session continuation prompt, issue a fresh-session prompt, or explicitly defer it with a reason.
- **Active sessions never disappear silently.** Reconcile every known active or unresolved session before advancing the frontier.
- **Progress is automatic.** During an ongoing plan, every orchestration response after a frontier-affecting event ends with a compact Progress Snapshot unless the user explicitly asks to suppress it.
- **Progress tracking is not strategic review.** After roughly two material frontier transitions, or immediately after one major/high-impact transition, run a deep Strategic Reassessment Gate that re-derives the remaining plan from the end objective, verified repository/product state, and current evidence instead of merely advancing the existing DAG.
- **Forecast the DAG; materialize the frontier.** Keep future waves visible at low resolution without freezing details that depend on current work.
- **Reuse context aggressively, preserve independence more strongly.** Prefer A2/B2 when existing context helps, except when a fresh independent perspective is required.
- **Review must earn its overhead, then block integration when required.** Substantial or integration-sensitive changes must pass an explicit Review Gate; when independent review is warranted, create Agent R and keep integration blocked until the review discharge condition is satisfied.
- **Reviewer and repairer stay separate.** Agent R identifies findings and never repairs the production target. Small bounded findings may be repaired by the planner; larger same-area findings normally return to the original implementer. Agent R re-reviews the repaired target in the same reviewer session.
- **Isolation must earn its cost.** Current checkout is the default; branches/worktrees require a concrete need.
- **Planning does not broaden implementation authority.** Preserve Causal Coding authority for implementation mutation, testing, verification, continuation, and stopping.
- **Separate planning from execution lifetime.** Use `persistent-agent-loop` for long-lived continuity, not for decomposition or next-wave planning.

## Environment composition

When operating in ChatGPT Web against a connected WSL/Linux repository, route repository work through `mcp-harness-router` to `wsl-web-harness` and treat that WSL target as authoritative. Use Causal Coding before implementation-affecting mutation.

Agent Work Planner owns:

- session/mission topology;
- execution-owner selection;
- dependencies and blockers;
- waves and readiness;
- prompts and handoffs;
- shared handoff-inbox assignment, discovery, and cleanup;
- workspace assignment;
- review-gate and integration ordering;
- progress state;
- replanning.

## Operating modes

Use the lightest mode that satisfies the mission.

### Plan-only

Inspect and recommend only. Do not mutate repository state merely to answer an advisory question.

### Lightweight orchestration

Use for small/medium efforts where prompts plus an in-chat state board are sufficient. Do not create durable planning files merely because several missions exist.

### Durable orchestration

Use when several waves, concurrent writers, important shared contracts, long-lived sessions, significant integration, or later recovery justify repository-resident coordination state. See `references/coordination-package-template.md`.

### Replan

Use after any frontier-invalidating event, not only returned agent reports.

## Workflow

### 1. Orient to authoritative state

Establish:

- user objective and constraints;
- repository/source-of-truth artifacts;
- known agents and their current missions/status;
- relevant Git/workspace state when available;
- current waves and blockers;
- returned reports or newly integrated artifacts;
- public/shared contracts relevant to candidate missions.

Verified repository state and current user direction outrank stale planning artifacts.

### 2. Reconcile known sessions

Before creating or advancing work, account for every known unresolved session.

Assign one disposition:

- `CONTINUE`
- `HOLD`
- `COMPLETE`
- `NEEDS DECISION`
- `SUPERSEDED`
- `CANCELLED`
- `REUSE AS <A2/B2/...>`

Do not silently omit an existing Agent B/C/E merely because another agent returned or a commit landed.

For durable efforts, maintain the Session Ledger defined in `references/orchestration-state.md`.

### 3. Update blocker state

For every blocked mission/wave, track:

- blocked item;
- blocker;
- owning mission/session;
- exact discharge condition;
- current status/evidence.

A commit, integration, review, or report may discharge only blockers it actually satisfies.

Never infer:

`unrelated mission completed -> blocked wave READY`

See `references/orchestration-state.md` for the Blocker Ledger.

### 4. Build or update the dependency DAG

For each mission identify:

- prerequisites;
- shared interfaces/contracts;
- mutable ownership/collision surfaces;
- role and artifact type;
- observable completion boundary;
- downstream missions unlocked;
- committed vs conditional status.

Group work into **waves**. A wave is a readiness frontier: missions that may start from the same prerequisite state.

Use optional **phases** only when several waves benefit from a higher-level grouping.

### 4.5 Balance mission size and review cadence

Treat **mission boundaries** and **review boundaries** as different things. A session may complete more than one bounded mission before independent review when those missions compose one coherent candidate and the later mission does not depend on reviewer feedback.

Prefer a topology like:

```text
A1 -> A2 -> R1 -> B1 -> R2
```

when `A1` and `A2` are coherent implementation work that can safely accumulate before review, `R1` reviews the combined stable candidate, and `B1` is a substantial repair or follow-up justified by that review before one bounded re-review.

Avoid review ping-pong like:

```text
A1 -> R1 -> A2 -> R2 -> A3 -> R3 -> B1 -> R4 -> A4 -> R5
```

unless each early review is independently justified by a high-cost architecture, security, migration, public-contract, or other direction-setting risk.

Before opening Agent R, ask:

- Is the current candidate stable enough that review findings will be actionable rather than immediately invalidated by the next planned implementation mission?
- Can the current implementer complete the next same-area mission first without materially increasing risk?
- Would early reviewer feedback change architecture or prevent expensive rework?
- Is the review target coherent enough that the reviewer can inspect all directly related surfaces in one pass?

Do not chase a minimum number of agent passes. Optimize for a small number of **meaningful implementation batches and review cycles**.

### 5. Choose the execution owner

For each newly READY action, decide in this order:

#### A. Planner-owned

Execute directly when the action is bounded coordination/setup/integration or a small determined change and delegation would cost more than it helps.

Typical examples:

- clean cherry-pick/integration;
- bounded coordination-file update;
- small deterministic metadata alignment;
- a small review finding whose causal owner and repair are already clear;
- trivial rebase/merge conflict resolution after a candidate is otherwise complete;
- version/freshness closure directly required by a bounded repair;
- branch/worktree/status inspection;
- preparing prompts/handoffs.

Prefer planner-owned execution when the repair is cheaper to prove directly than to explain, hand off, rediscover, and review as a separate implementation mission. Preserve Causal Coding authority for any implementation-affecting mutation.

Do not merely tell the user planner-owned work is ready when the current mission authorizes doing it.

#### B. Same-session continuation: A2/B2

Prefer a continuation mission in an existing chat when materially relevant conditions hold:

- the follow-up is small to medium;
- it is in the same or strongly adjacent ownership area;
- prior session context materially reduces rediscovery;
- no independent perspective is required;
- workspace ownership remains safe;
- previous mission state is not stale/superseded;
- the follow-up does not cross an unresolved blocker;
- it can be bounded as a distinct mission.

Issue a continuation prompt and explicitly say:

`Paste this into the existing Agent A/B chat. Do not open a new session.`

Do not number ordinary steering as A2/B2 while A1/B1 is still active. A continuation is a new bounded mission after the prior mission boundary; compatible in-mission steering remains part of the current mission.

#### C. Fresh session

Open a new Agent C/D/etc. when separation materially helps, such as:

- substantial implementation;
- different subsystem/ownership boundary;
- large diagnosis/investigation;
- independent diagnosis;
- independent review, which should normally use the reserved Agent R lane;
- concurrent writable work needing isolated ownership;
- fresh context materially improves reliability;
- existing session reuse would violate independence.

Explicitly say:

`Open a NEW chat for Agent C.`

### 6. Preserve independence

Self-review is not independent review.

Do not reuse an implementation session for an independent review merely because it is convenient.

Reserve **Agent R** as the normal independent-review lane. Keep R read-only by default and do not let R repair the production changes it is reviewing.

If Agent R finds blocking defects, choose the repair owner in this order:

1. **Planner-owned** for a small, causally clear, bounded repair that does not require substantial implementer context or redesign;
2. **same implementation session** for a medium/substantial same-area repair where prior context materially helps;
3. **fresh implementation session** only when ownership changes, context is stale, or independent diagnosis/implementation separation materially helps.

Then issue the narrow re-review into the existing Agent R chat. A planner-owned repair does not compromise review independence because Agent R remains read-only and did not author the fix.

Do not reuse R for implementation when doing so would destroy the independence required for the resulting repair.

### 7. Apply the Review Gate before integration

Before integrating a completed **review batch/candidate**, decide whether independent review materially reduces integration risk. A mission completion alone is not a review trigger. Review must earn its overhead; do not create Agent R after every implementation mission when more planned same-area work should reasonably join the same stable candidate.

Default toward an Agent R review when one or more materially apply:

- substantial implementation or large refactor/migration;
- cross-subsystem or shared-contract changes;
- public API/schema/persistence/data-shape changes;
- concurrency, process-lifetime, native/GPU/FFI, auth/security, or other difficult-to-observe behavior;
- broad/mechanical changes where attribution is harder;
- implementer-reported uncertainty, deviations, or unresolved risk;
- explicit user/spec/repository requirement for independent review.

Usually skip Agent R for clean cherry-picks, small deterministic integrations, tiny localized changes, or docs/metadata where independent review cost clearly exceeds plausible integration risk.

### Review batching policy

Target the **largest sensible stable boundary** that is still coherent and reviewable. That boundary may intentionally contain multiple implementation missions such as `A1 + A2`; review gates belong to stable integration candidates, not automatically to individual missions. Prefer to let the planned same-area implementation batch finish, update/rebase it onto the intended integration baseline, and refresh the directly affected validation before opening the review gate when earlier review would not change implementation direction.

Batch directly related surfaces into one review when they belong to the same integration decision, for example:

- core implementation + public handler/schema + exports for one feature;
- candidate + trivial post-rebase adaptation;
- implementation + freshness/version closure caused by the same semantic change;
- one feature's correctness, scope, and integration interaction with the current baseline.

Do **not** batch unrelated missions, a change set too large for one reviewer to reason about reliably, or an early architecture/security/public-contract decision whose review is needed before downstream implementation becomes expensive. Review count is not a quality metric; evidence and independence are.

When review is required:

1. first confirm the planned implementation batch is at a sensible stable milestone; do not open R1 merely because the latest mission ended;
2. create `R1` as a **NEW SESSION** if no suitable independent Agent R session exists;
3. record `Integration of <review batch>` as BLOCKED by R1 in the Blocker Ledger;
4. define the discharge condition as `R1 reports no blocking findings`;
5. instruct R1 to inspect the whole assigned batch and report **all material in-scope blocking findings it can substantiate in that pass**, rather than intentionally stopping after the first finding;
6. if R1 finds blockers, keep integration blocked and group directly related repair obligations into the smallest sensible repair batch. Use planner-owned work for tiny bounded fixes; otherwise use the same implementation session or a justified fresh implementation session;
7. after the repair batch is complete, issue `R2` into the **same Agent R chat** unless independence/context has materially broken;
8. keep R2 bounded to all repaired findings plus directly related regression/integration effects, and ask it to report all remaining material in-scope blockers in one pass;
9. discharge the review blocker only when the required review/re-review passes;
10. then let the planner perform bounded integration when authorized.

Do not let `implementation complete` silently mean `integration ready` when the Review Gate requires independent review.

### 8. Choose workspace topology

Use the simplest safe topology:

- current checkout for one writer at a time;
- same checkout/branch for sequential sessions when safe;
- separate branches/worktrees only for genuine concurrent writers, conflicting local state, explicit isolation needs, or another concrete safety requirement;
- no writable workspace for read-only missions.

Never create one worktree per agent by default. Never put concurrent writers in one worktree.

### 9. Define the mission contract

For each mission record when relevant:

- mission ID (`A1`, `A2`, `B1`, ...);
- agent/session;
- fresh vs same-session continuation;
- role;
- review independence;
- wave/phase;
- start condition;
- dependencies/blockers;
- approximate effort share;
- artifact type;
- ownership/coordination boundary;
- observable success;
- testing/validation authority;
- workspace;
- execution lifetime;
- out of scope;
- handoff inbox path when a shared filesystem is available.

Size missions for coherent ownership and a **reasonable amount of useful work**, not arbitrary task counts or a desire to minimize agent passes. Prefer several meaningful same-session implementation missions before the first review when they naturally form one candidate. Split earlier only when dependencies, ownership, context limits, or a direction-setting risk make the boundary useful.

### 10. Preserve testing and mutation authority

Planning must not grant authority the user or governing engineering workflow did not grant.

Use a field such as:

`Testing/validation authority: none | specified existing command(s) may run | test changes authorized | authoritative repository workflow`

When Causal Coding applies, preserve its distinctions among workflow execution, production mutation, test execution, test creation/modification, verification, continuation, and stopping.

### 11. Generate the correct prompt type

Use `references/agent-prompt-template.md`.


### 11.1 Use file-backed mission handoffs

When the planner and delegated sessions share the connected filesystem, use `references/handoff-artifacts.md`.

Default to a disposable cache outside the repository so coordination does not dirty the working tree. Derive one stable repository key from the canonical Git common directory so all worktrees for the same repository share the same inbox. Assign each mission an exact inbox path in its launcher/continuation/review prompt.

Before a delegated mission returns its chat finish report, require it to write one timestamped handoff receipt containing its status, workspace/branch/HEAD, concise outcome, validation actually performed, deviations, blockers, and downstream facts. The planner should discover and read these receipts when the user says things like `check Agent A`, `check their work`, or `continue from the latest agent result`; do not ask the user to copy/paste a report that already exists in the shared inbox.

A handoff receipt is advisory coordination state. Repository/Git/process facts still require authoritative verification before integration, review, or readiness claims. If the receipt is absent, stale, malformed, or refers to a different repository/worktree state, fall back to direct repository inspection and only ask the user for missing context when it cannot be reconstructed.

Treat handoff files as disposable cache. Preserve receipts for active/unresolved missions and the latest completed review/integration boundary; prune older stale receipts opportunistically after integration or during orientation according to the retention guidance in `references/handoff-artifacts.md`. Never delete source, branches, worktrees, or user artifacts as part of handoff cleanup.

For a **fresh session**, provide the full launcher prompt and say to open a new chat.

For an **A2/B2 continuation**, provide a shorter delta prompt and say to paste it into the existing agent chat.

For **R1**, provide the dedicated independent-review launcher and explicitly say to open a NEW Agent R chat. For **R2**, provide the re-review delta and explicitly say to paste it into the existing Agent R chat.

When durable mission files exist, point to them instead of duplicating full context.

### 12. Handle long-lived missions

Mark long-lived/wait-heavy missions:

`Execution lifetime: persistent-agent-loop`

Tell that session to load `persistent-agent-loop`. Do not duplicate its timer/wait/checkpoint mechanics here.

### 13. Apply the Frontier Transition Gate

Run this gate after every frontier-invalidating event, including:

- returned mission report or newly discovered mission handoff receipt;
- cherry-pick/merge/integration;
- planner-owned repository change that affects readiness;
- blocker confirmation/refutation;
- review result or re-review result;
- new dependency/blocker;
- mission cancellation/supersession;
- material contract change;
- workspace ownership change;
- user decision that changes readiness.

Before declaring any mission or wave READY:

1. reconcile all known unresolved sessions;
2. update blocker states;
3. list every blocker on the candidate mission/wave;
4. require concrete evidence that every required blocker is discharged;
5. preserve unrelated blockers;
6. recompute the readiness frontier;
7. apply the Review Gate to completed implementation that is approaching integration;
8. choose planner-owned vs A2/B2 vs R1/R2 vs fresh-session ownership for newly READY work;
9. execute planner-owned work or emit the required prompt immediately;
10. update progress state.

Never end a frontier transition with only `Wave X can start`.

### 14. Apply the Strategic Reassessment Gate

Frontier bookkeeping is necessary but insufficient. Periodically challenge whether the current plan is still the right plan.

Default cadence:

- run after **two material frontier transitions** since the last reassessment;
- treat one major/high-impact transition as sufficient to trigger immediately;
- run immediately when the user asks to rethink/reflect/audit, evidence contradicts a planning premise, the target configuration changes, an independent review exposes cross-cutting risk, an experiment may be measuring the wrong thing, or the plan is about to make a high-level readiness/live-validation claim;
- do not count status-only, elapsed-time, or no-op updates.

Read `references/strategic-reassessment.md` and apply its checklist. For connected repositories, ground the reassessment in targeted **read-only authoritative inspection**, not only prior reports or conversational summaries.

At minimum challenge:

- the end objective and non-negotiable target configuration;
- hidden assumptions and configuration-fidelity gaps;
- whether captured/serialized metadata actually changes runtime behavior where the claim requires it;
- experiment validity and confounds;
- DAG ordering, blockers, parallelism, and execution ownership;
- iteration topology: whether missions are too small, whether the next planned same-session implementation mission should finish before review, and whether planner-owned bounded work can remove unnecessary repair ping-pong;
- handoff topology: whether agent state is being copied manually through chat even though a shared handoff inbox could make the planner discover completion state directly;
- Review Gate placement: whether review is being triggered by mission completion instead of candidate stability, whether related review surfaces can be batched at a larger stable boundary, and validation depth;
- the distinction among implementation correctness, model fidelity, operational readiness, and outcome/strength claims.

Prefer the smallest evidence-backed replan. Explicitly preserve areas that remain valid rather than reopening them reflexively. If the reassessment discovers implementation-affecting work, route it through the correct mission owner and review path; do not opportunistically patch production merely because the planner found the issue.

After the gate, emit a concise **Strategic Reassessment receipt** and reset the reassessment cadence. If nothing changes, say that the current DAG remains valid and why.

### 15. Require finish reports

Every delegated mission returns:

1. `status: complete | blocked | needs decision`;
2. agent/session and mission ID;
3. role;
4. workspace/branch and relevant commits when any;
5. concise behavior/interface/artifact result;
6. testing/validation actually performed, if authorized;
7. deviations from mission;
8. information dependent missions need;
9. unresolved blockers/decisions.

### 16. Report progress automatically

When an orchestration plan is active, append a **Progress Snapshot** after every response that performs or processes an orchestration action, including status-only updates when the planner has enough state to report meaningfully.

Do not wait for the user to ask for progress.

Use the **tree-style Current frontier snapshot** in `references/orchestration-state.md` as the default UX. Reserve the larger Execution Board for initial planning, major replans, or materially changed DAGs.

The automatic snapshot must include, compactly:

- `Current frontier`;
- one tree node for every known active/unresolved agent/mission that matters now;
- status/ownership such as `CONTINUE`, `READY — SAME SESSION`, `READY — NEW SESSION`, `READY — REVIEW`, `BLOCKED`, or `COMPLETE + INTEGRATED`;
- one-line authoritative evidence/state where useful;
- explicit blockers, including review blockers;
- near-future PLANNED/CONDITIONAL work when it affects decisions;
- a compact planned-effort summary when effort weights exist;
- exact `Next human action`, including `paste H2 into existing Agent H`, `open Agent R with R1`, `continue Agent G`, or `nothing new`.

Do not permanently carry irrelevant historical completions. Collapse them to a short integrated-base fact once they no longer affect the frontier.

Use only known evidence. If state is unknown, label it `UNKNOWN`; do not fabricate ACTIVE/COMPLETE states.

Effort percentages are relative engineering-work estimates, not elapsed time or measured percent-complete. Rebaseline only when the plan materially changes.

See `references/orchestration-state.md` for the canonical tree format, Review Gate examples, and the larger-board escalation rule.

## Default output

Use the lightest useful structure, but during an ongoing plan the Progress Snapshot is mandatory unless explicitly suppressed.

Typical order:

1. Frontier transition / decision
2. Strategic Reassessment receipt, when the gate is due
3. Missions or integration action
4. Copy/paste prompt(s), when newly actionable
5. Review/integration note, including Agent R state when relevant
6. **Progress Snapshot — Current frontier tree**

For a newly READY mission:

- planner-owned -> perform it when authorized;
- same-session -> emit A2/B2 prompt in the same response;
- review -> emit R1/R2 prompt in the same response and keep integration blocked until review passes;
- fresh session -> emit new-agent prompt in the same response;
- deferred -> state the explicit reason.

## Guardrails

- Never let an unrelated completion discharge another mission's blocker.
- Never declare READY before the Frontier Transition Gate passes.
- Never let an active/unresolved agent disappear from the plan without a disposition.
- Never end with only `Wave X can start` when action can be assigned now.
- Never open a fresh session when an A2/B2 continuation is the cheaper correct owner.
- Never create an A2/B2 handoff for a tiny bounded repair the planner can safely and cheaply own under the active mutation authority.
- Never treat every implementation mission boundary as a review boundary. Allow multiple coherent missions to accumulate before R1 when early review would not change direction.
- Never optimize for the fewest agent passes by making missions oversized, mixing unrelated ownership, or delaying a genuinely direction-setting review. Optimize for balanced mission size and fewer feedback cycles.
- Never fragment one coherent reviewable candidate into multiple review waves merely because its implementation has layers; batch at the largest sensible stable boundary unless early review materially reduces risk.
- Never instruct Agent R to stop after the first blocker by default. Within the assigned review boundary, collect all material findings that can be substantiated in the same pass unless an early blocker makes the remaining review genuinely unobservable or meaningless.
- Never use A2/B2 when required independence would be compromised.
- Never equate self-review with independent review.
- Never let Agent R implement the production repair it is independently reviewing.
- Never integrate work while a required R1/R2 review blocker remains unresolved.
- Never manufacture agents, waves, worktrees, review phases, or coordination artifacts merely because a generic workflow often has them.
- Never place concurrent writers in one worktree.
- Never hide a dependency to make the plan look parallel.
- Never let planning broaden testing or mutation authority.
- Never present relative effort as elapsed-time progress.
- Never copy secrets/credentials into prompts or coordination files.
- Never let stale planning state outrank current user direction or verified repository evidence.
- Never let repeated frontier updates substitute for the Strategic Reassessment Gate once its cadence or trigger condition is met.
- Never ask the user to relay a delegated agent's finish report when a valid file-backed handoff receipt is discoverable from the assigned shared inbox.
- Never replan for novelty: a deep reassessment may conclude that the current DAG remains correct, but it must show what was challenged and why the plan still holds.
