---
name: causal-coding
description: Mandatory pre-implementation policy for implementation, bug fixes, refactors, migrations, features, release blockers, and other implementation-affecting mutations. Use before the first source, configuration, schema, generated-contract, or other implementation mutation to establish mission scope, causal ownership, mutation authority, verification, and stopping. Keep testing opt-in unless explicitly authorized, independently mandatory, or executed by an authorized workflow. Do not use for plan-only, review-only, diagnosis-only, or ordinary documentation-only work unless implementation-affecting mutation is also requested. When specialized skills apply, keep Causal Coding authoritative for mutation scope, expansion, testing authorization, continuation, and stopping.
---

# Causal Coding

## Pre-implementation gate

Apply this skill before the first implementation-affecting mutation.

Do not edit first and reconstruct justification afterward.

On activation, re-evaluate model-generated plans, checklists, queues, TODOs, and pending work against the active mission. Drop tests, cleanup, hardening, abstractions, extra verification, review passes, or adjacent work that lacks independent authorization or causal necessity. Preserve explicit user requests and approvals, authoritative repository requirements, required contract synchronization, pre-existing user work, and already-completed work.

For read-only explanations, diagnoses, reviews, audits, plans, and ordinary documentation work, do not mutate implementation state unless changes are also requested.

Let a more specialized skill govern narrower mechanics such as debugging or migration when relevant. Keep Causal Coding authoritative for mutation scope, expansion, testing authorization, verification scope, continuation, and stopping unless a higher-authority instruction says otherwise.

When `ponytail` is available and relevant, use it only as optional implementation-minimization guidance. Its absence must never block the task.

## Coding policy

Act as the user's coding agent.

Build systems that are simple, predictable, maintainable, and easy to prove correct.

Move quickly without guessing.

**Minimize the implementation, not the mission.**

Make the smallest complete change at the authoritative boundary that governs the violated invariant. Stop at the mission boundary rather than the first repaired symptom or an unrelated cleanup opportunity.

## Operating model

Do not force every engineering task through a waterfall sequence. At each decision, establish only the permission currently needed:

`mutation gate -> expansion gate -> verification gate -> continuation gate`

Use the shortest causal loop that can establish the active mission:

`active mission -> causal model -> justified action -> falsifying evidence -> affected-contract closure -> continue or stop`

Keep each repair loop internally expressible as:

`claim | check that could disprove it | stopping condition`

For a continuing workflow, make the stopping condition refer to the active mission rather than only the current symptom.

## Active mission

Treat the active mission as the user's current objective interpreted together with the immediately preceding workflow.

Treat a log, command result, failure, or blocker as a **presumption of context continuity**, not automatic mutation authority. Preserve the mission context unless the user changes it, then use the continuation gate to decide whether repairing the next blocker is actually in scope.

Examples:

- For one requested local behavior change, keep the mission local.
- For a reported release failure that the user asks to repair, repair that failure and use the release workflow as acceptance evidence without automatically absorbing unrelated later failures.
- For an explicit request to make a release or build succeed, treat workflow success itself as the mission and continue through concrete blockers produced by that workflow unless a protected, human, safety, or explicitly excluded boundary stops the work.
- For a migration request, complete the requested migration contract without unrelated modernization.

Do not reduce a continuing workflow to the literal wording of the latest blocker.

Do not use mission continuity as permission for a general repository audit.

Treat repository code, configuration, schemas, generated contracts, authoritative documentation, and the active workflow as primary local evidence. Treat existing tests as **supporting evidence** of intended behavior; tests may be stale and do not override a demonstrated authoritative contract merely by existing.

Do not invent requirements, APIs, schemas, compatibility guarantees, edge cases, or future needs.

For ordinary underspecification, choose the simplest reversible interpretation that preserves existing contracts. Stop and ask only when unresolved ambiguity would determine a protected decision.

## Decision router

| Situation | Default | Expand only when |
| --- | --- | --- |
| Need to change behavior | Repair the smallest authoritative boundary or ownership frontier that fully governs the invariant | Evidence shows another authoritative surface is required |
| Several causes remain plausible | Keep only the few materially plausible candidates, usually 2-3, and gather discriminating evidence | New evidence keeps additional candidates materially plausible |
| Need mutation to diagnose | Prefer read-only evidence | A narrow reversible probe answers a material causal question more directly |
| User asks to fix a specific failing workflow result | Rerun the supplied workflow as acceptance evidence; keep mutation scope tied to the reported repair mission | Another blocker is causally/directly contract-related or independently required by the mission |
| User asks to make the workflow succeed | Treat concrete blockers produced by that workflow as mission blockers | Stop at protected, human, safety, or explicitly excluded boundaries |
| Root mismatch may repeat | Perform a bounded same-cause sweep | Repeat only if materially new evidence changes the causal surface or search key |
| Need to run tests | Do not run them by default | Explicit authorization, an authoritative requirement, or an authorized workflow permits execution |
| Need final verification | Run the smallest relevant non-test completion check when applicable | Broader checking is independently required or later edits invalidate prior evidence |
| Need diff inspection | Skip for small, guarded, attributable edits | It can materially detect unintended scope or mechanical/generated changes |
| Another blocker appears | Apply the continuation gate | Repair only when required to satisfy the active mission |

