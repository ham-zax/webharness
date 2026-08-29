# Browser Harness upstream

Source: `https://github.com/browser-use/browser-harness`

Reviewed upstream commit: `41108b8`

License: MIT. See `LICENSE` in this directory.

This repository does not vendor Browser Harness as a runtime dependency. The `browser-fast` memory layer ports and adapts the domain-skill discovery idea from upstream `src/browser_harness/helpers.py::goto_url`:

- keep browser knowledge on disk;
- select knowledge lazily from the current URL;
- surface only a bounded relevant subset to the agent.

The WebSession adaptation intentionally differs from upstream in three ways:

1. It keeps the existing Agent Browser/Chrome lifecycle instead of Browser Harness daemon/attachment behavior.
2. It resolves exact site hosts plus reusable platform rules instead of upstream's first-host-label directory lookup.
3. It reads Markdown/JSON only; it does not execute Browser Harness-style `agent_helpers.py` under Local browser authority.

Browser Harness's `upload_file()` CDP technique was also reviewed, but no Python/CDP upload code is copied here because pinned Agent Browser 0.35.0 already provides an `upload` command. `browser-fast` wraps that existing backend with an approved-artifact manifest and target-specific WSL/Windows path translation instead of accepting Browser Harness-style arbitrary absolute paths.
