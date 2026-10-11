# Native skill library implementation

## Goal and authority

Implement the design approved in the conversation: self-contained skill files,
native deterministic discovery and bounded reads, generated metadata separated
from explicit access policy, dependency-wide revisions, and an explicit deployment
authorization boundary. Preserve `skills/` and `agents/skills/` unchanged.

Baseline: README, docs/architecture.md, docs/configuration.md, docs/security.md,
docs/compatibility.md, docs/development.md, scripts/public-paths.sh.
Start: main, ed7b61883db3d71b5a636a208f77250a0cbcb5d6, clean worktree, upstream 0/0.
Execution: inline, no delegation (user requested solo implementation).
TDD Route: off / skipped, from user-local Aegis tdd_mode=off. Meaningful post-change
regression tests cover security, stale dependencies, pagination and MCP routing.

## Architecture and minimum change

New provider owns policy validation, catalog derivation, lexical discovery and
revision-bound reading. Existing Local remains the five-tool routing owner;
templates/installers/doctor receive wiring only. No JevShelf, Skillshare, model
API or credentials are needed. Bundle all 28 MIT-licensed cc-thinking-skills
with attribution and unchanged payloads. No other personal collections are
silently imported. `catalog.json` is reproducible derived data; `policy.json`
explicitly names each readable file and compatibility requirements.

Two logical tools: find_skills and read_skill. Exact names take priority; query
search is lexical and may return no candidates. Collection browse is paginated.
Read revision covers all declared readable dependencies and their policy mapping.
No path supplied by MCP can expand the policy. Changed policy or dependencies
requires rediscovery/restart, never silent mixing. Files may be read, not executed.
Dependency completeness and runtime compatibility are separate reported claims.

Local integration is for the already powerful Personal/Server authority domain.
Standalone stdio deployment exposes only the two read-only tools; operators must
provide separate gateway authorization for skills-only remote clients. No new
gateway/scope framework is introduced. Existing smaller profiles stay unchanged.

## Tasks and acceptance

1. Add bounded filesystem/policy validation, metadata derivation, search, reader,
   two-tool MCP server and operator CLI. Keep each owner below 400 lines.
2. Bundle approved thinking files, license and provenance; generate catalog.
   Test exact queries, paraphrase browsing, no-result, missing assets, YAML flags,
   changed references, policy changes, path/symlink escapes, UTF-8 continuation.
3. Wire Personal/Server templates, setup, CI, doctor and Local discovery guidance.
   Verify real stdio find/read and calls through Local without expanding its ABI.
4. Document policy, completeness/compatibility claims, deployment and updates.
   Check staged public content is self-contained; run the repository portable gate.
5. Review diff and existing-tree preservation; commit the coherent verified task.

No live deployment, source cleanup, hosted ranking, broad corpus migration, or
public publication is required. A real ChatGPT session remains a separate client
qualification; portable integration must prove protocol calls through Local.

## Checkpoint

Implementation and solo source review complete. Native provider, explicit policy,
28 byte-identical MIT payloads, generated catalog, CLI, Personal/Server wiring,
publication classification and documentation delivered. Original skill trees unchanged.

Verification: full portable gate passed (476 Node tests plus shell suites), all 15
focused skill tests passed, real Local/inner-1MCP/provider find/read passed, and a
relocated minimal repository passed offline npm ci and retrieval with PATH-only
environment. Checksum/catalog and documentation/syntax checks passed.

Two pre-existing portable-gate issues were repaired at their test owners: smoke
expected Agent Browser 0.35.0 despite the current package pin 0.38.2; a browser
unit test contacted live CDP port 9222 and now uses an ephemeral local fixture.
Browser production behavior was not changed.

Staged-public native library/catalog check passed without either old skill tree;
public files include provider tests, policy, licenses and all payloads. The broader
staged publication suite has one pre-existing documentation failure: operations.md,
personal/harness.md and personal/non-native-ai-mcp-python.md link to the excluded
websession-clients.md. This is a public-release limitation, outside skill-library
implementation; source portable checks pass. No public release is claimed.

Implementation complete; remaining checkpoint action is local task commit.
No live configuration restart or client OAuth qualification is claimed.
