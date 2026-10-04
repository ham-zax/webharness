# Agent Prompt Templates

## Contents

- Fresh-session launcher
- Same-session continuation launcher
- Agent R independent-review launcher
- Agent R re-review launcher
- Steering vs continuation
- Prompt-local operator note

Use the template matching the execution owner selected by Agent Work Planner.

## Fresh-session launcher

Always precede this prompt with:

> **Open a NEW chat for Agent <X>.**

```markdown
You are Agent <X>, Mission <X1>, owning **<mission name>** for <effort/objective>.

## Role
Role: <implement | investigate | integrate | coordinate | compatible combination>
Review independence: <none | self-review sufficient | independent review required>

This is a fresh human-launched coding session. Own only this mission through its observable success conditions.

## Repository
Repository: <absolute repository path>
Workspace: <current checkout | branch/worktree path | read-only>
Handoff inbox: <exact shared path | unavailable>
Can start: <now | after dependency>
Depends on: <mission/blocker/contract/none>

## Read first
- <source plan/spec>
- <repository instructions>
- <coordination artifact when applicable>

Inspect current repository state before choosing implementation details.

## Objective
<Outcome this mission owns.>

## Current state
<Only facts that materially affect this mission.>

## Ownership
You own:
- <owned behavior/subsystem/artifact>

Neighboring missions own:
- <neighboring work or none>

## Success conditions
- <observable criterion>
- <observable criterion>

## Testing / validation authority
<none | specified existing command(s) may run | test changes authorized | authoritative repository workflow>

When Causal Coding applies, follow it for implementation scope, testing authorization, verification, continuation, and stopping.

## Execution lifetime
<ordinary | persistent-agent-loop>

If `persistent-agent-loop` is specified, load it for execution continuity. Do not infer additional planning scope.

## Out of scope
- <adjacent work>


## File-backed handoff

If `Handoff inbox` is available, before your final chat reply write one timestamped Markdown receipt into that directory using the assigned mission ID. Include structured frontmatter plus: status, repository/workspace, branch and HEAD when relevant, concise outcome, validation actually performed, deviations, unresolved blockers/decisions, and facts downstream missions need. Do not include secrets. This receipt is disposable coordination state outside the repository; the planner will verify consequential repository facts independently.

Use a filename shaped like:

`<UTC-YYYYMMDDTHHMMSSZ>-<MISSION>-<status>.md`

If the filesystem write is unavailable, say so in the chat finish report; do not fail an otherwise complete mission solely because the receipt could not be written.

## Finish report
Return:
1. status: complete / blocked / needs decision;
2. Agent <X>, Mission <X1>;
3. role;
4. workspace/branch and relevant commits, if any;
5. resulting behavior/artifact/interface summary;
6. testing/validation actually performed, if authorized;
7. deviations from mission;
8. information dependent missions need;
9. unresolved blockers/decisions.
```

## Same-session continuation launcher

Always precede this prompt with:

> **Paste this into the existing Agent <X> chat. Do not open a new session.**

Use a short delta prompt rather than restating the whole previous mission.

```markdown
Agent <X> — Mission <X2>

This is a new bounded continuation mission in your existing Agent <X> session.
Mission <X1> is <complete / otherwise resolved>. Do not reopen or expand it unless this mission explicitly requires a boundary fact from it.

## New mission
<Outcome this continuation owns.>

## Why this stays in the same session
<Relevant context/ownership continuity.>

## Current authoritative state
Repository: <path>
Workspace: <same assigned workspace or updated assignment>
Current HEAD/artifact: <when relevant>
Handoff inbox: <exact shared path | unavailable>
Depends on: <none / discharged blocker evidence>

## What changed since <X1>
- <new evidence/integration/decision>

## Ownership and boundaries
You own:
- <bounded follow-up>

Still out of scope:
- <adjacent work>

Review independence: <none | self-review sufficient | independent review required>

## Success conditions
- <observable criterion>

## Testing / validation authority
<authority>

When Causal Coding applies, preserve its mutation/testing/verification authority.


## File-backed handoff

If `Handoff inbox` is available, before your final chat reply write one timestamped Markdown receipt into that directory using the assigned mission ID. Include structured frontmatter plus: status, repository/workspace, branch and HEAD when relevant, concise outcome, validation actually performed, deviations, unresolved blockers/decisions, and facts downstream missions need. Do not include secrets. This receipt is disposable coordination state outside the repository; the planner will verify consequential repository facts independently.

Use a filename shaped like:

`<UTC-YYYYMMDDTHHMMSSZ>-<MISSION>-<status>.md`

If the filesystem write is unavailable, say so in the chat finish report; do not fail an otherwise complete mission solely because the receipt could not be written.

## Finish report
Return:
1. status: complete / blocked / needs decision;
2. Agent <X>, Mission <X2>;
3. concise result;
4. workspace/commit state when relevant;
5. authorized validation actually performed;
6. new blockers or information needed by the planner.
```

## Agent R independent-review launcher

Use when the Review Gate requires independent review. Always precede this prompt with:

> **Open a NEW chat for Agent R. Do not use the implementation agent for this review.**

