---
name: superpowers-web-adapter
description: Adapt the standalone Superpowers-derived engineering workflow set to ChatGPT sessions using `wsl-web-harness`, especially where subagent, progress-state, worktree, reviewer, browser, or local-execution primitives differ from legacy Superpowers runtimes. Keep Causal Coding authoritative for mutation scope, testing authorization, verification cadence, and stopping.
---

# Superpowers Web Adapter

Bridge the standalone Superpowers-derived Skills to ChatGPT/WSL execution without reintroducing legacy ceremony or pretending unavailable runtime primitives exist.

## Core rule

When a standalone Superpowers-derived workflow is relevant, invoke the specific Skill that owns the task. Use `using-superpowers` only as a tie-breaker when several workflow Skills plausibly overlap; do not bootstrap every engineering turn through it.

Treat this adapter as a compatibility layer only:

1. Follow the user's explicit instructions and higher-level product rules.
2. For source mutation, let Causal Coding govern scope, testing authorization, verification cadence, and stopping. Superpowers must not broaden those boundaries.
3. Follow the relevant Superpowers skill as written whenever the harness can support it and it does not conflict with the governing mutation policy.
4. Apply the fallbacks below only where ChatGPT Web lacks the primitive that Superpowers expects.
5. Never claim that a missing subagent, reviewer, todo system, worktree primitive, helper file, or local execution capability exists.

## Broad development routing

Use the installed standalone Superpowers-derived Skills for the engineering workflow pieces that still apply:

- Explicit ideation/design work, or implementation blocked by material product/architecture ambiguity -> `brainstorming`. Clear implementation work does not require a brainstorming gate.
- Bug, failing test, unexpected behavior, or regression -> `systematic-debugging`.
- Feature or bugfix implementation -> use the normal implementation workflow without introducing tests by default. Invoke `test-driven-development` only when the user explicitly requests TDD/testing, an authoritative user-approved specification requires it, or mandatory repository policy specifically requires it.
- Requirements/spec for multi-step work -> `writing-plans`.
- Existing implementation plan -> `executing-plans` by default. Use `subagent-driven-development` only when the user explicitly requests that delegated workflow.
- Starting work that has already passed the isolation gate below -> `using-git-worktrees`. Never invoke it merely because an implementation plan exists.
- Receiving review feedback -> `receiving-code-review`.
- Explicitly requested or authoritatively required independent review -> `requesting-code-review`.
- Before claiming completion -> `verification-before-completion`.
- After implementation is verified and integration is next -> `finishing-a-development-branch`.

Do not route to a subagent-dependent Superpowers skill merely because it exists. Use the fallback matrix below when this web session has no subagent dispatch primitive.

## Local-PC execution contract

Use the connected `wsl-web-harness` connector as the canonical path for repository filesystem and shell work in this environment.

For implementation requests, act on the repository through the connected local tools and make the required code changes directly. Do not stop at instructions, suggested patches, or code snippets unless the user explicitly asks for guidance or a plan only.

- Use its native Bash/read/write/edit capabilities when available.
- Discover the repository root and relevant paths before editing; do not guess absolute paths.
- Run git, build, lint, package-manager, and other permitted project commands through the local connector when the work belongs on the user's PC. Run tests only when the user, authoritative specification, or mandatory repository policy explicitly authorizes testing.
- Preserve the user's existing working tree and unrelated changes.
- Do not claim a command ran unless the connector returned evidence that it ran.
- If `wsl-web-harness` is unavailable or disconnected, state that the local execution dependency is missing and stop before pretending to modify or verify the repository.

If another connected tool is a better fit for a specific operation (for example, a GitHub connector for PR metadata), it may be composed with this adapter. Keep `wsl-web-harness` as the source of truth for the local working tree.

## Persist Superpowers artifacts to the real repository

Do not downgrade Superpowers planning into chat-only prose.

When the upstream skill requires a persistent artifact, write it through `wsl-web-harness` to the repository:

- Brainstorming design/spec: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Implementation plan: `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`
- Any other path explicitly required by the active Superpowers skill

After writing an artifact, re-read enough of it from disk to verify the saved content before saying it was persisted.

When a plan is later executed, load the exact saved plan file from disk. Do not reconstruct it from conversation memory.

## Durable progress only when needed

Do not create progress ledgers merely because an upstream workflow mentions todos. Use ordinary conversation/task state for bounded work.

Persist `.superpowers/web/<plan-basename>/progress.md` only when the mission genuinely needs durable cross-turn/restart recovery and no better persistent-agent/task-state primitive is available. When persistence is required:

1. keep the file local-only under `.superpowers/` and prefer `.git/info/exclude` for ignore bookkeeping;
2. record only the plan path, task state, relevant commit hashes, and explicitly required validation results;
3. recover from the saved plan, repository state, and progress file rather than conversational memory.

Do not mark a task complete until its observable success conditions are established. The adapter must not add tests, review cycles, checkpoints, or validation requirements that the task did not authorize.

## Subagent fallback matrix

### `subagent-driven-development`

If no real subagent dispatch tool exists, do not simulate implementer/reviewer agents in prose.

Use `executing-plans` instead and execute the saved plan sequentially in this session. Preserve the plan, justified isolation, explicitly authorized testing/validation, progress persistence, blocker handling, and any branch-finishing discipline that actually applies.

### `dispatching-parallel-agents`

If no subagent dispatch tool exists, do not claim parallel agents were launched. Identify the independent workstreams, then execute them sequentially in a sensible order. Parallel shell commands may be used only for genuinely independent command execution; they are not a substitute for independent reasoning agents.

### `requesting-code-review`

If no independent reviewer/subagent primitive exists:

1. Build a bounded review context from the requirements/plan and the relevant git diff.
2. Perform a separate inline review pass focused on correctness, spec compliance, regression risk, existing test evidence when relevant, security implications, and unnecessary scope.
3. Re-establish only the evidence invalidated by fixes. Do not run tests unless testing is independently authorized by the user/spec/repository policy.
4. Explicitly describe the result as an **inline self-review**, not an independent reviewer opinion.
5. If an actual external reviewer tool becomes available, prefer it for independence.

Do not manufacture a reviewer identity or review result.

### Skill authoring

For ChatGPT Skill creation/update, use `skill-creator` rather than the legacy Superpowers `writing-skills` workflow. Pressure-test/TDD-style skill authoring is opt-in only when the user explicitly requests it.

## Missing helper files

This bundle is intended to be self-contained. If a Skill references a helper that is not present in the installed bundle, do not silently borrow an unverified legacy copy from another runtime. Use a local matching copy only when its provenance/version is established; otherwise follow the stable contract described by the current Skill and state any material limitation.

## Task type and Causal-compatible validation

Before choosing testing, workspace isolation, setup, or validation, classify the work by what it actually changes. Testing is opt-in: executable code, bug fixes, refactors, APIs, risk, or nearby tests do not authorize test creation/modification/execution by themselves.

- **Executable behavior** — production code, runtime logic, APIs, persistence, build behavior, or other behavior that can regress.
- **Documentation/content only** — README files, guides, prose, examples, diagrams, comments, documentation organization, or other non-executable content.
- **Configuration/metadata** — manifests, CI/config files, schemas, packaging metadata, repository policy, or similar operational files.
- **Mixed** — a change containing more than one category.

Match non-test evidence to the affected artifact and the failure it is meant to detect. Add testing only when the user, authoritative user-approved specification, or mandatory repository policy explicitly requires it.

For documentation/content-only work:

- Do not apply TDD or manufacture RED/GREEN cycles.
- Do not create automated assertions for headings, prose, README layout, directory descriptions, or other documentation content merely to make the work "testable."
- Use relevant lightweight checks such as documentation builds, link/reference checks, stale-path searches, formatting validation, publication/export-policy checks, and diff review.
- Preserve existing repository-boundary contracts when documentation affects publication, packaging, privacy, or security; run a test for that contract only when testing is explicitly authorized or mandatory repository policy requires it.
- Do not run application tests for documentation-only work unless an explicit testing requirement applies.

For configuration/metadata work, run parser/schema/build/smoke validation only when the changed contract actually needs it or explicit instructions require it. Do not automatically escalate to the entire application suite.

For mixed work, keep validation scoped independently to each artifact. Do not let executable changes bootstrap testing for the whole mission.

A verification step must have a concrete failure or contract it is intended to detect. Do not perform broad verification merely because a generic template mentions it.

## Worktrees and git

Treat `using-git-worktrees` as a conditional isolation sub-skill, not a default implementation phase. Evaluate this section first. Do not invoke the worktree Skill merely because `executing-plans` or another generic workflow says to ensure isolation. If the conditions below do not justify isolation, satisfy that workflow by continuing safely in the current checkout.

Work in the user's current repository checkout by default.

A worktree is an isolation mechanism, not a mandatory phase of every task. Create or enter a worktree when at least one of these is true:

- the user explicitly requests isolated work;
- multiple independent workers need parallel writable workspaces;
- the current checkout contains unrelated or conflicting changes that should not be mixed with this effort;
- the work is sufficiently risky or long-lived that isolation provides material safety;
- repository-specific instructions require isolation.

Do not create a worktree merely because:

- an implementation plan exists;
- an upstream workflow generically recommends isolation;
- the task is documentation/content-only;
- the change is small and coherent in the current checkout;
- each task in a larger effort is starting.

Use one worktree for one coherent effort unless independent parallel work genuinely requires separate workspaces. Never create a new worktree per plan task by default.

