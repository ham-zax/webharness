# Orchestration State and Progress Formats

## Contents

- Session Ledger
- Handoff Inbox
- Blocker Ledger
- Review Gate state
- Strategic reassessment state
- Frontier transition receipt
- Strategic Reassessment receipt
- Canonical automatic Progress Snapshot
- Review-loop snapshots
- Execution Board escalation
- Effort semantics
- Progress-reporting triggers

Use these formats when an effort has enough moving parts that state can otherwise drift.

## Session Ledger

| Agent | Mission | Status | Role | Workspace | Handoff receipt | Disposition | Reusable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | A1 | COMPLETE | implement | main | `<path/to/A1 receipt>` | REUSE AS A2 | yes |
| G | G1 | ACTIVE | implement | isolated worktree | pending | CONTINUE | not yet |
| R | R1 | ACTIVE | independent review | read-only | pending | CONTINUE | re-review as R2 |

Statuses must reflect known evidence only.


## Handoff Inbox

When sessions share a filesystem, record one repository-level disposable handoff root and one mission subdirectory per delegated mission. Prefer the cache protocol in `handoff-artifacts.md` over repository-resident files for lightweight orchestration.

Track at least:

| Field | Value |
| --- | --- |
| Repository key | `<stable key derived from Git common dir>` |
| Handoff root | `<cache path>` |
| Mission inbox | `<handoff root>/<mission>` |
| Latest receipt | `<timestamped receipt path | pending>` |
| Receipt state | `<current | stale | missing | malformed>` |

A discovered receipt may transition a mission from `UNKNOWN/ACTIVE` to a candidate `COMPLETE/BLOCKED` state, but verify consequential Git/workspace facts before using it to discharge integration/review blockers. If the user asks to `check Agent X`, inspect the assigned inbox first instead of asking for copied chat text.

Reserve Agent R for independent review. Do not reuse R as the implementation owner of findings it discovers.

## Blocker Ledger

| Blocked item | Blocker | Owner | Discharge condition | Status/evidence |
| --- | --- | --- | --- | --- |
| Wave 3 integration | independent review | R1 | R1 reports no blocking findings | ACTIVE |
| Wave 4 | D68/D71 diagnosis | C1 | C1 returns and planner evaluates result | ACTIVE |
| Infra I2 | provenance | H1 | H1 commit integrated | DISCHARGED: `<commit>` |

An unrelated completion never discharges another row.

When review is required, integration must have an explicit review-blocker row.

## Review Gate state

Use review gates on **stable implementation batches**, not automatically after each mission. A healthy default for substantial work is:

```text
A1 COMPLETE
-> A2 READY — SAME SESSION
-> no review yet when A2 is a planned same-area continuation and early feedback would not change direction

A2 COMPLETE
-> review batch A1+A2 is stable
-> R1 READY — NEW SESSION
-> Integration BLOCKED by R1

R1 PASS
-> Integration READY — PLANNER OWNED

R1 BLOCKING FINDINGS
-> group all material in-scope findings from the pass
-> planner-owned tiny fixes OR B1/A3 repair batch as justified
-> R2 BLOCKED by repair batch

Repair batch COMPLETE
-> R2 READY — SAME REVIEWER SESSION

R2 PASS
-> Integration READY — PLANNER OWNED
```

A topology such as `A1 -> A2 -> R1 -> B1 -> R2` is often preferable to `A1 -> R1 -> A2 -> R2 -> A3 -> R3` when the early review boundaries would not change implementation direction.

Do not let Agent R repair the implementation and then approve its own repair. Do not optimize for minimum agent passes by making missions incoherent; optimize for balanced mission size and fewer feedback cycles.

## Strategic reassessment state

For long-running plans, track the deep-review cadence separately from ordinary progress. The default threshold is two material frontier transitions; one major/high-impact transition may trigger immediately.

Lightweight state may be a single line:

```text
Strategic reassessment: 1/2 material transitions since last deep review
```

Durable coordination may track:

| Field | Value |
| --- | --- |
| Last reassessment | `<event/commit/report>` |
| Material transitions since | `0 | 1 | 2` |
| Trigger reason | `<cadence | major event | user request | other>` |
| Last outcome | `<kept DAG | replanned: ...>` |

Reset the transition count after a completed Strategic Reassessment Gate. Status-only/no-op updates do not increment it.

## Frontier transition receipt

After a frontier-invalidating event, report only material changes plus preserved blockers before the automatic snapshot:

```text
Frontier transition
H1 COMPLETE + INTEGRATED
  Discharged: provenance blocker
C1 ACTIVE
  Still blocks: Wave 4
Wave 3 / G1 unchanged
```

For review:

```text
Frontier transition
G1 COMPLETE
Review Gate: independent review required
R1 READY — NEW SESSION
Integration BLOCKED -> R1
```

## Strategic Reassessment receipt

When the cadence or an immediate trigger fires, report the deep-review result before the Progress Snapshot:

```text
Strategic Reassessment
Trigger: 2 material frontier transitions since last deep review
Objective rechecked: ship an autonomous target-mode client, not merely pass search tests
Challenged: runtime configuration fidelity, experiment confounds, DAG ordering, readiness gates
New finding: one target setting is propagated as metadata but behavior remains approximate
Plan impact: add a read-only fidelity audit in parallel; narrow the current experiment claim
Preserved: completed execution and hidden-information repairs remain closed
Next reassessment: after ~2 material frontier transitions or sooner on a major trigger
```

