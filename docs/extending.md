# Bells, Whistles, Cost Savings & Extensions

WebHarness turns the web chat subscription you already pay for (ChatGPT, Claude, or Gemini) into a direct local engineering workstation on WSL2 or a headless Linux/ARM server. Edit repositories, run tests, supervise durable terminals, and drive browsers directly on your own machine without paying per-token API bills or separate Codex CLI, Claude Code, or Gemini CLI subscriptions.

## How WebHarness saves money, tokens, and RAM

| Cost driver | How WebHarness cuts it | Where it lives |
|---|---|---|
| **Extra CLI / API subscriptions** | Connects standard web chat connectors (OAuth + Cloudflare Tunnel) directly to local files, Git, terminals, and browsers. | `bin/webharness`, `scripts/render-config.mjs` |
| **Tool-schema token bloat** | Exposes only 2 outer servers (17 tools max, or 7 tools in Gemini compat mode). Adding more MCPs behind `Local` adds zero outer schema tokens until inspected on demand. | `providers/local-tools/`, `lib/bridge/connector-policy.mjs` |
| **Multi-turn round-trip tax** | `local_fallback_dispatch(calls:[...], sequential:true)` chains `edit -> test -> review_changes` in 1 call. `dev/run_script` runs up to 32 Dev calls (4x parallel reads) in 1 call for JS-computed loops. | `providers/local-tools/broker.mjs`, `providers/pi-dev/` |
| **Noisy read & test-log tokens** | `dev/read` defaults to 160 lines (`mode="outline"` maps structure; `targets` reads up to 20 files at once). Command output caps at 16 KiB with spill-to-disk paths, and `just` recipes redirect verbose logs to `/tmp` and print only counts and failing lines. | `justfile`, `MCP_DEV_MAX_OUTPUT_BYTES` |
| **Idle RAM on 7–8 GB hosts or cheap VPS** | `wake-proxy` evicts idle 1MCP, the Dev worker sleeps, and `DirectLocalServerPool` starts each Local server lazily and evicts it after 30 minutes idle. | `lib/bridge/wake-proxy.mjs`, `providers/local-tools/stdio-pool.mjs` |
| **Timeout retries & lost builds** | Long builds (>25–45s) run in `pueued.service` (`parallel=1`) via `just queue <cmd>` or tmux PTYs watched with `dev/wait`, surviving bridge restarts. | `systemd/pueued.service.in`, `providers/terminal/` |

## Start and use the built-in bells & whistles

Every add-on is modular and idempotent. Setup checks existing binaries first and skips already-qualified tools, so nothing is installed twice or overwritten.

### 1. Daily `justfile` commands

Run from the repository root (`just --list` shows every recipe):

```bash
just host-audit             # pueued + CLI toolbox + live bridge health in ~15 lines
just init-connector-policy  # install starter connector-policy.yaml only if missing
just sync-skills            # sync local Skillshare skills into gitignored skill-library/packs/
just test-fast              # core bridge/local-tools/skill-library tests (counts + failures only)
just queue "just test-shell"# run >25s test suites or builds in pueued (survives bridge restarts)
just queue-status           # check queued/running pueue tasks
just diff                   # structural AST diff via difft (falls back to git diff)
just loc                    # per-language line/complexity counts via scc
just deploy personal        # re-render config, reload adapter, queue detached bridge restart
just update                 # git pull --ff-only origin main + auto-detect profile + just deploy
just ship "feat: ..."       # check staged whitespace, commit staged changes, push main
```

Run `just ship`, `just deploy`, and `just update` as standalone calls rather than inside multi-step `calls[]` batches.

### 2. Automatic `AGENTS.md` + Global `GEMINI.md` guidance

Just like Claude Code or Codex, WebHarness guides connected agents on startup (in both `providers/pi-dev/server.mjs` and `lib/bridge/connector-policy.mjs`) to:
- Check for and read the target repository's `AGENTS.md` (or `CLAUDE.md` / `GEMINI.md`) before making edits.
- Read relevant sections of host-level global guidance (`~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`, or `~/.claude/CLAUDE.md`) when applicable.
- You can also append concise machine-wide policy directly via `MCP_OWNER_CONTEXT_FILE` (<=32 KiB) in `.env`.

### 3. Gemini Web mitigations (read-only surface, confirmations & continuations)

Gemini Web enforces stricter tool-annotation gating, frequent "Always ask" confirmation cards, and multi-turn cutoffs. WebHarness mitigates all three:

