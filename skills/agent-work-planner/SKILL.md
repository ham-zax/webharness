---
name: agent-work-planner
description: Use when splitting engineering work across multiple human-launched AI sessions, deciding agent count or parallelism, preparing mission briefs/prompts, materializing coordination artifacts, or replanning later waves from returned agent work.
---

# Agent Work Planner

Plan multi-session engineering work and produce durable mission briefs plus copy/paste prompts for fresh AI coding sessions.

Treat this Skill as a **human-launched coordination layer**, not an execution engine. Never spawn agents or claim agents are running. The user launches the sessions manually.

## Core principles

- **Declarative over procedural.** Give each agent an objective, ownership boundary, interfaces, constraints, and definition of success. Let the receiving agent explore and decide implementation details.
- **Vertical slices over arbitrary task counts.** Prefer coherent, independently verifiable missions rather than equal-sized chunks or layer chores.
- **Dependencies are first-class.** State what can start now, what is blocked, and what artifact, contract, or commit unblocks it.
- **Durable context over prompt bloat.** Put substantial coordination context in repository artifacts and make launcher prompts point to them.
- **Parallelize only real independence.** Do not manufacture N concurrent missions merely because N agents were requested.
- **Separate before serializing shared state.** Before adding locks, sequencing, or a shared writable coordination object, ask whether missions can own separate files, branches, keys, state directories, or other write targets. Eliminate unnecessary shared mutation first; serialize only when one shared writer is a real invariant.
- **Preserve agent autonomy.** Avoid line-by-line recipes, exact line numbers, or brittle implementation-path instructions unless they are contractual.
- **Materialize the frontier, not the fog.** Understand the larger DAG, but create detailed mission briefs only for work ready or intentionally queued for the current wave.
- **Replan from evidence.** Returned agent reports, commits, changed interfaces, and integration results outrank the original decomposition.
- **Testing is opt-in.** Do not put test creation, test modification, test execution, TDD, regression-test work, or coverage work into missions unless the user, authoritative source plan/specification, or mandatory repository policy explicitly requires it.
- **Isolation must earn its cost.** Worktrees are for genuine concurrent-write isolation or material safety, not a default ceremony for every mission.
- **Separate plan quality from execution lifetime.** When a mission is long-lived, wait-heavy, steerable, or process-persistent, let `persistent-agent-loop` own continuity rather than duplicating its wait/checkpoint protocol here.

## Default test policy

Testing is opt-in. Do not instruct delegated agents to create, modify, or run tests unless the user, authoritative source plan/specification, or mandatory repository policy explicitly requires testing. If tests could be useful but are not required, leave them out of the mission and launcher prompt. Mention them only as an optional follow-up when materially important.

## Operating modes

Infer the mode from the user's wording. If unclear and repository mutation would be consequential, stay in plan-only mode until the user asks to materialize.

### Plan-only

Use when the user asks how work should be split, how many agents to use, whether work can run in parallel, or requests prompts without asking for repository setup.

- Inspect the repository and source artifacts.
- Recommend execution shape, dependency map, missions, and prompts.
- Do not create branches, worktrees, commits, or coordination files merely to answer an advisory question.

### Materialize

Use when the user says things like "set this up", "prepare the agents", "create the mission files", "make the worktrees", or otherwise clearly asks for a runnable coordination package.

- Inspect Git/worktree/staging state first.
- Create durable coordination artifacts for the current wave.
- Create branches/worktrees only when requested or when concurrent writable missions genuinely require isolation.
- Make real repository changes only after the user's request clearly authorizes that setup.
- Never discard or overwrite unrelated uncommitted work.

### Replan / next wave

Use when the user brings back agent reports, branches, commits, blockers, integration results, or asks what should run next.

- Compare reality with the current coordination map.
- Update readiness and dependencies.
- Integrate or verify prerequisites when appropriate.
- Materialize only the newly ready frontier.
- Rewrite existing mission briefs only when their contract materially changed.

## Workflow

### 1. Orient to the work

