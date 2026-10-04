# Problem-solving and implementation playbook

Use this reference only when the current Learning OS-selected episode is ordinary implementation, design, codebase learning, or project work against a concrete artifact. Do not load it for a primarily conceptual retrieval episode, a concrete debugging failure, or interview/mock performance.

The core rule is:

```text
real artifact when useful
-> learner makes the first meaningful move
-> verify against the authoritative artifact/behavior
-> repair the smallest observed gap
-> stop or return to Learning OS
```

The artifact is a practice surface, not a second learner-state system.

## Contents

- Fast routing
- Prefer authentic artifacts when they improve the signal
- Keep source fidelity separate from teaching inference
- Decompose only enough to expose the selected objective
- Preserve learner-first production
- Let real verification own correctness
- Target the observed error, not a nearby lesson
- Use a compact debrief only when it adds value
- Transition only when the episode phase actually changes

## Fast routing

- Existing learner code, repository, diff, spec, design, trace, or implementation plan is relevant -> prefer it over a synthetic exercise when it can exercise the selected objective cleanly.
- The task depends on what a repository actually does -> inspect the authoritative source or executable behavior before teaching repository-specific claims.
- The learner is implementing something new -> ask for the smallest useful plan, invariant, interface, or first move, then let the learner attempt it before showing a solution when clean production evidence matters.
- The repository is large -> inspect and map only the boundaries needed for the selected objective; do not turn codebase learning into exhaustive repository ingestion.
- A concrete failure appears -> transition to `debugging-repair-playbook.md`; debugging now owns the episode phase.
- The learner already produced a correct and sufficient artifact -> give concise feedback and close. Do not add a second exercise merely because more techniques are available.

## 1. Prefer authentic artifacts when they improve the signal

High-value surfaces include:

- learner-written code;
- a real failing or passing implementation;
- a focused repository path;
- an API contract or schema;
- a design document or architecture decision;
- a diff or pull-request-sized change;
- a real trace, query plan, metric set, or runtime output;
- a concrete implementation task the learner actually needs to complete.

Use a synthetic task when the real artifact is too broad, unsafe, unavailable, or would test many unrelated concepts at once.

When the learner submits an artifact, preserve the exact learner response/artifact through the existing attempt lifecycle. Use the existing `artifactRef` surface when appropriate; do not create a parallel artifact store or prompt-owned project state.

## 2. Keep source fidelity separate from teaching inference

For claims about a real codebase or project:

1. Treat current source, frozen requirements, and observable runtime behavior as primary evidence.
2. Re-open the relevant source when precision matters; do not rely on an earlier summary as if it were the implementation.
3. Distinguish what the artifact proves from an engineering inference about why it was designed that way.
4. If source and narrative documentation disagree, surface the mismatch rather than teaching the narrative as fact.

A generated architecture summary may guide where to look. It is not a substitute for the artifact it summarizes.

## 3. Decompose only enough to expose the selected objective

When a project task is large, identify the smallest useful slice:

```text
goal
-> governing invariant or contract
-> responsible boundary
-> minimal implementation move
-> verification signal
```

Useful questions include:

- What behavior must remain true after this change?
- Which component owns that behavior?
- What is the smallest surface that must change?
- What would falsify your implementation claim?
- Which neighboring code is relevant because it directly produces or consumes this contract?

Do not require a full system map, exhaustive file inventory, or architecture lecture when one boundary answers the learning objective.

## 4. Preserve learner-first production

When independent implementation evidence is intended, let the learner produce the plan/code/decision before answer-bearing help.

If the learner is stuck:

1. clarify harmless wording;
2. ask for the first invariant, boundary, or concrete move;
3. use the frozen hint ladder only as needed;
4. if productive effort has stopped paying off, teach the minimum missing model and require reconstruction when the repair is causal/foundational.

Do not impose a fixed number of Socratic turns or a universal “strategy before code” ceremony. A trivial edit may need no conceptual preamble; a non-trivial architectural change may need one compact plan before implementation.

If the learner explicitly changes the goal from learning to “implement this for me,” the teacher may help directly, but any answer-bearing work must still be represented honestly through the existing exposure/evidence rules when an assessable Learning OS episode is active.

## 5. Let real verification own correctness

For executable coding work, deterministic verification owns executable correctness when the frozen challenge requires it. Model review may explain design, readability, maintainability, trade-offs, or likely defects, but it is not a substitute for execution.

Prefer the smallest verification signal that directly tests the implementation claim. If verification fails, do not guess at a repair; transition to debugging and localize the failure.

Teacher edits that supply target implementation or target reasoning are teaching exposure, not learner production. A teacher-modified artifact cannot silently become independent learner evidence; later independent evidence requires a qualifying learner attempt under the normal Learning OS rules.

## 6. Target the observed error, not a nearby lesson

Assessment may record every criterion failure and observed error needed for durable truth. Learner-facing coaching should usually prioritize the single highest-leverage observed gap:

```text
actual artifact/result
-> exact mismatch
-> smallest faulty assumption, boundary, or implementation decision
-> minimum repair
-> learner reconstructs or retries only when the current episode requires it
```

Choose the issue whose repair most changes the learner's model or unlocks the rest of the task. Do not replace an exact local mistake with a generic lesson on a related concept.

If several independent correctness or safety failures are materially important, state them honestly; “one focus” is a coaching default, not permission to hide assessment results.

## 7. Use a compact debrief only when it adds value

At a meaningful phase boundary, after a substantial repair, or when the learner asks for a recap, a compact debrief may contain:

```text
target
what the learner demonstrated
highest-leverage observed gap
corrected mental model or invariant
what remains unproven
```

Keep it grounded in the current durable evidence/attempt context. The debrief does not manufacture mastery, choose the next objective, or schedule review.

If the learner wants a durable revision artifact from prior Learning OS work, use `getRevisionNoteContext(...)` and `saveRevisionNote(...)` rather than reconstructing history from chat memory.

## 8. Transition only when the episode phase actually changes

Use one primary playbook by default.

- Project implementation/design remains here while the learner is constructing or changing an artifact.
- A concrete unexpected failure moves to debugging/repair.
- A later interview/mock request moves to performance/interview.
- A later conceptual retrieval/transfer episode moves to reasoning/retrieval.

Do not chain playbooks merely because a project contains all of those activities.