1. **Read-only tool surface (`connector-policy.yaml`):** Run `just init-connector-policy` once (copy-if-missing, hot-reloads without restart). `wake-proxy` auto-detects Gemini via `User-Agent: Google` (no `?client=gemini` required, though `?client=gemini` works as a backup), hides outer write tools, and applies `compat_annotations: true` to `local_fallback_dispatch` so Gemini can still edit, exec, browse, and run terminals seamlessly—while ChatGPT and Claude inherit `default` (direct read + write tools).
2. **Confirmation cards & checkpoint continuations (`scripts/gemini-auto-continue.user.js`):** Install this standalone Tampermonkey/Violentmonkey userscript on `https://gemini.google.com/*`:
   - **Auto-Allow (`autoAllow`):** Automatically clicks pending confirmation cards (`Allow` / `Approve`) so multi-step edits do not stall waiting on clicks.
   - **Auto-Continue (`armed`):** Detects checkpoint markers (`[[AUTO_CONTINUE]]` / `### Mid-Task Checkpoint`) or runs in `N-Turns` mode to resume multi-step work automatically, while stopping cleanly on `Status: Done|Blocked`, `[[AUTO_STOP]]`, handoff markers, or error banners.
   - **Safety baseline:** Uses `needsBaseline` on chat switches so opening an old chat never triggers an accidental send. Note that as of `v1.3.0`, both `armed` and `autoAllow` (no tool allowlist) start **ON** on page load unless disarmed in the floating widget—install only in browser profiles where unattended approval is intended.
3. **Round-trip & RPC timeout ceilings:** Pair the userscript with `local_fallback_dispatch(calls:[...], sequential:true)` (edit + test + review in 1 turn) and `just queue <cmd>` (`pueued.service`) for suites longer than ~25–45s like `just test-shell`.

### 4. Pick only the browsers you want

| Surface | Use when | Opt-in / customization |
|---|---|---|
| `browser-fast` | Routine clicks, forms, scraping, logins in an isolated persistent browser | Windows uses `%LOCALAPPDATA%\mcp-dev-bridge\chrome-profile`. Linux reads `~/.config/mcp-dev-bridge/browser-fast.json` (`x-main` is a starter default—customize with `wh-browser profile add <name>`). |
| `browser-daily` | Driving your own already-open everyday browser (tabs, cookies, extensions) | Completely optional. Inactive until you install and pair `browse` (`curl -fsSL https://opencode.ai/browse/install \| bash`). |
| `browser-devtools` | Network traces, console logs, Lighthouse, heap snapshots, screenshots | Shares the active Windows MCP profile or Linux CDP endpoint. |
| `scripts/wh-browser.cjs` | Driving the same browser stack from local CLIs without the MCP bridge | Symlink to `~/.local/bin/wh-browser`, then run `wh-browser profile list` or `wh-browser fast observe ...`. |

## How to extend WebHarness

### Add your own local MCP servers (zero outer schema bloat)

Point `MCP_LOCAL_SERVERS_FILE` in `.env` at a private mode-`0600` JSON file (<=128 KiB):

```json
{
  "version": "1.0.0",
  "mcpServers": {
    "my-db": {
      "type": "stdio",
      "protocolVersion": "2026-07-28",
      "command": "/usr/local/bin/node",
      "args": ["/abs/path/to/my-db-mcp/server.mjs"],
      "env": { "DB_READONLY": "1" }
    }
  }
}
```

Re-render with `just render personal` (or `server`). `DirectLocalServerPool` wakes `my-db` only on demand, restarts unexpected crashes (`restartOnExit: true` default), and evicts it after 30 minutes idle.

### Sync private Skillshare skills, site memory, or extensions

- **Starter + private skill library:** WebHarness ships 3 default starter packs (`critical-thinking`, `lateral-thinking`, `anthropic` — 40 skills) so fresh installs work immediately. All other folders under `skill-library/packs/*` and `skill-library/policy.json` are gitignored so personal skills never push publicly. Run `just sync-skills` to mirror `~/.config/skillshare/skills` (or pass `--source DIR`) alongside the starter packs, and validate with `./bin/webharness skills check`. See [Skill Library](skill-library.md).
- **Site browser memory:** Stage reusable per-host browser mechanics with `providers/browser-fast/browser-memory-author.mjs propose` and `promote` (see [Personal Workstation](personal/harness.md#learning-exact-site-browser-memory)).
- **Domain extensions:** Package artifact aliases, browser memory, and source mappings behind `webharness extension list|install|remove <name>`.

### Connect a headless Machine B with Cloudflare Email OTP

Add a second headless Linux/ARM server under a subdomain of your existing Cloudflare domain and approve it from Machine A's browser using Cloudflare Zero Trust One-Time PIN (email OTP)—no browser or SSH tunnel required on Machine B. See [Headless Server & Cloudflare Email OTP](headless-server.md), then update Machine B anytime with one `just update` call.

## Correct, debug, and improve WebHarness

1. **Inspect live MCP schemas directly:** `just inspect-dev tools/list`, `just inspect-local tools/list`, `just inspect-mcp tools/list`.
2. **Verify fast without hitting RPC timeouts:** `just test-fast` (~10s), `just queue "just test-shell"` (33s in `pueued`), `just queue "just test-pidev"`, and `bash tests/publication.sh`.
3. **Review and ship cleanly:** Check `just diff` and `git diff --check`, stage your files, run `just ship "type(scope): summary"`, then `just deploy` on WSL and `just update` on any headless server.
