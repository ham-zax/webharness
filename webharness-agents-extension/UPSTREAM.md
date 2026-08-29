# Upstream provenance

WebHarness Agents began from the Chrome extension in `totec448-spec/chat-on-steroids` and is now a WebHarness-owned adaptation for ChatGPT worker identity and command delivery.

- Upstream repository: `https://github.com/totec448-spec/chat-on-steroids`
- Upstream commit: `9e27c0fafc20bf2c81509844d5f92868678b4168`
- Upstream extension version: `2.0.2`
- Upstream path: `extension/`
- License: MIT; see `LICENSE` in this directory.

The active WebHarness extension is intentionally narrower than upstream: it keeps the MV3 service worker, ChatGPT DOM/Fiber observation, durable journal, and command-delivery mechanics needed by Agents, while disabling the upstream goal/compact/settings control plane. Refreshing from upstream is an explicit vendor-update operation: review the diff, preserve WebHarness trust boundaries, and update the pinned commit above.
