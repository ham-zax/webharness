# WebHarness: Make MCP Tool Failures Visible

*   **Author:** design session
*   **Status:** Draft
*   **Date:** 2026-11-07

--------------------------------------------------------------------------------

## Overview

The bridge answers a failed browser tool call with `-32603 "Error calling tool"`.
That message carries no cause. A reader of the client response cannot tell which
upstream server failed, what it said, or how long it waited.

This design adds the three missing records and removes one cause of failure:

1.  A log file for the inner 1MCP.
2.  An explicit request timeout for slow browser calls.
3.  One browser child that serves both tool listing and the first call.
4.  A path check that rejects a Linux path when the caller selected the Windows
    browser.

Scope is four changes in two providers and one config template. The wire
protocol, the capability model, and the client programs do not change.

## The Problem

### What the client receives

A browser tool call fails. The client receives this:

```json
{"code": -32603, "message": "Error calling tool", "data": null, "request_id": "req_011Cgoa821aWYb6igFr9tGZ7"}
```

Three facts are absent: the failing server, the upstream error text, and the
elapsed time.

### Why the cause is lost

Three losses stack.

**The wrapper discards the cause.** `toolRequestHandlers.js:161` wraps every
upstream `callTool` in `executeWithPostAuthOAuthRecovery(..., 'Error calling
tool')`. The wrapper replaces the upstream message with a constant string. The
cause survives only in the inner 1MCP process, which keeps no record.

**The inner 1MCP writes no log.** `providers/local-tools/server.mjs:203-216`
starts the inner 1MCP with `--transport=stdio` and `stderr: 'inherit'`. Under
stdio, 1MCP adds no console transport (`logger.js:107`). No `--log-file` is
passed, so the file transport never exists (`logger.js:95-105`). The inner 1MCP
therefore records nothing, and the outer log at `logs/one-mcp.log` cannot see
inside it.

**The timeout is invisible.** Nothing sets `requestTimeout`, so the SDK default
of 60000 ms applies (`DEFAULT_REQUEST_TIMEOUT_MSEC`). A cold `npx -y
chrome-devtools-mcp` start plus a Chrome launch can exceed that. The failure
then arrives as `-32001 Request timed out`, which names no server and no
duration.

### Why the timeout happens at all

`providers/browser/server.mjs:329-345` builds a throwaway child for
`listTools()`, then closes it in `finally`. That child never enters the router's
`children` map, because the code calls `this.childFactory('linux')` directly
instead of `this.child('linux')`. The first real `call()` then starts a second
child from scratch. Two cold starts happen where one is enough, and the second
one is the one that runs out of time.

### Why a valid path is rejected

`providers/browser/server.mjs:21-27` declares `filePath`, `requestFilePath`,
`responseFilePath` and `outputDirPath` as OS-temp-only fields. The tool
instructions repeat that rule. The provider does not check the value.

A caller that passes `/tmp/probe-quote.png` with `browser_target: windows` gets a
Windows interpretation, `C:\tmp\probe-quote.png`, and `chrome-devtools-mcp`
rejects it. The rejection quotes the temp-dir policy, not the path mismatch, so
the caller cannot tell what to change.

## Goals

1.  Every failed browser tool call leaves a record on disk that names the
    upstream server, the tool, the duration, and the upstream error text.
2.  A cold browser call does not fail on the SDK default timeout. The configured
    limit covers a cold `npx` start plus a Chrome launch.
3.  One browser child serves both `tools/list` and the first `call`. The router
    starts one child per target, not two.
4.  A path argument that cannot work for the selected target is rejected before
    the call, with a message that names the target and the path form it accepts.
    The provider cannot know the Windows temp directory without a `cmd.exe`
    round trip on every call, so the check is syntactic.
5.  The client-visible success path does not change. Tool names, tool results,
    and the wire protocol stay identical.
6.  Each change is independently revertable.

## Non-Goals

*   Changing the `-32603` wrapper inside 1MCP. That is upstream code, and the
    brief records patching the global package as an upgrade hazard
    (`concepts_brief.md` §5).
*   Adding a correlation header across hops. The brief stages that as item 5,
    after these fixes.
*   Fixing the 409 SSE-stream message, the 404 session-not-found response, or
    the downed port 3051. Those are client behavior and operations, not defects
    in these two providers.
*   Structured JSON logging, a log shipper, or a log index.
*   Changing the browser target model, the Chrome profile layout, or
    `browser-fast`.
*   Changing `requestTimeout` for any server other than the ones this design
    names.

## Open Questions

