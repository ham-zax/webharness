# Managed Clearcote backend

Use this reference for the default managed Linux/WSLg browser path: `browser-fast` with `browser_target="linux"` should resolve to a managed Clearcote profile unless the caller or governing workflow explicitly selects managed Chrome.

## Ownership

```text
ChatGPT / workflow
  -> Local -> browser-fast (observe / execute)
       -> Agent Browser: accessibility snapshots, refs, tab/target identity
       -> Clearcote runtime: persistent Chromium profile, lifecycle, humanized Playwright input
```

Keep those owners separate. Do not launch another browser process against the same profile, and do not bypass `browser-fast` with shell-driven browser automation for resource-local state.

## Profile and lifecycle defaults

- The selector lives in `~/.config/mcp-dev-bridge/browser-fast.json`. Managed Clearcote is the default Linux backend; managed Chrome is an explicit override only. An explicit selector/config choice of Chrome wins, but absence of that choice must not silently route Linux work to Chrome.
- Managed Clearcote profiles live beneath the bridge state directory; profile names are validated and must resolve as direct children of the profiles root.
- `headless` defaults to `false` for managed Clearcote profiles.
- `humanize` defaults to `true` when omitted. Only an explicit `humanize: false` disables it.
- The profile directory persists across process restarts, preserving cookies and authenticated browser state.
- `ManagedClearcoteRuntime` owns process close/restart. Agent Browser attaches over loopback CDP with idle shutdown disabled for this backend.
- Clearcote is launched with Chromium sandboxing enabled. Do not add `--no-sandbox`.
- A runtime/profile change invalidates prior Agent Browser refs and target IDs; observe again before acting.

## Humanized input contract

With `humanize: true`, supported `browser-fast` input routes through the Clearcote-owned Playwright page while Agent Browser continues to supply refs/target identity.

Current managed actions include click, fill, type, check, uncheck, select, press, hover, drag, and wheel scroll.

Functional defaults intentionally include:

- trusted browser-native mouse/keyboard input rather than forged DOM events;
- Clearcote trajectory/timing behavior for mouse movement and clicks;
- non-center interior target points when browser-fast must fall back to element geometry;
- consistent pointer acquisition before standalone typing without an extra click that could move an existing caret;
- humanized key dwell/cadence and single-key presses;
- held-button drag motion with grab delay, endpoint settling, and release dwell;
- eased wheel bursts with scroll anchoring and occasional pointer drift;
- persistent motor/persona behavior derived from the configured fingerprint when the Clearcote path preserves that seed.

Do not enable automatic ambient cursor motion by default. Clearcote keeps it opt-in because unsolicited movement can race or interfere with caller-directed actions.

## GUI authentication

Calling `browser-fast.observe` for Linux launches or reuses the headed managed profile when needed. For passwords, MFA, CAPTCHA/challenge responses, or other secrets, keep the visible browser open and let the human complete the step directly. After they finish, observe the page and verify authenticated state without exposing credentials.

## Clearcote 0.27.0 notes

The repository pins `clearcote@0.27.0`. The currently used free Linux engine provides persistent profiles and synthetic humanized input; do not infer support for every option present in newer SDK surfaces or licensed engine tiers.

`lightStealth` is optional and defaults off. In Clearcote 0.27.0, its launch-argument path consumes/removes the fingerprint seed before the later humanization installer reads the same options object. Therefore `lightStealth: true` can provide the metadata preset while losing the stable fingerprint-derived motor persona for that launch. Persistent profile state remains on disk. Do not patch upstream Clearcote behavior locally unless the user explicitly asks for that change.

Recorded human trajectories and several stronger network/WebRTC realism features are license/tier dependent. Do not claim those are active on the free engine merely because the SDK exposes related APIs.
