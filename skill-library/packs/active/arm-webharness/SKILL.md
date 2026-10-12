---
name: arm-webharness
description: Run commands and edit files on the Frankfurt ARM server (oci-hunter-arm) through its WebHarness MCP server `arm-webharness`, command the claive/Pi agent that lives on that server (start, wait, answer, cancel jobs and missions) from this machine or any harness, or (re)authorize the connection. Use when the user mentions the ARM server's web harness or its MCP, wants the ARM agent to do work, or needs the OAuth consent redone.
---

# ARM WebHarness (`arm-webharness` MCP)

- Endpoint: `https://mcp-arm.hamza.my.id/mcp` (Cloudflare tunnel `webharness-arm` -> loopback wake proxy :3050 on the server).
- Profile: `server` (`MCP_BRIDGE_PROFILE='server'`) = Dev + Local. Local has `terminal` plus the owner-added `browser-fast` (see Browser). `browser-devtools` is also available (same Chromium via CDP 9222; pass `browser_target: "linux"`). `browser-jev` is NOT set up (needs the Python worker plus model API keys).
- Claude Code: registered and authorized at user scope (`claude mcp add --scope user --transport http arm-webharness <url>`). Codex and OpenCode have NOT been connected yet: each needs the same URL added as a remote MCP server in its own config and its own consent approval (grants are per client), following the steps below.
- Plain shell access is simpler over SSH: `cd ~/repo/myservers && ssh -F ssh_config ARM` (private repo; read its AGENTS.md first).

## Tools (load schemas first where the client defers them)
- Dev: `dev_1mcp_exec` (argv, no shell, <45s), `bash`, `read`, `edit`, `write`, `file_ops`, `wait`, `review_changes`, `import_file`.
- Local: `local_1mcp_tool_list/schema/call/batch`. Terminal (durable tmux PTY) via `terminal_open` + `terminal_read`; use it for long-running work.
- Default cwd `/home/ubuntu`, user `ubuntu`. FMGE lives on AMD_basic, not here.
- Long jobs: `dev_1mcp_exec` with `detach: true` returns `job_id`, `pid`, `log_path`, `exit_path` at once (stdout+stderr in one log; the exit file appears atomically with the exit code, 127 = command missing). Then `dev_1mcp_wait` with `file_exists` on `exit_path`, then `read` the log. Jobs die on a WebHarness restart; logs are pruned after the spool TTL. Needs a client reconnect (`/mcp`) after the 2026-10 deploy to see the new schema; if `detach` is missing, use SSH or `terminal_open`.
- `dev_1mcp_write` also takes `encoding: "base64"` (binary or bulk content), `mode` (octal string like `"755"`, no setuid) and `mkdir_parents`.

## Commanding the agent on ARM (claive + Pi)
The server hosts a Pi coding agent driven by `claive` (repo `/home/ubuntu/repo/claive`, per-host config `~/.config/claive/config.json`). **Pi only: Muse is not installed there and must not be used** (`default_engine: "pi"`; roles scout, worker, reviewer, oracle all resolve to Pi models). Pi has no step cap and no OS sandbox, so it can do anything the `ubuntu` user can.

Reach it either way; both run the same commands:
- SSH: `cd ~/repo/myservers && ssh -F ssh_config ARM '<cmd>'`
- MCP: `dev_1mcp_exec` argv `["/home/ubuntu/repo/claive/bin/claive", ...]` (short commands) or detached exec.
- Always use the full path `C=/home/ubuntu/repo/claive/bin/claive`; non-interactive PATH lacks `~/.local/bin`. All paths passed to claive must be absolute, and the workspace must exist on the server.

Workflow (the orchestrating harness is the parent; for unattended work use the goal queue below):
1. Write the task to a file on ARM (`write` tool, or `ssh ... 'cat > /home/ubuntu/tasks/x.md'`). Make it self-contained: workers do not see this conversation. State scope, files they may touch, expected output, stopping condition.
2. Launch and note the first line `Worker <12-hex id> | <label> | <path>`:
   - single job: `$C start --role scout|worker|reviewer|oracle --workspace /abs/dir --prompt-file /abs/task.md --read-only`
   - reusable worker for follow-ups: `$C open --detach --role worker ...`, then `$C followup ID --prompt-file /abs/next.md`
   - parallel lanes: `$C batch validate PLAN.json && $C batch start PLAN.json`
   - Default to `--read-only` (scout/reviewer) for unattended work; drop it only for a goal the user approved, in a named workspace.
