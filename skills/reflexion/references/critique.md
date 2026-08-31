# Critique Mode

Use this mode for a report-only, multi-perspective review of completed work. The goal is a balanced, evidence-backed assessment rather than automatic modification.

## 1. Gather scope

Capture:

- original request/specification;
- work completed and relevant diff/artifacts;
- repository constraints and conventions;
- verification already run;
- known assumptions or tradeoffs.

If the scope is materially ambiguous, ask what should be reviewed.

## 2. Independent perspective passes

Perform three passes. If no subagent primitive exists, run them sequentially and write down each pass before reading across them.

### Pass A: Requirements Validator

Judge whether the result does what was requested.

Check:

- requirement-by-requirement coverage;
- missing behavior and edge cases;
- scope creep or accidental behavior changes;
- acceptance criteria and user-visible outcomes.

Return a score only if useful. Evidence matters more than the number.

### Pass B: Solution Architect

Judge the technical approach in the context of this repository.

Check:

- fit with existing architecture and seams;
- coupling and responsibility boundaries;
- compatibility and migration concerns;
- plausible alternative approaches and their tradeoffs;
- scalability/maintainability only where relevant to actual requirements.

Do not label something an anti-pattern merely because another architecture is fashionable.

### Pass C: Code or Output Quality Reviewer

Judge implementation/output quality.

For code, inspect readability, complexity, duplication, naming, error paths, tests, observability, and likely maintenance hazards.

For non-code work, inspect correctness, clarity, organization, source quality, and usability.

Cite concrete evidence. Avoid speculative defects.

## 3. Self-verification for each pass

Before finalizing each pass, ask 2-5 questions that challenge that pass's assumptions. Resolve them with code, tests, docs, or other evidence where available.

## 4. Cross-review and consensus

After all three passes:

- identify findings supported by multiple perspectives;
- identify disagreements;
- determine whether disagreement comes from different goals, missing evidence, or legitimate tradeoffs;
- resolve what the evidence supports;
- explicitly mark reasonable unresolved disagreement instead of forcing consensus.

## 5. Report

Use a structure like:

```markdown
# Critique Report

## Executive summary
Overall assessment and release/acceptance recommendation.

## Perspective summaries
| Perspective | Assessment | Key finding |
| --- | --- | --- |
| Requirements | ... | ... |
| Architecture | ... | ... |
| Quality | ... | ... |

## Strengths
- evidence-backed strength

## Issues
### Critical
- issue, evidence, impact, recommendation

### High
- ...

### Medium / Low
- ...

## Requirements alignment
- requirement -> met / partial / missed -> evidence

## Architecture assessment
- chosen approach, tradeoffs, alternatives worth considering

## Quality/refactoring opportunities
- prioritized, concrete, scoped recommendations

## Consensus and disagreements
- agreements
- disagreements and resolution/confidence

## Recommended next actions
- Must do
- Should do
- Could do

## Verdict
Ready | Needs improvement | Significant rework
```

Scale the report to the work. Small reviews should not become a huge template.

## Report-only guardrail

Do not modify code, files, branches, issues, or external systems in Critique mode unless the user explicitly converts the request into an implementation/fix task.