```markdown
You are Agent R, Mission R1, the independent reviewer for **<implementation batch / stable candidate>**.

## Role
Role: independent review
Review independence: required
Mutation authority: read-only unless the user separately authorizes a different mission

Do not repair production code in this mission. Your job is to determine whether the implementation is safe to integrate and to identify concrete blocking findings when it is not.

## Repository
Repository: <absolute repository path>
Review target: <branch/commit/range/worktree>
Authoritative base: <base commit/branch>
Workspace: read-only review of the assigned target
Handoff inbox: <exact shared path | unavailable>

## Read first
- <source plan/spec/mission>
- <implementer finish report>
- <repository instructions>

Inspect the actual implementation and surrounding contracts. Do not rely only on the implementer's summary. The assigned target may intentionally contain multiple implementation missions such as `A1 + A2`; treat it as one batched integration boundary. Do not demand separate review waves for internal layers unless evidence shows that the target is too broad, mixes unrelated risk, or an earlier direction-setting gate was required.

## Review objective
Determine whether <implementation batch / stable candidate> satisfies its integration contract without merge-blocking defects.

Focus on:
- mission correctness and affected contracts;
- regressions or missing transitive changes caused by this implementation;
- integration hazards and ownership violations;
- explicit user/spec/repository requirements;
- authorized verification evidence relevant to the review.

Do not manufacture findings merely because the change is large. Do not intentionally stop after the first blocker: continue through the assigned review boundary and report all material in-scope blocking findings you can substantiate in this pass, unless an early blocker makes the remaining review genuinely unobservable or meaningless.

## Independence boundary
- Do not implement fixes.
- Do not broaden into unrelated repository cleanup.
- Separate merge-blocking findings from non-blocking notes/questions.
- If a finding depends on unavailable evidence, state that uncertainty rather than guessing.


## File-backed handoff

If `Handoff inbox` is available, before your final chat reply write one timestamped Markdown receipt into that directory using the assigned mission ID. Include structured frontmatter plus: status, repository/workspace, branch and HEAD when relevant, concise outcome, validation actually performed, deviations, unresolved blockers/decisions, and facts downstream missions need. Do not include secrets. This receipt is disposable coordination state outside the repository; the planner will verify consequential repository facts independently.

Use a filename shaped like:

`<UTC-YYYYMMDDTHHMMSSZ>-<MISSION>-<status>.md`

If the filesystem write is unavailable, say so in the chat finish report; do not fail an otherwise complete mission solely because the receipt could not be written.

## Finish report
Return:
1. status: pass / blocking findings / blocked;
2. Agent R, Mission R1;
3. exact target reviewed;
4. blocking findings, each with concrete evidence and affected boundary;
5. non-blocking findings/questions, if useful;
6. review/verification evidence actually used;
7. exact repair obligations for the implementer, if blocking;
8. whether integration may proceed now;
9. if repair is required, the narrow re-review scope for R2.
```

## Agent R re-review launcher

Use after the assigned repair owner completes the R1 repair batch. The repair owner may be the planner, the same implementation session, or a justified fresh implementation session. Always precede this prompt with:

> **Paste this into the existing Agent R chat. Do not open a new reviewer session.**

```markdown
Agent R — Mission R2

Re-review the complete repair batch for your R1 blocking findings. Maintain the same independent-review role; do not implement fixes.

## Current authoritative state
Repository: <path>
Original reviewed target: <R1 target>
Repair target: <new commit/range/worktree>
Repair batch owner/mission: <planner-owned | A2/B2/G2/B1/...>
Handoff inbox: <exact shared path | unavailable>

## What changed since R1
- <implementer-reported repairs>
- <new commit/range>

## Re-review scope
Verify that:
- each R1 blocking finding is actually resolved;
- the repair did not introduce a directly related new blocking defect;
- the relevant integration contract now holds.

Do not restart a full repository review unless the repair materially widened the changed surface or evidence requires it. Keep the re-review limited to all repaired R1 findings plus directly related regression/integration effects. Report all remaining material in-scope blockers observable in this pass rather than intentionally serializing them across R3/R4. A small planner-owned repair is valid as long as reviewer independence remains intact.


## File-backed handoff

If `Handoff inbox` is available, before your final chat reply write one timestamped Markdown receipt into that directory using the assigned mission ID. Include structured frontmatter plus: status, repository/workspace, branch and HEAD when relevant, concise outcome, validation actually performed, deviations, unresolved blockers/decisions, and facts downstream missions need. Do not include secrets. This receipt is disposable coordination state outside the repository; the planner will verify consequential repository facts independently.

Use a filename shaped like:

`<UTC-YYYYMMDDTHHMMSSZ>-<MISSION>-<status>.md`

If the filesystem write is unavailable, say so in the chat finish report; do not fail an otherwise complete mission solely because the receipt could not be written.

## Finish report
Return:
1. status: pass / blocking findings / blocked;
2. Agent R, Mission R2;
3. R1 findings resolved/unresolved;
4. any new directly related blocking finding;
5. evidence used;
6. whether the review blocker can be discharged and integration may proceed.
```

## Steering vs continuation

Do not create `A2/B2` for ordinary steering while `A1/B1` remains active. Status questions, compatible clarification, and reprioritization inside the current mission remain part of that mission.

Use `A2/B2` after a mission boundary when a new bounded follow-up should reuse the same session.

For review, use `R2` only after R1 has completed and an implementer repair has created a new reviewable target. Ordinary clarification during R1 remains part of R1.

## Prompt-local operator note

After any prompt, show:

```text
Plan position
Mission: <A1/A2/R1/R2/...>
Session: <new | same Agent A/B/R chat>
Wave/track: <N/review>
Role: <role>
Effort: ~<relative share>%
Can act: <now | after blocker>
Blocks/Unlocks: <integration/wave/mission or none>
```
