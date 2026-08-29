# Contributing

Keep changes small, explicit, and easy to verify. This repository has a public bridge surface plus private personal-harness extensions; preserve that boundary.

## Before changing code

Read:

- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Development](docs/development.md)

If a change affects trust profiles, generated configuration, lifecycle, OAuth continuity, Terminal lifetime, or the model-facing tool surface, update the relevant current documentation in the same change.

## Verification

Use the smallest validation that directly establishes the changed behavior or contract. See [Development](docs/development.md) for available syntax/static checks and long-running command guidance.

For documentation-only changes, run `node scripts/check-doc-links.mjs`, scan for stale paths/claims, and use `git diff --check`.

## Documentation rules

- Primary docs describe the current accepted system, not project chronology.
- Put benchmark/design/plan archaeology under `docs/history/`.
- Do not copy private deployment identity, OAuth/session state, or credentials into public-facing files.
- Keep important old documentation URLs as small compatibility pointers when paths move.
- Prefer one authoritative explanation and links over duplicated guidance.

## Git hygiene

Use focused commits. Do not rewrite or force-delete other worktrees/branches without explicit ownership. Do not commit `.env`, generated state, OAuth/session files, logs, or runtime directories.
