# Browser Fast: Linux Chrome backend and the visible sandbox banner

Draft diagnosis. Not an RFC. Do not publish yet.

- **Date:** 2026-11-09
- **Surface:** `providers/browser-fast` (MCP `browser-fast`), `browser-devtools` unchanged
- **Status:** root cause proven, repair shape open

## Symptoms

1. `browser_target="linux"` with `browser_backend="chrome"` fails on every `observe`.
   - Without a profile: `BROWSER_FAST_OBSERVE_FAILED: No tab with target id ...`
   - With a named profile: `Chrome exited early (exit code: 0) without writing DevToolsActivePort`
2. Every managed CloakBrowser window shows the banner
   "You are using an unsupported command-line flag: --no-sandbox."

`docs/operations.md:221` and `skills/agent-browser/SKILL.md:45` both document mode 1 as supported.

## Evidence

Two agent-browser sessions for one call, same backend, different tab sets:

```
base session  mcp-browser-fast-linux        -> tab 27A29CBAD7C1D7F49EF86BF0D63206EF
per-tab       ...-tab-e4ce6798beaa6719      -> tab 0E290EE80A2BEB703D0D65F44E259D47
profile whtest, base session                -> Chrome starts, tab list ok
profile whtest, per-tab session             -> Chrome exited early (same profile lock)
```

The banner comes from the CloakBrowser process, not from our code:

```
--disable-infobars ... --no-sandbox --no-sandbox --fingerprint=20202 --class=google-chrome about:blank
```

`node_modules/cloakbrowser/dist/config.js:397` hardcodes `--no-sandbox`.
Chromium 146 ignores `--disable-infobars`, so the infobar stays.

## Root cause 1: the session key changes per tab

`linuxSession()` (`providers/browser-fast/server.mjs:372`) returns a session
name per tab once a tab is known. That is correct only for a browser that many
sessions can share through CDP. For a launched browser, each session starts its
own Chrome, so the tab id from the listing session does not exist in the
selecting session, and a second Chrome on the same profile cannot start.

The code already knows which case it is: `backend.cdp` and `backend.managed`.
The owner is the session-name function, not the observe handler.

```text
PatchShape: session-key policy branch (adapter)
CanonicalOwner: AgentBrowserRuntime.linuxSession() + backend descriptor (cdp/managed)
UpwardDrillSignal: none. The shared/not-shared fact is already on the backend.
Decision: fix owner
```

```text
Goal: make linux+chrome work, or fail with one clear error
DeeperCause: per-tab session applied to a non-shared browser
Evidence: two sessions, two tab sets, profile lock
Risk/Unknown: external CDP path must keep per-tab pinning
Decision: derive the session from the backend sharing mode
```

## Root cause 2: the banner

CloakBrowser adds `--no-sandbox` for container use. Chromium shows an infobar
for that flag unless the browser also gets `--test-type`. Our own args already
carry `--disable-infobars`, which Chromium 146 ignores.

Owner: `cloakbrowser-runtime.mjs` launch args (`providers/browser-fast/cloakbrowser-runtime.mjs:116`).
The package exposes `LaunchOptions.args`, so we can add a flag without forking.

## Other robustness gaps

1. **Hidden profile default.** When no `browser_profile` is named, the Linux
   Chrome path inherits `AGENT_BROWSER_PROFILE=Default` from the bridge env.
   That name means a persistent user profile inside agent-browser, not the
   bridge-state directory the code builds for named profiles. One concept, two
   sources of truth.
2. **Profile lock reads as a launch crash.** "Chrome exited early" does not say
   that another session owns the profile.
3. **No test at the failing seam.** 38 tests pass. None covers `observe` on a
   non-CDP Linux Chrome, because every test runner fakes the session.
4. **Two browsers on Linux.** Chrome and CloakBrowser both own a profile tree,
   a launch path, and a lifecycle. Only one is documented as the default.

## Repair options

| Option | Change | Risk |
|---|---|---|
| A. Session policy | Per-tab session only when the browser is shared (`cdp`/`managed`). One session per backend+profile otherwise. | Low. CloakBrowser and external CDP keep today's behavior. |
| B. A + explicit profile default | Always set `AGENT_BROWSER_PROFILE` from bridge state. Never inherit the env value. | Low. Changes where the unnamed Chrome profile lives. |
| C. B + banner | Add `--test-type` to CloakBrowser launch args. | Medium. `--test-type` enables test-mode behaviors. |
| D. Retire Linux Chrome | Keep CloakBrowser as the only Linux browser. Docs and skill text shrink. | Removes a documented mode. Callers that set `chrome` start failing. |

Option A is the smallest sufficient repair. Option D removes an owner instead
of fixing it. Both need the same test at the seam.

## Test plan for any option

1. Fake runner, non-CDP backend: assert `observe` uses one session name for the
   listing and the selection.
2. Fake runner, CDP backend: assert the per-tab session name is still used.
3. Gated real-browser test (needs a display): launch, observe, execute, close.
4. Banner check: inspect the launched args, assert the intended flag set.

## Open question

What does the Linux Chrome backend do today that CloakBrowser cannot do?
