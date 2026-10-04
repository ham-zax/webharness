# Strategic Reassessment Gate

Use this gate to prevent a long orchestration from becoming locally consistent but globally wrong. It is an orchestration-level read-only audit, not an independent code review and not an implementation mission.

## Trigger cadence

Use a default budget of two **material frontier transitions** between reassessments. One major transition is enough to trigger immediately.

Material transitions include completed or integrated substantive work, blocking review results, major experiment evidence, target/spec changes, newly discovered cross-cutting dependencies, and entry into a new validation stage.

Do not count pure status checks, elapsed time, repeated progress queries, or no-op confirmations.

Always trigger immediately when:

- the user asks to rethink, reflect, audit, or challenge the plan;
- evidence contradicts a premise that shaped the DAG;
- a product/runtime configuration changes or was previously omitted;
- a review exposes a cross-cutting invariant rather than a local defect;
- an experiment may be confounded or measuring a proxy instead of the intended claim;
- the planner is about to claim engineering readiness, begin risky live validation, or collapse several conditional branches into one.

## Deep-review procedure

1. **Re-read the end objective.** Restate the actual product/engineering outcome and its non-negotiable modes, limits, environments, and claim boundaries.
2. **Reconcile authoritative state.** Verify the relevant source revision, worktree status, generated artifacts, active sessions, returned reports, and current blockers. Use targeted repository inspection when available.
3. **Walk backward from the end state.** Ask what must be true for the final claim, then compare that list with the gates currently represented in the DAG.
4. **Challenge configuration fidelity.** Trace important settings through observation -> normalization -> serialization -> core state -> actual transition/evaluation behavior. Treat "field is present" and "behavior is modeled" as different claims.
5. **Hunt hidden assumptions.** Check defaults, feature flags, player counts, victory targets, modes, limits, client/server authority, hidden information, generated-code freshness, and exact-vs-approximate model boundaries.
6. **Challenge experiment validity.** Ask what the experiment truly measures, what it does not measure, and whether another approximation or changing workload can confound the interpretation.
7. **Separate claim layers.** Keep implementation correctness, model fidelity, experiment validity, operational/browser reliability, engineering readiness, and competitive/outcome strength as separate claims unless evidence genuinely joins them.
8. **Challenge the DAG itself.** Re-evaluate blockers, ordering, conditional branches, parallel-safe read-only work, session reuse, owner selection, and whether a pending mission is still worth doing. Check mission granularity: are agents getting enough coherent work to justify their context, or are missions being split into tiny review-triggering fragments? Explicitly look for small bounded repair/integration steps that are cheaper and safer for the planner to own directly.
9. **Challenge iteration topology.** Distinguish implementation missions from review cycles. Ask whether the next planned same-area mission can complete before review, whether the current candidate is stable enough to review, and whether the plan is drifting into `A1 -> R1 -> A2 -> R2 -> A3 -> R3` ping-pong. Prefer fewer meaningful feedback cycles, not the fewest agent passes.
10. **Challenge review topology.** Ask whether related implementation layers are being reviewed too early or separately. Prefer one batched review at the largest sensible stable boundary, and ask reviewers to surface all material in-scope findings in one pass when feasible. Preserve an earlier gate when architecture, security, public-contract, migration, or other high-cost risk needs feedback before more implementation accumulates.
11. **Challenge handoff friction.** Ask whether the user is manually relaying summaries between sessions despite a shared filesystem. Prefer a disposable file-backed handoff inbox so the planner can discover completion receipts directly, while still verifying repository truth independently.
12. **Challenge validation depth.** Check whether review, replay, shadow/recommend-only, full autonomous/live, or external benchmark stages are missing, premature, duplicated, or ordered incorrectly.
13. **Minimize the replan.** Preserve validated work. Add, remove, narrow, reorder, or condition only what the new evidence justifies.

## High-value questions

Ask these explicitly when relevant:

- Are we optimizing the current DAG instead of the user's actual end goal?
- Did a setting get propagated without actually changing semantics?
- Does a fixture really match the target runtime configuration?
- Is an observed failure a search/allocation defect, a model-fidelity defect, an execution defect, or merely uncertainty?
- Would the proposed repair still be justified if the current experiment result changed?
- Can a low-load read-only investigation run in parallel without contaminating timing or GPU evidence?
- Are implementation missions so small that the reviewer is being invoked before a useful stable candidate exists?
- Can the same implementer complete the next planned same-area mission before review without materially increasing risk?
- Are we optimizing for minimum agent passes instead of balanced mission size and fewer feedback cycles?
- Are we creating an agent handoff for a tiny bounded repair or integration step the planner could prove and execute directly?
- Are we reviewing a partial implementation layer that could safely wait and be batched with the complete stable candidate?
- Is the reviewer being asked to stop after the first blocker instead of surfacing all material in-scope findings that are already observable?
- Is the user copying an agent's finish report between chats when the planner could discover a shared handoff receipt instead?
- Would delaying review hide a high-cost architecture/security/public-contract mistake? If not, batch it.
- Are we about to call something "ready" that has only passed an implementation test, not its live or outcome gate?

## Composition

For connected WSL/Linux repositories, compose with `mcp-harness-router` for authoritative read-only inspection. Use only the smallest targeted commands needed to test the current assumptions.

When `reflexion` is available and the reassessment is high-impact, use it near the end to challenge the planner's conclusions. Reflexion does not replace repository evidence.

Do not turn this gate itself into an implementation session. If it discovers implementation-affecting work, finish the read-only reassessment first, then choose the cheapest correct owner: planner-owned for a small bounded repair, same-session continuation when implementation context materially helps, or a fresh mission only when separation earns its cost. Preserve independent Agent R review where required.

## Strategic Reassessment receipt

Return a compact receipt before the normal Progress Snapshot:

```text
Strategic Reassessment
Trigger: <two material transitions | major event | user-requested reflection | other>
Objective rechecked: <one-line end goal>
Challenged: <important assumptions/configuration/experiment/DAG boundaries>
New finding: <none | concise evidence-backed finding>
Plan impact: <keep | narrow | reorder | add gate | add conditional mission | cancel/supersede>
Preserved: <validated areas intentionally not reopened>
Next reassessment: after ~2 material frontier transitions, or sooner on a major trigger
```

If the plan remains unchanged, say so explicitly and identify the strongest assumptions that were revalidated.
