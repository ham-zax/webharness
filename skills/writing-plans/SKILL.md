---
name: writing-plans
description: Create detailed implementation plans for multi-step software work before editing code. Use when requirements or a specification must become concrete file-level tasks, interfaces, acceptance criteria, risks, rollout, or explicitly required validation. Default to no test creation, test modification, test execution, TDD, regression-test, or coverage work unless the user, authoritative specification, or mandatory repository policy explicitly requires testing.
---

# Writing Plans

Create comprehensive implementation plans that an engineer can execute without hidden context.

Use this Skill for planning, not for implementing the plan unless the user has also asked for execution.

## Planning principles

- Preserve the user's explicit requirements and constraints.
- Inspect the existing repository before inventing file paths, interfaces, or conventions.
- Follow existing repository patterns unless the plan explicitly calls for changing them.
- Prefer DRY, YAGNI, clear seams, and small independently reviewable tasks.
- Keep planning and execution separate when the user asked to plan first.
- Default to no testing work. Do not add test files, test commands, TDD cycles, regression-test tasks, or coverage work merely because the plan changes executable code.

## Test policy

Testing is opt-in for this Skill.

Do not add, modify, or run tests in the plan unless at least one of these is true:

- the user explicitly asks for testing;
- the authoritative specification or accepted plan explicitly requires tests; or
- repository instructions make a specific test command a mandatory completion condition for the requested work.

Do not infer a testing requirement from a bug fix, refactor, public API change, executable behavior, risk level, or the mere existence of a test suite. If testing could be useful but is not required, leave it out of the implementation plan. Mention it only as an optional follow-up when it materially helps the user make a decision.

## Scope check

If the work spans independent subsystems, split the plan into coherent phases or subplans. Each major task should produce an independently observable deliverable.

## File structure first

Before defining tasks, map the files that will be created or modified and state each file's responsibility.

- Give each file a clear responsibility.
- Prefer focused files over large catch-all modules.
- Keep code that changes together close together.
- In an existing codebase, respect established structure unless a restructuring decision is part of the requested work.

## Task sizing

A task is the smallest unit that carries a coherent implementation change and is meaningful to review independently.

For each task, include:

- exact files to create or modify;
- interfaces consumed and produced;
- implementation steps;
- expected result or observable success condition;
- any migration, documentation, compatibility, or rollout work that belongs to that deliverable;
- only the validation command or check that is explicitly required by the user, specification, or repository contract.

Avoid artificial microsteps that add ceremony without reducing implementation risk.

## Plan header

Start plans with:

```markdown
# [Feature Name] Implementation Plan

**Goal:** [One sentence]

**Architecture:** [Two or three sentences]

**Tech Stack:** [Relevant technologies]

## Global Constraints

- [Exact project-wide constraints copied from the request or spec]
```

## Task template

```markdown
### Task N: [Component or deliverable]

**Files:**
- Create: `exact/path`
- Modify: `exact/path:relevant-range`

**Interfaces:**
- Consumes: [existing APIs, types, data, or prior-task outputs]
- Produces: [new APIs, types, data, or behavior later tasks depend on]

**Steps:**
- [ ] Implement the smallest coherent change that satisfies the requirement.
- [ ] Inspect the resulting behavior/artifact against the acceptance criteria.
- [ ] Run only validation explicitly required by the user, authoritative specification, or repository contract.

**Acceptance criteria:**
- [Observable result]
```

Omit the validation step entirely when no validation command or automated check is required.

## No placeholders

Do not write vague steps such as:

- TBD, TODO, implement later, or fill in details;
- add appropriate error handling;
- add validation;
- handle edge cases;
- similar to Task N.

Replace them with the actual behavior, files, interfaces, cases, and commands required to execute the work.

## Self-review

Before presenting the plan, review it yourself without delegating:

1. Spec coverage: every requirement maps to at least one task or is explicitly marked out of scope.
2. Placeholder scan: remove vague or deferred instructions.
3. Type and interface consistency: later tasks use the same names and signatures established earlier.
4. Dependency order: tasks are ordered so prerequisites exist before dependents.
5. Test leakage: remove test creation, modification, execution, TDD, coverage, and regression-test steps unless they are explicitly required under the test policy.
6. Process proportionality: remove setup, validation, or broad commands that do not have a concrete requirement.
7. Risk check: identify migrations, destructive operations, auth/security concerns, public API changes, or rollout hazards.

Fix issues inline before presenting the plan.

## Execution handoff

When the plan is complete, state where it was saved if it was written to the repository. If the user asks to execute it, execute inline in the current session. Do not introduce tests or extra verification checkpoints during execution unless they are explicitly authorized by the test policy. Do not assume sub-agent availability and do not require orchestration.
