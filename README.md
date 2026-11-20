# WebHarness

Turn your existing ChatGPT, Claude, or Gemini web subscription into a direct local engineering workstation on WSL2 or a headless Linux/ARM server—without paying per-token API bills or separate Codex CLI, Claude Code, or Gemini CLI subscriptions.

Files, repositories, durable tmux terminals, and browser profiles stay on the machine that already owns them, exposed over OAuth + Cloudflare Tunnel through a compact model-facing MCP surface.

The maintained full deployment is the **Personal Workstation** (`personal`) profile on WSL2 + Ubuntu + x86_64 + Node.js 24+ + user-systemd (see [Reference Environment](docs/reference-environment.md)). Smaller `restricted`, `trusted-dev`, and headless `server` profiles build from the same source.

## Why it saves money, tokens, and RAM

- **Uses the chat subscription you already pay for:** Connect ChatGPT, Claude, or Gemini web directly to your local repositories, builds, terminals, and browsers instead of paying metered CLI/API token fees.
- **Tiny outer schema footprint:** Two outer MCP surfaces (17 tools max, or 7 tools in Gemini read-only compat mode). Adding more MCP servers behind `Local` (`DirectLocalServerPool`) adds zero outer schema tokens until inspected.
- **One-call edit-test-review pipelines:** Chain `edit -> test -> review_changes` in a single `local_fallback_dispatch(calls:[...], sequential:true)` call, batch up to 20 files in `read(targets=[...], mode="outline")`, or run JS-computed loops (up to 32 Dev calls, 4x parallel reads) in `run_script`.
- **Bounded outputs and quiet `just` recipes:** Default 160-line reads, 16 KiB command caps with disk spill paths, and `just` recipes that redirect verbose logs to `/tmp` and print only counts and failing lines.
- **Zero idle RAM tax:** `wake-proxy` sleeps idle 1MCP, the Dev worker sleeps between bursts, and `DirectLocalServerPool` starts each Local server lazily and evicts it after 30 minutes idle.

See [Bells, Whistles, Cost Savings & Extensions](docs/extending.md) for concrete tuning, extensions, and workflows.

## Architecture & model-facing surface

```text
MCP client (ChatGPT / Claude / Gemini)
  -> HTTPS + OAuth -> Cloudflare Tunnel -> loopback wake-proxy (connector-policy.yaml)
  -> on-demand 1MCP (loopback)
       |-- Dev    read list_directory search edit write import_file file_ops review_changes wait exec bash run_script
       `-- Local  tool_list tool_schema tool_call fallback_dispatch tool_batch
                    `-- DirectLocalServerPool (lazy start, 30m idle eviction)
                          |-- dev              hidden fallback-only mirror
                          |-- terminal         broker -> durable tmux PTYs
                          |-- host             Windows host actions (pc_sleep)
                          |-- skill-library    find_skills / read_skill (3 starter packs + private local sync)
                          |-- browser-fast     Agent Browser 0.43.0 (+ optional CloakBrowser 0.7.2)
                          |-- browser-daily    optional everyday browser via paired browse relay
                          `-- browser-devtools Chrome DevTools MCP diagnostics
```

## Core vs. optional & personal components

WebHarness separates the core bridge from optional add-ons. Pick only what fits your workflow—setup checks existing binaries first and skips already-qualified tools so nothing is installed twice or overwritten.

| Layer | Component | Role & opt-in boundary |
|---|---|---|
| **Core** | `Dev` + `Local` + `wake-proxy` + 1MCP + Cloudflare Tunnel | Required bridge and MCP surfaces (`restricted`, `trusted-dev`, `personal`, or `server`). |
| **Core (`personal`/`server`)** | `terminal` (tmux PTYs) + `skill-library` | Durable interactive shells and local skill library: ships 3 default starter packs (`critical-thinking`, `lateral-thinking`, `anthropic`), while all added/Skillshare packs (`just sync-skills`) stay gitignored and private. |
| **Optional (browsers)** | `browser-fast`, `browser-devtools` | Included in `personal`; excluded from `server`/`restricted`/`trusted-dev` unless opted in via `MCP_LOCAL_SERVERS_FILE`. Profile names like `x-main` in `config/browser-fast.example.json` are starter defaults, not fixed requirements. |
| **Optional (everyday browser)** | `browser-daily` | Transparent proxy to your own open browser via `opencode.ai/browse`. Inactive unless you install and pair `browse`. |
| **Optional (multi-client policy)** | `~/.config/mcp-dev-bridge/connector-policy.yaml` | Default keeps direct read + write tools for ChatGPT/Claude. Run `just init-connector-policy` (copy-if-missing) to auto-detect Gemini (`User-Agent: Google`) and apply the 7-tool compat shim only for Gemini. |
| **Optional (accelerators & queue)** | `scripts/setup-personal-toolbox.sh` (`--headless` on servers) + `pueued.service` + `justfile` | Best-effort optional tools (`ast-grep`, `fd`, `yq`, `pueue`/`pueued`, `difft`, `just`, `scc`, `hyperfine`, `mcp-inspector`) and compact `just` recipes. |
| **Optional (web helpers)** | `scripts/gemini-auto-continue.user.js` & `bin/adapter` (WebSession) | Client-side userscript mitigating Gemini Web confirmation cards and checkpoint cutoffs, plus an optional HTTP adapter for non-MCP sandboxes. |

## Choose an authority profile

There is no silent default. Pick the authority you intend to grant:

| Profile | Authority | Reference role |
|---|---|---|
| `personal` | WSL-user Dev + Local (`terminal`, `host`, `skill-library`, browsers, owner MCPs) | Maintained full Personal Workstation reference |
| `server` | Linux-user Dev + Local (`terminal`, `skill-library`, owner MCPs; no desktop/browser) | Separate headless Linux/ARM64 server ([Headless Server](docs/headless-server.md)) |
| `trusted-dev` | Workspace-bounded files + unrestricted `exec`/`bash` as the Linux user | Smaller trusted-development example |
| `restricted` | Workspace-bounded `read`/`edit`/`write` only (no shell execution) | Conservative minimal example |

Read [Security](docs/security.md) before enabling `trusted-dev`, `personal`, or `server`.

## Quick start

```bash
cp .env.example .env
# Set MCP_PUBLIC_URL (and MCP_WORKSPACE_ROOT for workspace-bounded profiles).

