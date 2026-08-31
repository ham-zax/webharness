---
name: using-superpowers
description: Lightweight router for the standalone Superpowers-derived engineering Skills in ChatGPT. Use when several engineering workflow Skills could plausibly apply and the correct sequence is unclear. Do not use as a global bootstrap for ordinary conversation.
---

# Superpowers Workflow Router

Use ChatGPT's native Skill routing first. This Skill is only a tie-breaker when several standalone Superpowers-derived workflows overlap.

For source mutation, Causal Coding remains authoritative for scope, testing authorization, verification cadence, and stopping. This router must not add tests, reviews, worktrees, approval gates, or other process merely because a Superpowers workflow mentions them.

## Route the Engineering Task

- Materially ambiguous product/design problem, or explicit ideation/design request -> `brainstorming`.
- Concrete bug, failing build/test, regression, or unexplained behavior -> `systematic-debugging`.
- Multi-step implementation plan requested -> `writing-plans`.
- Existing plan to execute -> `executing-plans`; use `subagent-driven-development` only when the user explicitly requests that high-process delegated workflow.
- Independent parallel work that genuinely benefits from separate agents -> `dispatching-parallel-agents`.
- Workspace isolation is actually justified -> `using-git-worktrees`.
- User provides review feedback to evaluate -> `receiving-code-review`.
- User or authoritative workflow explicitly asks for an independent review -> `requesting-code-review`.
- Explicit TDD/test-first requirement -> `test-driven-development`.
- About to make a completion/readiness claim -> `verification-before-completion`.
- Branch/worktree integration or cleanup decision -> `finishing-a-development-branch`.

Do not route a clear implementation task through brainstorming merely because it changes behavior. Do not introduce a review, worktree, subagent, or testing phase unless independently justified.

## Composition

If `superpowers-web-adapter` applies, let it adapt local ChatGPT/WSL execution details while this Skill only selects the workflow. Repository instructions and the user's current request remain authoritative within their scope.

Prefer the smallest sufficient workflow. If one specialized Skill clearly owns the task, invoke that Skill directly and stop routing.
