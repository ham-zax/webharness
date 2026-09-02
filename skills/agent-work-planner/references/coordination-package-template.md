# Coordination Package Template

## Contents

- README.md
- Mission files
- Launcher prompts

Use durable coordination only when repository-resident orchestration state materially helps.

## README.md

```markdown
# <Effort> - Session Coordination

**Repository:** <absolute path>
**Source of truth:** <spec/plan>
**Current wave:** <N>
**Coordination mode:** durable

## Progress Snapshot

<Use the canonical Current frontier tree from orchestration-state.md>

## Session Ledger

| Agent | Mission | Status | Role | Workspace | Disposition | Reusable |
| --- | --- | --- | --- | --- | --- | --- |

## Blocker Ledger

| Blocked item | Blocker | Owner | Discharge condition | Status/evidence |
| --- | --- | --- | --- | --- |

## Review Gate

<Record which completed implementation missions require independent review before integration, the R1/R2 mission, and the exact review-blocker discharge condition. State `not required` when review does not earn its overhead.>

## Dependency map

<compact DAG>

## Shared contracts

- <cross-mission contract>

## Workspace policy

<Current checkout or justified isolation topology. Do not create worktrees merely because agents exist.>

## Review / integration policy

<Identify Agent R review requirements, implementer repair ownership, re-review requirements, and who performs bounded integration after review passes.>

## Testing / validation authority

<Record inherited authority only. Planning does not expand it.>

## Execution lifetime

<List missions requiring persistent-agent-loop without duplicating its mechanics.>

## Future / blocked work

- Wave <N> - <purpose> - blocked by <condition> - ~<effort>% - <PLANNED | CONDITIONAL>

## Transition log

- <event> -> <blocker/session/review/frontier state change>
```

Update the README after frontier-invalidating events. Do not rewrite it for trivial elapsed time.

## Mission files

Use one file per materialized mission, not necessarily one per agent:

- `A1-<slug>.md`
- `A2-<slug>.md`
- `B1-<slug>.md`
- `R1-review-<slug>.md`
- `R2-rereview-<slug>.md`

Record:

- Agent/session;
- Mission ID;
- fresh vs same-session continuation;
- role/review independence;
- wave/track and effort;
- workspace;
- dependencies/blockers;
- objective/ownership;
- success conditions;
- testing/validation authority;
- execution lifetime;
- out of scope;
- finish report.

For A2/B2/R2 continuation files, include only the delta from the previous mission plus authoritative current state. Do not restate the entire prior mission unless necessary.

For R1/R2, keep mutation authority read-only by default. Record the integration blocker and review discharge condition explicitly.

## Launcher prompts

For fresh implementation/diagnostic missions:

```text
Open a NEW chat for Agent <X>.
Authoritative mission: <coordination-folder>/<X1-file>
Coordination map: <coordination-folder>/README.md
Read both first and own only Mission <X1>.
```

For same-session continuations:

```text
Paste this into the existing Agent <X> chat. Do not open a new session.
Authoritative continuation mission: <coordination-folder>/<X2-file>
Coordination map: <coordination-folder>/README.md
Read the continuation delta and own only Mission <X2>.
```

For independent review:

```text
Open a NEW chat for Agent R.
Authoritative review mission: <coordination-folder>/<R1-file>
Coordination map: <coordination-folder>/README.md
Review independently and do not implement fixes.
```

For re-review:

```text
Paste this into the existing Agent R chat. Do not open a new reviewer session.
Authoritative re-review mission: <coordination-folder>/<R2-file>
Coordination map: <coordination-folder>/README.md
Re-review the implementer's repair and report whether the integration blocker can be discharged.
```
