# Browser Fast tab workspace ownership

Status: open. Defect confirmed on 2026-11-09. No code change yet.

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

## Candidate repairs

| Option | Shape | Cost |
|---|---|---|
| A | Key the workspace by the MCP client session (`extra.sessionId`): a client reuses its tab across turns, and the claim is released when that tab closes | Session identity must be available in both tool handlers; needs a test seam |
| B | Release the claim at the end of every `execute` so the next `observe` reuses the tab | Two concurrent callers can claim the same tab; unsafe for parallel agents |
| C | Close the blank launch tab when a caller opens its own tab | Removes the symptom, keeps the leak |
| D | Leave the behaviour, document it | Keeps one extra tab per task indefinitely |

Option A is the smallest repair that keeps concurrent callers safe. It owns
`prepareObservation`, not the skill.

## Test plan

- Fake runner, no CDP: two `observe` calls with the same client session return one tab.
- Fake runner: two client sessions get different tabs.
- Closed tab: the next `observe` for that client allocates a fresh tab.
- Gated real-browser test: fresh CloakBrowser launch ends the task with one tab, not two.
