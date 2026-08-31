---
name: requesting-code-review
description: Use when the user explicitly asks for an independent code review, or an authoritative user-approved workflow requires one. Do not auto-trigger merely because implementation finished or a merge is approaching.
---

# Requesting Code Review

Independent review is an explicit workflow, not a default completion ritual. Causal Coding remains authoritative for whether another review cycle is in scope.

## Review Target

Use the exact target the user/workflow requested: working tree, branch, commit range, pull request, patch, files, or implementation against a named plan/spec. Resolve the smallest reproducible review scope rather than reviewing the whole repository by default.

## Reviewer Selection

Prefer, in order:

1. An installed `code-review` Skill when available for the target environment.
2. A real independent reviewer/subagent when the runtime exposes one and independence is actually requested or required. Use [code-reviewer.md](code-reviewer.md) as the bounded prompt template.
3. If neither exists, perform an inline self-review only when the user still wants a review and label it honestly as non-independent.

Do not invent a reviewer identity or claim independence that the runtime does not provide.

## Review Contract

- Keep review read-only unless the user separately asks to fix findings.
- Give the reviewer requirements/plan, exact change scope, relevant repository rules, and enough surrounding code to validate findings; do not dump irrelevant conversation history.
- Existing tests/results may be inspected as evidence. Running tests is not authorized merely because a review is happening; execute tests only when the user, authoritative specification, or mandatory repository policy independently requires it.
- Require concrete, change-linked, reachable findings. Suppress style nits and speculative issues.
- Treat reviewer feedback as evidence to evaluate, not commands to implement blindly. Use `receiving-code-review` when acting on returned feedback.

## Git Range

When a commit range is appropriate, resolve it explicitly rather than assuming `HEAD~1`:

```bash
BASE_SHA=<resolved base or merge-base>
HEAD_SHA=<reviewed head>
git diff --stat "$BASE_SHA".."$HEAD_SHA"
```

For dirty working-tree review, include staged, unstaged, and relevant untracked files instead of forcing an artificial commit range.

## Stop Condition

Return the review result and stop. Do not automatically start fixes, another reviewer pass, tests, or a broader suite unless independently authorized.
