# Skill Library

Read-only local skill packs served by `providers/skill-library/`.

## Default starter packs (tracked & ready out of the box)

WebHarness ships **3 starter packs (40 skills)** in `skill-library/packs/` via `policy.example.json` so fresh installs work immediately and show how custom packs are structured:

- `packs/critical-thinking/` — 28 MIT-licensed mental-model and decision-analysis skills (including `thinking-model-router`)
- `packs/lateral-thinking/` — 9 lateral-thinking skills (`analogy`, `concept-fan`, `inversion`, `lateral`, `provocation`, `random-stimulus`, `scamper`, `six-hats`, `worst-idea`)
- `packs/anthropic/` — 3 Apache-2.0 Anthropic design skills (`frontend-design`, `canvas-design`, `theme-factory`)

## Adding your own private skills (gitignored)

Every other folder added under `skill-library/packs/` and `skill-library/policy.json` are **gitignored** and excluded from public staging so personal or Skillshare skills are never pushed publicly.

Sync your local Skillshare library (or any `--source DIR` folder) into gitignored packs + `policy.json`:

```bash
just sync-skills
./bin/webharness skills check
```

See [docs/skill-library.md](../docs/skill-library.md) for setup, Skillshare sync, Jev mode, and CLI commands.
