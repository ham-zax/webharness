# Bundled skill library

This distributable library is separate from the retained ChatGPT snapshot in
`skills/` and machine-local `agents/skills/`.

- `policy.json`: approved readable files and compatibility declarations for every
  collection.
- `packs/`: source snapshots; the policy enables 150 skills across nine
  collections. Matt Pocock and Addy Osmani entries are disabled and cannot be
  discovered, selected, read or exported through the provider.


`packs/active/` carries the bundled Aegis method pack so its instructions are
readable through the same native reader. Each collection keeps its own `LICENSE`
and `PROVENANCE.md`; those notices and per-skill third-party files are preserved.

Metadata and revision hashes are calculated in memory; there is no generated
catalog file to maintain. Upstream license and provenance files stay with packs.
Use `./bin/webharness skills check` after reviewed changes.
See [the guide](../docs/skill-library.md) for deployment, MCP, updates and exports.