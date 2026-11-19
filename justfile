# WebHarness operational & verification recipes (run via `just <recipe>`).
# Every test recipe redirects verbose output to a temp log and prints only
# counts and failing lines so LLM/agent context stays clean.

set shell := ["bash", "--norc", "-euo", "pipefail", "-c"]

# List available recipes.
default:
    @just --list

# Fast core verification: bridge, local-tools, skill-library, lib, plus websession-adapter when present.
test-fast:
    @tmp="$(mktemp /tmp/wh-test-fast.XXXXXX.log)"; trap 'rm -f "$tmp"' EXIT; \
      files=( \
        lib/bridge/test/connector-policy.test.mjs \
        lib/bridge/test/wake-proxy.test.mjs \
        lib/bridge/test/http-diagnostics.test.mjs \
        lib/test/stdio-diagnostics.test.mjs \
        providers/local-tools/test/server.test.mjs \
        providers/local-tools/test/shutdown.test.mjs \
        providers/skill-library/test/server.test.mjs \
      ); \
      if [ -d providers/websession-adapter/test ]; then \
        files+=( \
          providers/websession-adapter/test/schema-hint.test.mjs \
          providers/websession-adapter/test/protocol-store.test.mjs \
          providers/websession-adapter/test/instructions.test.mjs \
        ); \
      fi; \
      set +e; \
      node --test "${files[@]}" >"$tmp" 2>&1; \
      rc=$?; set -e; \
      grep -E '^(ℹ (tests|pass|fail|cancelled|skipped)|✖ )' "$tmp" || true; \
      if [ "$rc" -ne 0 ]; then grep -n -A10 '✖ ' "$tmp" | head -n 40 || true; fi; \
      exit "$rc"

