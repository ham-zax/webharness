# Agent Portability

Ponytail is an agent-portable skill distribution. The upstream `skills/` hold the core behavior; host-specific files are adapters that load that behavior in a given agent.

Portable behavior consists of six modes:

- `ponytail`: lazy senior developer mode
- `ponytail-review`: over-engineering review
- `ponytail-audit`: whole-repo over-engineering audit
- `ponytail-debt`: harvest `ponytail:` shortcuts into a ledger
- `ponytail-gain`: measured-impact scoreboard
- `ponytail-help`: quick reference

The upstream repository also contains adapters for Claude Code, Codex, Grok Build, OpenCode, pi, Hermes Agent, Gemini CLI, Cursor, Windsurf, Cline, GitHub Copilot, and other instruction-tier hosts. Those adapters add host-specific activation, hooks, commands, statusline/config behavior, or plugin manifests.

For ChatGPT, keep the adapter thin: use this one skill entrypoint, route auxiliary modes through references, use `agents/openai.yaml` for OpenAI product metadata, and preserve mode state only through available conversation context. Do not emulate unsupported plugin lifecycle hooks with hidden files.

Upstream source commit used for this port: `2ed6c52c9d7e5e56942508591085fd45dea277d3`.
