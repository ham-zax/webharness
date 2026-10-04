# Source provenance

This ChatGPT-compatible port was derived from:

- Repository: `DietrichGebert/ponytail`
- Upstream commit: `2ed6c52c9d7e5e56942508591085fd45dea277d3`
- Upstream portable skills: `skills/ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`
- License: MIT, Copyright (c) 2026 DietrichGebert

Compatibility changes package the six portable behaviors as one ChatGPT skill, add OpenAI UI metadata, route auxiliary modes through references, replace unsupported host lifecycle/config mechanics with conversation-scoped behavior, keep Causal Coding authoritative for mutation scope/testing/verification/stopping, and add an OpenAI connected-WSL adapter that composes Ponytail with MCP Harness Router and `wsl-web-harness` before source mutations.