*   **Timeout value**: 180000 ms is a proposal, not a measurement. No one has
    timed a cold `npx -y chrome-devtools-mcp` start plus a Chrome launch.
    Measure once after Change 1 lands, because the inner log will record the
    duration of the failing call.
*   **Inner log volume**: the outer log at `info` reached 8.9 MB in six days.
    The inner serves the same servers with fewer clients. Measure for one day
    before fixing `maxSize`.
*   **Operator-supplied servers**: `MCP_LOCAL_SERVERS_FILE` adds servers such as
    `browser-lightpanda` to the inner config. The repository cannot set a
    timeout for them. Confirm that this is acceptable.

## Critical User Journeys

### CUJ 1: Diagnose a failed browser call

*   **Given**: the bridge runs, and a client calls `navigate_page` with
    `browser_target: windows`.
*   **When**: the call fails, and the operator reads the client response and
    then the inner log.
*   **Then**: the client response still says `-32603`, and
    `state/logs/local-inner.log` records the server name, the tool, the duration
    and the upstream message. The operator names the cause from the log alone.

### CUJ 2: Cold browser call after idle

*   **Given**: the inner 1MCP idled out, and no browser child runs.
*   **When**: the client calls one browser tool.
*   **Then**: one child starts, serves the call, and the call does not fail on
    the 60000 ms SDK default. The child stays for the next call.

### CUJ 3: Windows screenshot with a Linux path

*   **Given**: `browser_target: windows`.
*   **When**: the caller passes `filePath: /tmp/shot.png`.
*   **Then**: the call fails before any browser work starts, and the message
    names the target and a Windows path form.

## Technical Plan (Architecture)

Four changes, two providers, three config templates, one render script. No
change touches the wire protocol, the capability model, or a client program.

```text
client (ChatGPT, Claude, wh)
  |
  v
outer 1MCP ................. logs: state/logs/one-mcp.log
  |  stdio, requestTimeout 240000 on "local"          [change 2]
  v
local broker ............... providers/local-tools/server.mjs
  |  stdio, --config state/local-1mcp/mcp.json
  v
inner 1MCP ................. reads state/local-1mcp/config.toml  [change 1]
  |                          logs:  state/logs/local-inner.log   [change 1]
  |  stdio, requestTimeout 180000 on browser servers [change 2]
  v
browser provider ........... providers/browser/server.mjs
  |  one child per target for list and call          [change 3]
  |  path check before child start                   [change 4]
  v
npx chrome-devtools-mcp
```

### Change 1: inner 1MCP log file

**Mechanism.** `render-config.mjs` writes a second app config at
`stateDir/local-1mcp/config.toml`, next to the inner `mcp.json`. 1MCP reads
`config.toml` from the directory of its `--config` file
(`configLoader.js:236`), so the inner process finds it with no new argument.

The block copies the shape of the outer block at `render-config.mjs:498-502`:
`file`, `level`, `maxSize`, `maxFiles`. `file` points at
`stateDir/logs/local-inner.log`. `render-config.mjs:487` already defines
`logDir`, and `:525-527` already creates the inner config directory with mode
0700.

`maxSize` reuses `oneMcpLogMaxSize` (`render-config.mjs:377-381`), which is
validated to the range 1-64 MiB. `maxFiles` reuses `oneMcpLogMaxFiles`.

**No spawn argument changes.** `providers/local-tools/server.mjs:203-216` stays
as it is. The inner 1MCP keeps `stderr: 'inherit'` and gains a file transport
from the config.

**Fails if**: upstream changes the app-config lookup path, or a stale
`config.toml` survives a rollback and points at a removed directory.

### Change 2: request timeout

**Mechanism.** Add `requestTimeout` to the server entries that can wait on a
cold start. 1MCP reads it through `getRequestTimeout()`
(`utils/core/timeoutUtils.js:9`) and passes it as the per-request `timeout`
option (`toolRequestHandlers.js:159`). That option applies to every transport
kind, including stdio. The value is milliseconds.

**Values.**

| Entry | Value | Reason |
| --- | --- | --- |
| `browser-devtools` | 180000 | Covers a cold `npx` start plus a Chrome launch |
| `browser-fast` | 180000 | Same cold-start shape |
| `local` | 240000 | The outer wait must exceed the inner wait, or the outer fails first |

**Files.** `config/templates/mcp-local.json` gains the value on
`browser-devtools` and `browser-fast`. `config/templates/mcp-personal.json` and
`config/templates/mcp-server.json` gain it on `local`.

**Fails if**: a call that needs more than 180 s now fails later instead of
earlier. No capability is lost, but the client waits longer before the error.

### Change 3: one browser child for listing and calls