./bin/webharness doctor --profile personal
./bin/webharness setup --profile personal
# Add --enable-startup only when persistent user-systemd startup is intended.

webharness start
webharness status
```

Optional first-run helpers (when `just` is installed):

```bash
just init-connector-policy  # copy-if-missing starter policy (auto-detects Gemini)
just sync-skills            # sync local Skillshare skills into gitignored skill-library/packs/
just host-audit             # compact pueued + toolbox + bridge health check
just update                 # pull main + auto-detect profile + redeploy on this host
```

Generated state and OAuth sessions live outside Git under `${XDG_STATE_HOME:-$HOME/.local/state}/mcp-dev-bridge/` (transient state under `${XDG_RUNTIME_DIR:-/run/user/$UID}/mcp-dev-bridge/`). For Cloudflare Tunnel provisioning and OpenAI Secure MCP Tunnel boundaries, see [Getting Started](docs/getting-started.md#provision-the-cloudflare-transport-used-by-the-reference-deployment) and [idle configuration](docs/configuration.md#on-demand-runtimes).

## How an agent should route work

| Task | Route |
|---|---|
| Search text, outline files, read/edit/write, Git diff, short command (<45s target) | Dev (`search`, `read`, `list_directory`, `edit`, `review_changes`, `exec`/`bash`) |
| Static multi-step edit + test + review in one round trip | `local_fallback_dispatch(calls:[...], sequential:true)` |
| Long, duration-uncertain, interactive, or restart-surviving command | Local `terminal` + Dev `wait` (or `just queue <cmd>` via `pueued`) |
| Routine browser clicks/forms (isolated profile) | Local `browser-fast` (`observe` -> `execute` with pinned `active_tab`) |
| Your own already-open browser tabs/logins | Local `browser-daily` (optional, requires paired `browse`) |
| Network, console, performance, screenshots, DevTools | Local `browser-devtools` |
| Host sleep or owner-added local MCPs | Local `host` / `tool_list` -> `tool_schema` -> `tool_call` |

## Key boundaries & security notes

- **Pinned 1MCP 0.40.0:** Loopback-only behind Cloudflare Tunnel with required OAuth and qualified compatibility patches (see [Operations](docs/operations.md)).
- **Browser isolation:** Windows automation uses a dedicated Chrome profile (`%LOCALAPPDATA%\mcp-dev-bridge\chrome-profile`, ephemeral loopback CDP port) separate from everyday Chrome. Linux uses WSLg and `~/.config/mcp-dev-bridge/browser-fast.json`. Everyday browser access happens only if you opt into `browser-daily`.
- **Honest annotations & `tag:local`:** `fallback_dispatch` declares mutating annotations by default. Per-client `compat_annotations: true` in `connector-policy.yaml` is strictly a client-side transport shim—treat the downstream operation as the real side-effect boundary.
- **Human secrets stay in tmux:** Enter sudo/passwords/MFA in a human-controlled terminal (`wsl-term attach`), never in MCP arguments.
- **Planned follow-on:** Delegated workers (`spawn`/`message`/`status`/`finish`) are scoped separately in the [Agents implementation plan](docs/superpowers/plans/2026-08-29-webharness-agents-implementation.md).

## Documentation

- [Bells, Whistles, Cost Savings & Extensions](docs/extending.md) — cut token/subscription costs, enable add-ons, add custom MCPs, debug, and extend
- [Getting Started](docs/getting-started.md) — Cloudflare setup, profiles, and first run
- [Headless Server](docs/headless-server.md) — separate Linux/ARM64 server, existing Cloudflare domain setup, and Machine A -> Machine B Email OTP approval
- [Operations](docs/operations.md) — lifecycle, safe restarts, connector policy, browsers, `pueued`, and `justfile`
- [Configuration](docs/configuration.md) — `.env` variables, profiles, output caps, and idle tuning
- [Architecture](docs/architecture.md) — Dev/Local split, `DirectLocalServerPool`, Terminal, and Browser seams
- [Personal Workstation](docs/personal/harness.md) — tool cheat sheet, human-first tmux handoff, and extensions
- [Security](docs/security.md) | [MCP Compatibility](docs/compatibility.md) | [Troubleshooting](docs/troubleshooting.md) | [Development](docs/development.md) | [Full Index](docs/README.md)

## License

MIT. See [LICENSE](LICENSE).
