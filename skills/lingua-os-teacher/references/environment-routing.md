# Lingua OS environment routing

Use the repository and learner-state surface that is actually available. Never substitute chat memory for Lingua OS state.

## ChatGPT web session

1. Unless the user names another Lingua OS checkout, use `/home/hamza/repo/lingua-os`.
2. Read current repository `AGENTS.md` and `docs/lingua-teacher-agent-protocol.md` before learner-state work. Repository-local contracts outrank this packaged reference.
3. Prefer the public Lingua boundaries:
   - before profile binding: `createTeacherWorkspace()`;
   - after profile binding: `createTeacherKernel(db)` and `getStudyContinuation(...)` for ordinary continuation/next-action routing;
   - stable CLI fallback for profile/admin/read flows: `npm run lingua -- ...` (for example `profile list`, `goals`, `goal`, `continue --json`, `stats`, `due`).
4. When a required teacher-kernel operation is not exposed by the CLI, invoke the exported TypeScript public API inside the Lingua repository. Do not bypass the kernel with direct SQLite writes.
5. Keep each chat turn small: inspect only the state needed for the current learner request, perform the relevant kernel transition when needed, then answer naturally. Do not dump raw database state into the conversation.
6. If the repository or learner state is unavailable, say so. You may still explain language concepts, but do not claim to have read or changed the learner profile, selected an authoritative next action, recorded evidence, or scheduled review.

A typical web-session loop is:

```text
learner message
-> classify direct-safe vs state-sensitive/exposure-sensitive
-> consult Lingua OS when state matters
-> teach/ask/assess naturally
-> persist only the relevant bounded transition
-> answer learner
```

## CLI or IDE agent

1. Prefer the current Git root when it is a Lingua OS checkout.
2. Otherwise use the user-named path; use `/home/hamza/repo/lingua-os` only when it is the known intended repository.
3. Read current repository instructions before learner-state work.
4. Prefer public workspace/kernel APIs, then the current CLI, over direct database manipulation.

## Turn routing

### Direct-safe

Answer normally when the request does not decide or contaminate active learning state, such as:

- product/help questions about Lingua OS;
- ordinary conversation unrelated to an active challenge;
- learner-owned preferences, constraints, or goals;
- a small language clarification that does not reveal the answer to an active assessable target.

Do not manufacture evidence or progress from these turns.

### State-sensitive

Consult Lingua OS first for:

- `continue`, `resume`, or what to study next;
- quizzes, practice, review, diagnostics, or deliberate challenges;
- progress/readiness/weakness/due-state questions;
- goal or vocabulary-objective materialization;
- resuming an open attempt or reconstruction;
- recording learner performance, assessment, evidence, review, or scheduling transitions.

### Exposure-sensitive

Before showing an explanation, correction, hint, model answer, or worked example that overlaps an active assessable objective, inspect the active attempt/continuation state. If the material is answer-bearing and the relevant objective/session is identifiable, use the existing hint/exposure/reconstruction path before visible reveal. Useful teaching is allowed; hidden contamination of evidence is not.

## Data safety

- Use only the repository/profile path authorized by the user.
- Do not open or mutate another profile merely because it exists.
- Do not persist full provider conversations.
- Do not directly edit SQLite tables for normal teacher operation.
- Do not treat Git history, chat history, or a prior provider's prose as a replacement for current durable learner state.