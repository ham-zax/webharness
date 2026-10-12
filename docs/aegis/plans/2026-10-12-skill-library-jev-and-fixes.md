# Optional Jev selection and review fixes

User authorizes four reviewed fixes through Codex Luna max and optional Jev
implementation using the minimum useful JevShelf code. Start HEAD: 4b1a369.
Preserve the pre-existing staged import prompt/guide and separate import workstream.

Baseline read-set: docs/skill-library.md, docs/security.md, docs/configuration.md,
docs/compatibility.md, provider source and tests. All acknowledged. Policy and
reader remain canonical file-access owners. Behavioral defects and absent
semantic selection require code changes. TDD mode is off in user-local Aegis;
use diagnostic reproductions and meaningful post-change regression tests.

Port only JevShelf applicability/usefulness questions, evidence sampling and
selection thresholds, plus pinned router typed HTTP validation. Preserve MIT
attribution. No JevShelf/Python installation, new dependency, index, cache or
background service. Default find remains offline and lexical. mode=jev requires
server opt-in plus credentials; send task/context, approved metadata and bounded
SKILL.md excerpts only to fixed TypeSafe HTTPS. No script execution/new authority.
Keep two logical tools and five outer Local tools. selected/no_match/uncertain
remain distinct; never silently substitute lexical results for a Jev error.

Limits: 64 approved skills, 24000-byte requests, six verification candidates,
three selections, two HTTP calls, bounded response and 30-second route deadline.
Scopes exceeding limits require narrowing before paid calls. No semantic paging.

Worker 3ffb8f2d25d8 (Codex gpt-6-luna max, terminal 22171) owns files/policy/
catalog/library/cli modules, new fixes tests and policy/catalog data. It fixes
router adaptation while preserving upstream bytes, pagination progress,
executable export modes and catalog check bounds. No staging/commit/live edits.

Parent owns new Jev modules/tests, attribution, server schema and docs. After
worker hand-back, integrate mode/context through library/server/CLI and optional
private credential-file path rendering. Preserve all prior user edits.

Verify four regressions, native/no-network default, semantic acceptance and
abstention, invalid responses, timeouts/cancellation, limits, stdio/Local routing,
source fidelity and portable gate. Use a harmless live public-thinking query
with existing credentials if available. Close worker, review integrated diff,
and stage only task changes. No bulk import, binary expansion, public publishing
or unrelated refactors. Later user steering removes catalog.json/compile and
trims visible hash/license metadata: check/export derive metadata in memory.
User also authorizes a semantic local commit preserving prior staged import work,
and relevant old-review repairs: explicit invocation guidance, CI uv provisioning
and registering the live provider after verification. Preserve OAuth/state and
Terminal identities. Subsequent explicit authorization enables hosted ranking
in the real deployment using the existing private Browser Jev credential file;
new deployments remain disabled by default. Fresh
ChatGPT-session qualification remains client-dependent.

Sources: JevShelf 8cdd151469ae643b1379d9a00a240471990882d3,
src/jevshelf/selection.py; pinned jev-skill-router 0.4.1 revision
b3be6ec9545fc2526abaa8be135fbe0bd34b78e9,
src/jev_skill_router/{router,jev,evidence}.py. Both MIT licensed.
Primary API reference https://docs.typesafe.ai/api captured with Khiip.
