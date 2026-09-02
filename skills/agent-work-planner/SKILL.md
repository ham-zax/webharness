---
name: agent-work-planner
description: Plan engineering work across human-launched AI coding sessions and follow-up missions. Use when splitting work into agents/sessions, deciding whether the planner should act directly, continue an existing session as A2/B2, open a fresh implementation session, or create an independent Agent R review lane; tracking review gates, blockers, waves, relative effort, progress, integration readiness, workspace topology, prompts, and replanning after reports, integrations, commits, or other frontier-changing events.
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
- **Blockers do not disappear implicitly.** A blocker is discharged only by evidence satisfying its recorded discharge condition.
- **READY implies action.** When work becomes READY, either execute planner-owned work, issue a same-session continuation prompt, issue a fresh-session prompt, or explicitly defer it with a reason.
- **Active sessions never disappear silently.** Reconcile every known active or unresolved session before advancing the frontier.
- **Progress is automatic.** During an ongoing plan, every orchestration response after a frontier-affecting event ends with a compact Progress Snapshot unless the user explicitly asks to suppress it.
- **Forecast the DAG; materialize the frontier.** Keep future waves visible at low resolution without freezing details that depend on current work.
- **Reuse context aggressively, preserve independence more strongly.** Prefer A2/B2 when existing context helps, except when a fresh independent perspective is required.
- **Review must earn its overhead, then block integration when required.** Substantial or integration-sensitive changes must pass an explicit Review Gate; when independent review is warranted, create Agent R and keep integration blocked until the review discharge condition is satisfied.
- **Reviewer and implementer stay separate.** Agent R identifies findings; the original implementer normally repairs them via A2/B2; Agent R re-reviews via R2.
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

### 5. Choose the execution owner

For each newly READY action, decide in this order:

#### A. Planner-owned

Execute directly when the action is bounded coordination/setup/integration or a small determined change and delegation would cost more than it helps.

Typical examples:

- clean cherry-pick/integration;
- bounded coordination-file update;
- small deterministic metadata alignment;
- branch/worktree/status inspection;
- preparing prompts/handoffs.

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

If R1 finds blocking defects, route the repair back to the original implementer as A2/B2/etc. when same-session reuse remains the cheapest correct owner. Then issue R2 into the existing Agent R chat for re-review.

Do not reuse R for implementation when doing so would destroy the independence required for the resulting repair.

### 7. Apply the Review Gate before integration

Before integrating a completed implementation mission, decide whether independent review materially reduces integration risk. Review must earn its overhead; do not create Agent R for every tiny change.

Default toward an Agent R review when one or more materially apply:

- substantial implementation or large refactor/migration;
- cross-subsystem or shared-contract changes;
- public API/schema/persistence/data-shape changes;
- concurrency, process-lifetime, native/GPU/FFI, auth/security, or other difficult-to-observe behavior;
- broad/mechanical changes where attribution is harder;
- implementer-reported uncertainty, deviations, or unresolved risk;
- explicit user/spec/repository requirement for independent review.

Usually skip Agent R for clean cherry-picks, small deterministic integrations, tiny localized changes, or docs/metadata where independent review cost clearly exceeds plausible integration risk.

When review is required:

1. create `R1` as a **NEW SESSION** if no suitable independent Agent R session exists;
2. record `Integration of <mission>` as BLOCKED by R1 in the Blocker Ledger;
3. define the discharge condition as `R1 reports no blocking findings`;
4. if R1 finds blockers, mark the implementer repair mission A2/B2/etc. READY and keep integration blocked;
5. after repair, issue `R2` into the **same Agent R chat** unless independence/context has materially broken;
6. discharge the review blocker only when the required review/re-review passes;
7. then let the planner perform bounded integration when authorized.

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
- out of scope.

Size missions for coherent ownership, not arbitrary task counts.

### 10. Preserve testing and mutation authority

Planning must not grant authority the user or governing engineering workflow did not grant.

Use a field such as:

`Testing/validation authority: none | specified existing command(s) may run | test changes authorized | authoritative repository workflow`

When Causal Coding applies, preserve its distinctions among workflow execution, production mutation, test execution, test creation/modification, verification, continuation, and stopping.

### 11. Generate the correct prompt type

Use `references/agent-prompt-template.md`.

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

- returned mission report;
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

### 14. Require finish reports

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

### 15. Report progress automatically

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
2. Missions or integration action
3. Copy/paste prompt(s), when newly actionable
4. Review/integration note, including Agent R state when relevant
5. **Progress Snapshot — Current frontier tree**

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