# Run all pi-dev unit tests + server integration suites.
test-pidev:
    @tmp="$(mktemp /tmp/wh-test-pidev.XXXXXX.log)"; trap 'rm -f "$tmp"' EXIT; \
      set +e; \
      node --test providers/pi-dev/test/*.test.mjs >"$tmp" 2>&1; \
      rc=$?; set -e; \
      grep -E '^(ℹ (tests|pass|fail|cancelled|skipped)|✖ )' "$tmp" || true; \
      if [ "$rc" -ne 0 ]; then grep -n -A10 '✖ ' "$tmp" | head -n 40 || true; fi; \
      exit "$rc"

# Run shell contract suites (harness.sh + lifecycle.sh).
test-shell:
    @tmp="$(mktemp /tmp/wh-test-shell.XXXXXX.log)"; trap 'rm -f "$tmp"' EXIT; \
      set +e; \
      echo "=== harness.sh ===" >"$tmp"; bash tests/harness.sh >>"$tmp" 2>&1; rc1=$?; \
      echo "=== lifecycle.sh ===" >>"$tmp"; bash tests/lifecycle.sh >>"$tmp" 2>&1; rc2=$?; \
      set -e; \
      grep -E '^(===|not ok |[0-9]+ tests,)' "$tmp" || true; \
      exit $((rc1 != 0 || rc2 != 0))

# Run full verification sequentially (fast + pi-dev + shell).
test-all: test-fast test-pidev test-shell

# Run Oxlint + landmines correctness and anti-flake checks.
lint:
    @if [ ! -x node_modules/.bin/oxlint ]; then \
      echo "oxlint not installed; run 'npm ci' in repo root first" >&2; exit 2; \
    fi
    ./node_modules/.bin/oxlint

# Queue any long command in pueued (parallel=1, survives bridge restarts).
queue *CMD:
    pueue add --print-task-id -- {{CMD}}

# Show compact pueue queue status.
queue-status:
    pueue status

# Show pueue log for a task ID.
queue-log ID:
    pueue log {{ID}}

# Structural AST diff (falls back to plain git diff if difft is absent).
diff *ARGS:
    @if command -v difft >/dev/null 2>&1; then \
      DFT_DISPLAY=inline DFT_COLOR=never GIT_EXTERNAL_DIFF=difft git --no-pager diff {{ARGS}}; \
    else \
      git --no-pager diff {{ARGS}}; \
    fi

# Instant per-language LOC & complexity overview (falls back to git ls-files count).
loc:
    @if command -v scc >/dev/null 2>&1; then \
      scc --exclude-dir node_modules,.git,third_party,skill-library/packs .; \
    else \
      git ls-files | wc -l; \
    fi

# Probe local-tools MCP stdio server with official MCP Inspector CLI.
inspect-local METHOD="tools/list" *ARGS="":
    @mcp-inspector --cli \
      -e "MCP_LOCAL_INNER_CONFIG=${HOME}/.local/state/mcp-dev-bridge/local-1mcp/mcp.json" \
      --method {{METHOD}} {{ARGS}} node providers/local-tools/server.mjs

# Probe pi-dev MCP stdio server with official MCP Inspector CLI.
inspect-dev METHOD="tools/list" *ARGS="":
    @mcp-inspector --cli \
      -e MCP_DEV_SHELL_MODE=unrestricted \
      -e MCP_DEV_PATH_MODE=user \
      -e "MCP_DEV_DEFAULT_CWD=${HOME}" \
      -e "MCP_DEV_STATE_DIR=${HOME}/.local/state/mcp-dev-bridge/dev" \
      -e "MCP_DEV_TERMINAL_SOCKET=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/wsl-agent-terminal.sock" \
      --method {{METHOD}} {{ARGS}} node providers/pi-dev/server.mjs

# Probe live local WebHarness HTTP MCP endpoint (resolves MCP_ONE_MCP_PORT from env/.env, default 3050).
inspect-mcp METHOD="tools/list" *ARGS="":
    @port="${MCP_ONE_MCP_PORT:-}"; \
      if [ -z "$port" ] && [ -f .env ]; then \
        port="$(grep -E '^MCP_ONE_MCP_PORT=' .env | tail -n 1 | cut -d= -f2- | tr -d "\"' \r" || true)"; \
      fi; \
      port="${port:-3050}"; \
      mcp-inspector --cli --transport http --method {{METHOD}} {{ARGS}} "http://127.0.0.1:${port}/mcp"

# Check personal CLI toolbox qualification.
toolbox-check:
    bash scripts/check-personal-toolbox.sh

# Render personal or server config safely without unquoted shell interpolation.
render $PROFILE="personal":
    node scripts/render-config.mjs --profile "$PROFILE"

# Copy connector-policy template to ~/.config/mcp-dev-bridge only when missing (never overwrites local rules).
init-connector-policy:
    @mkdir -p "${HOME}/.config/mcp-dev-bridge"
    @if [ ! -f "${HOME}/.config/mcp-dev-bridge/connector-policy.yaml" ]; then \
      cp config/connector-policy.example.yaml "${HOME}/.config/mcp-dev-bridge/connector-policy.yaml"; \
      echo "Installed starter connector-policy.yaml from template."; \
    else \
      echo "Kept existing ~/.config/mcp-dev-bridge/connector-policy.yaml."; \
    fi

# Sync local Skillshare skills (+ optional extra packs) into gitignored skill-library/packs/ and skill-library/policy.json.
sync-skills *ARGS="":
    node scripts/sync-skillshare-library.mjs {{ARGS}}

# Check live WebHarness status.
status:
    ./bin/status

# Compact host audit: pueued + CLI toolbox summary + WebHarness status overview.
host-audit:
    @echo "=== pueued ==="
    @if command -v systemctl >/dev/null 2>&1; then \
      echo "service: $(systemctl --user is-active pueued.service 2>/dev/null || echo inactive)"; \
    fi
    @if command -v pueue >/dev/null 2>&1; then \
      pueue status; \
    else \
      echo "pueue: not installed"; \
    fi
    @echo "=== toolbox ==="
    @mode=""; \
      if [ -f "${HOME}/.local/state/mcp-dev-bridge/bridge.env" ] && grep -Eq "MCP_BRIDGE_PROFILE=['\"]?server" "${HOME}/.local/state/mcp-dev-bridge/bridge.env"; then \
        mode="--headless"; \
      fi; \
      out="$(bash scripts/check-personal-toolbox.sh $mode 2>&1 || true)"; \
      printf '%s\n' "$out" | grep -E '^(Personal|Headless|MISSING|INVALID|SUMMARY)' || true
    @echo "=== status ==="
    @./bin/status | grep -E '^(desired state:|public URL:|local health:|public health:|cloudflared:|watchdog:|user-systemd:|  MCP endpoint:|  issues:|WARN:)' || true

# Verify staged whitespace/conflicts, commit staged changes, and push main.
ship $MSG:
    @test -n "$MSG" || { echo "ship requires a non-empty commit message" >&2; exit 2; }
    @if git diff --cached --quiet; then echo "nothing staged to commit" >&2; exit 2; fi
    git diff --cached --check
    git commit -m "$MSG"
    git push origin main

# Render config, reload websession-adapter, and trigger detached bridge restart.
deploy $PROFILE="personal":
    node scripts/render-config.mjs --profile "$PROFILE"
    systemctl --user restart --no-block websession-adapter.service || true
    nohup bash -c 'sleep 1 && ./bin/webharness restart' >/tmp/wh-deploy-restart.log 2>&1 </dev/null &
    @echo "Detached bridge restart queued (log: /tmp/wh-deploy-restart.log). Verify with 'just status' in ~15s."

# Pull latest main and redeploy the active profile on this host.
update:
    git pull --ff-only origin main
    @profile=""; \
      if [ -f "${HOME}/.local/state/mcp-dev-bridge/bridge.env" ]; then \
        profile="$(grep -E '^MCP_BRIDGE_PROFILE=' "${HOME}/.local/state/mcp-dev-bridge/bridge.env" | tail -n 1 | cut -d= -f2- | tr -d "\"' \r" || true)"; \
      fi; \
      profile="${profile:-personal}"; \
      just deploy "$profile"
