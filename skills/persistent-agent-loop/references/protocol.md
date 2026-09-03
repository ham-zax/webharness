# Persistent Agent Loop Protocol

Use this reference for missions with nontrivial continuity: repeated waits, persistent processes, repeated steering, durable checkpoints, model-turn recovery, long leases, or several simultaneous resume conditions.

## 1. Mission state

Preserve only state that materially affects safe resumption:

```text
mission_id
mission_goal
completion_criteria
mission_source_or_assignment
current_status
verified_progress
next_action
active_resume_conditions
active_process_or_terminal_identifiers
important_artifacts
steering_decisions
blockers
last_authoritative_observation
last_checkpoint_time
```

When a mission originated from Agent Work Planner, also preserve the assigned session/mission identity and its ownership boundary. Do not copy the whole multi-wave plan into the local continuity state unless a small reference to the coordination artifact is insufficient.

Never store passwords, tokens, MFA values, private keys, or other secrets.

## 2. Checkpoint policy

Create or update durable state only when recovery value is real.

Checkpoint after a meaningful state transition, material steering, risky handoff, long-lived process creation, important blocker, or before continuity may cross a model-turn/session boundary.

Do not rewrite a checkpoint merely because a wait returned `pending`.

Prefer an existing project status artifact or Agent Work Planner coordination artifact. Create a locally ignored PAL-specific state file only when no existing durable location fits.

## 3. Cooperative scheduling model

Keep these lifetimes conceptually separate:

```text
mission lifetime       may span many observations or model turns
resume-condition state may outlive one observer call
observer/tool call     short-lived RPC/tool boundary
persistent process     independently owned process lifetime
model turn             product/runtime execution boundary
```

A local wait may remain durable after an observer call returns. That does not mean the model continues running and does not create a future model turn.

Treat `pending` as: the condition has not matched yet and durable condition state may still exist.

Treat `matched` as: the resume condition became true; reassess the mission.

Treat `timeout` as: the observer's safety/lease boundary ended; reassess the mission rather than declaring success or failure automatically.

Treat tool/provider failure as evidence about observability or tooling, not automatic evidence about the underlying process/repository state.

## 4. Semantic resume conditions

Choose conditions from meaning rather than polling habit.

### Time

Use when elapsed or absolute time itself is the reason to reassess.

A time condition becoming due does not automatically start model execution. It becomes useful only when an active/successor model turn evaluates or resumes the condition.

### External event

Use when useful work depends on external reality, such as process exit, readiness, output, file state, service state, or another observable event.

Prefer an event condition over periodic timers when it can identify readiness earlier and more precisely.

### Persistent process

Keep process lifetime in the authoritative persistent-process primitive selected by MCP Harness Router. Use resume conditions to observe that process rather than holding one giant RPC open.

Do not infer process exit from observer timeout.

## 5. Named resume-condition discipline

Give a durable condition a semantic identity.

Preserve a still-valid named condition across scheduling points.

If steering changes the meaning of the condition, retire the obsolete condition and create a new semantic identity rather than silently reusing the same name for a different purpose.

When several conditions represent alternatives, keep their cleanup/resumption relationship explicit. Avoid unbounded families of orphaned conditions.

## 6. User steering

Classify steering before changing continuity state:

### Status/checkpoint

Report from the latest verified state. Perform at most the smallest authoritative observation required to avoid an unsupported status claim.

Then continue the mission if it remains active.

### Additive request

Handle only when compatible with the mission and independently authorized. If it changes implementation scope, apply Causal Coding. If it creates a new session/mission boundary, return to Agent Work Planner rather than absorbing it silently.

### Reprioritization

Update the next action and affected resume condition. Preserve unchanged mission criteria.

### Mission replacement

Preserve useful old state, retire obsolete waits/process observation safely, and adopt the replacement objective.

### Stop

Preserve requested final evidence/state, retire obsolete waits when safe, and end.

Do not treat a user message as implicit cancellation merely because it arrived while the mission was waiting.

## 7. Repository/process ownership on resume

Treat process ownership, human/model terminal ownership, and repository writer ownership as different facts.

PAL does not choose branch/worktree topology. Agent Work Planner or the existing authoritative assignment owns that decision.

Before resuming mutation after interruption, verify that the assigned workspace is still safe to write. If another writer now owns it or the topology changed materially, stop mutation and surface the conflict for replanning.

Repository/process reality outranks checkpoint assumptions.

## 8. Long-lease continuity

If one local wait cannot safely span the whole real-world delay, treat waits as renewable observation leases rather than one uninterruptible execution guarantee.

Before renewing:

1. checkpoint only if state changed materially or recovery value exists;
2. verify durable process/session identifiers that matter;
3. confirm the same semantic condition is still the right thing to await;
4. retire an obsolete condition when necessary;
5. create/resume the next appropriate observation lease;
6. continue without claiming uninterrupted model execution.

Use MCP Harness Router for current tool-specific lease, timeout, and hold constraints.

## 9. Hard-cutoff recovery

When a successor model turn resumes an interrupted mission:

1. read the mission assignment and checkpoint;
2. inspect authoritative repository/process/artifact state;
3. establish which intended changes actually exist;
4. verify the assigned mission has not already completed or been replaced;
5. restore only still-valid resume conditions/process observation;
6. continue from the verified next action.

Never infer completion from an earlier intention to run a command.

For Agent Work Planner missions, restore only the assigned session mission. Do not continue into newly unblocked downstream sessions.

## 10. Completion contract

Temporary idleness is not completion.

A subtask finishing is not completion unless it is the entire assigned mission.

A timer/event match is not completion unless the mission explicitly defines that condition as terminal.

A wait timeout is not completion unless the mission explicitly defines timeout as its terminal condition.

Before ending:

1. re-read the assigned mission and completion criteria;
2. use only authorized evidence to establish completion;
3. confirm no required work remains merely waiting on a known condition;
4. preserve final recoverable state when appropriate;
5. retire obsolete conditions/process observation;
6. if planner-generated, return the session finish report and stop.

## 11. Practical patterns

### Long-running command inside one assigned implementation mission

```text
confirm mission authority
-> start persistent process using router-selected primitive
-> observe meaningful readiness/output/exit condition
-> pending: keep mission alive without manufacturing work
-> matched: inspect result
-> apply authorized repair if needed
-> repeat only while the same assigned mission remains incomplete
-> establish completion
-> return finish report
-> stop
```

### User asks for status while waiting

```text
status request
-> read latest verified state
-> perform one tiny authoritative probe only if needed
-> report status
-> preserve still-valid resume condition
-> continue assigned mission
```

### Steering invalidates the plan

```text
steering arrives
-> classify as reprioritization/replacement/scope change
-> checkpoint material change if recovery value exists
-> if multi-session decomposition changed: return to Agent Work Planner
-> if implementation authority changed: apply Causal Coding
-> resume only after the new mission boundary is clear
```

### Model turn disappears

```text
successor starts
-> read checkpoint/assignment
-> inspect repository/process reality
-> establish what actually happened
-> restore still-valid condition/process observation
-> continue assigned mission only
```

## 12. Anti-patterns

Avoid:

- treating `pending` as failure or completion;
- pretending a timer schedules a future model turn;
- heartbeat edits/logging with no mission value;
- one giant long-lived tool call when process lifetime should be separate;
- inventing new worktrees/agents/reviewers to preserve continuity;
- expanding testing or verification because the mission is long-lived;
- treating checkpoint text as more authoritative than repository/process reality;
- mutating an assigned worktree after writer ownership became ambiguous;
- resuming into a downstream planner wave after the assigned session mission completed;
- storing secrets in durable state.
