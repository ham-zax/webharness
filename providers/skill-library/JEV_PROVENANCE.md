# Optional Jev selection provenance

The native Node implementation ports only the selection and protocol pieces
needed by this provider. It does not copy the upstream catalog, filesystem
reader, lexical index, CLI, installer, cache, credential keychain, retry manager,
or concurrent routing runtime. No JevShelf installation is required.

- JevShelf revision `8cdd151469ae643b1379d9a00a240471990882d3`,
  `src/jevshelf/selection.py`: capability/exclusion evidence windows,
  applicability and usefulness questions, three-level usefulness rubric.
- JevShelf's pinned `jev-skill-router` 0.4.1, revision
  `b3be6ec9545fc2526abaa8be135fbe0bd34b78e9`,
  `src/jev_skill_router/router.py`: rank choice, six-candidate verification,
  fit >= 0.65, usefulness >= 1.5 and confidence >= 0.50 acceptance;
  `evidence.py`: fallback evidence sampling; `jev.py`: typed probability,
  choice/score validation and fixed TypeSafe HTTP request shape.
- API contract checked against https://docs.typesafe.ai/api on 2026-10-12.

Native changes: two calls per route, no retries/cache, scope capped at 64 skills,
24,000-byte request preflight, 64 KiB response cap, 30-second cancellation,
server and per-call opt-in, sanitized errors. Scope that cannot fit is rejected
before model calls rather than silently truncated. Source instructions retain
their invocation restrictions and remain subject to host/operator authority.

Both sources are MIT licensed. Their notice is retained in JEV_LICENSE.
