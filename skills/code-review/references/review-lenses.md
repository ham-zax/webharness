# Review Lenses

Use lenses selectively. Correctness, contracts, error/state flow, available verification evidence, and simplicity are baseline; activate deeper lenses only when the changed surface provides a signal.

## Baseline lenses

### Correctness and requirement fit

- Does current behavior match the stated requirement/spec and tests?
- Are boundary values, empty/missing inputs, alternate states, and negative paths handled where relevant?
- Are results derived from the right data and units?
- Does new control flow leave stale or partially-updated state?
- Does a bug fix repair the root cause or merely hide the observed symptom?

For a requirement that depends on runtime reachability, trace from an entry point through guards and dispatch rather than approving on local static reasoning alone.

### Contracts and compatibility

Check public APIs plus implicit contracts between modules:

- argument/return semantics;
- error conventions;
- serialization/schema shapes;
- config/environment semantics and defaults;
- CLI/output behavior scripts may consume;
- events/messages/webhooks;
- persisted data compatibility;
- library or endpoint callers.

Before claiming "breaks callers", find callers or a documented compatibility promise. Prefer preserving an existing stable contract unless the change explicitly includes migration/versioning.

Watch for flags/options that mutate an existing API's semantics when a separate operation or explicit error would make the contract clearer.

### Error handling and state transitions

- Recoverable conditions should not become fatal process-wide failures without a compelling invariant.
- Do not mix incompatible success/error conventions.
- Preserve causal context when translating errors.
- Do not swallow an error when downstream code will proceed with invalid state.
- When a follow-up side effect depends on prior success, track success explicitly rather than applying the follow-up to the entire input set.
- Check cleanup/rollback on partial failure.
- For retries, check idempotency before calling duplicate execution dangerous.

### Existing tests and verification evidence

- Treat existing or changed tests as evidence, not as automatic work to add or run.
- A useful test should fail for the wrong behavior the requirement cares about and prefer observable behavior over implementation-detail assertions.
- A test that cannot reach the changed path is not evidence for that path.
- If testing is independently required by the user, an authoritative user-approved specification, or mandatory repository policy, verify that the required test contract is actually satisfied.
- Do not demand new regression/business/error/integration tests merely because code changed, a bug was fixed, or extra confidence would be useful. Missing optional coverage is not a review defect by itself.

### Simplicity and maintainability

Evaluate conceptual load, not line count alone.

Look for:

- extra modes, flags, parameters, wrappers, or abstractions without current need;
- a refactor that relocates complexity instead of deleting branches/concepts;
- feature-specific logic leaking into a shared/general module;
- a bespoke near-duplicate of an existing canonical helper;
- repeated conditionals on the same state shape suggesting a missing model/dispatcher;
- hidden contracts where a caller must initialize/setup something for a callee that should own or explicitly receive it;
- middle-man wrappers that add indirection without policy or semantic value;
- dead paths/shims made unreachable by the change.

Do not mechanically enforce DRY. Two concrete uses can be clearer than one premature abstraction.

## Conditional lenses

### Authentication, authorization, secrets, and external input

Activate when changed paths involve auth, roles/permissions, tokens/secrets, user-controlled input, external APIs, SQL, file paths, templates/rendering, or tenant/user scoping.

Check:

- authorization at the resource/action boundary, not merely authentication;
- tenant/owner filters through joins/subqueries/lookups;
- parameterized queries and safe command/path construction;
- output encoding where untrusted data reaches HTML/JS/shell/SQL contexts;
- secrets excluded from source/logs/output;
- external API responses treated as untrusted and shape-validated before destructuring/use;
- parsed numbers/JSON/enums validated immediately after parsing;
- sanitization/redaction applied at every outbound path, including retries/fallbacks/error handlers;
- data that will be transformed and written back is not destructively redacted into placeholder content.

Escalate to ChatGPTlium when security is the primary task.

### Concurrency, async, timers, queues, and shared state

Activate for threads, async/await, promises, goroutines, actors, locks, queues, callbacks, timers, shared caches/state, or concurrent requests.

Check:

- unsynchronized shared mutation;
- lock ordering/deadlock;
- synchronization primitive matches the actual invariant (avoid heavyweight locks for a simple atomic state when project/language semantics support a clearer primitive);
- cancellation/timeouts propagate;
- callbacks re-check cancellation/error guards at the point of side effect, not only before dispatch;
- fan-out/concurrency is bounded where workload can grow;
- async errors are observed, not detached/swallowed;
- success-dependent follow-up actions use the set of operations that actually succeeded;
- retries do not duplicate non-idempotent side effects.

A theoretical interleaving is not a Major by itself. Demonstrate a credible interleaving and harmful result.

### Memory, lifetime, native/unsafe code, and FFI