Establish the source of truth before decomposing:

- the user's goal, constraints, and requested or target agent count;
- repository root and current branch/worktree/staging state when available;
- relevant `AGENTS.md`, `CLAUDE.md`, README, specs, plans, ADRs, issue/ticket text, and recent changes;
- public or cross-task interfaces that multiple missions will share;
- existing implementation that changes the decomposition;
- existing agent-plan folders or prior wave reports for this effort.

Use connected repository tools to inspect the real codebase. In ChatGPT Web, use the connected local repository tools for filesystem, Git, worktrees, and shell commands. Use test commands only when the mission explicitly authorizes testing. Use Codebase Memory when available and useful for structural queries, but do not make the workflow depend on unavailable graph tools.

If a Superpowers design/spec/implementation plan already exists, treat it as authoritative unless the user changes the requirements. If the work is materially ambiguous, finish the appropriate design/spec clarification before pretending it is ready to delegate.

### 2. Decide whether delegation helps

Classify the work as one of these shapes:

**Single session** — small or tightly coupled; coordination overhead would dominate.

**Sequential sessions** — later missions fundamentally depend on code, decisions, or interfaces produced by earlier missions.

**Parallel sessions** — missions have stable boundaries, minimal overlapping write ownership, and independently observable completion.

**Hybrid** — a foundation or contract lands first, several missions fan out, then integration or dependent waves follow.

If the user specifies an agent count, treat it as a target. Use fewer concurrent agents when the dependency graph does not justify the requested count. If no count is given, recommend one and explain the limiting dependency or collision risk.

### 3. Classify mission artifact types

Before assigning completion criteria or workspace topology, classify each mission by what it actually changes:

- **Executable behavior** — production/runtime code, APIs, persistence, build logic, or behavior that can regress.
- **Documentation/content** — README files, guides, prose, examples, diagrams, comments, or documentation organization.
- **Configuration/metadata** — manifests, CI/config files, schemas, packaging metadata, repository policy, or operational configuration.
- **Mixed** — more than one category.
- **Read-only** — research, review, analysis, or investigation without repository mutation.

This classification determines how to describe observable completion and whether isolation has value. It does not create a testing requirement.

Default to no test creation, test modification, test execution, TDD, regression-test work, or coverage work for every mission type. Testing enters a mission only when the user, authoritative source plan/specification, or mandatory repository policy explicitly requires it. Do not infer testing from executable behavior, bug fixes, refactors, APIs, risk, or nearby tests.

For documentation/content missions, do not create or run tests. Use documentation builds, renders, link/reference checks, stale-path searches, formatting checks, or publication/export-policy checks only when directly relevant to the requested outcome or explicitly required. Ordinary content edits can be completed by inspecting the artifact and diff.

For configuration/metadata missions, use parser/schema/build/smoke validation only when the changed contract actually needs it or explicit instructions require it.

For executable behavior, define observable success from the requested behavior. Do not add tests merely to increase confidence. If a test is explicitly required, keep it as narrow as the requirement permits.

For mixed missions, apply the same default independently to each artifact: no testing unless explicitly required, and no validation spillover between artifact types.

### 4. Build the dependency DAG

Map the actual work before assigning agents. For each candidate mission, identify:

- blockers and prerequisites;
- shared interfaces/contracts;
- likely write ownership and collision areas;
- artifact type and observable completion boundary;
- downstream missions it unlocks;
- whether a small planner-owned preparatory change would create a cleaner seam.

Prefer the **current frontier**: missions whose blockers are already satisfied. Do not force a blocked task into Wave 1 just to fill an agent slot. If a later task is independent while an earlier-numbered task is blocked, assign the independent task first.

When a wide mechanical refactor cannot stay green as vertical slices, use **expand → migrate → contract** and treat the migration batches as the parallelizable middle when safe.

### 5. Choose branch and worktree topology

Pick the simplest safe topology. **Current checkout is the default** unless isolation has a concrete purpose.

- **Current checkout / sequential sessions:** default for one writer at a time, including small coherent code changes, documentation, configuration, and mixed work when the existing tree is safe.
- **Same branch / same worktree, sequential sessions:** tightly coupled work where only one agent edits at a time.
- **Separate branches / separate worktrees:** use for genuinely concurrent writable missions or when unrelated/conflicting local changes create a real isolation need.
- **Shared integration branch:** use only when independently developed branches must combine before downstream work can begin or the feature can be verified.
- **No branch/worktree:** read-only research, planning, or review.

Do not create a worktree merely because a plan exists, because a mission was delegated, or because a generic engineering workflow recommends isolation. Do not create one worktree per plan task by default. Prefer **one workspace per coherent effort**, adding separate worktrees only for independent concurrent writers.

Never place concurrently editing agents in the same worktree. Avoid overlapping file ownership and unstable shared interfaces. Before choosing serialization or a shared mutable coordination file, try to give each concurrent writer a distinct owned target and merge only at an explicit integration boundary. If one canonical write target is genuinely required, use structural serialization such as a single owner or sequential phase rather than relying on agents to 'take turns' by instruction. If overlap is unavoidable, sequence the work or land the contract/foundation first.

When materializing parallel worktrees, derive them from the same known coordination base commit unless there is a deliberate reason not to. Record that base in the coordination README.

### 6. Decompose into missions

For each mission, define:

- **Mission:** the behavior or outcome this session owns.
- **Can start:** immediately, after a named dependency, or after a contract/commit exists.
- **Artifact type:** executable / docs / config / mixed / read-only.
- **Ownership:** subsystem, behavior, interface, or artifact the agent may change.
- **Coordination boundary:** what neighboring missions depend on and what must remain stable.
- **Acceptance:** observable conditions proving the mission is complete.
- **Required validation:** only a command or check explicitly required by the user, source plan/specification, repository policy, or integration contract; otherwise none.
- **Out of scope:** adjacent work that belongs elsewhere.
- **Execution lifetime:** ordinary one-turn execution, or `persistent-agent-loop` when the mission may span extended waits, repeated steering, persistent processes, scheduled wakeups, or multiple wait leases.
- **Wake strategy when blocking:** native timer when time itself is the condition; event wait when external state is the condition; Terminal + event wait when a persistent process owns the work.

Size each mission so a fresh capable coding agent can reasonably finish it within one context window. Prefer a long, coherent goal with clear boundaries over a hand-held list of tiny implementation steps.

### 7. Materialize the current wave

In materialize mode, create a durable coordination package. Default location when the repository already uses Superpowers planning conventions:

`docs/superpowers/agent-plans/YYYY-MM-DD-<effort>/`

Otherwise follow the repository's established planning/documentation convention or choose a similarly obvious location.

Create:

```text
<agent-plan-folder>/
├── README.md
├── agent-1-<mission>.md
├── agent-2-<mission>.md
└── ... current-wave missions only
```

Read `references/coordination-package-template.md` for the README and mission-file contracts.

The README is the durable low-resolution coordination map. Record:

- source spec/plan and repository root;
- coordination/base commit when relevant;
- current wave and execution shape;
- dependency DAG / readiness table;
- branch/worktree allocation **and the reason isolation exists when it does**;
- shared contracts and integration policy;
- current mission status;
- blocked or future work at low resolution;
- who integrates and what explicitly required validation remains, if any.

Each mission file is the authoritative brief for one fresh agent. It should be declarative, self-contained, and durable. Use `references/agent-prompt-template.md` as the content model.

Do **not** pre-write detailed briefs for every future wave when their context depends on current-wave results. Keep blocked future work summarized in the README and materialize it when it reaches the frontier.

### 8. Prepare repository topology when justified

If the user asked for worktrees, or the current wave has genuinely concurrent writable missions requiring isolation:

1. Inspect current branch, HEAD, status, existing worktrees, and uncommitted changes.
2. Determine whether the current checkout is already sufficient. Do not create isolation if it adds no material value.
3. Determine the coordination base. Do not silently commit unrelated work.
4. If coordination artifacts themselves need a shared base commit, create that commit only when the user's setup request authorizes repository changes and the commit contains only the intended coordination changes.
5. Create named branches/worktrees only for missions that actually need isolated writable workspaces.
6. Verify each created worktree points at the intended commit and is clean before reporting it ready.

Do not perform worktree-specific dependency installation or baseline testing for missions that are not using a new worktree. More generally, do not run tests unless testing is explicitly authorized for the mission. If repository state makes safe setup ambiguous, report the conflict rather than improvising destructive Git operations.

### 9. Generate copy/paste launcher prompts

When a durable mission file exists, keep the launcher prompt short. It should identify:

- agent/mission name;
- repository and working arrangement;
- authoritative mission file;
- source plan/spec when useful;
- instruction to inspect current code and own the mission through the stated observable success conditions, without adding tests unless explicitly authorized;
- required finish report.

Do not duplicate the entire mission file into the launcher prompt unless the receiving environment cannot access the repository artifact.

When no durable file exists, generate a full standalone prompt using `references/agent-prompt-template.md`.

### 9a. Compose long-lived execution with `persistent-agent-loop`

Keep this Skill responsible for **planning and coordination**. When a launcher prompt or mission is expected to involve extended waiting, repeated user steering, persistent processes, scheduled wakeups, multi-hour execution, or recovery across wait leases, explicitly tell the receiving session to use `persistent-agent-loop` for execution lifetime.

Use this handoff boundary:

- `agent-work-planner` owns decomposition, dependencies, workspaces, mission boundaries, acceptance criteria, explicitly required validation, launcher prompts, integration order, and replanning.
- `persistent-agent-loop` owns durable named waits, native timers, event-driven wakeups, steering while work continues, checkpoints, persistent-process observation, <=24-hour wait-lease renewal, hard-cutoff recovery, and the final completion gate.

Do not duplicate the full persistent-loop protocol in mission briefs. Include only the execution-lifetime facts the receiving session needs.

#### Plan wakeups from semantics

When time itself is the reason to wake, use the native Dev timer condition rather than Bash `sleep` or fake conditions:

```text
{kind:"timer", after_seconds:N}
{kind:"timer", at:"<timezone-qualified timestamp>"}
```

`after_seconds` is 1..86399. Absolute `at` values must include `Z` or a numeric timezone offset. `timeout_seconds` is the durable safety deadline, not the timer, and must be strictly later than the timer target; it is capped at 86400 seconds. `hold_seconds` bounds only one MCP invocation and remains <=15 seconds.

When external state is the reason to wake, prefer the matching event wait (`terminal_output`, `terminal_exit`, `process_exit`, `tcp_listen`, `file_exists`, `file_changed`, `http_ready`, or `systemd_user`) so work can resume as soon as reality changes. For a persistent/interactive command, plan Terminal/tmux as process lifetime authority and let `wait` observe readiness/output/exit.

For missions longer than one wait safety deadline, plan meaningful checkpoints plus renewable <=24-hour wait leases. Never promise that one ChatGPT turn is guaranteed to remain active for days.

#### Preserve steering without accidental termination

For long-lived launcher prompts, state that status/progress questions, compatible side tasks, requests for live visibility, and reprioritization are **in-mission steering events**, not implicit stop commands. The receiving session should handle the steering, update/checkpoint material state when useful, preserve still-valid named waits, and continue the mission. Cancel/re-arm a wait only when its semantic target changed or became obsolete.

Stop only after verified completion, explicit stop/replacement, or impossible/unsafe continuation after checkpointing recoverable state. If major steering invalidates the plan, `persistent-agent-loop` may checkpoint the changed constraints and return to `agent-work-planner` for substantial replanning.

#### Optional live developer visibility

