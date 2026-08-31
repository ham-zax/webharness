# Root Cause Tracing

## Overview

Bugs often manifest deep in the call stack (git init in wrong directory, file created in wrong location, database opened with wrong path). Your instinct is to fix where the error appears, but that's treating a symptom.

**Core principle:** Trace backward through the call chain until you find the original trigger, then fix at the source.

## When to Use

```text
symptom -> immediate cause -> caller/input -> originating owner -> repair owner -> verify invariant
```

**Use when:**
- Error happens deep in execution (not at entry point)
- Stack trace shows long call chain
- Unclear where invalid data originated
- Need to find which test/code triggers the problem

## The Tracing Process

### 1. Observe the Symptom
```
Error: git init failed in ~/project/packages/core
```

### 2. Find Immediate Cause
**What code directly causes this?**
```typescript
await execFileAsync('git', ['init'], { cwd: projectDir });
```

### 3. Ask: What Called This?
```typescript
WorktreeManager.createSessionWorktree(projectDir, sessionId)
  → called by Session.initializeWorkspace()
  → called by Session.create()
  → called by test at Project.create()
```

### 4. Keep Tracing Up
**What value was passed?**
- `projectDir = ''` (empty string!)
- Empty string as `cwd` resolves to `process.cwd()`
- That's the source code directory!

### 5. Find Original Trigger
**Where did empty string come from?**
```typescript
const context = setupCoreTest(); // Returns { tempDir: '' }
Project.create('name', context.tempDir); // Accessed before beforeEach!
```

## Adding Stack Traces

When you can't trace manually, add instrumentation:

```typescript
// Before the problematic operation
async function gitInit(directory: string) {
  const stack = new Error().stack;
  console.error('DEBUG git init:', {
    directory,
    cwd: process.cwd(),
    nodeEnv: process.env.NODE_ENV,
    stack,
  });

  await execFileAsync('git', ['init'], { cwd: directory });
}
```

Use a diagnostic channel that is observable in the failing environment; in a test runner this may mean stderr rather than a suppressed application logger.

If running the relevant test is independently authorized, capture only the signal needed for the hypothesis:
```bash
npm test 2>&1 | grep 'DEBUG git init'
```

**Analyze stack traces:**
- Look for test file names
- Find the line number triggering the call
- Identify the pattern (same test? same parameter?)

## Finding Which Test Causes Pollution

If something appears during tests but you don't know which test:

When the task explicitly authorizes running the relevant tests, the bundled helper can bisect a polluting test:

```bash
../scripts/find-polluter.sh '.git' 'src/**/*.test.ts'
```

Do not run this helper merely because the debugging workflow mentions it; testing authorization still comes from the user, authoritative specification, or mandatory repository policy.

Runs tests one-by-one, stops at first polluter. See script for usage.

## Real Example: Empty projectDir

**Symptom:** `.git` created in `packages/core/` (source code)

**Trace chain:**
1. `git init` runs in `process.cwd()` ← empty cwd parameter
2. WorktreeManager called with empty projectDir
3. Session.create() passed empty string
4. Test accessed `context.tempDir` before beforeEach
5. setupCoreTest() returns `{ tempDir: '' }` initially

**Root cause:** Top-level variable initialization accessing empty value

**Fix:** Made tempDir a getter that throws if accessed before beforeEach

**Repair boundary:** Validate the value at the owner/trust boundary that actually permits the invalid state. Add another guard only when it protects a distinct real boundary; do not duplicate validation at every layer by default.

## Key Principle

```text
found immediate cause
  -> trace one level up while it can change ownership
  -> identify originating owner/invariant
  -> repair that owner
  -> re-run the original falsifying evidence
```

**NEVER fix just where the error appears.** Trace back to find the original trigger.

## Stack Trace Tips

**Observable channel:** Use stderr or another channel the failing environment actually exposes when the normal logger is suppressed.
**Before operation:** Log before the dangerous operation, not after it fails.
**Include context:** Include only fields that can change the causal conclusion, such as directory, cwd, relevant environment/config, and stack.
**Capture stack:** `new Error().stack` can reveal the call chain when static tracing is insufficient.
