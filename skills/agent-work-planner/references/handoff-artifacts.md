# File-Backed Handoff Artifacts

Use this protocol when the planner and delegated sessions can access the same filesystem. The goal is to eliminate manual copy/paste of agent completion summaries without turning coordination metadata into repository state.

## Storage

Prefer a disposable cache outside the repository:

`$XDG_CACHE_HOME/agent-work-planner/<repo-key>/handoffs/<mission>/`

or, when `XDG_CACHE_HOME` is unset:

`$HOME/.cache/agent-work-planner/<repo-key>/handoffs/<mission>/`

Derive `<repo-key>` from the canonical Git common directory rather than the worktree root so all worktrees for one repository share the same handoff namespace. A useful shape is:

`<repo-name>-<12-char sha256 of canonical git-common-dir>`

The planner should compute the exact path once and place it in every mission prompt. Agents should not invent their own handoff roots.

Use `/tmp/agent-work-planner/...` only when same-boot ephemerality is desirable and loss across reboot is acceptable. Do not put lightweight handoff receipts inside the source repository by default; that risks dirty trees and accidental commits. Use repository-resident coordination only when durable orchestration explicitly justifies it.

## Receipt naming

Write exactly one new receipt for each completed, blocked, or needs-decision mission result:

`<UTC-YYYYMMDDTHHMMSSZ>-<MISSION>-<status>.md`

Example:

`20260923T031653Z-A2-complete.md`

Never overwrite an older receipt. Timestamped immutable receipts make concurrent or repeated missions easy to distinguish.

## Receipt format

Use YAML frontmatter plus concise Markdown:

```markdown
---
schema: agent-work-planner-handoff-v1
repository: /absolute/repo/path
mission: A2
agent: A
status: complete
created_at: 2026-09-23T03:16:53Z
workspace: /absolute/worktree/path
branch: agent-a/example
head: deadbeef...
base: cafe1234...
---

# Outcome
<what changed or what was learned>

## Validation
<commands/evidence actually used, or none>

## Deviations
<none or concise deviations>

## Blockers / decisions
<none or exact unresolved blocker>

## Downstream facts
<what the planner/reviewer/next mission needs to know>
```

Keep receipts short. Link to repository commits, branches, worktrees, or generated artifacts instead of embedding large logs. Never include credentials, tokens, private keys, passwords, or other secrets.

## Planner discovery

When the user says `check Agent A`, `check their work`, `what did R find?`, or otherwise refers to a delegated result without pasting it:

1. identify the repository and assigned handoff root from orchestration state;
2. list the relevant mission directory and choose the newest receipt consistent with the expected mission/session;
3. read the receipt;
4. verify consequential branch/HEAD/status/range facts against the authoritative repository before changing blockers, integrating, or issuing review prompts;
5. reconcile the mission and continue orchestration without requiring the user to relay the chat summary.

If no valid receipt exists, inspect the assigned workspace/branch directly. Ask the user for missing information only when the result cannot be reconstructed from the shared filesystem and repository state.

A receipt is a coordination pointer, not proof. Current repository state outranks stale receipt text.

## Review receipts

Agent R uses the same protocol. A review receipt should additionally include:

- exact reviewed range/target;
- pass / blocking findings / blocked;
- all material in-scope blocking findings observable in that pass;
- whether the review blocker is discharged;
- the narrow re-review scope if repair is required.

The planner can therefore discover R1/R2 results directly from the inbox and prepare the next repair/integration action without the user copying the review report.

## Cleanup

Treat receipts as disposable cache, not durable project history.

- Preserve receipts for active or unresolved missions.
- Preserve the newest completed receipt for the current integration/review boundary until that boundary is integrated or superseded.
- After integration or supersession, the planner may opportunistically prune older receipts that are no longer referenced by active orchestration state.
- A default stale-retention horizon of 14 days is reasonable for cache-backed receipts when no project-specific rule exists.
- Never delete repository source, branches, worktrees, test artifacts, or user files as part of handoff cleanup.

There is no background cleanup promise. `/tmp` may be cleaned by the OS; cache-backed receipts are cleaned opportunistically during later planner activity.
