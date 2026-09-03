---
name: persistent-agent-loop
description: Use when one already-defined mission must remain active across extended waiting, repeated tool work, user steering, persistent processes, resumable checkpoints, or recovery after a lost model turn. Preserve mission continuity without treating pending waits, timers, idle periods, or subtask completion as mission completion. Do not use for multi-session decomposition or next-wave planning; use agent-work-planner for that. When implementation-affecting work is involved, preserve Causal Coding authority over mutation, testing, verification, continuation, and stopping. On connected WSL/Linux targets, use mcp-harness-router to select concrete wsl-web-harness wait, Terminal, process, and repository primitives.
---

# Persistent Agent Loop

Keep one already-defined mission alive, steerable, and recoverable across waits, persistent processes, tool/RPC boundaries, and model-turn loss.

## Mission boundary

Treat this Skill as an **execution-continuity layer for one mission/session**, not a planner or autonomous worker manager.

Do not expand the assigned mission merely because another task becomes ready.

When a mission came from Agent Work Planner:

- preserve that session's objective, ownership, dependencies, and success conditions;
- stop when that session mission is complete;
- return the required finish report;
- do not absorb another session's work or enter the next wave;
- let the human operator and Agent Work Planner decide what fresh session launches next.

## Authority composition

Keep responsibilities separate:

- **Agent Work Planner** owns decomposition, session roles, waves, dependencies, workspace topology, integration ordering, and replanning.
- **Causal Coding** owns implementation mutation scope, expansion, testing authorization, verification authority, continuation, and stopping for implementation-affecting work.
- **MCP Harness Router** owns selection of concrete WSL/Linux wait, Terminal, process, repository, and human-handoff primitives.
- **Persistent Agent Loop** owns continuity across waits, steering, persistent-process observation, meaningful checkpoints, interruption recovery, and protection against false completion.

Persistence never broadens implementation, testing, verification, review, delegation, workspace, or mutation authority.

## Core invariant

Treat a heartbeat, `pending` wait result, timer condition, process-idle period, temporary lack of work, or completed subtask as a **scheduling event**, not mission completion.

A durable wait may preserve local condition state. It does not preserve, restart, schedule, or create model execution.

No local timer or wait should be described as initiating a future ChatGPT turn unless a separate scheduler/runtime actually provides that capability.

End the mission only when:

1. the assigned mission's completion criteria are established by the authority governing that mission;
2. the user explicitly stops or replaces the mission; or
3. continuation is impossible or unsafe and recoverable state has been preserved when useful.

## Cooperative loop

Use:

```text
reason -> act -> checkpoint if recovery value exists -> wait -> reassess -> continue
```

At each cycle:

- act only when useful;
- treat `pending` as a cooperative scheduling point;
- preserve a still-valid named wait rather than recreating it without cause;
- do not manufacture edits, logs, probes, or verification merely to show liveness;
- if nothing material changed, resume the relevant wait or continue observing the existing process;
- re-check the mission boundary after steering or a major external-state change.

## User steering

Classify steering by its effect on continuity:

1. **Status/checkpoint request** - report the latest verified state promptly, then continue the mission if it remains active.
2. **Additive request** - handle it only when it is compatible with the mission and independently authorized; otherwise preserve the current mission and surface the scope boundary.
3. **Reprioritization** - update the next action while preserving unchanged completion criteria.
4. **Mission replacement** - checkpoint the old mission when recovery value exists, retire obsolete waits/process observation safely, and adopt the replacement mission.
5. **Stop** - preserve requested final state/evidence, retire obsolete waits when safe, and end.

Do not treat ordinary status questions, progress questions, added context, visibility requests, or compatible side work as implicit termination.

Steering classification does not itself authorize implementation mutation. Apply Causal Coding or the relevant authoritative workflow when the steering changes implementation scope.

## Resume conditions

Choose the resume condition from mission semantics:

- **time condition** - reassess after elapsed time or at a specific instant;
- **event condition** - reassess when external state changes;
- **persistent-process condition** - reassess on process output, readiness, interaction need, or exit.

Prefer the condition that can match the real dependency most directly. Do not replace a meaningful event condition with periodic polling merely to keep the loop active.

On connected WSL/Linux targets, use MCP Harness Router for the concrete wait/process primitive and current tool schema/limits rather than duplicating those contracts here.

## Persistent process continuity

Keep long-running or interactive process lifetime separate from the observer call that watches it.

Do not infer process completion because an observer wait ended, timed out, or became unavailable.

Preserve the established repository/process ownership arrangement. If resumption would make this session a second writer in an already-owned worktree or otherwise violate the assigned topology, stop mutation and surface the ownership conflict for replanning instead of inventing a new branch/worktree arrangement.

## Checkpoint proportionally

Checkpoint only when durable recovery would materially improve continuation.

Useful checkpoint triggers include:

- a meaningful mission transition;
- steering that materially changes the next action;
- a risky handoff or model-turn boundary;
- a long-lived process/wait whose identifiers matter after interruption;
- recovery across a real wait-lease or session boundary;
- an important blocker or decision that a successor must know.

Do **not** create checkpoint artifacts merely because this Skill is active.

Prefer, in order:

1. an existing project progress/status artifact;
2. an existing Agent Work Planner coordination artifact when the mission originated there;
3. a locally ignored mission-state artifact only when no existing durable location is appropriate.

Store only state that changes future action. Never checkpoint secrets.

## Recover from authoritative reality

After an unexpected model-turn loss or other hard interruption:

1. read the durable mission checkpoint when one exists;
2. inspect authoritative repository, process, wait, and artifact state rather than trusting conversational intention;
3. determine which previously intended actions actually completed;
4. revalidate the assigned mission boundary and next action;
5. retire only clearly obsolete waits/process observation;
6. continue from verified reality.

If the mission originated from Agent Work Planner, recover only that session's assigned mission. Newly ready downstream sessions remain planner/human responsibilities.

## Use the detailed protocol when continuity is complex

Read [references/protocol.md](references/protocol.md) when the mission needs one or more of:

- repeated wait/resume cycles;
- persistent process ownership;
- repeated user steering;
- recovery across model-turn loss;
- durable checkpoints;
- long wait leases or multi-day continuity;
- several simultaneous named resume conditions;
- a nontrivial handoff between model, process, or human control.

Do not load the detailed protocol merely because a mission is expected to last a particular number of minutes.

## Completion gate

Before ending:

- re-read the assigned mission and its completion criteria;
- obtain only the evidence authorized and required by the governing workflow;
- distinguish verified mission completion from temporary idleness, wait timeout, timer match, or subtask completion;
- preserve final recoverable state when the mission cannot safely continue;
- retire obsolete waits/process observation only when they are no longer part of the mission;
- if planner-generated, return the mission finish report and stop rather than entering another wave.

Report only continuity actually observed. Never claim uninterrupted multi-day execution merely because local wait/process state could theoretically survive that long.

## Guardrails

- Never turn persistence into scope expansion.
- Never launch another session, reviewer, external agent, branch, or worktree merely to keep a mission alive.
- Never treat a local wait/timer as future model scheduling.
- Never infer that an intended command completed after a lost turn.
- Never create heartbeat work solely to demonstrate activity.
- Never let checkpoint text outrank current authoritative repository/process reality.
- Never store secrets in durable mission state.
- Never cross from a completed planner mission into another session's mission without explicit replanning/assignment.