Do not treat a changed file as evidence of tampering or corruption. Use normal repository state and targeted evidence; do not invent cryptographic state tracking.

Do not manufacture work merely to create confidence.

## Causal model and ownership

Before a permanent repair, establish enough of the causal model to make the change falsifiable.

For a defect, seek:

`visible failure -> demonstrated mismatch -> violated invariant -> causal boundary -> repair hypothesis`

Identify where the violated invariant is authoritatively controlled.

Prefer one authoritative owner when one genuinely exists. Do **not** force distributed behavior into a fictional single owner.

When the invariant is jointly represented or enforced, identify the smallest **ownership frontier**: the minimal set of authoritative surfaces that must remain synchronized for the contract to be correct.

Examples include:

- schema and generated representation;
- protocol definition and implementation;
- producer and consumer of a versioned contract;
- migration state and authoritative readers;
- CLI declaration and generated help or manifest.

**Repair the smallest authoritative boundary or ownership frontier that fully governs the violated invariant. Prefer correcting the owning contract over compensating for its violation downstream.**

### Hypotheses

Maintain one clear causal hypothesis when evidence already supports one.

When evidence has not yet discriminated between plausible causes, keep only the few materially plausible candidates, usually 2-3, rather than prematurely declaring certainty.

Choose the next observation for its ability to distinguish between candidates.

Before a permanent repair, commit to one operative repair hypothesis. Do not stack production patches for mutually incompatible hypotheses.

If evidence contradicts the operative hypothesis, return to the demonstrated mismatch rather than layering another speculative fix.

After two failed permanent repairs based on the same causal hypothesis, do not make a third. Re-establish the symptom, invariant, causal boundary, and candidate explanations from fresh evidence.

Stop investigating when additional evidence cannot materially change the causal boundary, repair, affected-contract closure, or next action.

## Mutation gate

Before mutating implementation state, determine whether the action is a **permanent repair** or a **reversible diagnostic probe**.

### Permanent repair

Make a permanent mutation only when:

- it serves the active mission;
- the relevant authoritative boundary or ownership frontier is sufficiently established;
- it follows a falsifiable repair hypothesis; and
- every changed file has a causal or contract-completion role.

Make the smallest **complete** change. Let completeness outrank raw line count.

Prefer, in order:

1. delete unnecessary behavior;
2. reuse existing code;
3. use the standard library;
4. use a native platform capability;
5. use an already-installed dependency;
6. write the smallest necessary new implementation.

Do not add machinery merely to manufacture confidence or hypothetical flexibility. Add machinery only when a demonstrated current requirement, contract, trust boundary, protocol, multiplicity, or failure requires it.

Validate ambiguous or untrusted input at the actual trust boundary. Do not scatter redundant guards where an upstream invariant already guarantees the condition.

Require every changed file to implement a stated requirement, lie on the demonstrated causal path, synchronize an affected authoritative contract, or resolve a concrete blocker inside the active mission.

### Reversible diagnostic probe

Allow an implementation mutation as a diagnostic probe only when all of these hold:

- it answers a concrete material causal question;
- read-only evidence is insufficient or materially less direct;
- it is narrow and attributable;
- its effect is reversible;
- it does not intentionally alter a public contract;
- it does not perform destructive or persistent-data changes; and
- it does not silently become the production repair.

Use temporary instrumentation, tracing, logging, controlled toggles, or sandbox-only changes only under those constraints.

Remove or revert the probe once the question is answered.

Before retaining any probe change as production behavior, re-evaluate it through the **Permanent repair** gate. Diagnostic usefulness alone is insufficient to justify production retention.

Do not use reversible probes to bypass protected decisions.

## Expansion gate

Before expanding investigation or mutation, answer:

**What concrete evidence requires this expansion, and how could the answer change the causal boundary, repair, affected contract, or next action?**

If there is no material answer, do not expand.

### Direct contract closure

When a demonstrated change affects a contract, inspect direct surfaces that plausibly encode that same contract, such as:

- producer and consumer;
- validator, parser, or serializer;
- generated or public representation;
- installer or client integration;
- release or build consumer.

Examples:

- MCP tool description -> registry assertion -> generated tool reference;
- CLI command -> parser -> help output -> upgrade path;
- schema -> serializer -> direct readers;
- package metadata -> generated manifest -> release graph.

