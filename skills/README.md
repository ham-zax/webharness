# Session Skill Snapshot

This directory tracks the Skills that were exposed or invoked in ChatGPT and keeps a portable WSL-side snapshot with the harness. For the installed harness Skills, ChatGPT is the upstream copy: synchronization into this directory is explicit and one-time when requested, not a watcher or automatic mirror. `SNAPSHOT_SHA256.txt` reflects the current tracked skill tree, not an immutable historical byte snapshot.

## Included skills

1. `agent-browser`
2. `agent-work-planner`
3. `causal-coding`
4. `clean-migration`
5. `code-review`
6. `docx`
7. `frontend-design`
8. `job-application`
9. `lateral-thinking`
10. `learning-os-teacher`
11. `lingua-os-teacher`
12. `mcp-harness-router`
13. `pdfs`
14. `persistent-agent-loop`
15. `ponytail`
16. `reflexion`
17. `skill-creator`
18. `slides`
19. `spreadsheets`
20. `systematic-debugging`
21. `writing-plans`
22. `x-content`

## Provenance

The current ChatGPT runtime is the sole upstream for the 22 skill directories listed above. On an explicit synchronization request, each complete `/home/oai/skills/<name>` directory is copied byte-for-byte into `skills/<name>`, including helper scripts, references, binary assets, and executable modes. Downstream-only first-level skill directories are removed in the same synchronization so the repository skill set matches the session skill set exactly.

`README.md` and `SNAPSHOT_SHA256.txt` are repository snapshot metadata, not upstream skill payloads. No skill-specific files are synthesized, omitted, or locally patched during synchronization.

## Validation

Do not add local installability metadata or normalize an upstream skill directory: byte identity with the current session copy is the invariant. Verify the synchronized directory set and contents against the imported upstream snapshot, then regenerate the tracked checksum manifest deterministically:

```bash
bash scripts/skill-snapshot.sh write
bash scripts/skill-snapshot.sh check
```

The checksum manifest covers regular files under `skills/` except the manifest itself. The repository publication policy treats all `skills/*` paths as private-only.

## Fresh ChatGPT installation

The WSL bootstrap does not silently install Skills into a ChatGPT account or workspace. ChatGPT owns its installed-Skill state and remains upstream; this repository is only a portable downstream snapshot that changes on explicit synchronization.

When reusing a bundle elsewhere, keep each skill directory intact so its `SKILL.md` and every supporting file travel together. ChatGPT-side Skill installation remains separate from connecting the MCP endpoint and completing OAuth.
