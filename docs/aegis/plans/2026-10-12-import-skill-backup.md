# Import Skillshare Backup Skills Into the Native Library

## Goal

Bring the skills Hamza selected from the `my-skills-backup` snapshot into
WebHarness's native read-only skill library, retaining complete source
packages and their provenance while making the result independent of the
backup checkout, Skillshare, and JevShelf at runtime.

## Architecture

`providers/skill-library/` remains the sole owner of discovery and reads.
The change is explicit policy and payload under `skill-library/`; generated
`catalog.json` remains derived metadata. JevShelf-dependent entry skills receive
small WebHarness dispatch wrappers, with original payloads retained beside
separate adaptation notes. Their specialist packages must stay out of ordinary
browsing and be reachable through explicit shim-scoped discovery. The current
provider exposes every policy skill in normal discovery, so implement and verify
the smallest discovery-visibility change before copying specialist payloads.

## Tech Stack

Markdown skill packages, JSON policy/catalog, Node.js MCP provider and CLI,
SHA-256 manifests, and the repository's existing shell/Node verification.

## Baseline and Authority References

- User request and its clarified source boundary: backup packages must also be
  Skillshare-managed Codex/agents skills; bundle specialist dependencies that
  the selected entry skills reference.
- `docs/skill-library.md` — explicit readable-file policy, generated metadata,
  dependency-wide revisions, completeness/compatibility separation, export and
  Local MCP contract.
- `skill-library/policy.json` and `skill-library/catalog.json` — current
  library data and generated baseline.
- `providers/skill-library/library.mjs`, `policy.mjs`, `catalog.mjs`, and the
  provider tests — discovery/read owners and constraints.
- Existing `skills/` and `agents/skills/` must remain byte-for-byte unchanged.
- Initial worktree: branch `main`, HEAD
  `4b1a36982896d375f0ec8295bec4d88c35aa40e6`. Two task-related documentation
  paths were already staged before this plan: `docs/skill-library.md` and
  `docs/prompts/skill-library-import.md`; retain them in the task commit.

## Compatibility Boundary

- Candidate source is the backup's `skills/` tree only. Do not copy its
  `.git/`, `config/`, or any credentials or personal runtime state.
- Include the 46 package paths that match direct Codex/agents Skillshare links,
  and the 58 specialist packages present in the backup and Skillshare source
  behind those entry skills. The installed `cachebeat` package is outside the
  direct-link intersection and requires Claude Code background Task APIs.
- Keep the 58 specialist packages behind their existing routers; do not make
  them ordinary browse results. The existing 28-skill `thinking` pack already
  backs the critical-thinking shim and must not be duplicated.
- `jevshelf-marketing` is in the direct-link intersection, but its referenced
  50-skill collection is absent from both the backup and Skillshare source.
  Academic and Addy specialists also name repository-level reference material
  not present in their skill packages; resolve and bundle these before claiming
  those workflows complete.
- The backup snapshot is canonical for copied bytes. Record its drift from the
  installed source for the eight linked skills whose `SKILL.md` differs.
- Adapt JevShelf routing to native `find_skills` / `read_skill`; preserve each
  original payload and invocation restriction.
- Keep `skills/`, `agents/skills/`, provider code, and live deployment
  configuration unchanged. Do not publish.
- Exclude and document skills that require unavailable host capabilities, and
  document all installed plugin skills outside the clarified backup/Skillshare
  source boundary.

## Change Necessity

The existing library owner already supports explicit per-skill readable files,
compatibility declarations, dependency-wide revisions, generated catalogs,
export, and Local MCP reads. It does not support shim-only discovery, so the
policy/catalog/provider contract needs a narrow visibility rule: ordinary
browse omits specialist records, while an explicitly selected shim collection
can search them and receive normal revision-bound reads.

## TDD Route

- Mode: `off`.
- Decision: `skipped` for strict TDD.
- Authority: no user request for test-first development.
- Test posture: verify imported data through source hashes, policy/catalog
  checks, representative discovery/read workflows, Local MCP calls, relocation,
  and existing repository checks.
- Reason: this is a data-only expansion to an existing reader contract; existing
  tests plus the requested end-to-end checks cover the change without adding a
  separate regression test suite.

## Tasks

1. Finish source/dependency and capability inventory. Present the exact proposed
   list before copying. Identify source differences, local references,
   invocation hints, and unsupported host-specific requirements. Do not copy
   plugin packages or Skillshare runtime configuration.
2. Implement and verify shim-only specialist discovery, then copy complete
   selected package trees into new `skill-library/packs/`
   directories as real files. Add per-pack provenance and adaptation records;
   preserve original payload hashes and create minimal WebHarness wrappers only
   where JevShelf is required.
3. Extend `skill-library/policy.json` with explicit readable-file sets and
   separate compatibility declarations. Regenerate `catalog.json` only through
   the existing compiler.
4. Verify source hashes, references, policy completeness, representative
   workflows, Local MCP discovery/read, and export relocation from a standalone
   copy. Run relevant repository checks and review the full task diff, including
   confirmation that `skills/` and `agents/skills/` stayed unchanged.
5. Commit the verified task paths locally, read back the commit and task delta,
   and report inclusion/exclusion counts, adaptations, checks, and limitations.

## Verification and Risks

Success requires every included skill to have an explicit readable set and
compatibility status; no symlinks or source-checkout paths in copied payloads;
all source-file hashes to match their preserved originals; all declared local
references to resolve; complete native discovery/read through the provider and
Local route; successful relocation without the source backup or Skillshare;
and a reviewed local commit. Skill text is untrusted guidance and grants no
authority. Executable helpers are copied but not run unless a representative
workflow specifically requires a safe read-only invocation. Skills needing
external MCPs or unavailable provider-specific tools remain marked
`requires-tools`/`unverified`; this is distinct from package completeness.

## Execution Route

Inline and solo, as requested. The data import is tightly coupled through the
shared policy/catalog owner, so parallel writers would add coordination without
reducing risk.