Headless Terminal execution is the default. When a developer wants to watch a persistent PTY, the launcher may request `terminal_open(..., present:true)` so Kitty presents the exact private tmux PTY while tmux/broker remain the lifetime and ownership authority. For an already-running headless session, passive viewing may use the human-side `wsl-term present <session>`. Use `terminal_yield` only when human input/control is actually useful. Do not restart or duplicate a process merely to make it visible.

### 10. Plan integration and reporting

Every agent should return:

- status: complete / blocked / needs decision;
- working arrangement and relevant commits when any;
- concise behavior/interface/artifact summary;
- explicitly required validation actually run, if any; otherwise state none;
- deviations from the mission;
- coordination notes for dependent sessions;
- unresolved risks or blockers.

Identify who integrates: the planner/user, a dedicated integration session, or a downstream mission. Treat integration as real work when merges can expose cross-mission incompatibilities.

Do not invent an integration/branch-finishing phase for read-only work or a simple in-place docs/config change that has no separate branch to integrate.

### 11. Replan from reports

When reports or completed branches return:

1. verify the reported branch/commit state as needed;
2. compare results with the coordination README and DAG;
3. update contracts, blockers, and status;
4. decide whether integration is required before unlocking dependents;
5. determine the new frontier;
6. materialize only the newly ready mission files/worktrees/prompts;
7. update the README so another session can recover the orchestration state.

Do not force the original decomposition after reality changes. A changed interface, unexpected shared file, failed integration, or newly discovered dependency is a reason to reshape later waves.

## Planner-owned work

The planner may perform small changes itself when that reduces coordination cost or unlocks clean parallelism, for example:

- clarifying or creating a source spec/plan;
- establishing a tiny stable interface/seam;
- checking or repairing baseline setup when it is relevant to executable work;
- preparing the coordination package;
- creating worktrees when justified;
- integrating completed branches;
- running only final validation explicitly required by the source plan, user, repository policy, or integration contract.

Do not absorb a full agent mission merely because local tools are available. If the planner becomes the primary implementer, switch to the appropriate implementation workflow rather than disguising it as orchestration.

## Default output

For plan-only mode, use:

### Execution recommendation
- Recommended agent/session count
- Single / sequential / parallel / hybrid
- Branch/worktree strategy and, when isolation is proposed, the concrete reason
- Short rationale

### Dependency map
A compact DAG or readiness table.

### Missions
For each mission: name, start condition, artifact type, ownership, dependencies, success conditions, and explicitly required validation if any.

### Copy/paste prompts
One clearly delimited prompt per session.

### Integration order
How outputs come back together and what explicitly required integration validation remains, if any.

For materialize mode, additionally report:

- coordination folder path;
- coordination/base commit if created or used;
- branches/worktrees created and the reason each was necessary;
- current-wave mission files;
- concise launcher prompts pointing at those files;
- blocked future work that remains intentionally unmaterialized.

If multiple sessions do not help, say so and recommend one session instead of manufacturing agent prompts.

## Guardrails

- Never claim to have dispatched, launched, or messaged an agent unless the current environment actually provides and uses such a tool.
- Never assume two agents can safely edit one worktree concurrently.
- Never hide a dependency merely to make the plan look parallel.
- Never create a Git commit, branch, worktree, or repository file in plan-only mode.
- Never create a worktree solely because a task was delegated or a plan exists.
- Never add, modify, or run tests unless the user, authoritative source plan/specification, or mandatory repository policy explicitly requires testing.
- Never infer testing from executable code, bug fixes, refactors, public APIs, risk, or nearby tests.
- Never require TDD or content-assertion tests for documentation-only missions.
- Never require a full application suite unless that exact requirement is explicitly present in the mission/source plan or mandatory repository policy.
- Never overwrite or fold unrelated uncommitted user work into a coordination commit.
- Never copy secrets, tokens, credentials, or sensitive values into agent prompts or mission files; point to the approved secret-management mechanism instead.
- Never use a stale plan as higher authority than the user's current instruction or verified repository state.
- Prefer concrete acceptance criteria over implementation instructions.
- Prefer repository evidence over assumptions about architecture.
