# Bundled skill library

This distributable library is separate from the retained ChatGPT snapshot in
`skills/` and machine-local `agents/skills/`.

- `policy.json`: approved readable files and compatibility declarations.
- `catalog.json`: reproducible metadata, not access authority.
- `packs/thinking/`: 28 unchanged instruction-only skills, MIT license and provenance.

Use `./bin/webharness skills check` from the repository root. After a reviewed
update, use `./bin/webharness skills compile` and rerun checks.
See [the guide](../docs/skill-library.md) for deployment, MCP, updates and exports.
