---
name: context-audit
description: Use when auditing user-controlled agent context, instruction files, installed skills, or tool descriptions for contradictions, duplication, trigger collisions, stale guidance, over-constraint, missing autonomy, or unclear mission boundaries.
---

# Context Audit

Audit the instructions an agent actually receives from user-controlled sources and reduce friction without deleting load-bearing constraints.

## Scope

Audit only context that is available and user-controlled, such as:

- root and nested `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or similar files
- local profile/refinement files used by the user's harness
- installed/custom skill metadata and bodies when accessible
- tool/MCP descriptions the user controls
- repository docs explicitly used as agent instructions

Do not claim access to hidden system/developer prompts or private platform memory. Do not attempt to rewrite them.

When a connected local repository is available, use it to inspect the real files and paths.

## Audit workflow

1. Inventory each context layer, its location, approximate size, audience, and precedence if known.
2. Read interacting layers together rather than auditing each in isolation.
3. Classify findings using `references/classification.md`.
4. Separate permanent invariants from task-specific rules that should move behind a skill/reference trigger.
5. Identify missing decision boundaries that cause either wandering or excessive permission-seeking.
6. Produce a prioritized refinement proposal.
7. Apply changes only when the user explicitly asks to update/refine the harness.
8. After edits, re-read the effective context and check that no new contradiction was introduced.

## What to preserve

Be conservative with rules that encode a specific past failure, security boundary, destructive-operation guard, repository invariant, or explicit user preference.

If a rule looks over-constrained but names a concrete incident or costly failure, treat its purpose as evidence to investigate, not as clutter to delete.

## What to reduce

Target:

- duplicated guidance repeated across global files and skills
- contradictory defaults
- rules that restate obvious language/framework behavior
- generic wisdom that does not change agent decisions
- task-specific detail loaded on every turn
- outdated tool names, paths, workflows, or unavailable capabilities
- overly literal file restrictions where a mission boundary would work better
- instructions that make the agent ask for permission on routine implementation choices
- trigger overlap among skills that causes ambiguous routing

## Autonomy/boundary audit

For development harnesses, explicitly check whether the context distinguishes:

- implementation decisions the agent should make autonomously
- necessary transitive changes it may make and report
- architectural/public-contract/security/ownership decisions that require escalation
- unrelated improvements that are simply out of scope

A strong harness should provide both agency and a ceiling.

## Output

Return:

1. Context inventory
2. Highest-cost conflicts
3. Duplicates and trigger collisions
4. Over-constraints that should become judgment calls
5. Load-bearing gotchas to keep
6. Missing boundaries/preferences
7. Proposed patch plan, ordered by impact and risk
8. Expected effect on agent behavior

When possible, express the proposal as concrete diffs or replacement blocks rather than vague advice.

## Modification mode

If the user explicitly says to refine/update/apply the audit:

1. Make the smallest coherent set of context changes.
2. Preserve a backup or rely on version control when available.
3. Do not rewrite unrelated project documentation.
4. Report every changed instruction layer and why.
5. Verify the resulting files parse/read correctly.

If the user only asked for an audit, stop before editing.
