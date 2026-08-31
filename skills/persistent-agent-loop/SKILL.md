---
name: persistent-agent-loop
description: Use when a task must remain active across extended waiting, repeated tool work, user steering, process observation, multi-hour mission execution, planner-generated workflows that may outlive one ordinary turn, or when ChatGPT must reason precisely about durable wait/timer semantics, `pending` results, model-turn continuity, and explicit resumption.
---

# Persistent Agent Loop

## Core invariant

Keep the **mission** alive across short tool/RPC boundaries. A heartbeat, `pending` wait result, timer firing, subtask completion, or temporary lack of work is a scheduling event, not mission completion.

A durable wait preserves local condition state; it does not preserve or restart model execution. No wait or timer initiates a new ChatGPT/model turn. After `pending`, continue or resume the named wait only while a model turn is active; if that turn is lost, a successor recovers from the durable checkpoint and explicitly resumes the wait.

End only when one of these is true:

1. the mission completion criteria are verified;
2. the user explicitly stops or replaces the mission; or
3. continuation is impossible or unsafe and the recoverable state has been checkpointed.

## Use the cooperative loop

```text
reason -> act -> checkpoint if meaningful -> wait -> reassess -> continue
```

- Treat `wait(...)=pending` as a cooperative scheduling point. The named wait remains durable; process new steering or do other useful tool work, then resume by the same name when appropriate.
- Do not manufacture activity. If nothing changed, resume the wait.
- User steering has priority over the previous next action. Decide whether it supplements, reprioritizes, replaces, or stops the mission; preserve the original mission unless steering changes it.
- For persistent commands, servers, builds, or interactive work, keep process lifetime in Terminal and use `wait` for output/readiness/exit observation.
- Keep Terminal work headless by default. If live human visibility is useful from the start, use `terminal_open(..., present:true)` so the exact private tmux PTY is visible in Kitty while tmux/broker remain the lifetime and ownership authority. For an already-running headless session, passive viewing can be offered through the human-side `wsl-term present <session>` frontend; use `terminal_yield` only when human input/control is actually useful.
- Treat ordinary steering, status requests, progress questions, added context, and compatible side tasks as in-mission events, not implicit termination. For status/progress steering, emit a prompt bounded checkpoint from already-verified state and do not launch broad tests, independent review, or auxiliary verification merely to produce that update. Then continue the active mission in the same turn unless the user explicitly stops/replaces it or continuation becomes impossible/unsafe; steering itself is not a yield or completion condition.

## Keep latency and external usage bounded

- Respond to explicit user steering early within the active turn, then resume the mission. Do not turn a status/checkpoint request into another long implementation or verification cycle before acknowledging it, and do not end/yield the turn merely to improve responsiveness.
- Persistence does not authorize tests. Create, modify, or run tests only when the user, authoritative mission/specification, or mandatory repository policy explicitly requires testing.
- Run broad verification only when it is explicitly required at a meaningful transition boundary such as a real merge/completion decision; do not introduce it merely because a progress message arrived or because the mission is long-lived.
- Treat usage-metered or separately billed external agents/models/CLIs, including Codex, as **explicit opt-in only**. Do not invoke or substitute them for a missing reviewer/subagent unless the user explicitly authorizes that external agent for the current task.
- If another workflow asks for delegated review but no native or already-authorized reviewer exists, do not silently fall back to Codex or another metered agent. Use bounded in-session review when appropriate, report that delegated review was unavailable, or ask the user at the actual decision boundary.

## Keep repository writer ownership explicit

For repository missions, process ownership and Git writer ownership are separate contracts. Keep **one writable autonomous process per Git worktree**. Read-only agents/reviewers may run concurrently against a stable tree, but two writers must never share one worktree merely because their intended files differ.

- Before taking over a repository with an existing Terminal/Codex/agent process, inspect Git/worktree state and establish whether that process is still a writer. Do not silently become a second writer.
- If concurrent writable delegation is genuinely useful, give each writer a separate worktree/branch from a known verified base, keep ownership disjoint, verify each result independently, then integrate centrally. Otherwise serialize writers.
- Delegated writers must not merge, rebase, reset, switch shared branches, or rewrite another writer's branch unless that mutation is explicitly part of their assignment.
- Terminal model/human ownership protects PTY input; it does not establish repository writer ownership. Track both independently.
- Before saying `clean`, `green`, `committed`, or equivalent, obtain fresh repository evidence from the authoritative WSL worktree.

## Compose with agent-work-planner

If `agent-work-planner` is available and the mission still needs explicit decomposition, dependency ordering, execution phases, or substantial replanning, use that Skill for the planning layer and keep this Skill responsible for execution lifetime.

- Let `agent-work-planner` own **what should happen and in what order**.
- Let `persistent-agent-loop` own **how the mission stays alive while that plan is executed**: durable waits, timers, steering, checkpoints, persistent-process observation, lease renewal, and completion gating.
- When producing a ready-to-run plan or agent prompt for work that is expected to be long-lived, tell the executing agent to use `persistent-agent-loop` for the execution phase.
- Normalize long-lived planned phases around a concrete resume condition: `timer` when elapsed time is the condition; an event wait when external state is the condition; Terminal + event wait when a persistent process owns the work.
- If major steering invalidates the current plan, consult `agent-work-planner` again when useful, then resume the persistent loop with the revised plan.
- Do not require the planner for a simple long wait or already well-specified mission, and do not duplicate the persistent-loop protocol inside the planner.

## Use native timers for time-based conditions

Use Dev `wait` with `{kind:"timer", after_seconds:N}` for a relative timer condition, or `{kind:"timer", at:"2026-08-17T09:00:00+05:30"}` for an absolute timezone-qualified timer condition.

Do not use Bash `sleep`, repeated polling, or an impossible file/process condition as a timer.

Choose the resume condition dynamically from mission semantics: use `timer` when elapsed time itself is the reason to reassess; use an event condition such as Terminal output/exit, process exit, TCP readiness, file state, HTTP readiness, or systemd state when external reality is the reason to reassess. Prefer the event condition when it can match earlier and more precisely than a periodic timer.

`timeout_seconds` is the durable safety deadline, not the timer itself. Keep it **strictly later** than the timer target because the safety deadline wins ties. It supports at most 86400 seconds; `timer.after_seconds` supports at most 86399 seconds. `hold_seconds` only controls one MCP invocation and remains at most 15 seconds.

## Keep long missions recoverable

Checkpoint only meaningful mission state: goal, completion criteria, verified progress, durable process/wait identifiers, artifacts, steering decisions, blockers, and the next intended action. Never checkpoint secrets.

For missions that may span more than 24 hours, renew waits as <=24-hour leases after a checkpoint. Do not increase `hold_seconds` or pretend a single ChatGPT turn is guaranteed to live forever.

## Read the detailed protocol when needed

Read [references/protocol.md](references/protocol.md) before any mission expected to span more than about 30 minutes, accept repeated user steering, cross a 24-hour lease boundary, or require hard-cutoff recovery; follow its state, steering, lease, and recovery rules.

## Completion gate

Before ending a mission:

- re-read the completion criteria;
- obtain the fresh evidence required to establish the mission's completion criteria; do not infer testing authorization from persistence;
- distinguish verified completion from temporary idleness;
- cancel obsolete waits only when they are no longer part of the mission;
- leave a durable checkpoint if the mission cannot safely continue.

Never claim uninterrupted multi-day execution merely because the local wait state can survive that long. Report only the continuity actually observed.
