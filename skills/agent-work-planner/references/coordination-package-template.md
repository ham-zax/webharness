# Coordination Package Template

Use these templates when materializing a multi-session wave. Adapt headings when the repository already has a stronger convention.

## README.md

```markdown
# <Effort> — Agent Coordination

**Repository:** `<absolute path>`
**Source of truth:** `<spec/plan path>`
**Coordination base:** `<commit or "not applicable">`
**Execution shape:** `<single | sequential | parallel | hybrid>`
**Current wave:** `<N>`

## Current frontier

| Mission | Type | Status | Can start | Workspace | Isolation reason | Blocked by |
|---|---|---|---|---|---|---|
| Agent 1 — <name> | executable/docs/config/mixed/read-only | ready | now | `<current checkout or worktree>` | `<none or reason>` | none |

## Dependency map

```text
<compact DAG showing current wave, integration, and later blockers>
```

## Shared contracts

- <cross-mission interface or artifact that must remain stable>

## Workspace policy

<Default current checkout or justified worktree topology. Record why each isolated workspace exists. Prefer distinct write ownership over shared mutable coordination state. If one shared writer is unavoidable, name the owner/serialization boundary. Do not create worktrees solely because missions exist.>

## Integration policy

<Who integrates isolated branches, onto what base/branch, and what must be verified before downstream work starts. Say "not applicable" when no branch integration exists.>

## Execution lifetime policy

<Which current-wave missions are ordinary one-turn work versus `persistent-agent-loop` missions. For long-lived missions, record timer/event/Terminal wake strategy, meaningful checkpoint boundary, steering expectations, and whether optional Kitty visibility is useful. Do not duplicate the persistent-loop protocol.>

## Validation policy

<Default: no test creation, test modification, or test execution. Record only validation explicitly required by the user, source plan/specification, repository policy, or integration contract.>

## Future / blocked work

Keep this deliberately low-resolution. Record enough to know what is waiting and why, but do not write detailed mission briefs until the work reaches the frontier.

- <future mission> — blocked by <condition>

## Status log

- `<date/time or commit>` — coordination package created for Wave <N>.
```

Update this README whenever returned agent work materially changes readiness, contracts, branch topology, validation requirements, or integration state.

## Mission file

Use one file per current-wave agent: `agent-N-<slug>.md`.

```markdown
# Agent N — <Mission name>

**Repository:** `<absolute repository path>`
**Artifact type:** `<executable | docs | config | mixed | read-only>`
**Workspace:** `<current checkout | branch/worktree path | read-only>`
**Isolation reason:** `<none | concrete reason>`
**Can start:** `<immediately | after dependency>`
**Depends on:** `<mission/commit/contract or none>`
**Execution lifetime:** `<ordinary | persistent-agent-loop required | optional>`
**Wake strategy:** `<none | native timer | event wait | Terminal + event wait>`
**Developer visibility:** `<headless | Kitty from start | passive presentation on request | human handoff if needed>`

## Read first

- `<source spec/plan>` — authoritative requirements
- `<coordination README>` — dependency map and neighboring ownership
- `<AGENTS.md / CLAUDE.md / ADR>` — repository conventions if relevant

## Objective

<Outcome this session owns. Describe desired behavior and scope, not an implementation recipe.>

## Current state

<Only facts that materially affect this mission.>

## Ownership

You own:
- <behavior/subsystem/interface/artifact>
- <completion responsibility for that ownership>

Neighboring missions own:
- <adjacent area>

## Coordination contract

<What other agents depend on. Identify stable public contracts or the protocol for proposing a change.>

## Success conditions

- <observable criterion>
- <observable criterion>
- <compatibility / documentation expectation>

## Required validation

<Default: none. State only commands or checks explicitly required by the user, source plan/specification, repository policy, or integration contract. Never add tests merely because the mission changes code.>

## Out of scope

- <adjacent work>

## Working style

Explore the repository before deciding implementation details. Follow repository conventions and current code rather than stale assumptions in this brief. Keep the mission coherent and focused. Do not create, modify, or run tests unless testing is explicitly authorized by the mission/source plan or mandatory repository policy. Keep any required non-test validation minimal. Do not create a worktree merely because this is a delegated mission; use the assigned workspace unless a real isolation problem is discovered.

## Finish report

Return:
1. status: complete / blocked / needs decision;
2. workspace/branch and commits created, if any;
3. resulting behavior/artifact and public/interface changes;
4. explicitly required validation actually run, if any; otherwise state none;
5. anything dependent sessions need to know;
6. unresolved risks, deviations, or decisions needed.
```

## Short launcher prompt

When the receiving agent can access the repository, prefer a pointer instead of repeating the mission:

```text
You are <Agent N / mission name> for <effort>.

Repository: <repo path>
Workspace: <current checkout or worktree path>
Authoritative mission: <agent-plan-folder>/agent-N-<slug>.md
Coordination map: <agent-plan-folder>/README.md
Source plan/spec: <path>

Read the mission and coordination map first, inspect the current repository, and own that mission through its observable success conditions. If the mission says `persistent-agent-loop` is required, use that Skill for execution lifetime: durable waits/timers, steering, checkpoints, and completion gating. Do not create extra worktrees. Do not create, modify, or run tests unless testing is explicitly authorized by the mission/source plan or mandatory repository policy. Do not absorb neighboring missions unless correctness requires a small boundary adjustment; report any larger conflict instead. Return the finish report requested in the mission file.
```
