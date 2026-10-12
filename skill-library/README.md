# Bundled skill library

This distributable library is separate from the retained ChatGPT snapshot in
`skills/` and machine-local `agents/skills/`.

- `policy.json`: approved readable files and compatibility declarations.
- `packs/thinking/`: 28 unchanged instruction-only skills, MIT license and provenance.

Metadata and revision hashes are calculated in memory; there is no generated
catalog file to maintain. Upstream license and provenance files stay with packs.
Use `./bin/webharness skills check` after reviewed changes.
See [the guide](../docs/skill-library.md) for deployment, MCP, updates and exports.
