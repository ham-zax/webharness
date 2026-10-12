# Intent — Import Skillshare Backup Skills

- Requested outcome: integrate the user's selected Skillshare-managed skills
  from `my-skills-backup` into WebHarness's native skill library, verify the
  behavior and source fidelity, then make a local commit.
- Scope: backup `skills/` packages that match the current Codex/agents
  Skillshare-managed paths, plus referenced hidden specialist skill packages;
  explicit policy/provenance/adaptation data; generated catalog; checks and
  local commit.
- Non-goals: copy backup configuration or Git internals; import credentials or
  personal runtime state; alter `skills/` or `agents/skills/`; retain runtime
  dependence on the backup checkout, JevShelf, or Skillshare; alter provider
  behavior without evidence; change live deployment configuration; publish.
- Parent plan: `docs/aegis/plans/2026-10-12-import-skill-backup.md`.
- Baseline: branch `main`, HEAD `4b1a36982896d375f0ec8295bec4d88c35aa40e6`.
  Pre-existing staged task-related files: `docs/skill-library.md` and
  `docs/prompts/skill-library-import.md`.
- Baseline refs read: `docs/skill-library.md`, current skill policy, provider
  library/policy owners, source backup README, direct Skillshare link inventory.
- Baseline usage: acknowledged and cited above; no missing authority reference.
- Confirmed source inventory: 105 backup skill packages; 46 match direct
  Codex/agents links; 58 are hidden specialist packages to validate as selected
  dependencies; the backup differs from installed `SKILL.md` bytes for eight
  linked packages. The backup snapshot is the requested source of copied bytes.
- Risks: explicit readable policy can be incomplete if local references are
  missed; skill instructions are untrusted; some skills require tools absent
  from a base WebHarness setup; source licenses vary and must remain attributed.
- Success evidence: source/copy SHA-256 match, local-reference review, generated
  catalog check, representative CLI and Local MCP discovery/reads, relocated
  library checks, repository checks, unchanged protected directories, reviewed
  diff, and local commit receipt.
- Stop states: `done | blocked | needs-verification | scope-exceeded`.
- TDD: off; strict TDD skipped. Use existing tests and requested data/provider
  checks after import.
