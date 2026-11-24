# Skill Library (Starter Packs + Private Local Sync)

WebHarness ships a native, read-only MCP provider (`providers/skill-library/`) behind `Local` (`server="skill-library"`). It exposes two tools — `find_skills` and `read_skill` — with strict file-policy checks, SHA-256 revision verification, bounded UTF-8 pagination, and offline BM25 search.

## Default Starter Packs & Privacy Boundary

Fresh clones work immediately with **3 tracked public starter packs (40 skills)** loaded from `skill-library/policy.example.json`, serving both as ready-to-use skills and as a template showing where to add your own:

| Starter pack | Skills | Contents |
|---|---|---|
| `critical-thinking` | 28 | MIT-licensed mental models (`thinking-first-principles`, `thinking-pre-mortem`, `thinking-model-router`, etc.) |
| `lateral-thinking` | 9 | `analogy`, `concept-fan`, `inversion`, `lateral`, `provocation`, `random-stimulus`, `scamper`, `six-hats`, `worst-idea` |
| `anthropic` | 3 | Apache-2.0 design skills (`frontend-design`, `canvas-design`, `theme-factory`) |

**Your personal skills are never pushed publicly:**
- Every other folder under `skill-library/packs/*` and the merged `skill-library/policy.json` are **gitignored** in `.gitignore` and excluded from public staging by `scripts/public-paths.sh`.
- When `skill-library/policy.json` exists locally, the server loads it; otherwise it falls back cleanly to `skill-library/policy.example.json`.
- `skills/` (retained ChatGPT session snapshots) and `agents/skills/` remain separate and are never implicitly exposed.

## Sync Your Local Skills (Skillshare or Custom Folder)

If you manage your skills with [Skillshare](https://github.com/runkids/skillshare) (`~/.config/skillshare/skills`), run one command from the repository root:

```bash
just sync-skills
# Equivalent: node scripts/sync-skillshare-library.mjs
```

What `sync-skillshare-library.mjs` does:
1. Preserves the 3 tracked starter packs untouched on disk so `git status` stays clean.
2. Reads `~/.config/skillshare/skills` (plus non-symlinked local skills in `~/.agents/skills` and optional extra packs in `~/.config/mcp-dev-bridge/skill-packs/`).
3. Copies regular UTF-8 files (dereferencing symlinks cleanly and skipping binaries/git/node_modules) into gitignored `skill-library/packs/<collection>/`.
4. Generates gitignored `skill-library/policy.json` combining the 3 starter packs + all local collections and validates it with `SkillLibrary.open().catalog()` before swapping it into place.

**Without Skillshare:** Point `--source` at any directory of `<skill-name>/SKILL.md` folders (or vault subdirectories), or set `MCP_SKILL_POLICY_FILE=/abs/path/to/policy.json` in `.env`:

```bash
node scripts/sync-skillshare-library.mjs --source /path/to/my-skills
./bin/webharness skills check
```

Restart the Local provider (or `just deploy`) after syncing so the running server reloads the updated `policy.json`.

## Discover & Read Tools

| Tool | Key arguments & bounds |
|---|---|
| `find_skills` | Optional `query`, `collection`, `limit` (`1..20`, default `3`), `cursor`, `mode` (`"lexical"` default offline BM25, or `"jev"`), `context` (Jev only). Returns compact cards (`id`, `description`, `revision`, `invocationHints`) — never full bodies. |
| `read_skill` | Required `id` and `revision` (64-hex SHA-256); optional `file` (approved pack-relative ID, omit for `SKILL.md`), `cursor`, `max_bytes` (`256..16384`, default `8192`). Verifies the full dependency set on every read; never executes helpers or grants tool authority. |

Typical calls through `Local`:

```json
{"server":"skill-library","tool":"find_skills","arguments":{"query":"thinking-pre-mortem","collection":"critical-thinking","limit":3}}
{"server":"skill-library","tool":"read_skill","arguments":{"id":"critical-thinking/thinking-pre-mortem","revision":"<returned-sha256>"}}
```

## Optional Jev Semantic Selection (`mode="jev"`)

Disabled by default so ordinary discovery stays 100% offline. To opt in:

1. Create a private mode-`0600` file (<=64 KiB) with `TYPESAFE_API_KEY=<key>` and optional `TYPESAFE_MODEL=jev-latest`.
2. Set `MCP_SKILL_JEV_ENABLED=1` and `MCP_SKILL_JEV_ENV_FILE=/abs/path/to/jev.env` in `.env` and re-render.
3. Pass `mode="jev"` and a single `collection` (each collection must be <=64 skills; unscoped calls fail with `JEV_SCOPE_TOO_LARGE` before any API request). Errors never silently fall back to lexical search.

## Deployment, Standalone Mode & CLI

- **Personal & Server profiles:** Include `server="skill-library"` behind `Local` (`tag:local`). For a skills-only client, run standalone stdio mode instead:
  ```json
  {"mcpServers":{"skill-library":{"command":"/abs/path/to/node","args":["/abs/path/to/webharness/providers/skill-library/server.mjs"]}}}
  ```
- **Operator CLI:**
  ```bash
  ./bin/webharness skills check
  ./bin/webharness skills check --policy skill-library/policy.example.json
  ./bin/webharness skills find --collection critical-thinking --query first-principles --limit 3
  ./bin/webharness skills read --id critical-thinking/thinking-first-principles --revision <SHA256>
  ./bin/webharness skills export --destination /new/path/skill-library
  ```

## Common Errors

| Code | Fix |
|---|---|
| `STALE_REVISION` / `STALE_CURSOR` | Re-run `find_skills` (without cursor) to get fresh revisions. |
| `POLICY_CHANGED` | Automatic when routed through `Local` (recycles `skill-library` once to apply the updated `policy.json`); restart standalone stdio servers manually. |
| `FILE_NOT_APPROVED` / `MISSING_DEPENDENCY` / `UNSAFE_FILE` | Re-run `just sync-skills` or fix the declared regular file in `policy.json`. |
| `JEV_SCOPE_TOO_LARGE` / `JEV_DISABLED` | Specify a single `collection` (<=64 skills), or use default `mode="lexical"`. |