3. Wait without blocking past the tool limit: `$C wait ID --any --timeout 40` (MCP) or up to ~300 (SSH). Exit 0 done, 1 failed, **3 needs a decision**, 124 still running, 130 cancelled. For long waits use `run_in_background` or poll.
4. Exit 3: read the question (`$C show ID`), ask the user if it is theirs to decide, then `$C answer ID --message "..."` and wait again. A single-turn job cannot be answered; start a new one with the decision included.
5. Read results: `$C show ID --json`, `$C logs ID`, `$C logs ID --stderr`. A worker's report is evidence, not proof; verify before relying on it.
6. After compaction or from another harness: `$C inbox --consumer NAME --json` (finished turns since that consumer's last read; `--peek` does not advance) and `$C mission list` / `$C mission show ID` (the `Next:` line says what to do). For multi-turn goals: `$C mission new --title T --goal-file /abs/goal.md`, `export CLAIVE_MISSION=ID` for launches, `$C mission note ID "decision..."`.
7. Stop: `$C cancel ID` (kills the process group, 3 s grace) or `$C close ID` (drains assigned turns, then ends). `$C list` shows what is live; stop the parent loop to stop issuing work.

### 24/7 mode: goals and the supervisor
`claive-serve` (systemd user unit, enabled, lingering) works a durable goal queue with no parent session. Use it when the user wants "keep working until I say stop".
- Add: `$C goal add --title T --role worker --workspace /home/ubuntu/work/<dir> --prompt-file /abs/goal.md [--write] [--budget 2h] [--max-attempts 3]`. Goals are read-only unless `--write`. The prompt file must be self-contained.
- Watch: `$C goal list` (finished goals drop out of the list), `$C goal show ID` (history, result), `$C serve --status`, `$C inbox --consumer NAME`. Serve log: `~/.local/state/claive/supervisor/serve.log`.
- A worker that needs a decision parks its goal; read the question in `goal show`, then `$C goal answer ID --message "..."`. `goal cancel ID`, `goal retry ID`.
- Budgets: 2h wall clock per goal (parked time not counted), then `timed_out`; failures retry with backoff 30 s up to 30 min, then fail after `--max-attempts`.
- **Stop switch**: `$C serve --stop` (cancels workers, requeues goals, serve exits and stays stopped). Resume with `$C serve --resume && systemctl --user start claive-serve` (over ssh set `XDG_RUNTIME_DIR=/run/user/$(id -u)`). `systemctl --user restart claive-serve` only restarts; workers survive and are adopted.
- Allowlist: `~/.config/claive/config.json` `workspaces` = `/home/ubuntu/work` read-only, `/home/ubuntu/work/scratch` writable (deepest entry wins). Goals outside it are refused at add and at launch; a write goal needs a writable entry. Put each goal in its own subdirectory (`~/work/<name>`); to allow writes elsewhere, add an entry with the user's approval and say so. The launcher is `~/.local/bin/claive` (symlink to the repo).

Safety: never put secrets in prompt files (`~/.pi/agent/models.json` holds the provider key); give each job its own workspace directory rather than `/home/ubuntu` itself (Pi can read the account's credentials, e.g. `~/.pi`, `~/.oci`, `~/.ssh`); FMGE and the old hunter are on AMD_basic and out of scope here; no `pkill -f`/broad name kills, cancel by id. Run one heavy job at a time (small server).

## Browser (`browser-fast`, via `local_1mcp_tool_call`)
- Call `server: "browser-fast"`, tool `observe` then `execute`; always pass `browser_target: "linux"` (omitting it tries the Windows cmd.exe). Reuse the `browser_backend` that `observe` returns (`clearcote`; it is just the label for the external-CDP mode, not Clearcote itself, which is x64-only).
- Setup on the server: user units `webharness-xvfb` (Xvfb :99) and `webharness-chrome` (Playwright Chromium arm64, software GL, CDP 127.0.0.1:9222, profile `~/.local/state/mcp-dev-bridge/chrome-profile`); `~/.config/mcp-dev-bridge/browser-fast.json` = `{"version":1,"linux":{"browser":"clearcote","cdpPort":9222}}`; the provider is registered via `MCP_LOCAL_SERVERS_FILE` (`~/.config/mcp-dev-bridge/local-servers.json`) in the checkout's `.env`.
- Why a persistent CDP Chrome: the provider opens one agent-browser session per tab, and without `--cdp` each session launches its own Chrome, so the pinned tab id vanishes (`No tab with target id ...`).
- If it breaks: `systemctl --user status webharness-chrome webharness-xvfb`; `curl -s 127.0.0.1:9222/json/version`. Kill stray processes by pid; never `pkill -f` from a Bash/ssh one-liner.

## (Re)authorize
Needed when the server shows "Needs authentication" (`claude mcp list`).
1. Open the owner-approval tunnel: `cd ~/repo/myservers && ssh -F ssh_config -f -N -o ExitOnForwardFailure=yes -L 127.0.0.1:43070:127.0.0.1:3050 ARM`
2. Start auth (Claude Code: tool `authenticate` or `/mcp`) to get the `/authorize?...` URL.
3. Give the user that URL with ONLY the origin replaced by `http://127.0.0.1:43070`. The consent form posts to a relative path, so the page must load from the local origin; the public origin returns 403 on `/oauth/consent` by design.
4. After approval the `http://localhost:<port>/callback` redirect is normally caught by the client. If not, pass the pasted URL to `complete_authentication`.
5. Close the tunnel with `kill $(lsof -t -i :43070)`. Do not use `pkill -f` with the forward spec: it matches and kills your own shell.

The user approves the consent page themselves. Do not bypass OAuth by calling the loopback MCP port directly.

## Verify
- `dev_1mcp_exec` argv `["bash","-c","hostname; uname -m"]` returns `oci-hunter-arm` and `aarch64`.
- `curl -s -o /dev/null -w '%{http_code}' https://mcp-arm.hamza.my.id/health/ready` returns 200; unauthenticated `/mcp` returns 401.
- Agent: `/home/ubuntu/repo/claive/bin/claive doctor` exits 0 (Pi green; a Muse warning is expected and fine). Supervisor: `systemctl --user is-active claive-serve` is `active` and `claive serve --status` says running with the stop switch clear (set by `--stop`, so check it before assuming a stuck queue). A live check: `claive run --role scout --read-only --workspace /abs/dir --prompt-file /abs/ping.md` completes.
