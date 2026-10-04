# Environment routing

## CLI or IDE agent

1. Prefer the current Git root when it is a Learning OS checkout.
2. Read current `AGENTS.md` and `docs/teacher-agent-protocol.md`.
3. Prefer current public APIs/CLI over bundled examples.
4. If the current directory is not Learning OS, try `/home/hamza/repo/learning-os` as the known default only when appropriate; otherwise ask for the repository path.

## Connected web session

The conversation is the learner UI. The agent operates Learning OS through its connected WSL/repository access, consults or mutates durable Learning OS state through public boundaries, and then returns the learner-facing response in chat.

1. Prefer the repository/worktree named by the user.
2. Otherwise use `/home/hamza/repo/learning-os` as the known default path.
3. Read current repository instructions before learner-facing work.
4. Use repository state rather than chat memory for profile, mission, progress, and resumption decisions.
5. Do not require or search for a dedicated Learning OS MCP server merely to use Learning OS. MCP/WSL is the agent's bridge to the repository; Learning OS remains the local kernel/CLI and durable state owner.
6. Do not tell the learner to run routine `npm run tutor -- ...` commands as the primary learning flow unless they explicitly want to operate the CLI. Invoke the kernel/CLI yourself when those are the available execution surfaces.

Without repository access, do not claim to have opened a profile, persisted onboarding, recorded evidence, or selected an authoritative next mission. You may discuss concepts or draft structured intake until access exists.

## Public boundary preference

Prefer:

1. `createTeacherWorkspace()` before a profile exists;
2. `createTeacherKernel(db)` after profile resolution, calling `getStudyContinuation(...)` before ordinary resumption/next-action selection;
3. `npm run tutor -- ...` when CLI is the available stable execution surface for the agent;
4. narrow read-only inspection for diagnosis.

Avoid direct SQLite writes for learner-state operations.

Canonical learner state is intentionally versioned. Before staging changed `registry.json`/`tutor.db`, use the repository's profile checkpoint command; when the current work includes those learner-state changes, include the canonical files in the commit rather than treating them as disposable runtime state. Keep WAL/SHM/journal and registry lock/temp artifacts untracked. Repository access controls are learner-data access controls, and independently changed SQLite databases are not text-mergeable.
