---
name: moyu
description: Use when implementing or reviewing engineering work where the agent should stay autonomous inside a bounded mission while avoiding scope creep, speculative abstractions, redundant tests, unnecessary worktrees, excessive setup, or disproportionate verification.
---

# Moyu: Mission-Bounded Simplicity

Optimize for the smallest correct change and the smallest justified process that fully satisfy the mission.

## Core rules

### 1. Own the mission, not the neighborhood

Act autonomously inside the assigned objective. Modify files that are genuinely necessary to complete it, even if the user did not name every file.

Do not absorb adjacent features, opportunistic cleanup, unrelated refactors, or "while I am here" improvements.

### 2. Choose the simplest correct design

Before creating a new layer, ask whether the existing code can express the behavior directly.

Prefer:

- reuse over parallel implementations
- one direct implementation over speculative interface/factory/strategy stacks
- local changes over repository-wide rewrites
- existing dependencies over new dependencies
- existing conventions over a new architecture invented for one task

Simplicity must not weaken correctness, security, meaningful verification, or an explicit contract.

### 3. Ask at boundaries, not at every implementation decision

Make implementation-level decisions yourself when they remain inside the mission and established architecture.

Stop and surface the decision when completing the task would require one of these boundary changes:

- altering a public API or agreed inter-agent contract
- changing persistent data shape or migration strategy beyond the plan
- introducing a new external dependency or service
- changing authentication, authorization, privacy, or security semantics
- redesigning a neighboring subsystem
- editing work explicitly owned by another concurrent mission
- destructive or difficult-to-reverse operations
- materially expanding product scope

Read `references/boundaries.md` for the decision matrix.

## Work loop

1. Read the task/mission and any authoritative plan.
2. Inspect the relevant implementation and search for reusable existing paths.
3. Classify the affected artifact: executable behavior, documentation/content, configuration/metadata, mixed, or read-only.
4. State the effective mission boundary internally: desired outcome, owned surface, contracts to preserve, definition of done.
5. Select the smallest design and smallest justified process that satisfy those constraints.
6. Implement in small coherent increments.
7. Gather the smallest direct evidence required by the mission; defer routine non-test checks to the candidate-final state and do not create, modify, or run tests unless testing is explicitly authorized under Causal Coding.
8. Inspect the diff for drift before claiming completion.

When a connected local repository is available, use its real git diff/status and relevant verification commands rather than relying on memory or pasted snippets.

## Necessary transitive changes are allowed

Do not confuse scope discipline with literal file locking.

A change outside the initially named file is acceptable when it is required to make the requested behavior correct, such as:

- updating a test required by an explicitly authorized testing contract when the behavior change makes that update necessary
- updating an internal call site after a required signature change already authorized by the mission
- changing a nearby type/schema declaration that is part of the same contract
- adding a small migration explicitly implied by an approved data change

Keep these changes tight and report them at the end.

## Reject common over-engineering moves

Do not add these without demonstrated need:

- abstractions for hypothetical second implementations
- configuration for a single stable value
- generic utility layers used once
- defensive checks for states made impossible by the type/system contract
- new packages when standard-library or existing project facilities are enough
- broad formatting/comment/doc rewrites during a functional task
- future-facing extensibility with no current requirement

## Process must earn its cost

Treat workflow machinery the same way as production code: it must have a concrete benefit for this mission.

Do not introduce or perform process overhead merely because a generic workflow template mentions it. This includes:

- creating a worktree when the current checkout is already safe for the coherent effort
- creating one worktree per task instead of per genuinely independent concurrent effort
- reinstalling dependencies when the existing environment is already usable
- running baseline/full-suite tests that do not exercise anything the changed artifact can affect
- creating test infrastructure for documentation or prose
- turning a documentation/configuration change into a broad engineering validation campaign
- creating extra coordination artifacts that no later session will use

Use worktrees when isolation has a real reason: explicit user request, concurrent writable missions, conflicting unrelated changes, material risk/long-lived work, or repository policy.

For documentation/content-only changes, use relevant checks such as docs builds, links, stale references, formatting, publication/export-policy checks, and diff review. Do not invent RED/GREEN cycles or assertions about prose/headings/layout unless that content is itself a machine-enforced contract.

For configuration/metadata, use parser/schema/build/smoke validation only when the changed contract actually needs it or explicit instructions require it. For mixed changes, avoid validation spillover between artifact types.

## Testing follows Causal Coding

Testing is opt-in. Do not create, modify, or run tests merely because the mission changes executable code, fixes a bug, refactors an API, appears risky, or has nearby tests.

Testing is in scope only when the user explicitly requests it, an authoritative user-approved specification requires it, or mandatory repository policy specifically requires a test or test command. When testing is authorized, keep it proportional: reuse existing coverage when sufficient, add only tests that serve the authorized requirement, run the narrowest relevant command, and do not manufacture TDD/RED states or coverage work beyond that scope.

If testing is not authorized, use direct implementation evidence and the smallest relevant non-test candidate-final checks instead. Do not describe omitted optional tests as incomplete required work.

## Drift detection

Use three intervention levels:

### Level 1: Local drift

You notice a small unrelated edit, style cleanup, extra helper, unnecessary check, or redundant process step.

Action: remove it and continue.

### Level 2: Design or process inflation

The implementation or workflow is gaining new abstractions, dependencies, files, worktrees, setup steps, tests, or broad verification that are not clearly required.

Action: stop, re-read the mission, identify the concrete failure/risk each addition protects, and remove anything without a convincing justification.

### Level 3: Boundary breach

The task now requires a public-contract, architecture, ownership, security, destructive, or major scope decision.

Action: stop and present the minimum decision needed from the user/coordinator. Do not silently expand the mission.

## Completion check

Before completion, verify:

- every changed file contributes to the mission or explicitly required validation
- no adjacent feature or cleanup slipped in
- no new abstraction exists without present-day need
- no new dependency was added without authorization
- any new/changed test is independently authorized under the governing testing policy and stays within that authorization
- every worktree/setup/broad validation step is explicitly required or has a concrete non-test contract reason
- documentation/configuration work used artifact-appropriate checks instead of code-oriented ceremony
- the diff is understandable without a tour of unrelated changes
- any necessary transitive changes are called out clearly