Activate for C/C++, Rust `unsafe`, native extensions, manual allocation, raw pointers/handles, buffers, memory-mapped regions, ABI/FFI boundaries, or resource-lifetime changes.

Check:

- references/pointers/handles do not outlive their owner or backing storage;
- initialization occurs before publication or executable/use-visible state;
- bounds, sizes, alignment, ownership transfer, and nullability match the called API/ABI;
- all success and error paths release resources exactly once;
- no use-after-free, double-free, stale pointer, uninitialized read, or buffer overrun becomes reachable;
- concurrency ordering does not publish partially initialized state;
- unsafe/native wrappers preserve the actual cost and failure semantics rather than hiding them behind a misleading abstraction.

Do not infer memory unsafety from unfamiliar syntax. Trace allocation/ownership/lifetime through the concrete path.

### Data, database, schemas, migrations, and persistence

Activate for migrations, ORM models, queries, indexes, schemas, storage formats, event/data contracts.

Check:

- tenant/user scoping;
- migration compatibility with old/new application versions during rollout;
- expand/contract ordering for destructive changes;
- defaults/nullability/backfill behavior;
- constraints and referential integrity;
- query correctness under concurrent writes where relevant;
- N+1/unbounded result sets;
- index need tied to an actual query/access pattern rather than speculation;
- persisted format/API compatibility;
- rollback/recovery for destructive operations.

Treat naturally idempotent DDL/upserts as counter-evidence to duplicate-execution alarms.

### External I/O and resilience

Activate for HTTP/RPC/database/cache/queue/file/process dependencies.

Check:

- timeout/cancellation behavior;
- retry policy, backoff/jitter, and idempotency;
- partial failure handling;
- dependency failure does not silently become wrong success;
- unbounded buffers/queues/fan-out;
- correlation/diagnostic context for new failure paths when the project relies on it;
- synchronous/blocking work inside async execution when materially harmful.

Do not demand elaborate resilience machinery for a bounded low-risk internal call without evidence.

### Performance

Activate for explicit performance claims, hot paths, loops/queries/render paths, large-data processing, allocation-sensitive code, or algorithmic changes.

Check:

- algorithmic complexity and whether input is actually unbounded;
- repeated I/O/query work (N+1);
- avoidable large copies/allocations in hot paths;
- pagination/bounds;
- redundant renders/computation;
- contention introduced by synchronization;
- benchmarks that match real workloads when a performance improvement/regression claim is central.

Do not block on speculative micro-performance. If complexity is unchanged and bounded, request measurement before claiming a regression.

### Dependencies and lockfiles

Activate when manifests/lockfiles change.

Check:

- whether the existing stack/standard library already solves the need;
- direct dependency version and migration/changelog implications when available locally;
- lockfile delta matches the manifest intent;
- unexpected transitive additions or source/registry changes;
- license/policy requirements documented by the repo;
- available build/test evidence around behavior supplied by the dependency; do not run tests unless independently authorized.

Do not hand-edit lockfiles and do not infer vulnerability status from memory. A dedicated security/supply-chain review may be required for security verdicts.

### Build, CI, configuration, infrastructure, and defaults

Activate for Dockerfiles, workflows, deployment scripts, IaC, manifests, build-system/config changes, feature flags, env vars.

Check:

- defaults are safe for supported environments;
- configuration does not duplicate an existing control without need;
- CI does not mask failures;
- build/deploy remains reproducible; when reviewing a commit series or when repository policy requires it, intermediate commits remain buildable/bisectable rather than depending on manual fixups;
- secrets are not introduced;
- destructive rollout has a credible recovery/rollback path;
- config changes match runtime consumers;
- new flags have a caller/rollout/expiry story.

### UI and accessibility

Activate for UI/rendering/input changes.

Check:

- loading/error/empty states;
- keyboard/focus semantics and accessible labels for changed interactions;
- stale state and race conditions between requests/interactions;
- untrusted content rendering;
- behavior at responsive/boundary states relevant to the component;
- unnecessary rerenders only when materially evidenced.

### Documentation and comments

Activate when code changes public behavior, setup, config, API, or non-obvious invariants.

Check:

- docs/comments still describe actual behavior;
- stale names/paths/examples were updated;
- public contract changes have migration/setup documentation when users need it;
- comments explain non-obvious why, not restate code.

Wrong documentation can be a correctness issue when users/operators rely on it; missing polish is usually Minor.

## Structural remedy vocabulary

When a structural finding is real, name a concrete direction rather than merely saying "too complex":

- collapse duplicate branches;
- separate orchestration from business policy;
- move feature-owned behavior out of a shared module;
- reuse the canonical helper;
- make an implicit type/state boundary explicit;
- delete a pass-through wrapper;
- remove an unused flag/parameter;
- replace repeated state conditionals with one explicit model/dispatcher;
- split a file/module only when the split reduces concepts/coupling rather than relocating them.

Prefer the remedy that removes moving pieces.