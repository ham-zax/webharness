---
name: executing-plans
description: Use when the user asks to execute an existing written implementation plan. Load the exact plan, remove stale or unauthorized process steps, execute the authorized tasks in order, and preserve Causal Coding's scope/testing/stopping rules.
---

# Executing Plans

## Overview

Load the exact plan, review it against the current request and repository state, execute the authorized tasks, and stop when the requested outcome is established.

Use `subagent-driven-development` only when the user explicitly requests that high-process delegated workflow. Do not introduce subagents merely because they are available or because a plan has several tasks.

## The Process

### Step 1: Load and Review Plan
1. Use the current checkout by default; create/use a worktree only when explicit/concurrent-writer isolation or mandatory repository policy requires it.
2. Read the plan file.
3. Review critically for blockers, stale assumptions, and process steps that exceed the task's authority.
4. Remove test creation/modification/execution, TDD, broad-suite, setup, or validation steps unless the user, authoritative user-approved specification, or mandatory repository policy explicitly requires them. A stale plan does not create testing authorization.
5. If a proposed normalization would change product behavior, public contracts, security semantics, or another protected boundary, raise that decision; otherwise proceed with the normalized plan.

### Step 2: Execute Tasks

For each task:
1. Mark as in_progress
2. Follow each step exactly (plan has bite-sized steps)
3. Run only validation that remains explicitly required after the Step 1 scope review
4. Mark as completed

### Step 3: Complete Development

After all tasks reach their authorized success conditions:
- gather only the fresh completion evidence required for the final claims;
- use `finishing-a-development-branch` only when branch/worktree integration, preservation, publication, or cleanup is actually the next decision;
- otherwise report the completed result and stop.

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- Review plan critically first
- Follow the plan after Step 1 normalization; do not resurrect removed unauthorized ceremony
- Don't skip explicitly required validation, and don't invent additional test/verification work
- Reference skills when plan says to
- Stop when blocked, don't guess
- Use the current checkout by default; branch/worktree policy comes from the task, repository, and justified isolation needs
