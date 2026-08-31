---
name: systematic-debugging
description: Root-cause debugging for concrete technical failures including bugs, failing builds or tests, integration issues, performance regressions, and unexpected behavior. Use before proposing or implementing a repair when diagnosis is required. Reproduce the symptom, trace the responsible owner, maintain one leading causal hypothesis, and falsify it with the smallest direct evidence. Compose with Causal Coding for source mutation; testing is opt-in and requires independent authorization.
---

# Systematic Debugging

## Overview

**Core principle:** Find the root cause before attempting a repair. Do not patch the visible symptom while the responsible owner remains unknown.

Causal Coding remains authoritative for mutation scope, testing authorization, verification cadence, and stopping. This Skill governs diagnosis: establish the visible failure, demonstrated mismatch, violated invariant, responsible owner, and a falsifiable repair hypothesis.

Testing is opt-in. Debugging requires a reproducible symptom and falsifiable evidence, not automatically an automated test. Create, modify, or run tests only when the user, authoritative user-approved specification, or mandatory repository policy explicitly authorizes testing.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## The Four Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

1. **Read Error Messages Carefully**
   - Don't skip past errors or warnings
   - They often contain the exact solution
   - Read stack traces completely
   - Note line numbers, file paths, error codes

2. **Reproduce Consistently**
   - Can you trigger it reliably?
   - What are the exact steps?
   - Does it happen every time?
   - If not reproducible → gather more data, don't guess

3. **Check Recent Changes**
   - What changed that could cause this?
   - Git diff, recent commits
   - New dependencies, config changes
   - Environmental differences

4. **Gather Evidence in Multi-Component Systems**

   **WHEN system has multiple components (CI → build → signing, API → service → database):**

   **BEFORE proposing fixes, add diagnostic instrumentation:**
   ```
   For EACH component boundary:
     - Log what data enters component
     - Log what data exits component
     - Verify environment/config propagation
     - Check state at each layer

   Run once to gather evidence showing WHERE it breaks
   THEN analyze evidence to identify failing component
   THEN investigate that specific component
   ```

   **Example (multi-layer system):**
   ```bash
   # Layer 1: Workflow
   echo "=== Secrets available in workflow: ==="
   echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"

   # Layer 2: Build script
   echo "=== Env vars in build script: ==="
   env | grep IDENTITY || echo "IDENTITY not in environment"

   # Layer 3: Signing script
   echo "=== Keychain state: ==="
   security list-keychains
   security find-identity -v

   # Layer 4: Actual signing
   codesign --sign "$IDENTITY" --verbose=4 "$APP"
   ```

   **This reveals:** Which layer fails (secrets → workflow ✓, workflow → build ✗)

5. **Trace Data Flow**

   **WHEN error is deep in call stack:**

   Read [references/root-cause-tracing.md](references/root-cause-tracing.md) when the failure is deep in a call chain or the bad value's origin is unclear.

   **Quick version:**
   - Where does bad value originate?
   - What called this with bad value?
   - Keep tracing up until you find the source
   - Fix at source, not at symptom

### Phase 2: Pattern Analysis

**Find the pattern before fixing:**

1. **Find Working Examples**
   - Locate similar working code in same codebase
   - What works that's similar to what's broken?

2. **Compare Against References**
   - If an existing implementation or documented pattern governs the broken path, read the smallest relevant material that establishes its contract
   - Expand only when a concrete unanswered question could change the diagnosis
   - Understand the required pattern before applying it

3. **Identify Differences**
   - What's different between working and broken?
   - List every difference, however small
   - Don't assume "that can't matter"

4. **Understand Dependencies**
   - What other components does this need?
   - What settings, config, environment?
   - What assumptions does it make?

### Phase 3: Hypothesis and Falsification

**Scientific method:**

1. **Form One Leading Hypothesis**
   - State clearly: "I think X is the root cause because Y"
   - Be specific and falsifiable
   - Keep one leading hypothesis at a time

2. **Falsify Minimally**
   - Use the smallest observation, command, runtime probe, or reversible change that can disprove the hypothesis
   - One variable at a time
   - Do not stack candidate fixes
   - An automated test is only one possible probe and still requires independent testing authorization

