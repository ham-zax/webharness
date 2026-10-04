---
name: clean-migration
description: Internal API and contract migration discipline. Use when replacing an internal function, method, module interface, data shape, configuration contract, or other API while callers still exist and coordinated migration is possible. Inventory the real callers, define the target contract, migrate the authorized scope, remove the obsolete path in the same wave, and avoid permanent compatibility adapters unless an external consumer, rollout constraint, or explicit requirement actually needs them.
---

# Clean Migration

Converge on one internal contract instead of leaving old and new paths alive together.

## Method

1. Establish the target contract and why the old contract is being replaced.
2. Inventory the real in-scope callers and consumers, including generated/config/schema references when relevant.
3. Check whether backward compatibility is actually required:
   - external or separately deployed consumers;
   - staged rollout or mixed-version operation;
   - persisted/wire formats that cannot change atomically;
   - explicit user or repository requirement.
4. If compatibility is not required, migrate callers and delete the obsolete API in the same change or coordinated migration wave.
5. Remove stale adapters, aliases, overloads, flags, and dead compatibility branches once no authorized caller needs them.
6. Inspect the final diff for dual-path behavior or leftover references and stop.

Temporary adapters are exceptional. If one is genuinely required, make its purpose and removal condition concrete. Do not build a compatibility framework for an internal migration that can be coordinated directly.

Do not create or run tests by default. Testing remains governed by `causal-coding` or the user's explicit request. Routine checks should be deferred to the candidate-final stage under the governing implementation policy.

If external compatibility cannot be broken safely, do not pretend this skill authorizes it. Report the constraint and follow the actual compatibility contract.
