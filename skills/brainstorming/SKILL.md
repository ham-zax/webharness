---
name: brainstorming
description: Use when the user explicitly asks to brainstorm, explore alternatives, design a feature/system, or when material product/architecture ambiguity must be resolved before implementation. Do not auto-trigger for clear implementation tasks merely because they add or change behavior.
---

# Brainstorming Ideas Into Designs

Use brainstorming to resolve real design ambiguity, not as a mandatory prelude to every code change.

Causal Coding remains authoritative if the task proceeds into source mutation. Brainstorming must not create testing, review, approval, worktree, or documentation requirements that the user/spec/repository did not already require.

## Workflow

1. **Understand the outcome.** Inspect only enough current project context to identify the real owner, existing mechanisms, constraints, and success criteria.
2. **Resolve material ambiguity.** Infer ordinary reversible details. Ask a clarifying question only when the missing answer would materially change architecture, public contract, persistence, security, ownership, destructive behavior, or product scope.
3. **Compare real alternatives.** When more than one materially different approach is viable, present the meaningful tradeoff, recommend the best default, and omit fake alternatives.
4. **Design the smallest coherent solution.** Cover only boundaries that affect the decision: ownership, components, data flow, interfaces/contracts, failure behavior, rollout/migration, and explicitly required validation.
5. **Record the design when useful.** Persist a spec only when the user asks for one, an authoritative workflow requires one, or the design is complex enough that a durable artifact is necessary for later execution. Default path: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
6. **Transition appropriately.** If the user asked only for design, stop after the design. If implementation is also requested, use `writing-plans` when a multi-step implementation plan is genuinely needed; otherwise continue through the appropriate implementation workflow.

## Design Principles

- Reuse existing project mechanisms before inventing new architecture.
- Prefer one clear owner for behavior and mutable state.
- Keep public/shared contracts explicit; do not introduce extension points for hypothetical future uses.
- Include only transitive cleanup/refactoring required by the proposed design.
- Do not turn testing into a design requirement unless testing is independently authorized.
- Scale the design to the problem: a small decision may need only a few paragraphs.

## Decision Boundaries

Proceed autonomously on internal implementation choices that preserve established contracts. Stop and surface a decision when the design would materially change a public API, persistent data model/migration strategy, auth/security/privacy semantics, external dependency/service, another mission's ownership, destructive behavior, or product scope.

Do not require user approval after every section. A user review gate is appropriate only when the unresolved decision actually belongs to the user.

## Visual Companion

When a mockup, layout, architecture diagram, or other genuinely visual comparison would materially improve the design decision, read [visual-companion.md](visual-companion.md) and use the companion only if the required browser/local tooling is actually available. Do not offer or start it for text-only decisions.