3. **Evaluate Before Continuing**
   - Supported? Proceed to Phase 4
   - Contradicted? Return to the smallest reproduction and form a new hypothesis
   - Do not add more fixes on top

4. **When You Don't Know**
   - Say "I don't understand X"
   - Don't pretend to know
   - Ask for help
   - Research more

### Phase 4: Implementation

**Fix the root cause, not the symptom:**

1. **Establish a Failing Reproduction**
   - Use the simplest observable reproduction of the real symptom
   - Prefer direct runtime/input/output evidence when that is sufficient
   - Use an automated test only when testing is explicitly authorized
   - Do not create a one-off test script merely to manufacture a test requirement
   - The reproduction must be capable of disproving the proposed fix

2. **Implement Single Fix**
   - Address the root cause identified
   - ONE change at a time
   - No "while I'm here" improvements
   - No bundled refactoring

3. **Verify Fix**
   - Does the original reproduction now succeed?
   - Is the violated invariant restored at the responsible boundary?
   - Run tests only when testing is independently authorized; otherwise do not expand the validation surface just because a bug was fixed
   - Use the completion-evidence workflow before claiming success

4. **If the Repair Doesn't Work**
   - STOP and return to the original reproduction
   - If two repair attempts were based on the same causal hypothesis, do not make a third repair under that hypothesis
   - Re-establish the mismatch and responsible owner from new evidence before another repair
   - Do not stack patches merely because the previous one failed

5. **Question Architecture Only When Evidence Requires It**

   **Signals of an architectural problem:**
   - distinct evidence-backed repairs repeatedly expose the same shared-state or coupling flaw across owners
   - the responsible invariant cannot be restored without changing an actual architecture or public-contract boundary
   - each local repair necessarily creates a new failure elsewhere

   If the evidence now requires an architectural or public-contract decision, stop and surface that boundary before redesigning. Repeated failed guesses alone do not justify a rewrite.

## Red Flags - STOP and Follow Process

If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes and see what happens"
- "Skip the reproduction; I'll just eyeball the fix"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Pattern says X but I'll adapt it differently"
- "Here are the main problems: [lists fixes without investigation]"
- Proposing solutions before tracing data flow
- **"One more fix attempt" under a causal hypothesis that already failed twice**
- **Each attempted repair reveals a different owner without new evidence**

**ALL of these mean: STOP. Return to Phase 1.**

Question architecture only when evidence establishes an architectural boundary, not merely because several guesses failed.

## your human partner's Signals You're Doing It Wrong

**Watch for these redirections:**
- "Is that not happening?" - You assumed without verifying
- "Will it show us...?" - You should have added evidence gathering
- "Stop guessing" - You're proposing fixes without understanding
- "Ultra-think this" - Question fundamentals, not just symptoms
- "We're stuck?" (frustrated) - Your approach isn't working

**When you see these:** STOP. Return to Phase 1.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "I'll add a test because this is a bug fix" | A bug fix requires a falsifiable reproduction; automated testing is separate and only in scope when independently authorized. |
| "Multiple fixes at once saves time" | You cannot isolate what changed the outcome. Make one causal repair at a time. |
| "Reference too long, I'll adapt the pattern" | Read the relevant contract and governing implementation closely enough to know which differences matter; do not substitute guesswork for evidence. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" under the same twice-failed hypothesis | Return to the original reproduction and establish a new evidence-backed hypothesis before another repair. |

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form one theory, falsify minimally | Supported or replaced hypothesis |
| **4. Implementation** | Establish reproduction, repair owner, verify invariant | Original symptom resolved with required evidence |

## When Process Reveals "No Root Cause"

If systematic investigation reveals issue is truly environmental, timing-dependent, or external:

1. You've completed the process
2. Document what you investigated
3. Implement appropriate handling (retry, timeout, error message)
4. Add monitoring/logging for future investigation

**But:** 95% of "no root cause" cases are incomplete investigation.

## Supporting Techniques

Load these references only when the failure shape requires them:

- [references/root-cause-tracing.md](references/root-cause-tracing.md) — trace a bad value or side effect backward to its originating owner.
- [references/condition-based-waiting.md](references/condition-based-waiting.md) — diagnose timing/flakiness caused by arbitrary delays; use only when the task actually involves timing or explicitly authorized tests.
