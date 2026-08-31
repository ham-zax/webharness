---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, passing, committed, or ready. Require fresh claim-specific evidence before assertions, without introducing tests or broad checks that the task did not authorize.
---

# Verification Before Completion

## Overview

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

Use fresh evidence from the authoritative environment. A command is required only when the claim itself depends on command execution; focused reads, diffs, status, or direct behavior may be the correct evidence for other claims. This Skill does not authorize tests.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What smallest authoritative evidence proves this claim?
2. OBTAIN: Read/inspect/run only that evidence fresh. Run tests only when testing is independently authorized.
3. READ: Inspect the complete relevant result, including exit status when a command was used.
4. VERIFY: Does the evidence confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Original symptom/reproduction no longer fails and responsible invariant is restored | Code changed, assumed fixed |
| Regression test works (only when testing was authorized) | Required test behavior demonstrated under the authorized test workflow | Test file merely exists |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | Obtain fresh claim-specific evidence |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests, only when testing is independently authorized:**
```
✅ [Run the authorized test command] [See: 34/34 pass] "All authorized tests pass"
❌ "Should pass now" / "Looks correct"
```

Do not create, modify, or run tests merely because a completion claim is approaching. Testing authorization comes from the user, authoritative user-approved specification, or mandatory repository policy—not from this Skill.

**Build:**
```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

**Agent delegation:**
```
✅ Agent reports success → Check authoritative VCS/artifact evidence → Report actual state
❌ Trust agent report
```

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness
