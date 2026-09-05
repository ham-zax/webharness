# Session Skill Snapshot

This directory tracks the Skills that were exposed or invoked in ChatGPT and keeps a portable WSL-side snapshot with the harness. For the installed harness Skills, ChatGPT is the upstream copy: synchronization into this directory is explicit and one-time when requested, not a watcher or automatic mirror. `SNAPSHOT_SHA256.txt` reflects the current tracked skill tree, not an immutable historical byte snapshot.

## Included skills

1. `agent-work-planner`
2. `brainstorming`
3. `context-audit`
4. `dispatching-parallel-agents`
5. `executing-plans`
6. `finishing-a-development-branch`
7. `mcp-harness-router`
8. `moyu`
9. `persistent-agent-loop`
10. `receiving-code-review`
11. `reflexion`
12. `requesting-code-review`
13. `skill-creator`
14. `subagent-driven-development`
15. `superpowers-web-adapter`
16. `systematic-debugging`
17. `test-driven-development`
18. `using-git-worktrees`
19. `using-superpowers`
20. `verification-before-completion`
21. `writing-plans`
22. `writing-skills`
23. `agent-browser`
24. `causal-coding`

## Provenance

- The 14 Superpowers skills come from the locally installed `superpowers` 6.2.0 bundle whose `brainstorming`, `using-superpowers`, and `writing-skills` entrypoints were checked against the versions exposed in this session. The complete local skill directories were copied so helper/reference files omitted by the ChatGPT Web resource view are preserved along with executable permissions.
- `agent-work-planner` is materialized from the currently installed ChatGPT Skill, including its UI metadata, icon, agent prompt template, and coordination-package template.
- `agent-browser` is materialized from the installed ChatGPT browser Skill with harness routing for two Local browser surfaces: routine Windows/WSLg interaction uses experimental `browser-fast` `observe`/`execute`, including bounded read-only site/platform/policy memory returned by observation; DevTools diagnostics use `browser-devtools`, and isolated/Electron automation keeps the existing `agent-browser` CLI workflow.
- `causal-coding` mirrors the currently installed ChatGPT implementation-mutation policy bundle, including its UI metadata and icon.
- `job-application` and `x-content` are intentionally excluded from the tracked snapshot and ignored by Git. They may exist locally for ChatGPT-side/private workflow synchronization, but canonical Git history does not carry those private bundles.
- `mcp-harness-router` mirrors the currently installed ChatGPT router bundle and is maintained alongside harness behavior such as the installed `wsl-term` handoff path and the durable wait/RPC boundary.
- `persistent-agent-loop` mirrors the currently installed ChatGPT bundle. Its compact `SKILL.md` directly references `references/protocol.md` so ChatGPT can load the detailed mission/checkpoint/recovery protocol only when needed. It composes with `agent-work-planner` when planning/replanning is needed, understands native timer versus event waits, preserves in-mission steering without accidental termination, and treats Kitty presentation as optional visibility over the same tmux-owned Terminal process.
- `superpowers-web-adapter`, `context-audit`, `moyu`, and `reflexion` were materialized from the session-exposed resources. Their resource reader exposes the instruction body without YAML frontmatter, so valid `name`/`description` frontmatter was added without changing the body.
- `skill-creator` uses the locally installed official OpenAI system Skill Creator bundle. The session resource view is useful for reading instructions but is not byte-preserving for executable source because escaped newlines inside scripts are rendered as literal line breaks; the local canonical bundle is therefore safer and executable.
- `agents/openai.yaml` files for the Superpowers bundles are local ChatGPT UI metadata added for installability; their upstream `SKILL.md` and helper files are otherwise copied unchanged.
- `LICENSES/superpowers-LICENSE.txt` preserves the license shipped with the copied Superpowers package. Skills with their own session-exposed licenses keep those licenses inside their directories.

## Validation

Every first-level skill directory must contain:

- `SKILL.md` with valid YAML frontmatter;
- `agents/openai.yaml` with a display name and short description.

Validate each Skill with the installed OpenAI Skill Creator validator, then verify that the checksum manifest exactly covers the current tracked Skill tree:

```bash
VALIDATOR="$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py"
for dir in skills/*/; do
  [ -f "$dir/SKILL.md" ] || continue
  python3 "$VALIDATOR" "$dir"
done
bash scripts/skill-snapshot.sh check
```

After an intentional tracked Skill change, regenerate the manifest deterministically with `bash scripts/skill-snapshot.sh write`, then rerun the check. The repository publication policy treats all `skills/*` paths as private-only.

## Fresh ChatGPT installation

The WSL bootstrap does not and cannot silently install these Skills into a new ChatGPT account/workspace. ChatGPT owns its installed-Skill state and is upstream for the harness bundles synchronized here; this repository is a portable WSL snapshot and changes only when explicitly synchronized.

For a new ChatGPT environment, install the desired bundles from this directory through ChatGPT's Skills UI (`Plugins` -> `Skills` -> `Create` -> upload from your computer). Package/upload one skill directory at a time so its `SKILL.md`, `agents/openai.yaml`, and supporting resources remain together. Validate the directory first with the command above.

At minimum, install `mcp-harness-router` when you want the local Dev/Code/Terminal/Local routing policy from this repository, and install the tracked `agent-browser` replacement when you want browser requests to choose fast resource-local interaction, DevTools diagnostics, or the isolated `agent-browser` CLI correctly. `job-application` and `x-content` remain separately managed private ChatGPT-side skills and are not sourced from this Git snapshot. Removing a local extension does not remove its ChatGPT Skill automatically, so uninstall that Skill separately when retiring the domain workflow. Also install `persistent-agent-loop` when conversations should run long-lived, steerable missions across durable waits, native timers/event wakeups, checkpoints, optional live Kitty/tmux observation, and repeated tool work. Install `agent-work-planner` when you want human-launched multi-session planning and coordination; it hands long-lived execution to `persistent-agent-loop` rather than duplicating lifecycle mechanics. Supporting files such as `persistent-agent-loop/references/protocol.md` and `agent-work-planner/references/*.md` must stay in their uploaded Skill directories so ChatGPT can load them progressively when referenced. The other tracked Skills are reusable workflow/process bundles and may be installed as desired. ChatGPT-side Skill installation is separate from connecting the MCP endpoint and completing OAuth.
