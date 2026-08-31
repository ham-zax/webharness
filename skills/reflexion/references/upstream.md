# Upstream and Adaptation Notes

Source project:

- Repository: NeoLabHQ/context-engineering-kit
- Upstream plugin path: plugins/reflexion
- Upstream skills: reflect, critique, memorize

This package is an adaptation for ChatGPT Skills rather than a verbatim copy.

Key compatibility changes:

1. The three upstream skills are consolidated into one `reflexion` skill with mode-specific reference files so it installs as a single ChatGPT Skill.
2. The upstream Claude hook that triggers reflection from a prompt keyword is not bundled. Instead, the skill description is written so requests containing "reflect" or "then reflect" can trigger the workflow natively.
3. Multi-agent critique does not require a Task/subagent tool. Without subagents, the three perspectives are performed as independent sequential passes and are described honestly as such.
4. Memory curation is generalized from a mandatory `CLAUDE.md` target to the repository's existing agent-instruction convention (`AGENTS.md`, `CLAUDE.md`, or a user-specified target).
5. Hostile or theatrical evaluator identity language is replaced with a rigorous evidence-first review stance. The quality gate remains strict without relying on threat-style prompting.
6. Repository evidence uses whatever connected local tools are actually available. In Hamza's ChatGPT Web setup, `wsl-web-harness` is the authoritative local execution connector. Testing remains opt-in under the governing implementation policy.

The core workflow remains: generate -> reflect/critique -> refine -> optionally curate durable lessons.
