# Reflect Mode

Use this mode to examine the immediately preceding work, find deficiencies, verify claims, and improve the result when appropriate.

## 1. Establish the object of reflection

Determine exactly what is being reviewed:

- the previous answer;
- recent repository changes;
- a named file, commit, branch, diff, plan, or artifact;
- the result of a task the user asked to complete and then reflect on.

Recover the original requirements and constraints before judging the result.

## 2. Triage depth

Choose Quick, Standard, or Deep using the rules in `SKILL.md`.

For Standard and Deep reflection, evaluate all of the following.

### Requirement coverage

- Does the result satisfy every explicit requirement?
- Are important implied constraints missing?
- Did implementation drift beyond scope?

### Correctness

- Is the logic sound?
- Are edge cases, failure modes, null/empty/boundary values, concurrency, state transitions, or cleanup relevant?
- Are assumptions supported by the repository or source material?

### Dependency and impact

- What consumes the changed interfaces, files, data, or behavior?
- Would a proposed rename/removal/refactor break callers, docs, migrations, configs, or tests?
- Are there active decisions or plans that constrain the change?

### Claim verification

Verify claims that depend on evidence, especially:

- existing test/build/lint status already available from the task, plus any non-test check actually required to establish the claim;
- performance or complexity;
- library/API/version behavior;
- security properties;
- current external facts;
- counts, metrics, generated artifacts, or repository state.

### Quality and design

For code, assess readability, cohesion, coupling, naming, error handling, testability, and whether the repository's existing patterns were respected.

Avoid reflexively replacing custom code with a dependency. Evaluate established libraries or services when they materially reduce maintenance or risk, but account for project constraints, dependency cost, performance, security, and YAGNI.

For non-code work, assess clarity, completeness, accuracy, audience fit, structure, examples, caveats, and unsupported assertions.

## 3. Generate verification questions

Create a small set of questions that could falsify your own assessment. Examples:

- Which explicit requirement would fail if I am wrong?
- What direct evidence proves the claimed behavior, and is any proposed test/command actually authorized by the task or repository policy?
- What caller or dependent system might I have missed?
- Am I criticizing a repository convention merely because I prefer another style?
- Which factual claim still lacks an authoritative source?

Answer the questions using evidence where possible, then revise the assessment.

## 4. Decide whether refinement is needed

Classify findings by consequence:

- **Critical**: correctness, data loss, security, contract break, or task failure.
- **High**: major requirement gap or substantial maintainability/reliability issue.
- **Medium**: meaningful improvement with bounded impact.
- **Low**: polish or preference.

If no material issue remains, say what was verified and what evidence supports the result. Do not manufacture criticism to justify the reflection step.

If refinement is needed and the user already authorized implementation within the same scope, fix the issue and re-establish only the evidence invalidated by that fix. Do not introduce tests or broader validation unless independently authorized. Otherwise present the finding and recommended action.

## 5. Report shape

Use a compact report scaled to the task:

```markdown
## Reflection

**Depth:** Quick | Standard | Deep
**Verdict:** Pass | Improve | Blocked

### Findings
- [severity] finding, with evidence

### Verification
- command/source -> observed result

### Refinements made
- change and why

### Remaining uncertainty
- anything not proven
```

Omit empty sections. For answer-only work, the refined answer can follow immediately after the reflection summary.
