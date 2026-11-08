# Browser Fast tab workspace ownership

Status: implemented 2026-11-09. The provider reuses idle blank tabs. See Decision below.

## Symptom

A managed Linux CloakBrowser shows one unused tab next to the tab that does the work, and the
unused tabs accumulate across tasks. A fresh launch leaves an empty `about:blank` tab open.

## Evidence

Measured on `browser_target="linux"`, `browser_backend="cloakbrowser"`, `browser_profile="x-main"`.

| Step | Tabs after the call |
|---|---|
| Fresh launch, first `observe` | 1: `about:blank`, claimed by the caller |
| `tab_new https://example.com` | 2: the blank tab stays open |
| Second `observe` without `tab` | 3: blank, example.com, new blank |

## Cause

`providers/browser-fast/server.mjs:689`:

```js
targetId = claims.size === 0 ? liveTargets[0]?.targetId : undefined;
if (targetId === undefined) targetId = (await this.cloakbrowserRuntime.newTarget(...)).targetId;
```

The server claims an existing tab only while no tab is claimed, and releases a claim only when
that tab closes. It has no client identity, so every new task looks like a new caller and
receives a new tab. `newTarget()` opens a page and nothing closes the previous one.

Playwright starts a persistent context with one `about:blank` page. That page is the "already
open" tab.

Two behaviours combine:

1. The provider claims a tab on `observe` and never hands it back.
2. The `wh-browser` skill told agents to open their own tab, so the claimed tab stayed unused.

The skill now tells agents to navigate the observed tab when it is blank. That removes the
dead tab in the common case and needs no code change.

## Decision (2026-11-09)

The provider now reuses a blank tab whose claim went idle, and keeps every tab that holds
content claimed.

| Rule | Behavior |
|---|---|
| First no-tab `observe` | Claims the blank launch tab |
| No-tab `observe` with a claimed blank tab younger than 10 minutes | Opens a new tab, so concurrent callers stay separate |
| No-tab `observe` with a blank tab last claimed more than 10 minutes ago | Releases that claim and reuses the tab |
| No-tab `observe` with only content tabs claimed | Opens a new tab |
| Tabs that hold content | Stay claimed until they close |

`providers/browser-fast/server.mjs` holds the rule (`BLANK_TAB_CLAIM_IDLE_MS`), and
`cloakbrowser-runtime.mjs` now reports each target's URL so the provider can tell a blank tab
from a used one.

### Why not the session-keyed workspace

The first proposal keyed the workspace by the MCP client session. That needs
`extra.sessionId`, which only the HTTP transports set. The bridge starts every provider over
stdio, so the deployed path would have fallen back to one shared workspace for all callers:
two agents would then share one tab and overwrite each other. Reusing idle blank tabs keeps
concurrent callers separate and removes the dead tab, so it is the smaller safe change.

A session-keyed workspace becomes useful if the provider ever runs over HTTP. The blank-tab
rule does not block that later step.

## Implemented tests

`providers/browser-fast/test/server.test.mjs`:

- `reuses a blank tab whose claim went idle`: one tab after 11 idle minutes, `newTarget` not called.
- `keeps a recent blank claim and opens a tab for the next caller`: a second tab after 1 minute.
- `never reuses a claimed tab that holds content`: a second tab after 11 idle minutes.

Still open: no test proves the tab count of a full task against a real CloakBrowser. The skill
now tells agents to navigate the claimed tab and to close it, so the common case needs no
further provider change.
