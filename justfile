# WebHarness operational & verification recipes (run via `just <recipe>`).
# Every test recipe redirects verbose output to a temp log and prints only
# counts and failing lines so LLM/agent context stays clean.

set shell := ["bash", "-euo", "pipefail", "-c"]

# List available recipes.
default:
    @just --list

# Fast core verification: bridge, local-tools, skill-library, websession-adapter, lib.
test-fast:
    @tmp="$(mktemp /tmp/wh-test-fast.XXXXXX.log)"; trap 'rm -f "$tmp"' EXIT; \
      set +e; \
      node --test \
        lib/bridge/test/connector-policy.test.mjs \
        lib/bridge/test/wake-proxy.test.mjs \
        lib/bridge/test/http-diagnostics.test.mjs \
        lib/test/stdio-diagnostics.test.mjs \
        providers/local-tools/test/server.test.mjs \
        providers/local-tools/test/shutdown.test.mjs \
        providers/skill-library/test/server.test.mjs \
        providers/websession-adapter/test/schema-hint.test.mjs \
        providers/websession-adapter/test/protocol-store.test.mjs \
        providers/websession-adapter/test/instructions.test.mjs >"$tmp" 2>&1; \
      rc=$?; set -e; \
      grep -E '^(ℹ (tests|pass|fail|cancelled|skipped)|✖ )' "$tmp" || true; \
      if [ "$rc" -ne 0 ]; then grep -n -A10 '✖ ' "$tmp" | head -n 40 || true; fi; \
      exit "$rc"

# Run pi-dev unit tests + server integration suite.
test-pidev:
    @tmp="$(mktemp /tmp/wh-test-pidev.XXXXXX.log)"; trap 'rm -f "$tmp"' EXIT; \
      set +e; \
      node --test \
        providers/pi-dev/test/call-diagnostics.test.mjs \
        providers/pi-dev/test/idle-worker.test.mjs \
        providers/pi-dev/test/list-directory.test.mjs \
        providers/pi-dev/test/run-script.test.mjs \
        providers/pi-dev/test/search.test.mjs \
        providers/pi-dev/test/render.test.mjs \
        providers/pi-dev/test/boundary.test.mjs \
        providers/pi-dev/test/files.test.mjs \
        providers/pi-dev/test/server.test.mjs >"$tmp" 2>&1; \
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
      exit $((rc1 + rc2))

# Run full verification sequentially (fast + pi-dev + shell).
test-all: test-fast test-pidev test-shell

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

# Probe live local WebHarness HTTP MCP endpoint (pass extra --header args if auth required).
inspect-mcp METHOD="tools/list" *ARGS="":
    mcp-inspector --cli --transport http --method {{METHOD}} {{ARGS}} http://127.0.0.1:43050/mcp

# Check personal CLI toolbox qualification.
toolbox-check:
    bash scripts/check-personal-toolbox.sh

# Render personal config.
render PROFILE="personal":
    node scripts/render-config.mjs --profile {{PROFILE}}

# Check live WebHarness status.
status:
    ./bin/status

# Render personal config, reload websession-adapter, and trigger detached bridge restart.
deploy PROFILE="personal":
    node scripts/render-config.mjs --profile {{PROFILE}}
    systemctl --user restart --no-block websession-adapter.service || true
    nohup bash -c 'sleep 1 && ./bin/webharness restart' >/tmp/wh-deploy-restart.log 2>&1 </dev/null &
    @echo "Detached bridge restart queued (log: /tmp/wh-deploy-restart.log). Verify with 'just status' in ~15s."
