# Managed CloakBrowser backend

Use this reference for the default managed Linux/WSLg browser path: `browser-fast` with `browser_target="linux"` should resolve to a managed CloakBrowser profile unless the caller or governing workflow explicitly selects managed Chrome.

## Ownership

```text
ChatGPT / workflow
  -> Local -> browser-fast (observe / execute)
       -> Agent Browser: accessibility snapshots, refs, tab/target identity
       -> CloakBrowser runtime: persistent Chromium profile, lifecycle, humanized Playwright input
```

Keep those owners separate. Do not launch another browser process against the same profile, and do not bypass `browser-fast` with shell-driven browser automation for resource-local state.

`CLOAKBROWSER_PROFILE_IN_USE` with a live endpoint is ownership evidence, not a stale-port signal. Continue through the provider that owns that runtime. If the owning route is unavailable, leave the process intact and ask the human to restore that route or close the owner; direct imports and raw CDP attachment create a competing lifecycle owner.

Within one provider, concurrent agents using the same profile reuse one browser process and shared cookie/storage state. Browser Fast claims a distinct tab/target for each observation and binds execution to the returned tab. It creates another tab when existing targets are already claimed; it does not create another profile.

Isolation is explicit. Define another profile under `cloakbrowser.profiles` in `browser-fast.json`, then call `observe` with `browser_target="linux"`, `browser_backend="cloakbrowser"`, and that `browser_profile`. Different configured profiles have separate persistent data directories and browser processes. Browser Fast never changes profiles merely because another agent is active.

## Profile and lifecycle defaults

- The selector lives in `~/.config/mcp-dev-bridge/browser-fast.json`. Managed CloakBrowser is the default Linux backend; managed Chrome is an explicit override only. An explicit selector/config choice of Chrome wins, but absence of that choice must not silently route Linux work to Chrome.
- Managed CloakBrowser profiles live beneath the bridge state directory; profile names are validated and must resolve as direct children of the profiles root.
- A requested CloakBrowser profile must exist in the configuration catalog. Unknown names fail instead of cloning another profile or silently using the default.
- `headless` defaults to `false` for managed CloakBrowser profiles.
- `humanize` defaults to `true` when omitted. Only an explicit `humanize: false` disables it.
- The profile directory persists across process restarts, preserving cookies and authenticated browser state.
- `ManagedCloakBrowserRuntime` owns process close/restart. Agent Browser attaches over loopback CDP with idle shutdown disabled for this backend.
- CloakBrowser's own launch defaults include `--no-sandbox`; the provider adds no sandbox flags of its own. Treat pages in this browser as less contained than in managed Chrome.
- A runtime/profile change invalidates prior Agent Browser refs and target IDs; observe again before acting.

## Humanized input contract

With `humanize: true`, supported `browser-fast` input routes through the CloakBrowser-owned Playwright page while Agent Browser continues to supply refs/target identity.

Current managed actions include click, fill, type, check, uncheck, select, press, hover, drag, and wheel scroll.

Functional defaults intentionally include:

- trusted browser-native mouse/keyboard input rather than forged DOM events;
- CloakBrowser trajectory/timing behavior for mouse movement and clicks;
- non-center interior target points when browser-fast must fall back to element geometry;
- consistent pointer acquisition before standalone typing without an extra click that could move an existing caret;
- humanized key dwell/cadence and single-key presses;
- held-button drag motion with grab delay, endpoint settling, and release dwell;
- eased wheel bursts with scroll anchoring and occasional pointer drift;
- one fingerprint identity per profile, kept in the profile's stored seed.

Do not enable automatic ambient cursor motion by default. CloakBrowser keeps it opt-in because unsolicited movement can race or interfere with caller-directed actions.

## GUI authentication

Calling `browser-fast.observe` for Linux launches or reuses the headed managed profile when needed. For passwords, MFA, CAPTCHA/challenge responses, or other secrets, keep the visible browser open and let the human complete the step directly. After they finish, observe the page and verify authenticated state without exposing credentials.

For requests that explicitly require a window visible on Windows, browser content and desktop projection are separate checks. A browser snapshot or screenshot proves rendered content. Completion requires a host-desktop capture showing the projected window or explicit human confirmation; otherwise report desktop visibility as unverified.

## CloakBrowser 0.6.2 notes

The repository pins `cloakbrowser@0.6.2` with `playwright-core`. The binary is downloaded once into `~/.cloakbrowser` (signature and checksum verified) for Linux x86_64 or arm64; `scripts/setup-cloakbrowser.sh` pre-downloads it.

Without a license key the wrapper runs the free Chromium 146 build. A key in `CLOAKBROWSER_LICENSE_KEY` or `~/.cloakbrowser/license.key` (`cloakbrowser login`) selects the newer build; the free key allows one concurrent session, so several live profiles need the keyless build or a paid key. Do not claim the newer build is active without checking.

Profile options in `browser-fast.json`: `headless`, `humanize`, `humanPreset` (`default` or `careful`), `timezone`, `locale`, `extensions`, `platform` (`windows` or `macos`) and `fingerprint` (integer seed). Omit `fingerprint`: the wrapper then stores one seed per profile in `<profile>/.cloakbrowser-seed`, which keeps the identity stable across restarts. On Linux the default persona is a Windows desktop; install the Windows font set upstream documents before relying on that persona against strict detectors.