**Mechanism.** `listTools()` currently calls `this.childFactory('linux')`
directly and closes the result in `finally` (`server.mjs:329-345`). The child
never enters the router's `children` map, so the first `call()` starts a second
one.

The listing path must resolve the same route as a call, because `call()` keys
its child by route (`server.mjs:361-363`). A bare `this.child('linux')` would
use key `linux`, while a default call uses key `linux:chrome:<profile>`, and the
two would still be separate children.

So `listTools()` resolves `await this.linuxRoute(undefined, undefined)` and
passes it to `this.child('linux', route)`. It drops the `finally` block.
`toolsPromise` still memoizes the tool list.

**Fails if**: the default Linux route is invalid. Listing then fails where it
previously succeeded with a bare child. Calls would fail on the same route, so
the new failure is earlier and clearer, not new.

**Memory**: one `chrome-devtools-mcp` process per target stays resident between
calls. `shutdown()` already closes every child in the map
(`server.mjs:371-379`).

### Change 4: path check before child start

**Mechanism.** In `call()`, after the target is validated (`server.mjs:357-361`)
and before `this.child(...)`, inspect the keys in `OS_TEMP_PATH_FIELDS`
(`server.mjs:21-26`).

For `target === 'windows'`, accept a value that matches a drive-letter path or
a UNC path. Reject any other value with `INVALID_ARGUMENT`. The message names
the target and gives a form such as `C:\\Users\\<user>\\AppData\\Local\\Temp\\shot.png`.

For `target === 'linux'`, reject a value that matches a drive-letter path, for
the same reason in reverse.

No filesystem call, no `cmd.exe` round trip, no translation. The check is
syntactic and cheap.

**Fails if**: a caller uses a relative path. Relative paths do not match either
form and would be rejected, where today they pass through. Keep them accepted:
check only for the wrong absolute form, not for the right one.

That decision keeps the change narrow. A relative path is resolved by
`chrome-devtools-mcp` against its own working directory, which is the same
behaviour as today.

## Alternatives Considered

The predecessor brief weighs the alternatives for the whole bridge
(`concepts_brief.md`, "Alternatives Weighed"). This section records only the
alternatives weighed for these four changes, including the two that the design
gate rejected.

### Alternative A: Patch the `-32603` wrapper in 1MCP

*   **Pros**: the client sees the upstream cause directly. No new file, no new
    config.
*   **Cons**: `scripts/install-bridge-runtime.sh` already carries three patches,
    and the brief records one of them as broken against 0.39.8
    (`concepts_brief.md` §5). A fourth patch adds a fourth upgrade failure. It
    also changes a message that clients may match on.
*   **Reason for Rejection**: the brief stages patch versioning as item 12 and
    blocks the 0.39.8 upgrade until then. A record on disk answers the same
    question without touching upstream code.

### Alternative B: Log only at the outer 1MCP

*   **Pros**: no new file, no new config, no change to the inner process.
*   **Cons**: the outer log records the outer-to-broker call. The failing call
    is inner-to-browser. The outer sees `-32603` from the broker and nothing
    more.
*   **Reason for Rejection**: it records the symptom, not the cause.

### Alternative C: Pass `--log-file` with no rotation

*   **Pros**: one added argument. No new config file. Nothing depends on how
    1MCP finds its app config.
*   **Cons**: the file grows without limit. The outer log reached 8.9 MB in six
    days at the same level.
*   **Reason for Rejection**: rejected at the design gate. A log that can fill
    the disk trades one silent failure for another.

### Alternative D: Pass `--log-file` and rotate inside local-tools

*   **Pros**: rotation stays in our code and does not depend on upstream's
    config lookup.
*   **Cons**: a second rotation policy to maintain, and a file operation on the
    start path of a process that already starts slowly.
*   **Reason for Rejection**: rejected at the design gate. 1MCP's own winston
    transport already rotates, and the config file is found automatically.

### Alternative E: One global request timeout for every server

*   **Pros**: one value in one place.
*   **Cons**: `dev` shell calls carry their own timeouts (`MCP_DEV_*`), and a
    180 s default would let a hung shell call sit for three minutes.
*   **Reason for Rejection**: the slow path is the browser. The timeout belongs
    on the browser entries and on the broker that waits for them.

### Alternative F: Translate a Linux path to the Windows temp directory

*   **Pros**: the call succeeds instead of failing.
*   **Cons**: the file lands where the caller did not name it, and the
    translation needs `cmd.exe` to resolve `%TEMP%` on every call.
*   **Reason for Rejection**: silent relocation is worse than a clear rejection
    for a file that the caller must then read.

