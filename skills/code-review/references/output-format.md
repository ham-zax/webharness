# Review Output Format

Keep the review compact enough to act on. The final response is the deliverable unless the user explicitly asks for a report file.

## Verdict first

Use exactly one verdict line at the top:

```text
🔴 Request changes — <N> blocker, <N> major, <N> minor.
✅ Approve — no blocker or major findings; <N> minor/advisory item(s).
💬 Comment — mergeability cannot be determined: <specific missing requirement/evidence>.
```

Pluralize naturally and omit zero-value categories when that makes the line clearer.

Approval means only that no qualifying Blocker/Major was found in the reviewed scope. It is not a global correctness guarantee.

## Scope

Give one compact scope line or short paragraph containing the facts that matter for reproducibility:

- repository/path reviewed;
- base or explicit range when applicable;
- HEAD/branch;
- whether staged/unstaged/untracked work was included;
- any user-specified focus area.

Do not dump Git bookkeeping that does not help the reader understand what was reviewed.

## Findings

Order findings by severity (Blocker, Major, Minor), then by causal/root-cause importance. Merge duplicate symptoms of the same root cause.

Use stable sequential IDs `F1`, `F2`, ... across the whole review.

Preferred form:

```markdown
### F1 [Major] [Correctness] `src/path.ts:41-48` — Retry marks failed work complete

When `postReply()` rejects for one item, the code still resolves every input thread, so a failed reply can be hidden as completed. This is reachable whenever one reply fails after the batch starts; `resolveThreads(comments.map(...))` does not distinguish success from failure.

**Fix direction:** Track IDs that actually succeeded and resolve only those.
**Verify:** Reproduce the mixed success/failure behavior through the smallest direct mechanism available. If testing is independently authorized, a focused regression test is one valid route.
```

Every Blocker/Major finding must communicate, in prose rather than mandatory form fields:

- observable failure;
- trigger/preconditions and realistic reachability;
- exact causal evidence;
- minimal fix direction;
- verification route when non-obvious.

Minor findings may be shorter when the consequence and fix are self-evident.

Do not restate the diff line-by-line. Do not narrate the review process. Avoid hedging filler. If uncertainty is material, move the item to Questions.

### Evidence references

- Use current local file paths and verified line/range references.
- If the claim depends on another file/caller/constraint, cite that evidence in the finding too.
- Do not use diff-hunk `+N` offsets as line numbers without checking the current file.
- Quote only the minimum code needed to make the causal point; usually identifiers and references are enough.

## Questions

Render only when a material uncertainty remains after repository inspection.

```markdown
## Questions

- `src/client.ts:88`: Is the upstream API allowed to return `items: null`? The local schema and tests do not define that contract. If `null` is allowed, this destructure becomes a Major correctness issue; if it is prohibited upstream, no change is needed.
```

Questions never affect the verdict until evidence resolves them.

## Advisories

Render only when useful. Keep YAGNI and project-wide observations out of corrective findings.

```markdown
## Advisories

- [YAGNI] `src/policy.ts:20`: `PolicyProvider` has one implementation and no current extension requirement. The direct concrete type satisfies today's callers. Keep the abstraction when a second implementation or documented extension boundary appears.
```

For a project-wide pattern that predates the change, label it explicitly out of scope:

```markdown
## Out-of-scope observations

- The same unchecked parse pattern exists in several older call sites. This review does not count those as findings because this change did not introduce them.
```

Omit the section if there is nothing material to say.

## Verification

Always end with a concise verification section when commands were run or when an important check could not be run.

```markdown
## Verification

- `git diff --check <base>` — passed
- `npm test -- path/to/affected.test.ts` — passed (12 tests; testing explicitly authorized)
- Typecheck — not run; project dependencies are not installed in this checkout
```

Report only commands/results actually observed from WSL. Do not write "tests pass" from CI badges, user claims, or inference.

If a command failed, distinguish:

- the code/check genuinely failed;
- the command could not run because of environment/setup;
- the harness/tool result was unobservable.

Only the first is itself code-review evidence.

## Clean review

A clean result should stay short:

```markdown
✅ Approve — no blocker or major findings.

Scope: `<base>...HEAD` plus current working-tree changes; 4 source files and 2 tests reviewed.

No qualifying findings survived the evidence/refutation pass.

## Verification
- `git diff --check <base>` — passed
- `<focused test command>` — passed (testing explicitly authorized)
```

Do not manufacture a "What's good" section. Mention a positive only when it is specific and materially useful to the merge decision.

## Comment verdict

Use `Comment` instead of guessing when a missing boundary prevents a merge verdict, for example:

- the requested branch baseline cannot be resolved and committed changes are therefore ambiguous;
- the requirement is externally defined but unavailable and code/tests support conflicting interpretations;
- local source required to verify a supplied patch does not correspond to the patch version;
- a critical runtime contract can only be known from an unavailable environment.

State the exact missing evidence and what would resolve it. Do not turn ordinary unrun tests into a `Comment` verdict when static review is still meaningful.