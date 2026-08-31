---
name: using-git-worktrees
description: "Use only when a software task actually needs workspace isolation: explicit user request, concurrent writable missions, conflicting unrelated local changes, material long-lived/risky work, or mandatory repository policy. Do not create a worktree merely because implementation or a plan exists."
---

# Using Git Worktrees

## Overview

Create or enter an isolated workspace only when isolation has a concrete reason. Prefer the platform's native worktree mechanism when available; otherwise use Git worktrees.

**Core principle:** justify isolation -> detect existing isolation -> reuse/native tool -> Git fallback. If isolation is not justified, stay in the current checkout.

## Step 0: Detect Existing Isolation

**Before creating anything, check if you are already in an isolated workspace.**

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
```

**Submodule guard:** `GIT_DIR != GIT_COMMON` is also true inside git submodules. Before concluding "already in a worktree," verify you are not in a submodule:

```bash
# If this returns a path, you're in a submodule, not a worktree — treat as normal repo
git rev-parse --show-superproject-working-tree 2>/dev/null
```

**If `GIT_DIR != GIT_COMMON` (and not a submodule):** You are already in a linked worktree. Skip to Step 2 (Project Setup). Do NOT create another worktree.

Report with branch state:
- On a branch: "Already in isolated workspace at `<path>` on branch `<name>`."
- Detached HEAD: "Already in isolated workspace at `<path>` (detached HEAD, externally managed). Branch creation needed at finish time."

**If `GIT_DIR == GIT_COMMON` (or in a submodule):** You are in a normal repo checkout.

Before creating anything, establish a real isolation reason. Isolation is justified when at least one applies:

- the user explicitly requested a worktree/isolated workspace;
- multiple writable missions need independent checkouts;
- unrelated or conflicting local changes should not be mixed with this effort;
- the work is materially risky or long-lived enough that isolation protects the active checkout;
- repository policy specifically requires isolation.

If none applies, continue in the current checkout and stop this Skill. Do not ask the user to choose a worktree merely because one is available.

## Step 1: Create Isolated Workspace

**You have two mechanisms. Try them in this order.**

### 1a. Native Worktree Tools (preferred)

The user has asked for an isolated workspace (Step 0 consent). Do you already have a way to create a worktree? It might be a tool with a name like `EnterWorktree`, `WorktreeCreate`, a `/worktree` command, or a `--worktree` flag. If you do, use it and skip to Step 2.

Native tools handle directory placement, branch creation, and cleanup automatically. Using `git worktree add` when you have a native tool creates phantom state your harness can't see or manage.

Only proceed to Step 1b if you have no native worktree tool available.

### 1b. Git Worktree Fallback

**Only use this if Step 1a does not apply** — you have no native worktree tool available. Create a worktree manually using git.

#### Directory Selection

Follow this priority order. Explicit user preference always beats observed filesystem state.

1. **Check your instructions for a declared worktree directory preference.** If the user has already specified one, use it without asking.

2. **Check for an existing project-local worktree directory:**
   ```bash
   ls -d .worktrees 2>/dev/null     # Preferred (hidden)
   ls -d worktrees 2>/dev/null      # Alternative
   ```
   If found, use it. If both exist, `.worktrees` wins.

3. **If there is no other guidance available**, default to `.worktrees/` at the project root.

#### Safety Verification (project-local directories only)

**MUST verify directory is ignored before creating worktree:**

```bash
git check-ignore -q .worktrees 2>/dev/null || git check-ignore -q worktrees 2>/dev/null
```

**If NOT ignored:** Prefer a local-only rule in `.git/info/exclude` for adapter/workflow bookkeeping. Modify tracked `.gitignore` only when the repository intentionally wants a shared worktree-directory convention.

**Why critical:** Prevent accidentally staging worktree contents without creating an unrelated tracked change merely to satisfy the workflow.

#### Create the Worktree

```bash
# Determine path based on chosen location
path="$LOCATION/$BRANCH_NAME"

git worktree add "$path" -b "$BRANCH_NAME"
cd "$path"
```

**Sandbox fallback:** If `git worktree add` fails with a permission error (sandbox denial), tell the user the sandbox blocked worktree creation and continue in the current directory only when that still satisfies the requested isolation/safety contract. Do not bootstrap setup or tests merely because worktree creation failed.

## Step 2: Project Setup Only When Needed

Do not install dependencies or run setup merely because a new worktree exists. Reuse the existing environment when it is already usable. Run only the minimum setup required by the requested work or an explicit repository rule.

If a required command later proves the worktree lacks necessary dependencies, use the project's established setup mechanism at that point rather than preemptively installing everything.

## Step 3: Establish Only Required Baseline Evidence

A fresh worktree does not itself authorize tests. Run baseline tests only when the user, authoritative specification, or mandatory repository policy explicitly requires testing or a specific baseline test command.

Otherwise verify only the worktree facts needed for safe use, such as intended branch/HEAD, clean status, and required files/dependencies for the immediate task.

### Report

```
Worktree ready at <full-path>
Branch/HEAD and working-tree state verified
Required setup/validation: <none | concise result>
Ready to implement <feature-name>
```

## Quick Reference

| Situation | Action |
|-----------|--------|
| Already in linked worktree | Skip creation (Step 0) |
| In a submodule | Treat as normal repo (Step 0 guard) |
| Native worktree tool available | Use it (Step 1a) |
| No native tool | Git worktree fallback (Step 1b) |
| `.worktrees/` exists | Use it (verify ignored) |
| `worktrees/` exists | Use it (verify ignored) |
| Both exist | Use `.worktrees/` |
| Neither exists | Check instruction file, then default `.worktrees/` |
| Directory not ignored | Prefer `.git/info/exclude`; change tracked `.gitignore` only for an intentional shared convention |
| Permission error on create | Use current checkout only if it still satisfies the required isolation boundary |
| Testing explicitly required | Run only the required baseline test command and report its result |
| No setup requirement | Do not install dependencies merely because the worktree is new |

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'm obviously not in a worktree — no need to check" | Run Step 0. Harness-created isolation and submodules both fool eyeballing; the detection commands settle it. |
| "`git worktree add` is quicker than hunting for a native tool" | A native tool (e.g. `EnterWorktree`) owns placement, branching, and cleanup. Bypassing it is the #1 mistake — it creates phantom state your harness can't see or manage. |
| "The worktree directory is surely ignored already" | Run `git check-ignore`. An unignored worktree directory commits the whole tree into the repo. |
| "Any directory name works" | Explicit instructions beat an existing project-local directory, which beats the `.worktrees/` default. |
| "A new worktree needs baseline tests" | Worktree creation does not authorize testing. Verify Git/worktree state; run tests only when the task/spec/repository policy explicitly requires them. |