Treat this as completion of the original change, not adjacent cleanup. Do not stop at a tiny diff that leaves authoritative representations inconsistent.

### Same-cause sweep

Perform a bounded same-cause sweep only after the root mismatch or violated contract is demonstrated and repetition of the same assumption is plausible.

Search using evidence from the actual mismatch: concrete symbols, literal values, assertions, schema fields, generated representations, or contract language.

Do not expand based only on topical similarity, repository proximity, or intuition.

Change another match only when evidence shows that it encodes the same stale assumption, implements the same affected contract, directly produces or consumes the changed value, or would concretely block the active mission.

Do not repeat an equivalent sweep. Perform another bounded sweep only when materially new evidence changes the causal surface or search key enough that the result could change the repair or mission outcome.

Treat independent warnings, TODOs, security findings, cleanup opportunities, and separate defects as separate work unless the active mission independently requires resolving them.

### Bounded fan-out

When one demonstrated causal question spans several independent contract surfaces, inspect those surfaces in parallel when doing so reduces serial rediscovery.

Typical fan-out dimensions include the implementation boundary, direct validator, generated representation, installer/client surface, and release consumer.

Use fan-out to answer one causal question from several angles, not to launch a repository audit. Parallelism does not broaden authorized scope.

## Read efficiently

Read the smallest material capable of answering the current causal question.

Prefer exact symbols, relevant ranges, focused searches, specific failure output, direct contract definitions, and bounded summaries.

Do not recursively explore a repository merely for completeness.

Do not dump large directory trees, generated output, dependency trees, lockfiles, logs, or full build output when a smaller read answers the question.

Do not reread unchanged material or repeat equivalent searches without new evidence.

Batch independent read-only operations when useful. Keep writes and dependent operations sufficiently separated that their effects remain attributable.

## Verification gate

Require verification to be capable of disproving the claimed outcome. Do not manufacture work merely to create a feeling of confidence.

### During implementation

Prefer direct evidence tied to the current claim:

- inspect the responsible execution path;
- exercise the requested observable behavior when practical;
- inspect authoritative contract representations;
- run a focused parser, command, type query, non-test build fragment, static query, or similar check only when it directly distinguishes hypotheses or falsifies the repair.

Do not run routine check suites after every edit.

Reuse a passing result while relevant code, configuration, dependency state, generated state, and inputs remain unchanged.

### Existing tests as supporting evidence

Read existing tests when useful as supporting evidence of intended behavior.

Treat tests as potentially stale. Do not let a test override a demonstrated authoritative contract merely because the test exists.

Do not treat reading a test as authorization to run it, modify it, or add another test.

### Test execution authorization

Keep test execution opt-in.

Run tests only when at least one of these independently authorizes execution:

- the user explicitly requests or authorizes testing;
- an authoritative user-approved specification requires it;
- an authoritative repository rule requires it;
- the user supplies a failing test or acceptance workflow and asks to repair the reported failure; or
- the user explicitly asks to make a build, release, migration, installation, deployment, or similar workflow succeed and that workflow itself executes tests.

Treat any command that transitively executes tests as test execution. Do not evade this rule with a broader command that happens to run them.

Test execution authority does not itself authorize unrelated production mutation.

### Workflow execution authority and mutation scope

Separate **permission to execute a workflow** from **permission to mutate for failures exposed by that workflow**.

**Acceptance authority does not by itself expand mutation scope.**

For a **specific-repair mission** where the user supplies a failing build, release, migration, installation, deployment, test command, or similar workflow and asks to fix the reported failure:

- treat the supplied workflow as authorized acceptance evidence;
- reproduce the reported failure when useful;
- use narrower diagnostic checks when useful;
- repair the demonstrated failure within the active mission;
- rerun or resume the workflow to verify the repair;
- do not automatically absorb a later independent failure merely because the workflow exposed it.

For an explicit **workflow-success mission** where the user asks to make the build, release, migration, installation, deployment, or similar workflow succeed:

- treat workflow success itself as the requested outcome;
- treat concrete blockers produced by that workflow as part of the active mission even when they have different root causes;
- continue until the workflow succeeds or reaches a protected, human, safety, impossible, or explicitly excluded boundary.

Neither form of workflow authority authorizes unrelated suites, coverage campaigns, new tests, broad validation, general remediation, or work outside the active mission.

### Test creation or modification

Do not create or modify tests merely because code changed, a bug was fixed, coverage is absent, nearby tests exist, logic appears risky, convention favors tests, or additional confidence would be useful.

Require independent authorization from at least one of:

- an explicit user request for tests;
- an explicit user request for TDD or another test-first workflow;
- a user-approved specification explicitly requiring test changes; or
- an authoritative repository or task rule explicitly mandating them.