Only after isolation is justified, explicitly invoke `using-git-worktrees` and follow its safety/setup procedure using the connected local tools. If isolation is not justified, do not invoke that skill; continue directly in the current checkout and do not perform worktree-specific dependency installation or baseline testing.

Always preserve unrelated local changes. Do not merge, push, delete branches, discard work, or rewrite unrelated state without the appropriate user decision.

## Test authorization boundary

Testing is opt-in. Do not create, modify, or run tests merely because a change affects executable behavior, fixes a bug, changes an API, carries risk, or has nearby coverage.

Testing is in scope only when the user explicitly requests it, an authoritative user-approved specification requires it, or mandatory repository policy specifically requires a test or test command. When testing is authorized, keep it proportional: reuse existing coverage where sufficient, add only tests that serve the authorized requirement, use RED/GREEN only when TDD itself is authorized, and run the narrowest required test surface before any broader suite explicitly required by the same authority.

When testing is not authorized, use direct behavioral evidence and the smallest relevant non-test candidate-final checks. Do not label optional omitted tests as incomplete required work.

## Plan execution discipline

Treat a saved plan as executable guidance, not as permission to repeat generic ceremony. Before execution, review its testing, setup, worktree, and verification steps against the actual task type and current repository state.

If a generic plan contains code-oriented ceremony that does not apply — such as RED/GREEN tests for documentation, a worktree without an isolation reason, duplicate dependency setup, or a full-suite run with no relevant failure mode — normalize those steps to the smallest meaningful workflow before execution.

This normalization may remove or replace process overhead, but must not silently remove a real product requirement, regression check, repository policy, security boundary, or acceptance criterion. Escalate only when changing the plan would alter intended behavior, architecture, or user-visible scope.

When the user asks to execute a saved plan:

1. Load the exact plan from disk.
2. Review it for blockers, contradictions, and generic process steps inappropriate for the actual task type.
3. Remove unauthorized testing and normalize workspace, setup, and validation according to the policies above.
4. Establish isolation only if it is materially justified.
5. Resume from persisted progress if present.
6. Execute tasks sequentially in the current session.
7. Apply the test authorization boundary. Use direct/artifact-appropriate non-test evidence when testing is not authorized.
8. Establish each task's observable success conditions and run only explicitly required validation before marking it complete.
9. Stop on a genuine blocker instead of guessing.
10. After all tasks, gather fresh completion evidence proportional to the affected artifacts, without introducing unauthorized tests, and use `finishing-a-development-branch` only when a branch-integration decision is actually relevant.

Never describe long-running implementation as background or asynchronous work. Continue in the active session until completion or a real stop condition.

## Composition with other development skills

This adapter does not replace other installed development skills.

### Causal Coding and MCP Harness Router

When Causal Coding and/or MCP Harness Router also apply, keep the boundaries explicit:

- **Causal Coding controls mutation scope and stopping**: owner selection, smallest complete change, testing authorization, verification cadence, and when to stop.
- **Superpowers Web Adapter controls only compatible workflow adaptation**: brainstorming, planning, debugging structure, worktree/isolation integration, review fallbacks, and branch-finishing compatibility inside the Causal Coding boundary.
- **MCP Harness Router controls local primitive selection only**: for example `read` versus short-RPC `exec`/`bash`, mandatory Local Terminal + Dev `wait` for long or duration-uncertain commands, `edit` versus `write`/`file_ops`, Local Code versus `rg`, Local `tool_call` versus `tool_batch`, Local Browser routing, or `wait` versus polling.
- Do not let MCP Harness Router prescribe Git workflow, worktree policy, planning, testing, review, or implementation methodology.
- Do not invoke MCP Harness Router merely because a software-development task exists. Use it when choosing between direct Dev primitives, Local Code/Terminal/Host/Browser routes, or Dev `wait` is materially relevant.
- If the router's preferred primitive is unavailable, preserve the Superpowers workflow and choose the best actually exposed local primitive rather than inventing a tool.

In short: Causal Coding sets the mutation boundary; the standalone Superpowers-derived Skills supply compatible workflow structure; MCP Harness Router chooses the local primitive for each concrete operation.

### Other skills

- If Agent Browser applies, let it choose the browser surface/action and route that action through the selected private logical browser server exposed via Local on `wsl-web-harness`. Do not substitute a browser CLI unless that Skill explicitly calls for one in the active environment.
- If Codebase Memory applies, use its graph workflow only when its required graph tools are actually connected; otherwise fall back to source inspection without pretending graph evidence exists.
- Repository-specific instructions (`AGENTS.md`, `CLAUDE.md`, project docs, etc.) remain authoritative within their scope.

## Completion standard

Before claiming work is complete, fixed, passing, persisted, committed, pushed, or merged, obtain fresh evidence for that exact claim. Match the evidence to the affected artifact rather than running unrelated checks. Use `verification-before-completion` and the local connector outputs as the evidence source.