### Alternative G: Serve the tool list from a static table in the provider

*   **Pros**: no child start for listing at all, and no cold start on the
    listing path.
*   **Cons**: the table must track the pinned `chrome-devtools-mcp` version, and
    `addBrowserTarget` already rewrites every schema. A version bump would need
    a second edit in a second place.
*   **Reason for Rejection**: Change 3 removes the extra start with less
    maintenance and no duplicated schema.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Thirteen files. None is created and none is deleted. Two are code, three are
config templates, one is a build script, four are tests, three are docs. Two
files carry two changes each, so the count is smaller than the change list.

Order matters in one place: Change 1 must land before Change 2 is measured,
because the inner log is what records the duration of the slow call.

### Target Files to Create/Modify

#### 1. `scripts/render-config.mjs` (Modify)

*   **Type / Scope**: Build script. Config rendering.
*   **Proposed Changes**:
    *   Next to `localInnerConfigPath` (`:402`), derive
        `localInnerAppConfigPath` as `config.toml` in the same directory. Keep
        it empty when the profile is not local, matching how
        `localInnerConfigPath` is handled.
    *   Build a second app-config string. It holds one `[logging]` block with
        `file` set to `path.join(logDir, 'local-inner.log')`, `level = "info"`,
        and the `maxSize` and `maxFiles` values already validated at `:377-381`.
        It holds no `port`, no `[auth]` and no `[admin]`: the inner runs stdio
        and needs none of them.
    *   Write it inside the existing `if (!checkOnly)` block, next to the
        `localRendered` write at `:529`, through the same `atomicWrite` helper.
    *   Add `localInnerAppConfigPath` to the returned object at `:557` so tests
        and callers can assert on the path.
    *   Rationale: 1MCP loads `config.toml` from the directory of its `--config`
        file (`configLoader.js:236`). Without this file the inner 1MCP has no
        file transport and records nothing.

#### 2. `bin/status` (Modify)

*   **Type / Scope**: Operator CLI. Shell.
*   **Proposed Changes**:
    *   Add a second `storage_stats` call for `local-inner*.log` in the same log
        directory used at `:142`, and print a new line after `:150`.
    *   Compute the inner policy bytes with the same formula as `:146`
        (`maxSize * maxFiles`), because both blocks use the same values.
    *   Warn on the same condition as `:153-154`.
    *   Keep the existing `1MCP rotated logs:` line byte-identical.
        `tests/lifecycle.sh:315` matches that line exactly.
    *   Rationale: a log that no tool reports is a log that nobody reads. The
        brief makes the same point about `operations.sqlite` in §4.

#### 3. `scripts/smoke-local.sh` (Modify)

*   **Type / Scope**: Smoke test. Shell.
*   **Proposed Changes**:
    *   Extend the config validation at `:120-132` to read
        `local-1mcp/config.toml` and require `[logging]` and a `file =` entry.
    *   Rationale: the smoke test already refuses stale generated state. A
        missing inner config would silently restore the silent-log failure, and
        the smoke test is the only place that checks rendered files.

#### 4. `tests/harness.sh` (Modify)

*   **Type / Scope**: Renderer test. Shell.
*   **Proposed Changes**:
    *   Extend `test_one_mcp_log_policy_validation` (`:307`) to assert that the
        rendered `local-1mcp/config.toml` exists, contains `[logging]`, names
        `local-inner.log`, and repeats the outer `maxSize` and `maxFiles`.
    *   Extend `test_final_rendered_composition` (`:23`) to assert
        `requestTimeout` is 180000 on `browser-devtools` and `browser-fast`, and
        240000 on `local` in both the personal and server renders.
    *   Rationale: both changes are pure rendering. A renderer test is the
        cheapest proof, and this file already owns both subjects.

#### 5. `config/templates/mcp-local.json` (Modify)

*   **Type / Scope**: Config template. Inner 1MCP server list.
*   **Proposed Changes**:
    *   Add `requestTimeout` with value 180000 to `browser-devtools` and to
        `browser-fast`.
    *   Rationale: both start `npx -y chrome-devtools-mcp` cold. 1MCP applies the
        value as a per-request option (`toolRequestHandlers.js:159`), so it
        covers stdio transports.

#### 6. `config/templates/mcp-personal.json` (Modify)

*   **Type / Scope**: Config template. Outer 1MCP server list, personal profile.
*   **Proposed Changes**:
    *   Add `requestTimeout` with value 240000 to `local`.
    *   Rationale: the outer waits on the broker, and the broker waits on the
        browser. A shorter outer limit fails before the inner one can report the
        cause.

