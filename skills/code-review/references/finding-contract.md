# Finding Contract

Use this contract to decide whether a review observation deserves to become a finding.

## The seven gates

A candidate finding survives only when the relevant gates are satisfied.

1. **Change linkage** — the reviewed change introduces the issue, worsens it, or exposes a previously unreachable dangerous defect. Ordinary pre-existing debt is out of scope.
2. **Concrete failure** — name an observable wrong result: incorrect output/state, crash, data loss/corruption, authorization failure, compatibility break, deployment failure, meaningful reliability degradation, or maintainability regression that materially raises future change risk.
3. **Reachability** — state the input, state, ordering, caller, environment, or workload required to hit the failure. "Could happen" is not enough.
4. **Impact** — identify who/what is affected and how badly. Separate inconvenience/retry from silent wrong results, corruption, exposure, or unrecoverable breakage.
5. **Evidence** — cite the exact changed location plus the surrounding code/test/config evidence that establishes the causal chain. Claims about other files require reading/searching those files.
6. **Project fit** — check local standards and established patterns. Do not convert generic taste into a finding when the repository intentionally follows another safe convention.
7. **Actionability** — identify a plausible minimal fix direction or the missing verification that would resolve the issue. A finding need not contain a patch.

A Blocker or Major must satisfy all seven. Minor maintainability findings may have a softer observable-failure gate, but must still be change-linked, evidenced, project-aware, and actionable. Missing optional test coverage is not a finding by itself; tests matter when the change makes existing tests misleading/broken or when testing is independently required by the user, an authoritative user-approved specification, or mandatory repository policy.

## Severity

### Blocker

Use only when the change should not merge because the demonstrated impact is severe and credible, such as:

- exploitable authorization/authentication or secret exposure;
- cross-tenant/cross-user data access;
- data loss, corruption, unrecoverable migration damage;
- deterministic crash/outage on a normal supported path;
- breaking an existing public/compatibility contract with real callers/users;
- a build/CI/deployment failure that prevents shipping;
- a concurrency/memory-safety defect with a demonstrated harmful interleaving/lifetime.

Do not use Blocker for a recoverable error where the realistic worst case is a visible failure and safe retry.

### Major

Use when the change introduces a realistic correctness, reliability, compatibility, security, or operational defect that should be fixed before merge but is not catastrophic:

- wrong behavior for a credible input/state;
- missing error handling that loses or misreports an operation;
- race/async ordering bug with a realistic trigger;
- migration/query/index problem with material production impact;
- a new architectural dependency/coupling that concretely makes the changed behavior unsafe or very difficult to evolve;
- a material performance regression on a demonstrated or obviously unbounded hot path.

### Minor

Use for real, directly introduced issues that do not justify blocking merge on their own:

- local maintainability/readability problem not handled by automated tooling;
- avoidable duplicate/helper/wrapper that adds measurable cognitive cost;
- small docs/config mismatch;
- modest performance waste with low impact.

Suppress pure formatting and subjective style nits by default.

### Question

Use a question when an uncertainty is material but you cannot verify the premise from available code/docs/runtime evidence.

Examples:

- an external contract may differ but its schema/version is unavailable;
- a production-only path cannot be exercised and local evidence is ambiguous;
- expected behavior is missing from every available spec/test.

Questions do not affect the verdict. State exactly what evidence would answer them.

### Advisory / YAGNI

Use for optional simplification that is not a correctness failure.

A YAGNI advisory should satisfy both:

1. **No present evidence of need** — no current caller, requirement, measured workload, rollout plan, compatibility need, or existing project convention requires the extra mechanism.
2. **A strictly simpler form exists** — removing a flag/layer/wrapper/config hook/indirection would satisfy the current requirement with less conceptual surface.

Examples worth checking:

- new interface/base class with one implementation and no near-term second use;
- feature/config flag nobody sets and no rollout/expiry plan;
- wrapper that only delegates;
- new helper duplicating a canonical helper;
- defensive branch at a trusted internal boundary with no reachable invalid caller;
- observability or scaling machinery for a workload not yet present.

Never mix YAGNI with Blocker/Major/Minor. State what concrete future condition would justify the extra mechanism.

## Refutation protocol

For each candidate, actively search for evidence that defeats it:

- a caller guarantees the allegedly missing precondition;
- a schema/type/DB constraint makes the bad state impossible;
- a test proves the relevant behavior through the real entry path;
- a feature flag/config makes the path unreachable;
- an existing compatibility shim preserves callers;
- the suspicious code is unchanged/pre-existing;
- the project standard intentionally prescribes the pattern;
- the operation is idempotent, so a retry/replay concern is benign;
- the claimed performance path is cold/bounded by an invariant;
- a proposed simplification would violate a real contract.

Reconcile as follows:

- **Confirmed:** keep current severity.
- **Impact smaller than claimed:** demote.
- **Premise uncertain:** convert to Question.
- **Real but optional simplification:** convert to Advisory.
- **Concrete counter-evidence disproves causal chain:** drop.

Do not drop a candidate merely because another interpretation is imaginable. Find actual counter-evidence.

## Common false-positive traps

Drop or demote findings based only on:

- hypothetical future scale with no current workload evidence;
- "best practice" unsupported by project constraints;
- unchanged legacy code adjacent to the diff;
- style already decided by formatter/linter;
- a diff hunk start line mistaken for the changed line;
- assuming a helper is unused without searching references;
- assuming a public API has callers without finding them or a documented compatibility promise;
- treating defensive handling as mandatory when the type/schema makes the state impossible;
- treating idempotent retry/replay as data corruption;
- claiming a performance regression without benchmark/workload evidence when complexity is unchanged and bounded;
- requiring abstraction merely because two snippets look similar;
- insisting on a new test that only asserts implementation details rather than behavior.

## Security boundary

During ordinary code review, flag obvious and evidenced security defects such as authorization bypasses, injection, secret exposure, unsafe external-input handling, or cross-tenant access.

When the user's primary request is an AppSec/security audit, exploit verification, threat model, vulnerability investigation, or security-focused diff review, hand the primary workflow to ChatGPTlium rather than expanding this general review into a full security assessment.