A valid receipt may say `New finding: none` and `Plan impact: keep` when the DAG survives the challenge.

## Canonical automatic Progress Snapshot

Use this **tree-style snapshot as the default UX** for ongoing orchestration. Append it automatically after orchestration actions unless the user explicitly suppresses progress reporting.

```text
Progress Snapshot

Current frontier
├─ Wave 3 / G1 / Agent G
│  CONTINUE
│  Uncommitted Wave 3 implementation exists in its isolated worktree
│
├─ Infra I1 / H1 / Agent H
│  COMPLETE + INTEGRATED
│  main HEAD: 725fb49
│
├─ Infra I2 / H2 / Agent H
│  READY — SAME SESSION
│  Next: paste H2 into the existing Agent H chat
│
└─ Wave 4 / D68
   PLANNED
   Confirmed 96-step failing fixture exists
   Strategy diagnosis remains separate from I2

Planned effort: 55% COMPLETE | 20% ACTIVE | 10% READY | 15% PLANNED

Next human action:
Paste H2 into the existing Agent H chat.
Agent G continues independently.
```

The tree node contract is:

```text
<track/wave> / <mission ID> / <Agent>
<STATUS + execution ownership>
<one-line authoritative state/evidence when useful>
<blocker or next action when relevant>
```

Useful status/ownership labels:

- `CONTINUE`
- `HOLD`
- `ACTIVE`
- `COMPLETE`
- `COMPLETE + INTEGRATED`
- `READY — PLANNER OWNED`
- `READY — SAME SESSION`
- `READY — NEW SESSION`
- `READY — REVIEW`
- `BLOCKED -> <mission>`
- `NEEDS DECISION`
- `PLANNED`
- `CONDITIONAL`
- `CANCELLED`

Same-session reuse must say where to paste the prompt. Fresh sessions must explicitly say to open a new chat.

For long-running plans, include the reassessment cadence line when it is nonzero or due, so the planner does not silently lose the deep-review trigger. Omit it when that state would add no useful information.

Do not permanently carry irrelevant historical completions. Once a completed mission no longer affects current decisions, collapse it into a compact fact such as:

```text
Integrated base: main @ 725fb49
```

## Review-loop snapshots

When a substantial **implementation batch** reaches a stable review boundary:

```text
Progress Snapshot

Current frontier
├─ Wave 3 / G1 / Agent G
│  COMPLETE
│  Substantial implementation ready for independent review
│
├─ Review / R1 / Agent R
│  READY — REVIEW / NEW SESSION
│  Blocks: Wave 3 integration
│  Next: open a new Agent R chat with the R1 prompt
│
└─ Wave 4 / D68
   PLANNED
   Remains separate from the review/integration frontier

Next human action:
Open Agent R with R1.
Do not integrate G1 yet.
```

If R1 finds blockers:

```text
Progress Snapshot

Current frontier
├─ Review / R1 / Agent R
│  COMPLETE — BLOCKING FINDINGS
│
├─ Wave 3 repair / G2 / Agent G
│  READY — SAME SESSION
│  Next: paste G2 into the existing Agent G chat
│
├─ Review / R2 / Agent R
│  BLOCKED -> G2
│  Re-review after the implementer repairs R1 findings
│
└─ Integration
   BLOCKED -> R2 PASS

Next human action:
Paste G2 into the existing Agent G chat.
```

After repair:

```text
Current frontier
├─ Wave 3 repair / G2 / Agent G
│  COMPLETE
│
├─ Review / R2 / Agent R
│  READY — REVIEW / SAME SESSION
│  Next: paste R2 into the existing Agent R chat
│
└─ Integration
   BLOCKED -> R2 PASS
```

## Execution Board escalation

Use the larger Execution Board only for:

- initial multi-wave planning;
- a major replan;
- a materially changed DAG;
- substantial effort rebaselining;
- a user request for the full plan.

Do not repeat the large board after every small transition when the Current frontier tree communicates the state more clearly.

## Effort semantics

Effort percentages represent approximate share of engineering work in the current planning envelope. They are not elapsed time or measured completion.

Track categories when useful:

- COMPLETE;
- ACTIVE;
- READY;
- BLOCKED/PLANNED;
- CONDITIONAL reserve.

A compact line is usually enough:

```text
Planned effort: 55% COMPLETE | 20% ACTIVE | 10% READY | 10% PLANNED | 5% CONDITIONAL
```

Rebaseline when evidence materially changes the plan. Do not modify percentages merely because one task took longer than expected.

## Progress-reporting triggers

Emit or refresh the snapshot after:

- a mission report;
- cherry-pick/merge/integration;
- Review Gate decision;
- R1/R2 result;
- blocker change;
- newly READY work;
- new prompt generation;
- A2/B2/R2 continuation creation;
- mission cancellation/supersession;
- material contract or workspace change;
- planner-owned action affecting readiness;
- a status request during an active plan;
- a Strategic Reassessment Gate result or reset.

Do not fabricate state to fill the snapshot. Use `UNKNOWN` when necessary.