#### 7. `config/templates/mcp-server.json` (Modify)

*   **Type / Scope**: Config template. Outer 1MCP server list, server profile.
*   **Proposed Changes**:
    *   Same addition as file 6.
    *   Rationale: the server profile mounts `local` through the same broker, so
        it inherits the same double wait.

#### 8. `providers/browser/server.mjs` (Modify)

*   **Type / Scope**: MCP provider. Two changes.
*   **Proposed Changes**:
    *   `listTools()` (`:329-345`): resolve `const route = await
        this.linuxRoute(undefined, undefined)`, then obtain the child through
        `this.child('linux', route)`. Delete the `finally` block that closes the
        child. Keep the `toolsPromise` memoization and the catch that clears it.
    *   Add a helper beside `OS_TEMP_PATH_FIELDS` (`:21-27`) that inspects one
        path value against one target and returns a rejection message or null.
        It accepts a Windows drive-letter form and a UNC form for `windows`,
        and a POSIX absolute form for `linux`. It accepts a relative path for
        both targets.
    *   `call()` (`:347-372`): after the target check at `:357-361` and before
        `this.child(...)`, run that helper over every key of
        `OS_TEMP_PATH_FIELDS` present in `upstreamArgs`. Throw `INVALID_ARGUMENT`
        with a message that names the target and one accepted example.
    *   Rationale for the listing change: the router keys children by route
        (`:361-363`). A bare `this.child('linux')` would use key `linux`, which
        still differs from `linux:chrome:default`, so the two children would
        remain.
    *   Rationale for the path change: the schema already tells the caller the
        rule (`:137-141`), and the provider never checks it. The rejection
        arrives from `chrome-devtools-mcp` as a temp-dir policy message that
        names neither the target nor the mismatch.

#### 9. `providers/browser/test/server.test.mjs` (Modify)

*   **Type / Scope**: Provider test. Node test runner.
*   **Proposed Changes**:
    *   Add a router test with an injected `childFactory` that counts creations
        and an injected `linuxBackendResolve` that returns `{ browser: 'chrome' }`.
        Call `listTools()`, then `call()`, and assert one creation and no close
        between them.
    *   Add path cases: windows with `/tmp/x.png` rejects; windows with
        `C:\Users\u\AppData\Local\Temp\x.png` passes; linux with `C:\tmp\x.png`
        rejects; linux with `/tmp/x.png` passes; a relative name passes for both
        targets.
    *   Assert that a rejected path never reaches `childFactory`.
    *   Rationale: the file already injects `childFactory`, so these tests need
        no new harness.

#### 10. `docs/configuration.md` (Modify)

*   **Type / Scope**: Reference documentation.
*   **Proposed Changes**:
    *   Add `logs/local-inner.log` to the state-directory file list at `:141`.
    *   Extend the logging paragraph at `:166` with the inner block: same size
        limits, same rotation mode, written by the renderer to
        `local-1mcp/config.toml`.
    *   Add a short paragraph on `requestTimeout`, the two values, and why the
        outer value is larger.
    *   Rationale: the file documents the outer logging policy today. Two
        policies in one deployment must be described together, or a reader will
        assume the inner log follows the outer one.

#### 11. `docs/operations.md` (Modify)

*   **Type / Scope**: Operator documentation.
*   **Proposed Changes**:
    *   Extend the log paragraph at `:138-140` to name the inner log and the new
        `bin/status` line.
    *   Rationale: this is the page an operator reads during an incident. A
        second log that status ignores is a trap.

#### 12. `docs/troubleshooting.md` (Modify)

*   **Type / Scope**: Operator documentation.
*   **Proposed Changes**:
    *   Add a section after `:5`: a browser tool call fails with `-32603 Error
        calling tool`. It points at `logs/local-inner.log`, the two
        `requestTimeout` values, and the per-target path rule.
    *   Rationale: the existing section explains connector limits. It does not
        explain a browser failure, and it is the first place a reader looks.

#### 13. `tests/lifecycle.sh` (Modify)

*   **Type / Scope**: Lifecycle test. Shell.
*   **Proposed Changes**:
    *   Add an assertion for the new `bin/status` line beside the existing
        assertion at `:315`, with the same sandbox log files.
    *   Rationale: `:315` matches the current status line exactly. The new line
        needs its own match, or the reporting change has no test.

### Test Commands

| Scope | Command |
| --- | --- |
| Browser provider | `npm --prefix providers/browser test` |
| Renderer and composition | `bash tests/harness.sh` |
| Lifecycle and status | `bash tests/lifecycle.sh` |
| Full gate | `bash scripts/test-all.sh` |