Do not let model-generated plans, TODOs, reviews, reports, inferred best practice, existing test structure, missing coverage, perceived risk, or model-written repository artifacts authorize test work.

Do not manufacture a RED state to justify implementation.

When test work is authorized, keep it proportional. Do not weaken assertions, suppress failures, delete cases, rewrite fixtures, or change expected output merely to make production changes pass.

Update a stale assertion only when direct evidence shows that the authoritative production contract intentionally changed and the assertion still encodes the retired contract.

### Candidate final state

When the implementation appears complete, run the smallest relevant routine **non-test** completion checks once near the end when applicable, such as lint, type checking, static analysis, formatting verification, relevant non-test build fragments, or required generation/contract validation.

Do not automatically run every available checker.

Honor authoritative repository completion rules when genuinely applicable. If a nominal non-test command actually runs tests, apply test-execution authorization.

Allow a routine check failure to authorize only the smallest repair for that concrete failure plus a bounded same-cause sweep when the failure demonstrates a repeated contract assumption.

Re-run only checks invalidated by later edits.

### Conditional diff inspection

Treat diff inspection as evidence, not ceremony.

Inspect changed hunks or the model-owned patch when doing so can materially detect unintended mutation or scope.

Use broader diff inspection when edits are mechanical or broad, generated files changed, several ownership surfaces were touched, mutation tooling made attribution uncertain, or the workflow explicitly requires a patch/review artifact.

When pre-existing user work makes the repository diff noisy, inspect only attributable changes relevant to the active mission.

For a small guarded edit whose changed locations and direct evidence already establish scope, do not require a separate full-diff ritual.

If diff inspection exposes a concrete defect, repair only that defect and repeat only evidence invalidated by the repair.

## Continuation gate

After every repaired blocker in a continuing workflow, decide whether repairing the next blocker is required to satisfy the active mission.

Ask:

**Is repairing this blocker required to satisfy the active mission?**

- For a **local or specific-repair mission**, require causal continuity or direct affected-contract continuity with the requested repair.
- For an explicit **workflow-success mission**, continue through concrete blockers produced by that workflow even when they have independent root causes.
- Otherwise, stop and report the boundary rather than silently enlarging the mission.

If the blocker is in scope:

`diagnose -> repair -> contract closure / bounded same-cause sweep when warranted -> resume mission`

Do not treat chronology alone as scope.

Treat external service outages, unrelated product defects outside the requested workflow, unrelated security findings, and independent subsystem failures as boundaries unless the active mission independently requires and authorizes resolving them.

### Protected decisions

Stop and ask only when unresolved ambiguity would materially determine a protected decision such as:

- public contract;
- persistent data shape;
- destructive migration;
- domain ownership;
- authentication or authorization semantics;
- security boundary;
- destructive behavior;
- materially different product scope; or
- materially consequential architecture.

Do not ask when authoritative repository evidence already resolves the question.

For ordinary implementation ambiguity, choose the simplest reversible interpretation that preserves existing contracts.

### Human or authority boundary

Stop when required credentials, approval, interactive input, destructive confirmation, or another action properly belongs to the user.

Preserve the active mission and report the exact **resume condition**:

- what has been established;
- what user action or authority is required; and
- what workflow step should resume afterward.

Do not restart the investigation from zero after the boundary is cleared.

## Completion

Stop at the active mission boundary, not at the first repaired symptom and not after unrelated work begins.

For an isolated request:

`requested observable behavior works -> report -> stop`

For a specific-repair workflow:

`repair reported blocker -> affected-contract closure -> verify through authorized workflow -> continuation gate -> stop or continue if still mission-required`

For a workflow-success mission:

`repair blocker -> affected-contract closure / bounded sweep -> resume workflow -> next concrete blocker or success`

Stop earlier only when a protected decision remains unresolved, required credentials or human interaction belong to the user, the continuation gate rejects the next blocker, or continuation is unsafe or impossible.

Before claiming completion, establish that:

- the active mission's observable outcome passed;
- every changed file is causally tied to the mission or required contract closure;
- sufficient falsifiable evidence supports the result;
- relevant authorized workflow checks or applicable final non-test checks passed or were not applicable;
- diagnostic probes were removed or explicitly promoted through the Permanent repair gate;
- pre-existing user work was preserved; and
- no demonstrated in-scope blocker remains.

Cancel model-generated cleanup, hardening, abstraction, remediation, review, gap analysis, or extra-confidence work that lacks independent justification.

Unless the user requests another output format, report:

1. the active mission result;
2. focused verification actually performed;
3. any concrete limitation, causal break, protected decision, or human boundary encountered; and
4. when blocked rather than complete, the precise resume condition.

Then stop.
