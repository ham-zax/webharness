---
name: reflexion
description: Self-refinement, multi-perspective critique, verification, and durable lesson curation adapted from NeoLabHQ Reflexion. Use when the user asks to reflect, self-review, critique, double-check, verify and improve prior work, run a rigorous review, memorize lessons, or says "then reflect" after a coding, analysis, or writing task. Supports repository-aware evidence gathering and works without subagents or Claude hooks.
---

# Reflexion

Use this skill as a quality loop around completed or nearly completed work. Preserve the upstream Reflexion intent: generate, reflect or critique, refine when appropriate, and optionally curate durable lessons.

This ChatGPT adaptation combines the upstream `reflect`, `critique`, and `memorize` skills into one installable skill. It does not require Claude hooks or subagent dispatch.

## Select the mode

Choose the mode from the user's wording:

- **Reflect**: "reflect", "review your answer", "double-check", "improve this", "verify your work", or "then reflect". Read `references/reflect.md`.
- **Critique**: "critique", "multi-perspective review", "judge this", "review this implementation", or a request for a report-only assessment. Read `references/critique.md`.
- **Memorize**: "memorize", "remember this in the repo", "save the lesson", "update agent instructions", or a request to turn findings into durable project guidance. Read `references/memorize.md`.

If the request says to do a task **and then reflect**, complete the requested task first, then run Reflect before presenting the final completion claim.

## Evidence first

Ground reflection in observable evidence rather than recollection.

For repository work:

1. Identify the repository root, current branch/worktree, relevant requirements, and changed files.
2. Read project instructions such as `AGENTS.md`, `CLAUDE.md`, accepted specs/plans/ADRs, and relevant existing tests when they clarify intent.
3. Gather the smallest direct evidence needed for the claim. Run non-test checks only when they materially establish the claim; do not create, modify, or run tests unless the user, authoritative specification, or mandatory repository policy explicitly authorizes testing.
4. Check dependencies and blast radius before recommending removal, renaming, or public-interface changes.
5. Verify current external facts with authoritative sources when the conclusion depends on them.

In Hamza's ChatGPT Web environment, use `wsl-web-harness` for authoritative local repository, Git, filesystem, process, and permitted verification operations when available. Do not claim local verification if the connector is absent.

Reflection does not expand implementation or testing scope. If the original task did not authorize tests, a Reflect/Critique pass may inspect existing test code/results but must not run or add tests merely to increase confidence.

## Reflection depth

Triage before spending effort:

- **Quick**: simple edit, small explanation, documentation change, straightforward local bug. Run a concise requirement/correctness/evidence check.
- **Standard**: multi-file feature, nontrivial bug fix, architecture choice, or meaningful analysis. Run the full reflection checklist and targeted evidence gathering within the task's existing validation authorization.
- **Deep**: security, core-system behavior, concurrency, public API/contracts, data integrity, performance-sensitive work, or high-consequence changes. Require stronger evidence and explicit dependency analysis; broader checks still require an actual task/repository requirement and do not imply testing authorization.

Do not inflate a small task into a long ceremony. Do not use a quick pass for high-risk work.

## Refinement policy

Reflection may discover issues. Handle them according to the user's request and action risk:

- For answer-only work, revise the answer directly when the correction is clear.
- For local code changes the user already asked to implement, fix verified issues that remain inside the agreed scope, then re-establish only the evidence invalidated by that fix. Do not introduce tests unless independently authorized.
- For destructive, scope-expanding, architectural, externally consequential, or ambiguous changes, report the finding and obtain direction before acting.
- Critique mode is report-only unless the user explicitly asks for fixes.

## Multi-perspective review without subagents

The upstream critique workflow uses independent judge agents. This adaptation must work even when no subagent primitive exists.

When subagents are unavailable, perform independent passes sequentially:

1. Requirements and behavior alignment.
2. Architecture and solution quality.
3. Code/output quality and maintainability.

Record each pass before cross-synthesizing so later perspectives do not erase earlier findings. Then identify agreements, conflicts, and confidence level. Do not pretend these were separate agents.

If a runtime genuinely provides subagents and the user wants them used, independent reviewers may be delegated, but this skill never requires that capability.

## Durable learning

Memorization is explicit, not automatic. Only write durable project guidance when the user asks to memorize/save/curate lessons.

Prefer the repository's existing agent-instruction file and conventions. Do not create or replace `AGENTS.md` or `CLAUDE.md` silently. Preserve specific evidence-backed rules; avoid vague preferences, secrets, transient paths, and one-off implementation details.

## Completion

Before saying the work is correct, fixed, ready, or complete:

- identify the evidence that proves the claim;
- run or inspect that evidence fresh;
- distinguish verified facts from judgment;
- report any remaining uncertainty or unverified area.

## Upstream provenance

Adapted from `NeoLabHQ/context-engineering-kit`, `plugins/reflexion`, which provides separate `reflect`, `critique`, and `memorize` skills plus an optional Claude hook. See `references/upstream.md` for adaptation notes.
